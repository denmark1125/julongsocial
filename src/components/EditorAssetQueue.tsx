import { useEffect, useState, type ReactNode } from 'react';
import { collection, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Asset, AssetFlowStage, Post, UserProfile, Vendor, deriveFlowStage } from '../types';
import {
  buildCloudUploadUpdate,
  buildCloudUploadUndoUpdate,
  buildFlowUpdate,
  buildSubmitUndoUpdate,
  getFlowDaysStuck,
  getFlowDueInfo,
  isFlowStale,
  sortFlowColumn,
} from '../lib/assetFlow';
import {
  Scissors, Film, CheckCircle2, UploadCloud, Clock, Flame,
  CalendarClock, ChevronDown, ChevronRight, ChevronLeft, PackageCheck, Search, X,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';

/**
 * 剪輯師工作台的分區。刻意**不是**照 flowStage 分，而是照「這支片現在要不要你動手」分。
 *
 * 為什麼不照 flowStage：「上傳雲端」不是交棒鏈上的一棒，是獨立的一條事實線
 * （見 assetFlow.ts 的 buildCloudUploadUpdate）。我們是在 LINE 上請剪輯師上傳，
 * 他不該卡在我們有沒有空回後台點「業主通過」。所以「還沒上傳」的片不管業主審了沒，
 * 都該待在同一個要動手的區塊裡，而不是被埋在最下面的唯讀區。
 */
type Bucket = 'to_edit' | 'to_upload' | 'done';

function bucketOf(asset: Asset): Bucket | null {
  const stage = deriveFlowStage(asset);
  // 'revising' 併進「待剪」：老闆 2026-08-11 決定業主要改一律走 LINE，系統不做退回流程。
  // 但這裡仍要接住它 —— 若哪天資料庫真的出現 revising 的片而沒有區塊收，
  // 那支片會從剪輯師畫面上憑空消失，正是當年那個「退回的片不見了」的 bug。
  if (stage === 'to_edit' || stage === 'revising') return 'to_edit';
  if (asset.cloudUploadedAt) return 'done';
  if (stage === 'client_review' || stage === 'to_upload') return 'to_upload';
  // ready 但沒有 cloudUploadedAt = 這套流程上線前就完成的舊資料，不是剪輯師的事
  return null;
}

const ACTIONABLE: Bucket[] = ['to_edit', 'to_upload'];

const TABS: { key: Bucket; title: string; icon: ReactNode; onClass: string }[] = [
  { key: 'to_edit', title: '待剪', icon: <Film size={12} />, onClass: 'bg-[#5A5A40] border-[#5A5A40] text-white' },
  { key: 'to_upload', title: '待上傳雲端', icon: <UploadCloud size={12} />, onClass: 'bg-sky-600 border-sky-600 text-white' },
  { key: 'done', title: '已完成', icon: <PackageCheck size={12} />, onClass: 'bg-gray-500 border-gray-500 text-white' },
];

type StepState = 'done' | 'active' | 'locked';

/**
 * 一支片對剪輯師而言只有兩個動作：交片送審（內部叫「轉成片」）、上傳雲端。
 * 過去每張卡只長出「當下該按的那一顆」，剪輯師看不出整支片走到哪、下一步是什麼。
 * 改成固定兩段，讓進度自己說話。
 */
function stepStates(asset: Asset): { convert: StepState; upload: StepState } {
  const stage = deriveFlowStage(asset);
  const uploaded = !!asset.cloudUploadedAt;
  if (stage === 'to_edit' || stage === 'revising') {
    return { convert: 'active', upload: uploaded ? 'done' : 'locked' };
  }
  // 已送審之後，上傳隨時可按 —— 不必等業主審完
  return { convert: 'done', upload: uploaded ? 'done' : 'active' };
}

function Step({
  state, label, caption, icon, tone, busy, onClick,
}: {
  state: StepState;
  label: string;
  caption: string;
  icon: ReactNode;
  tone: 'primary' | 'cloud';
  busy: boolean;
  onClick?: () => void;
}) {
  const clickable = state === 'active' && !!onClick;
  const style =
    state === 'done'
      ? 'bg-gray-50 border-black/5 text-gray-400'
      : state === 'locked'
        ? 'bg-white border-dashed border-black/15 text-gray-400'
        : tone === 'cloud'
          ? 'bg-sky-600 border-sky-600 text-white shadow-sm hover:bg-sky-700'
          : 'bg-[#5A5A40] border-[#5A5A40] text-white shadow-sm hover:bg-[#4a4a35]';

  return (
    <button
      onClick={clickable ? onClick : undefined}
      disabled={!clickable || busy}
      className={`flex-1 min-w-0 rounded-xl px-3 py-2 text-left transition-all border ${style} disabled:opacity-100 ${clickable ? '' : 'cursor-default'}`}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-bold">
        {state === 'done' ? <CheckCircle2 size={12} /> : icon}
        {busy && clickable ? '處理中...' : label}
      </span>
      <span className={state === 'active' ? 'block text-[9.5px] mt-0.5 text-white/70' : 'block text-[9.5px] mt-0.5 text-gray-400'}>
        {caption}
      </span>
    </button>
  );
}

function FlowSteps({
  asset, busy, onAdvance, onUpload,
}: {
  asset: Asset;
  busy: boolean;
  onAdvance?: () => void;
  onUpload?: () => void;
}) {
  const stage = deriveFlowStage(asset);
  const { convert, upload } = stepStates(asset);

  const convertCaption =
    convert === 'done'
      ? asset.submittedAt ? `${format(parseISO(asset.submittedAt), 'MM/dd')} 已送審` : '已送審'
      : '剪完按這裡交給業主審';

  const uploadCaption =
    upload === 'done'
      ? asset.cloudUploadedAt ? `${format(parseISO(asset.cloudUploadedAt), 'MM/dd')} 已上傳` : '已上傳'
      : upload === 'active' ? '傳完雲端按這裡，不用等業主' : '送審後才需要上傳';

  return (
    <div className="flex items-stretch gap-2 max-w-lg">
      <Step
        state={convert}
        // 剪輯師端一律講「送審」——「轉成片」是我們內部的講法，對外包剪輯師不直觀
        label="交片送審"
        caption={convertCaption}
        icon={<Film size={12} />}
        tone="primary"
        busy={busy}
        onClick={onAdvance}
      />
      <Step
        state={upload}
        label="上傳雲端"
        caption={uploadCaption}
        icon={<UploadCloud size={12} />}
        tone="cloud"
        busy={busy}
        onClick={onUpload}
      />
    </div>
  );
}

/** 唯讀的業主側狀態，讓剪輯師知道球在哪，但不影響他能不能上傳 */
function ClientBadge({ asset }: { asset: Asset }) {
  const stage = deriveFlowStage(asset);
  if (stage === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[9px] font-bold border border-green-200">
        <PackageCheck size={9} /> 已完成，可排程
      </span>
    );
  }
  if (stage === 'to_upload') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[9px] font-bold border border-green-200">
        <CheckCircle2 size={9} /> 業主已通過
      </span>
    );
  }
  if (stage === 'client_review') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 text-[9px] font-bold border border-black/5">
        <Clock size={9} /> 業主審核中
      </span>
    );
  }
  return null;
}

function AssetCard({
  asset, vendorName, posts, busy, onAdvance, onUpload, onUndoSubmit, onUndoUpload, showClientBadge,
}: {
  // 這個專案沒有安裝 @types/react，JSX.IntrinsicAttributes 不存在，
  // 所以 key 要自己宣告成 prop，否則 tsc 會當成多餘屬性報錯。
  key?: string;
  asset: Asset;
  vendorName: string;
  posts: Post[];
  busy: boolean;
  onAdvance?: () => void;
  onUpload?: () => void;
  onUndoSubmit?: () => void;
  onUndoUpload?: () => void;
  showClientBadge?: boolean;
}) {
  const due = getFlowDueInfo(asset, posts);
  const days = getFlowDaysStuck(asset);
  const stale = isFlowStale(asset);

  return (
    <div className="p-4 space-y-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-[#5A5A40] text-sm">{vendorName}</span>
          {asset.isUrgent && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-600 text-[9px] font-bold border border-red-200">
              <Flame size={9} /> 急件
            </span>
          )}
          {showClientBadge && <ClientBadge asset={asset} />}
        </div>
        <p className="text-sm text-gray-600 truncate mt-0.5">{asset.title}</p>

        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {due && (
            <span
              className={
                due.overdue
                  ? 'inline-flex items-center gap-1 text-[10px] font-bold text-red-600'
                  : due.imminent
                    ? 'inline-flex items-center gap-1 text-[10px] font-bold text-amber-600'
                    : 'inline-flex items-center gap-1 text-[10px] text-gray-400'
              }
            >
              <CalendarClock size={10} />
              {format(parseISO(due.scheduledAt), 'MM/dd HH:mm')} 要上
              {due.overdue
                ? `（已逾期 ${Math.abs(due.daysUntil)} 天）`
                : due.imminent ? `（剩 ${due.daysUntil} 天）` : ''}
            </span>
          )}
          <span className={stale
            ? 'inline-flex items-center gap-1 text-[10px] font-bold text-red-500'
            : 'inline-flex items-center gap-1 text-[10px] text-gray-400'}
          >
            <Clock size={10} /> 停留 {days} 天
          </span>
          <span className="text-[10px] text-gray-400">
            {asset.filmingDate ? `${format(parseISO(asset.filmingDate), 'MM/dd')} 拍攝` : '未填拍攝日'}
          </span>
        </div>

      </div>

      <FlowSteps asset={asset} busy={busy} onAdvance={onAdvance} onUpload={onUpload} />

      {onUndoSubmit && deriveFlowStage(asset) === 'client_review' && !asset.cloudUploadedAt && !asset.editorInvoiceId && !asset.usedInPostId && (
        <button
          type="button"
          onClick={onUndoSubmit}
          disabled={busy}
          className="mt-2 text-[10px] text-gray-400 hover:text-red-500 underline decoration-dotted underline-offset-2 disabled:opacity-50"
        >
          送審按錯了？撤回到待剪
        </button>
      )}

      {/* 按錯了要有得反悔。做得低調是刻意的——這是例外操作，不該跟兩個主要步驟搶注意力。
          已進請款單的不給（帳務凍結），所以那種情況連鈕都不出現。 */}
      {onUndoUpload && !!asset.cloudUploadedAt && !asset.editorInvoiceId && (
        <button
          type="button"
          onClick={onUndoUpload}
          disabled={busy}
          className="mt-2 text-[10px] text-gray-400 hover:text-red-500 underline decoration-dotted underline-offset-2 disabled:opacity-50"
        >
          上傳按錯了？取消這個標記
        </button>
      )}
    </div>
  );
}

function Section({
  title, hint, count, tone, icon, children, empty, collapsible,
}: {
  title: string;
  hint: string;
  count: number;
  tone: 'danger' | 'normal' | 'cloud' | 'muted';
  icon: ReactNode;
  children: ReactNode;
  empty: string;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);

  const headerTone =
    tone === 'danger' ? 'text-red-600'
      : tone === 'cloud' ? 'text-sky-700'
        : tone === 'muted' ? 'text-gray-400'
          : 'text-[#5A5A40]';
  const border = tone === 'danger' ? 'border-red-200' : tone === 'cloud' ? 'border-sky-200' : 'border-black/5';

  return (
    <div className={`bg-white rounded-3xl shadow-sm border ${border} overflow-hidden`}>
      <button
        onClick={collapsible ? () => setOpen(o => !o) : undefined}
        disabled={!collapsible}
        className={`w-full text-left px-5 pt-4 pb-3 border-b border-black/5 ${collapsible ? 'hover:bg-black/[0.015]' : 'cursor-default'}`}
      >
        <h3 className={`text-sm font-bold flex items-center gap-2 ${headerTone}`}>
          {collapsible && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          {icon} {title}
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-black/5 text-gray-500">{count}</span>
        </h3>
        <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>
      </button>
      {open && (
        count === 0
          ? <div className="p-8 text-center text-gray-400 italic text-xs">{empty}</div>
          : <div className="divide-y divide-black/5">{children}</div>
      )}
    </div>
  );
}

export default function EditorAssetQueue({ userProfile }: { userProfile: UserProfile | null }) {
  const vendorIds = userProfile?.assignedVendorIds || [];
  const vendorIdsKey = [...vendorIds].sort().join(',');

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'flow' | 'newest' | 'vendor'>('flow');
  const [page, setPage] = useState(1);
  // null＝使用者還沒自己選過，這時自動落在「有事要做」的那一頁，不要開在空白頁
  const [tab, setTab] = useState<Bucket | null>(null);

  // 每個指派廠商各自訂閱單一文件，不用集合查詢——避開 Firestore `in` 條件上限，也符合權限規則(逐廠商路徑核可)
  useEffect(() => {
    if (vendorIds.length === 0) { setVendors([]); return; }
    const unsubs = vendorIds.map(vid => onSnapshot(doc(db, 'vendors', vid), (snap) => {
      setVendors(prev => {
        const others = prev.filter(v => v.id !== vid);
        return snap.exists() ? [...others, { id: snap.id, ...snap.data() } as Vendor] : others;
      });
    }));
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  useEffect(() => {
    if (vendorIds.length === 0) { setAssets([]); return; }
    const unsubs = vendorIds.map(vid => {
      const q = query(collection(db, 'assets'), where('vendorId', '==', vid));
      return onSnapshot(q, (snap) => {
        setAssets(prev => {
          const others = prev.filter(a => a.vendorId !== vid);
          return [...others, ...snap.docs.map(d => ({ id: d.id, ...d.data() } as Asset))];
        });
      });
    });
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  useEffect(() => {
    if (vendorIds.length === 0) { setPosts([]); return; }
    const unsubs = vendorIds.map(vid => {
      const q = query(collection(db, 'posts'), where('vendorId', '==', vid));
      return onSnapshot(q, (snap) => {
        setPosts(prev => {
          const others = prev.filter(p => p.vendorId !== vid);
          return [...others, ...snap.docs.map(d => ({ id: d.id, ...d.data() } as Post))];
        });
      });
    });
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  // 廠商層級的指派（assignedVendorIds）是主要範圍，但素材可以逐支覆寫剪輯師（Asset.editorId），
  // 所以有指定且不是我的就不該出現在我的清單裡。
  const myEditorId = userProfile?.linkedEditorId;
  const settledPostIds = new Set(
    posts.filter(p => p.status === 'scheduled' || p.status === 'published').map(p => p.id)
  );

  const myVideos = assets.filter(a =>
    a.type === 'video' &&
    // 作廢的片不該再出現在剪輯師的工作台，也不會進他的請款清單（見 isBillable）
    !a.voidedAt &&
    (!myEditorId || !a.editorId || a.editorId === myEditorId) &&
    // 封存＝業主不用這支，我們丟進暫存區。已經上傳過的仍要留著（那是他的請款依據），
    // 還沒做完就被封存的則不該再出現在他的待辦裡。
    (a.status !== 'archived' || !!a.cloudUploadedAt) &&
    // 已排程/已發布的貼文代表這支真的用掉了，不該再出現在工作清單
    !(a.usedInPostId && settledPostIds.has(a.usedInPostId))
  );

  const vendorName = (vendorId: string) => vendors.find(v => v.id === vendorId)?.name || '未知廠商';

  const displayed = myVideos.filter(a => bucketOf(a) !== null);

  // 剪輯師實務上是「坐下來一次處理同一個 IP」，四個區塊把所有 IP 混排會看不出該先動哪一家。
  // 只有被指派兩個以上 IP 才需要這排切換。
  // 明確標成 string[]：這個專案的 tsconfig 下 Array.from(new Set(...)) 會退化成 unknown[]
  const filterVendorIds: string[] = Array.from(new Set<string>(displayed.map(a => a.vendorId)))
    .sort((a, b) => vendorName(a).localeCompare(vendorName(b), 'zh-Hant'));

  // 選中的 IP 可能因為片全部做完而從清單消失，這時要自動退回「全部」，否則會停在一片空白的畫面上
  const activeVendorId =
    vendorFilter !== 'all' && filterVendorIds.includes(vendorFilter) ? vendorFilter : 'all';

  const keyword = search.trim().toLowerCase();
  const visible = (activeVendorId === 'all' ? displayed : displayed.filter(a => a.vendorId === activeVendorId))
    .filter(a => !urgentOnly || a.isUrgent)
    .filter(a => !keyword || (a.title || '').toLowerCase().includes(keyword) || vendorName(a.vendorId).toLowerCase().includes(keyword));

  // 待辦數不含「已完成」——那區是唯讀的，算進去會讓剪輯師以為自己還有事要做
  const pendingCount = (vendorId: string) =>
    displayed.filter(a => {
      const b = bucketOf(a);
      return (vendorId === 'all' || a.vendorId === vendorId) && !!b && ACTIONABLE.includes(b);
    }).length;

  const inBucket = (b: Bucket) => {
    const list = visible.filter(a => bucketOf(a) === b);
    if (sortBy === 'newest') return [...list].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (sortBy === 'vendor') return [...list].sort((a, b) => vendorName(a.vendorId).localeCompare(vendorName(b.vendorId), 'zh-Hant'));
    return sortFlowColumn(list, posts);
  };

  const toEdit = inBucket('to_edit');
  const toUpload = inBucket('to_upload');
  const done = inBucket('done');

  // 預設落在第一個有東西的待辦頁；兩邊都空才停在待剪
  const activeTab: Bucket =
    tab ?? (toEdit.length > 0 ? 'to_edit' : toUpload.length > 0 ? 'to_upload' : 'to_edit');

  const currentList = activeTab === 'to_edit' ? toEdit : activeTab === 'to_upload' ? toUpload : done;
  const pageCount = Math.max(1, Math.ceil(currentList.length / 5));
  const activePage = Math.min(page, pageCount);
  const pagedList = currentList.slice((activePage - 1) * 5, activePage * 5);

  useEffect(() => { setPage(1); }, [activeTab, activeVendorId, search, urgentOnly, sortBy]);

  const thisMonth = format(new Date(), 'yyyy-MM');
  // 本月已上傳＝本月可請款的支數。用本地時區換算，不可以用 ISO 字串裁切（差 8 小時會算到上個月）
  const uploadedThisMonth = myVideos.filter(a =>
    a.cloudUploadedAt && format(parseISO(a.cloudUploadedAt), 'yyyy-MM') === thisMonth
  ).length;

  const advance = async (asset: Asset) => {
    if (!auth.currentUser) return;
    if (!window.confirm(`確定「${asset.title}」已經剪完，要交片送審嗎？\n\n送出後會移到「待上傳雲端」，若誤按可在尚未上傳前撤回。`)) return;
    const msg = '已送審，等待業主回覆';
    setBusyId(asset.id!);
    try {
      await updateDoc(
        doc(db, 'assets', asset.id!),
        buildFlowUpdate(asset, 'client_review', {
          byUid: auth.currentUser.uid,
          byName: userProfile?.displayName || userProfile?.username,
        })
      );
      toast.success(msg);
      // 這裡故意不推即時通知：老闆 2026-08-12 回報「LINE 好吵」，
      // 剪輯師每交一支片就跳一則。改由每日 09:30 的 flow-digest-push 彙總成一則。
    } catch (error) {
      console.error('Flow advance failed:', error);
      toast.error('操作失敗，請稍後再試');
    } finally {
      setBusyId(null);
    }
  };

  const undoSubmit = async (asset: Asset) => {
    if (!auth.currentUser) return;
    if (deriveFlowStage(asset) !== 'client_review' || asset.cloudUploadedAt || asset.editorInvoiceId || asset.usedInPostId) {
      toast.error('這支已進入後續流程，不能直接撤回，請聯絡管理員');
      return;
    }
    if (!window.confirm(`確定要把「${asset.title}」撤回到待剪嗎？`)) return;
    setBusyId(asset.id!);
    try {
      await updateDoc(doc(db, 'assets', asset.id!), buildSubmitUndoUpdate(asset, {
        byUid: auth.currentUser.uid,
        byName: userProfile?.displayName || userProfile?.username,
      }));
      toast.success('已撤回到待剪');
    } catch (error) {
      console.error('Undo submit failed:', error);
      toast.error('撤回失敗，請稍後再試');
    } finally {
      setBusyId(null);
    }
  };

  // 按錯了要能自己收回。沒有這條路的話，cloudUploadedAt 一旦寫下去那支素材就永遠刪不掉
  // （firestore.rules 的 allow delete 要求它為空），剪輯師只能回頭找我們處理。
  const undoUploaded = async (asset: Asset) => {
    if (!auth.currentUser) return;
    if (asset.editorInvoiceId) {
      toast.error('這支已經送進請款單了，不能再取消上傳');
      return;
    }
    if (!window.confirm('確定要取消「已上傳雲端」嗎？取消後這支不會列入請款，要重新上傳並再按一次。')) return;
    setBusyId(asset.id!);
    try {
      await updateDoc(
        doc(db, 'assets', asset.id!),
        buildCloudUploadUndoUpdate(asset, {
          byUid: auth.currentUser.uid,
          byName: userProfile?.displayName || userProfile?.username,
        })
      );
      toast.success('已取消上傳標記');
    } catch (error) {
      console.error('Undo upload failed:', error);
      toast.error('操作失敗，請稍後再試');
    } finally {
      setBusyId(null);
    }
  };

  const markUploaded = async (asset: Asset) => {
    if (!auth.currentUser) return;
    setBusyId(asset.id!);
    try {
      await updateDoc(
        doc(db, 'assets', asset.id!),
        buildCloudUploadUpdate(asset, {
          byUid: auth.currentUser.uid,
          byName: userProfile?.displayName || userProfile?.username,
        })
      );
      toast.success(
        deriveFlowStage(asset) === 'to_upload'
          ? '已標記上傳完成，小編可以排程了'
          : '已標記上傳完成，這支列入本月請款'
      );
      // 同上，不推即時通知，交給每日彙總
    } catch (error) {
      console.error('Mark uploaded failed:', error);
      toast.error('操作失敗，請稍後再試');
    } finally {
      setBusyId(null);
    }
  };

  if (vendorIds.length === 0) {
    return (
      <div className="bg-white rounded-3xl shadow-sm border border-black/5 p-12 flex flex-col items-center justify-center text-center space-y-4">
        <div className="w-16 h-16 bg-[#5A5A40]/10 rounded-2xl flex items-center justify-center text-[#5A5A40]">
          <Scissors size={28} />
        </div>
        <div>
          <h3 className="text-lg font-bold serif text-[#5A5A40]">我的剪輯任務</h3>
          <p className="text-xs text-amber-600 bg-amber-50 px-4 py-2 rounded-xl mt-3">
            目前尚未被指派任何廠商，請聯繫管理員設定。
          </p>
        </div>
      </div>
    );
  }

  const cardProps = (a: Asset) => ({
    key: a.id,
    asset: a,
    vendorName: vendorName(a.vendorId),
    posts,
    busy: busyId === a.id,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold serif text-[#5A5A40] flex items-center gap-2">
            <Scissors size={20} /> 我的剪輯任務
          </h2>
          <p className="text-xs text-gray-400 mt-1">
            剪完按「交片送審」；檔案傳上雲端後就按「上傳雲端」，不用等我們通知。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm">
            <p className="text-[10px] font-bold text-gray-400">待處理</p>
            <p className="text-lg font-bold leading-none text-[#5A5A40]">
              {pendingCount('all')} <span className="text-xs font-normal text-gray-400">支</span>
            </p>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-sky-200 shadow-sm">
            <p className="text-[10px] font-bold text-gray-400">本月已上傳</p>
            <p className="text-lg font-bold leading-none text-sky-700">
              {uploadedThisMonth} <span className="text-xs font-normal text-gray-400">支</span>
            </p>
          </div>
        </div>
      </div>

      {/* 只帶一個 IP 的剪輯師不需要這排，多一列按鈕反而是雜訊 */}
      {filterVendorIds.length >= 2 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-gray-400 w-10 shrink-0">依 IP</span>
          <button
            onClick={() => setVendorFilter('all')}
            className={activeVendorId === 'all'
              ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
              : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
          >
            全部
            {pendingCount('all') > 0 && <span className="ml-1.5 opacity-70">{pendingCount('all')}</span>}
          </button>
          {filterVendorIds.map(vid => (
            <button
              key={vid}
              onClick={() => setVendorFilter(vid)}
              className={activeVendorId === vid
                ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
                : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
            >
              {vendorName(vid)}
              {pendingCount(vid) > 0 && <span className="ml-1.5 opacity-70">{pendingCount(vid)}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[170px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋片名或 IP"
            className="w-full pl-8 pr-8 py-2 rounded-xl text-xs bg-white border border-black/5 focus:outline-none focus:border-[#5A5A40]/30" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="清除搜尋" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"><X size={13} /></button>}
        </div>
        <button type="button" onClick={() => setUrgentOnly(v => !v)} className={urgentOnly
          ? 'px-3 py-2 rounded-xl text-[11px] font-bold bg-red-500 text-white'
          : 'px-3 py-2 rounded-xl text-[11px] font-bold bg-white border border-black/5 text-gray-500'}>只看急件</button>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as 'flow' | 'newest' | 'vendor')}
          className="px-3 py-2 rounded-xl text-[11px] font-bold bg-white border border-black/5 text-gray-500 focus:outline-none">
          <option value="flow">預設順序</option><option value="newest">最新加入</option><option value="vendor">依 IP</option>
        </select>
      </div>

      {/* 大分頁而不是三個區塊疊在一起：手機上一路捲到底才看得到「待上傳雲端」，
          而那正是最常用的一區。一次只顯示一類，捲動長度就固定了。 */}
      <div className="grid grid-cols-3 gap-2">
        {TABS.map(t => {
          const count = t.key === 'to_edit' ? toEdit.length : t.key === 'to_upload' ? toUpload.length : done.length;
          const on = activeTab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={on
                ? `rounded-2xl px-3 py-3 text-left border shadow-sm ${t.onClass}`
                : 'rounded-2xl px-3 py-3 text-left border border-black/5 bg-white text-gray-500 hover:text-[#5A5A40]'}
            >
              <span className="flex items-center gap-1.5 text-[11px] font-bold">
                {t.icon} {t.title}
              </span>
              <span className={on ? 'block text-xl font-bold leading-none mt-1' : 'block text-xl font-bold leading-none mt-1 text-[#5A5A40]'}>
                {count}<span className="text-[10px] font-normal opacity-70 ml-1">支</span>
              </span>
            </button>
          );
        })}
      </div>

      {activeTab === 'to_edit' && (
        <Section
          title="待剪"
          hint="剪完按「交片送審」，系統會自動通知同事拿去給業主審。"
          count={toEdit.length}
          tone="normal"
          icon={<Film size={14} />}
          empty="目前沒有待剪的原始素材"
        >
          {pagedList.map(a => <AssetCard {...cardProps(a)} onAdvance={() => advance(a)} />)}
        </Section>
      )}

      {/* 這一區是重點：只要送審過、還沒上傳的都在這，不管業主審完沒有。
          上傳是請款的認定依據，必須由剪輯師自己按，也不該被審核進度卡住。 */}
      {activeTab === 'to_upload' && (
        <Section
          title="待上傳雲端"
          hint="已交片的都在這。檔案傳上雲端後就按「上傳雲端」，不用等業主審完 —— 這一步決定這支算不算你這個月的請款。"
          count={toUpload.length}
          tone="cloud"
          icon={<UploadCloud size={14} />}
          empty="目前沒有待上傳的片"
        >
          {pagedList.map(a => <AssetCard {...cardProps(a)} onUpload={() => markUploaded(a)} onUndoSubmit={() => undoSubmit(a)} onUndoUpload={() => undoUploaded(a)} showClientBadge />)}
        </Section>
      )}

      {/* 唯讀：你該做的都做完了，留著是為了讓你核對這個月上傳了哪幾支 */}
      {activeTab === 'done' && (
        <Section
          title="已完成"
          hint="你這邊都處理完了。這些就是本月請款的依據，可對照「我的請款」核對。"
          count={done.length}
          tone="muted"
          icon={<PackageCheck size={14} />}
          empty="還沒有完成的片"
        >
          {pagedList.map(a => <AssetCard {...cardProps(a)} onUndoUpload={() => undoUploaded(a)} showClientBadge />)}
        </Section>
      )}

      {currentList.length > 5 && (
        <div className="flex items-center justify-center gap-3 pt-1">
          <button type="button" disabled={activePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
            className="p-2 rounded-xl bg-white border border-black/5 text-[#5A5A40] disabled:opacity-30" aria-label="上一頁"><ChevronLeft size={16} /></button>
          <span className="text-xs font-bold text-gray-500">第 {activePage} / {pageCount} 頁・每頁 5 支</span>
          <button type="button" disabled={activePage >= pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))}
            className="p-2 rounded-xl bg-white border border-black/5 text-[#5A5A40] disabled:opacity-30" aria-label="下一頁"><ChevronRight size={16} /></button>
        </div>
      )}
    </div>
  );
}
