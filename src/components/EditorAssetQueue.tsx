import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, doc, onSnapshot, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebase';
import {
  Asset, AssetFlowStage, DURATION_TIER_LABEL, DurationTier,
  Post, UserProfile, Vendor, deriveFlowStage,
} from '../types';
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
import { visibleVendors } from '../lib/vendorStatus';
import {
  Scissors, Film, CheckCircle2, UploadCloud, Clock, Flame,
  CalendarClock, Check, ChevronDown, ChevronRight, PackageCheck, Search, X,
  ArrowLeft, LayoutGrid,
} from 'lucide-react';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
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

/** 一次多看幾支。初始也是這個數字。 */
const PAGE_STEP = 20;

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
      ? 'bg-gray-50 border-black/5 text-gray-500'
      : state === 'locked'
        ? 'bg-white border-dashed border-black/15 text-gray-500'
        : tone === 'cloud'
          ? 'bg-sky-600 border-sky-600 text-white shadow-sm hover:bg-sky-700'
          : 'bg-[#5A5A40] border-[#5A5A40] text-white shadow-sm hover:bg-[#4a4a35]';

  return (
    <button
      onClick={clickable ? onClick : undefined}
      disabled={!clickable || busy}
      className={`flex-1 min-w-0 rounded-xl px-3 py-2 text-left transition-all border ${style} disabled:opacity-100 ${clickable ? '' : 'cursor-default'}`}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-bold">
        {state === 'done' ? <CheckCircle2 size={12} /> : icon}
        {busy && clickable ? '處理中...' : label}
      </span>
      <span className={state === 'active' ? 'block text-[9.5px] mt-0.5 text-white/70' : 'block text-[9.5px] mt-0.5 text-gray-500'}>
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
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[13px] font-bold border border-green-200">
        <PackageCheck size={9} /> 已完成，可排程
      </span>
    );
  }
  if (stage === 'to_upload') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[13px] font-bold border border-green-200">
        <CheckCircle2 size={9} /> 業主已通過
      </span>
    );
  }
  if (stage === 'client_review') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 text-[13px] font-bold border border-black/5">
        <Clock size={9} /> 業主審核中
      </span>
    );
  }
  return null;
}

function AssetCard({
  asset, vendorName, posts, busy, onAdvance, onUpload, onUndoSubmit, onUndoUpload, showClientBadge,
  selected, onToggleSelect,
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
  /** 有傳 onToggleSelect 才會出現勾選框（目前只有「待上傳雲端」那一區用） */
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const due = getFlowDueInfo(asset, posts);
  const days = getFlowDaysStuck(asset);
  const stale = isFlowStale(asset);

  return (
    <div className="p-4 space-y-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {onToggleSelect && (
            <button
              type="button"
              onClick={onToggleSelect}
              aria-label={selected ? '取消選取' : '選取這支'}
              className={selected
                ? 'shrink-0 w-5 h-5 rounded-md bg-[#5A5A40] text-white flex items-center justify-center'
                : 'shrink-0 w-5 h-5 rounded-md border-2 border-gray-300 hover:border-[#5A5A40]'}
            >
              {selected && <Check size={13} />}
            </button>
          )}
          <span className="font-bold text-[#5A5A40] text-base">{vendorName}</span>
          {asset.isUrgent && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-600 text-[13px] font-bold border border-red-200">
              <Flame size={9} /> 急件
            </span>
          )}
          {showClientBadge && <ClientBadge asset={asset} />}
        </div>
        <p className="text-base text-gray-600 truncate mt-0.5">{asset.title}</p>

        {/* 每個標籤都 nowrap：中文沒有詞界，不鎖的話手機上會在「停留 12 天」中間斷成兩行留孤字。
            要換行就整個標籤換下一行。 */}
        <div className="flex items-center gap-x-3 gap-y-1 mt-1 flex-wrap">
          {due && (
            <span
              className={
                due.overdue
                  ? 'inline-flex items-center gap-1 text-[13px] font-bold text-red-600 whitespace-nowrap'
                  : due.imminent
                    ? 'inline-flex items-center gap-1 text-[13px] font-bold text-amber-600 whitespace-nowrap'
                    : 'inline-flex items-center gap-1 text-[13px] text-gray-500 whitespace-nowrap'
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
            ? 'inline-flex items-center gap-1 text-[13px] font-bold text-red-500 whitespace-nowrap'
            : 'inline-flex items-center gap-1 text-[13px] text-gray-500 whitespace-nowrap'}
          >
            <Clock size={10} /> 停留 {days} 天
          </span>
          <span className="text-[13px] text-gray-500 whitespace-nowrap">
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
          className="mt-2 text-[13px] text-gray-500 hover:text-red-500 underline decoration-dotted underline-offset-2 disabled:opacity-50"
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
          className="mt-2 text-[13px] text-gray-500 hover:text-red-500 underline decoration-dotted underline-offset-2 disabled:opacity-50"
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
        : tone === 'muted' ? 'text-gray-500'
          : 'text-[#5A5A40]';
  const border = tone === 'danger' ? 'border-red-200' : tone === 'cloud' ? 'border-sky-200' : 'border-black/5';

  return (
    <div className={`bg-white rounded-3xl shadow-sm border ${border} overflow-hidden`}>
      <button
        onClick={collapsible ? () => setOpen(o => !o) : undefined}
        disabled={!collapsible}
        className={`w-full text-left px-5 pt-4 pb-3 border-b border-black/5 ${collapsible ? 'hover:bg-black/[0.015]' : 'cursor-default'}`}
      >
        <h3 className={`text-base font-bold flex items-center gap-2 ${headerTone}`}>
          {collapsible && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          {icon} {title}
          <span className="text-[13px] font-bold px-2 py-0.5 rounded-full bg-black/5 text-gray-500">{count}</span>
        </h3>
        <p className="text-[13px] text-gray-500 mt-0.5">{hint}</p>
      </button>
      {open && (
        count === 0
          ? <div className="p-8 text-center text-gray-500 italic text-sm">{empty}</div>
          : <div className="divide-y divide-black/5">{children}</div>
      )}
    </div>
  );
}

export default function EditorAssetQueue({ userProfile, jumpToVendorId, onJumpConsumed }: {
  userProfile: UserProfile | null;
  /** 從「上片排程」點庫存標籤跳過來時要打開的 IP */
  jumpToVendorId?: string | null;
  onJumpConsumed?: () => void;
}) {
  const vendorIds = userProfile?.assignedVendorIds || [];
  const vendorIdsKey = [...vendorIds].sort().join(',');

  const [vendors, setVendors] = useState<Vendor[]>([]);
  // 素材有兩個來源：我負責的 IP（廠商層）、以及逐支指名給我的片（素材層）。
  // 分開存是因為兩邊的訂閱範圍不同，混在同一個陣列裡會互相覛掉。
  const [vendorAssets, setVendorAssets] = useState<Asset[]>([]);
  const [assignedAssets, setAssignedAssets] = useState<Asset[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [vendorFilter, setVendorFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [urgentOnly, setUrgentOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'flow' | 'newest' | 'vendor'>('flow');
  // 不用頁碼用「再看 N 支」：待剪 30 支時每頁 5 支等於要翻 6 頁，
  // 而剪輯師的使用情境是「從頭掃一遍看有什麼」，不是「跳到第 4 頁」。
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP);
  // 兩層：先看「我負責哪幾個 IP、各自什麼狀況」，選了才進那一家的清單。
  // 以前一打開就是混排清單，長期難產的 IP 會把第一頁整個吃掉，其他家等於不存在。
  const [view, setView] = useState<'overview' | 'list'>('overview');
  // null＝使用者還沒自己選過，這時自動落在「有事要做」的那一頁，不要開在空白頁
  const [tab, setTab] = useState<Bucket | null>(null);
  // 總覽預設只列「有待辦」的 IP。沒事的那幾家收在一行後面 ——
  // 14 家裡常常一半寫著「目前沒有待辦」，卻跟有事的那幾家佔一樣大的版面。
  const [showIdleIps, setShowIdleIps] = useState(false);
  // 「待上傳雲端」的多選。只有這一區做批次 ——
  // 交片送審要逐支選長度分級決定單價，批次只會讓人亂按。
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  // 交片送審的確認視窗：同時要選這支是 60 秒以上還是以下（決定單價）
  const [submitAsset, setSubmitAsset] = useState<Asset | null>(null);
  const [submitTier, setSubmitTier] = useState<DurationTier>('under60');

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
    if (vendorIds.length === 0) { setVendorAssets([]); return; }
    const unsubs = vendorIds.map(vid => {
      const q = query(collection(db, 'assets'), where('vendorId', '==', vid));
      return onSnapshot(q, (snap) => {
        setVendorAssets(prev => {
          const others = prev.filter(a => a.vendorId !== vid);
          return [...others, ...snap.docs.map(d => ({ id: d.id, ...d.data() } as Asset))];
        });
      });
    });
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  // 逐片指名給我的素材。這條查詢自帶 where('editorId','==',我)，每一筆都滿足安全規則的
  // 「這支片指名給我」條件（firestore.rules 的 assetAssignedToMe），所以不會整條 permission-denied。
  // ⚠️ 絕對不能改成用 vendorId 查沒被指派的廠商——那會整條 403，不是回空陣列。
  const myEditorId = userProfile?.linkedEditorId;

  useEffect(() => {
    if (!myEditorId) { setAssignedAssets([]); return; }
    const q = query(collection(db, 'assets'), where('editorId', '==', myEditorId));
    return onSnapshot(q, (snap) => {
      setAssignedAssets(snap.docs.map(d => ({ id: d.id, ...d.data() } as Asset)));
    }, (error) => {
      console.error('讀取指派給我的素材失敗:', error);
    });
  }, [myEditorId]);

  // 兩個來源依 id 去重。同一支片兩邊都來時內容一樣，後蓋前無害。
  const assets = useMemo(() => {
    const m = new Map<string, Asset>();
    for (const a of vendorAssets) m.set(a.id!, a);
    for (const a of assignedAssets) m.set(a.id!, a);
    return [...m.values()];
  }, [vendorAssets, assignedAssets]);

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
    !(a.usedInPostId && settledPostIds.has(a.usedInPostId)) &&
    // 從沒上傳過、但已被後台盤點成「舊制已結清」＝當年在系統外就領過錢了，這支已經結案。
    // 沒有這條的話那批片會永遠掛在待辦裡（沒人會去按上傳雲端，按了反而變成重複請款）。
    !(a.legacySettlementStatus === 'paid' && !a.cloudUploadedAt)
  );

  // 指名給我、但廠商不在我範圍內的片讀不到 vendor 文件，退回素材上的名稱快照
  const vendorName = (vendorId: string) =>
    vendors.find(v => v.id === vendorId)?.name
    || assets.find(a => a.vendorId === vendorId && a.vendorName)?.vendorName
    || '未知廠商';

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
  const pagedList = currentList.slice(0, visibleCount);
  const remainingCount = currentList.length - pagedList.length;
  // 只算還在目前清單裡的：勾完之後資料可能已經變了（別人改了狀態），
  // 數字要跟畫面上看得到的一致，不然按鈕會寫著一個你看不到的數字。
  const selectedCount = currentList.filter(a => selectedIds[a.id!]).length;

  // 換分區、換 IP、搜尋、篩急件、改排序都要收回去 ——
  // 不收的話切到別家會直接展開一大串，反而更難看。
  useEffect(() => {
    setVisibleCount(PAGE_STEP);
    // 選取也要清掉：篩選改了以後畫面上看不到的那幾支還被勾著，
    // 按下去會一次改掉一批自己沒在看的片。
    setSelectedIds({});
  }, [activeTab, activeVendorId, search, urgentOnly, sortBy]);

  const thisMonth = format(new Date(), 'yyyy-MM');
  // 本月已上傳＝本月可請款的支數。用本地時區換算，不可以用 ISO 字串裁切（差 8 小時會算到上個月）
  const uploadedThisMonth = myVideos.filter(a =>
    a.cloudUploadedAt && format(parseISO(a.cloudUploadedAt), 'yyyy-MM') === thisMonth
  ).length;

  /**
   * 這家 IP 最近一次「有新東西進來」是什麼時候：新素材進系統、交片送審、或上傳雲端，取最近的那一次。
   * 這是總覽排序的依據 —— 最近有在動的 IP 排前面，長期沒東西進來的自己沉下去，
   * 不必靠任何人工標記。
   * ⚠️ createdAt 是「素材建進系統」的時間，不是拍攝日。同事補建一批舊素材會讓那家跳到最前面，
   *    那其實是對的（有新工作進來了），不要為此另外修正。
   */
  const supplyTime = (a: Asset): number => {
    let best = 0;
    for (const raw of [a.createdAt, a.submittedAt, a.cloudUploadedAt]) {
      if (!raw) continue;
      const t = new Date(raw).getTime();
      if (!Number.isNaN(t) && t > best) best = t;
    }
    return best;
  };

  /** 超過這個天數沒有新素材，卡片就改口說「已 N 天沒有新素材」，不再報一個早就過期的日期 */
  const SUPPLY_QUIET_DAYS = 14;

  /**
   * 總覽要列哪幾家：我被指派的（排除已終止），加上任何還有片掛在我身上的 ——
   * 廠商就算被終止，他手上沒做完的片也不能從畫面上消失。
   */
  const overviewVendorIds: string[] = Array.from(new Set<string>([
    ...visibleVendors(vendors).map(v => v.id!),
    ...displayed.map(a => a.vendorId),
  ]));

  /**
   * 逐 IP 彙總。
   * ⚠️ 全部從上面同一份 displayed / myVideos 算出來，**不可以另外數一份**：
   *    總覽各卡加總必須等於頁首那兩張卡，同一張畫面上兩個數字打架就沒人敢信了。
   */
  const ipRows = overviewVendorIds.map(vid => {
    const mine = displayed.filter(a => a.vendorId === vid);
    const all = myVideos.filter(a => a.vendorId === vid);
    const lastSupplyMs = all.reduce((m, a) => Math.max(m, supplyTime(a)), 0);
    return {
      vendorId: vid,
      name: vendorName(vid),
      toEdit: mine.filter(a => bucketOf(a) === 'to_edit').length,
      toUpload: mine.filter(a => bucketOf(a) === 'to_upload').length,
      urgent: mine.filter(a => a.isUrgent && ACTIONABLE.includes(bucketOf(a)!)).length,
      uploadedThisMonth: all.filter(a =>
        a.cloudUploadedAt && format(parseISO(a.cloudUploadedAt), 'yyyy-MM') === thisMonth
      ).length,
      lastSupplyMs,
    };
  }).sort((x, y) => {
    // 急件的 IP 最前（人標的訊號優先於自動判斷）；再來是有待辦的；沒事做的沉到最後 ——
    // 沒事做的 IP 不該只因為剛上傳完就排第一。
    const rank = (r: typeof x) => (r.urgent > 0 ? 0 : r.toEdit + r.toUpload > 0 ? 1 : 2);
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (x.lastSupplyMs !== y.lastSupplyMs) return y.lastSupplyMs - x.lastSupplyMs;
    return x.name.localeCompare(y.name, 'zh-Hant');
  });

  // 有待辦（含急件）的排在上面的格子，其餘收起來。排序已經在 ipRows 做過，這裡只是切兩段。
  const busyIpRows = ipRows.filter(r => r.toEdit + r.toUpload > 0 || r.urgent > 0);
  const idleIpRows = ipRows.filter(r => !(r.toEdit + r.toUpload > 0 || r.urgent > 0));

  // 只帶一個 IP 的剪輯師不需要總覽，多一層只是多按一下（跟下面「依 IP」膠囊列同一個判斷）
  const activeView: 'overview' | 'list' = ipRows.length >= 2 ? view : 'list';

  const openVendor = (vendorId: string) => {
    setVendorFilter(vendorId);
    // 回到「自動落在第一個有東西的分區」，否則會帶著上一家選過的分區進來、開在空白頁
    setTab(null);
    setView('list');
  };

  // 從上片排程點「庫存有 N 支待剪」過來。直接落在那家 IP 的待剪分區，
  // 因為他點那個標籤就是想知道「是哪幾支」。片名只在這裡出現——
  // 日曆那邊一律不接片名，那會變成系統把某一支配給了某一天，而那個配對不存在。
  useEffect(() => {
    if (!jumpToVendorId) return;
    openVendor(jumpToVendorId);
    setTab('to_edit');
    onJumpConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToVendorId]);

  // 送審前先問長度分級：這一步同時決定這支多少錢，所以不能只用 window.confirm 帶過。
  const advance = (asset: Asset) => {
    setSubmitTier(asset.durationTier ?? 'under60');
    setSubmitAsset(asset);
  };

  const confirmSubmit = async () => {
    const asset = submitAsset;
    if (!asset || !auth.currentUser) return;
    const msg = '已送審，等待業主回覆';
    setBusyId(asset.id!);
    try {
      await updateDoc(
        doc(db, 'assets', asset.id!),
        {
          ...buildFlowUpdate(asset, 'client_review', {
            byUid: auth.currentUser.uid,
            byName: userProfile?.displayName || userProfile?.username,
          }),
          // 只寫分級、不寫 editorFee：金額要到請款送出那一刻才凍結，
          // 中間管帳若調整分級價或逐支改價都還來得及。
          durationTier: submitTier,
        }
      );
      setSubmitAsset(null);
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

  /**
   * 一次標記多支已上傳。
   *
   * ⚠️ 每一支都走跟單支完全相同的 buildCloudUploadUpdate()，不在這裡另外組欄位。
   *    那支函式裡有兩個不能重犯的坑（cloudUploadedAt 用 || 不能用 ??、
   *    billableEditorId 只在未定案時寫），寫兩份遲早分岔。
   */
  const markUploadedBatch = async () => {
    if (!auth.currentUser) return;
    const targets = currentList.filter(a => selectedIds[a.id!]);
    if (targets.length === 0) return;
    if (!window.confirm(`把選取的 ${targets.length} 支都標記為已上傳雲端？

這一步決定這幾支算不算你這個月的請款。`)) return;

    setBatchBusy(true);
    try {
      // Firestore 一批上限 500，取 400 留餘裕（比照後台舊帳盤點的做法）
      for (let i = 0; i < targets.length; i += 400) {
        const batch = writeBatch(db);
        for (const asset of targets.slice(i, i + 400)) {
          batch.update(
            doc(db, 'assets', asset.id!),
            buildCloudUploadUpdate(asset, {
              byUid: auth.currentUser.uid,
              byName: userProfile?.displayName || userProfile?.username,
              billableEditorId: myEditorId,
            })
          );
        }
        await batch.commit();
      }
      toast.success(`已標記 ${targets.length} 支上傳完成`);
      setSelectedIds({});
    } catch (error) {
      console.error('Batch mark uploaded failed:', error);
      toast.error('部分或全部沒成功，請重新整理後再試一次');
    } finally {
      setBatchBusy(false);
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
          // 按下這顆鈕的人就是要請這支款的人。在這裡凍結，之後換剪輯師也不會把舊片的錢算到新人頭上。
          billableEditorId: myEditorId,
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
          <p className="text-sm text-amber-600 bg-amber-50 px-4 py-2 rounded-xl mt-3">
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
    // readability-surface：手機點擊區 44px、桌面 24px、輸入框 16px（避免 iOS 自動放大整頁）。
    // 規則寫在 index.css，是 opt-in 的，掛在哪一頁就只影響那一頁。
    <div className="readability-surface space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold serif text-[#5A5A40] flex items-center gap-2">
            <Scissors size={20} /> 我的剪輯任務
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {activeView === 'overview'
              ? '選一個 IP 進去看，或直接看全部。'
              : '剪完按「交片送審」；檔案傳上雲端後就按「上傳雲端」，不用等我們通知。'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm">
            <p className="text-[13px] font-bold text-gray-500">待處理</p>
            <p className="text-lg font-bold leading-none text-[#5A5A40]">
              {pendingCount('all')} <span className="text-sm font-normal text-gray-500">支</span>
            </p>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-sky-200 shadow-sm">
            <p className="text-[13px] font-bold text-gray-500">本月已上傳</p>
            <p className="text-lg font-bold leading-none text-sky-700">
              {uploadedThisMonth} <span className="text-sm font-normal text-gray-500">支</span>
            </p>
          </div>
        </div>
      </div>

      {activeView === 'overview' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(showIdleIps ? ipRows : busyIpRows).map(row => {
              const pending = row.toEdit + row.toUpload;
              const quietDays = row.lastSupplyMs
                ? differenceInCalendarDays(new Date(), new Date(row.lastSupplyMs))
                : null;
              return (
                <button
                  key={row.vendorId}
                  type="button"
                  onClick={() => openVendor(row.vendorId)}
                  className={pending > 0
                    ? 'text-left bg-white rounded-2xl border border-black/5 shadow-sm p-4 hover:border-[#5A5A40]/40 transition-colors'
                    : 'text-left bg-white/60 rounded-2xl border border-black/5 p-4 hover:border-[#5A5A40]/30 transition-colors'}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={pending > 0
                      ? 'font-bold text-[#5A5A40] break-all'
                      : 'font-bold text-gray-500 break-all'}>{row.name}</span>
                    {row.urgent > 0 && (
                      <span className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500 text-white text-[13px] font-bold">
                        <Flame size={10} /> 急件 {row.urgent}
                      </span>
                    )}
                  </div>

                  <p className="mt-2 text-base font-bold text-[#1a1a1a]">
                    {pending > 0
                      ? <>待剪 {row.toEdit} 支<span className="mx-1.5 text-gray-300">・</span>待上傳 {row.toUpload} 支</>
                      : <span className="text-gray-500">目前沒有待辦</span>}
                  </p>

                  <div className="mt-2 flex items-end justify-between gap-2">
                    <span className="text-[13px] text-gray-500">
                      {quietDays === null
                        ? '還沒有素材'
                        : quietDays >= SUPPLY_QUIET_DAYS
                          ? `已 ${quietDays} 天沒有新素材`
                          : `最近有新素材 ${format(new Date(row.lastSupplyMs), 'MM/dd')}`}
                    </span>
                    <span className="text-[13px] text-gray-500 shrink-0">
                      本月已上傳 {row.uploadedThisMonth} 支
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* 沒事的 IP 收成一行。不是藏起來 —— 數字還在、點一下就展開，
              只是不讓它們跟真的有事的那幾家占一樣大的版面。 */}
          {idleIpRows.length > 0 && (
            <button
              type="button"
              onClick={() => setShowIdleIps(v => !v)}
              className="w-full py-2.5 rounded-2xl text-[13px] font-bold text-gray-500 hover:text-[#5A5A40] flex items-center justify-center gap-1.5"
            >
              {showIdleIps
                ? <>收起沒有待辦的 {idleIpRows.length} 個 IP</>
                : <>另外 {idleIpRows.length} 個 IP 目前沒有待辦</>}
            </button>
          )}

          {busyIpRows.length === 0 && !showIdleIps && (
            <p className="text-center text-sm text-gray-500 py-6">所有 IP 都沒有待辦了。</p>
          )}

          <button
            type="button"
            onClick={() => { setVendorFilter('all'); setTab(null); setView('list'); }}
            className="w-full py-3 rounded-2xl bg-white border border-black/5 shadow-sm text-sm font-bold text-gray-500 hover:text-[#5A5A40] flex items-center justify-center gap-1.5"
          >
            <LayoutGrid size={13} /> 全部一起看
          </button>
        </>
      )}

      {activeView === 'list' && ipRows.length >= 2 && (
        <button
          type="button"
          onClick={() => setView('overview')}
          className="flex items-center gap-1 text-[13px] font-bold text-gray-500 hover:text-[#5A5A40]"
        >
          <ArrowLeft size={13} /> 回總覽
        </button>
      )}

      {/* 只帶一個 IP 的剪輯師不需要這排，多一列按鈕反而是雜訊 */}
      {activeView === 'list' && filterVendorIds.length >= 2 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-bold text-gray-500 w-10 shrink-0">依 IP</span>
          <button
            onClick={() => setVendorFilter('all')}
            className={activeVendorId === 'all'
              ? 'px-3 py-1 rounded-full text-[13px] font-bold bg-[#5A5A40] text-white'
              : 'px-3 py-1 rounded-full text-[13px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
          >
            全部
            {pendingCount('all') > 0 && <span className="ml-1.5 opacity-70">{pendingCount('all')}</span>}
          </button>
          {filterVendorIds.map(vid => (
            <button
              key={vid}
              onClick={() => setVendorFilter(vid)}
              className={activeVendorId === vid
                ? 'px-3 py-1 rounded-full text-[13px] font-bold bg-[#5A5A40] text-white'
                : 'px-3 py-1 rounded-full text-[13px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
            >
              {vendorName(vid)}
              {pendingCount(vid) > 0 && <span className="ml-1.5 opacity-70">{pendingCount(vid)}</span>}
            </button>
          ))}
        </div>
      )}

      {activeView === 'list' && (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[170px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜尋片名或 IP"
            className="w-full pl-8 pr-8 py-2 rounded-xl text-sm bg-white border border-black/5 focus:outline-none focus:border-[#5A5A40]/30" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label="清除搜尋" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"><X size={13} /></button>}
        </div>
        <button type="button" onClick={() => setUrgentOnly(v => !v)} className={urgentOnly
          ? 'px-3 py-2 rounded-xl text-[13px] font-bold bg-red-500 text-white'
          : 'px-3 py-2 rounded-xl text-[13px] font-bold bg-white border border-black/5 text-gray-500'}>只看急件</button>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as 'flow' | 'newest' | 'vendor')}
          className="px-3 py-2 rounded-xl text-[13px] font-bold bg-white border border-black/5 text-gray-500 focus:outline-none">
          <option value="flow">預設順序</option><option value="newest">最新加入</option><option value="vendor">依 IP</option>
        </select>
      </div>
      )}

      {/* 大分頁而不是三個區塊疊在一起：手機上一路捲到底才看得到「待上傳雲端」，
          而那正是最常用的一區。一次只顯示一類，捲動長度就固定了。 */}
      {/* 手機上硬排三欄會把「待上傳雲端」擠成兩行，改成可橫滑；
          sm 以上空間夠就回到三欄。flex-shrink-0 由 .readability-surface 的規則代勞。 */}
      {activeView === 'list' && (
      <div className="flex gap-2 overflow-x-auto sm:grid sm:grid-cols-3">
        {TABS.map(t => {
          const count = t.key === 'to_edit' ? toEdit.length : t.key === 'to_upload' ? toUpload.length : done.length;
          const on = activeTab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={on
                ? `rounded-2xl px-3 py-3 text-left border shadow-sm min-w-[8.5rem] sm:min-w-0 ${t.onClass}`
                : 'rounded-2xl px-3 py-3 text-left border border-black/5 bg-white text-gray-500 hover:text-[#5A5A40] min-w-[8.5rem] sm:min-w-0'}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-bold whitespace-nowrap">
                {t.icon} {t.title}
              </span>
              <span className={on ? 'block text-xl font-bold leading-none mt-1' : 'block text-xl font-bold leading-none mt-1 text-[#5A5A40]'}>
                {count}<span className="text-[13px] font-normal opacity-70 ml-1">支</span>
              </span>
            </button>
          );
        })}
      </div>
      )}

      {activeView === 'list' && activeTab === 'to_edit' && (
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

      {/* 批次列：選了才出現，沒選時不占版面。預設不預先全選 ——
          一次改幾十支的請款歸屬應該是他主動選的，不是預設勾好等他按。 */}
      {activeView === 'list' && activeTab === 'to_upload' && pagedList.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap px-1">
          <button
            type="button"
            onClick={() => {
              const allSelected = pagedList.every(a => selectedIds[a.id!]);
              const next = { ...selectedIds };
              for (const a of pagedList) next[a.id!] = !allSelected;
              setSelectedIds(next);
            }}
            className="text-[13px] font-bold text-gray-500 hover:text-[#5A5A40]"
          >
            {pagedList.every(a => selectedIds[a.id!]) ? '取消全選' : `選取這 ${pagedList.length} 支`}
          </button>
          {selectedCount > 0 && (
            <button
              type="button"
              disabled={batchBusy}
              onClick={markUploadedBatch}
              className="px-4 py-2 rounded-xl bg-[#5A5A40] text-white text-[13px] font-bold disabled:opacity-50"
            >
              {batchBusy ? '處理中…' : `把選取的 ${selectedCount} 支標記已上傳`}
            </button>
          )}
        </div>
      )}

      {/* 這一區是重點：只要送審過、還沒上傳的都在這，不管業主審完沒有。
          上傳是請款的認定依據，必須由剪輯師自己按，也不該被審核進度卡住。 */}
      {activeView === 'list' && activeTab === 'to_upload' && (
        <Section
          title="待上傳雲端"
          hint="已交片的都在這。檔案傳上雲端後就按「上傳雲端」，不用等業主審完 —— 這一步決定這支算不算你這個月的請款。"
          count={toUpload.length}
          tone="cloud"
          icon={<UploadCloud size={14} />}
          empty="目前沒有待上傳的片"
        >
          {pagedList.map(a => (
            <AssetCard
              {...cardProps(a)}
              onUpload={() => markUploaded(a)}
              onUndoSubmit={() => undoSubmit(a)}
              onUndoUpload={() => undoUploaded(a)}
              showClientBadge
              selected={!!selectedIds[a.id!]}
              onToggleSelect={() => setSelectedIds(prev => ({ ...prev, [a.id!]: !prev[a.id!] }))}
            />
          ))}
        </Section>
      )}

      {/* 唯讀：你該做的都做完了，留著是為了讓你核對這個月上傳了哪幾支 */}
      {activeView === 'list' && activeTab === 'done' && (
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

      {activeView === 'list' && remainingCount > 0 && (
        <button
          type="button"
          onClick={() => setVisibleCount(n => n + PAGE_STEP)}
          className="w-full py-3 rounded-2xl bg-white border border-black/5 shadow-sm text-sm font-bold text-gray-500 hover:text-[#5A5A40]"
        >
          再看 {Math.min(remainingCount, PAGE_STEP)} 支（還有 {remainingCount} 支）
        </button>
      )}

      {/* 交片送審：確認片名 + 選長度分級。趁剪輯師還記得這支多長的時候問，
          等到請款頁才補，片已經上傳、記憶也模糊了。
          ⚠️ 這裡刻意不顯示金額：分級雖然決定單價，但金額是財務的事，
             剪輯師只要分辨秒數就好（老闆明確要求，別再把 NT$ 加回來）。 */}
      {submitAsset && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onMouseDown={() => !busyId && setSubmitAsset(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md p-6 shadow-xl" onMouseDown={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold serif text-[#5A5A40]">確定要交片送審嗎？</h3>
            <p className="mt-2 text-base text-gray-600 break-words">{submitAsset.title}</p>

            <p className="mt-5 text-base font-bold text-gray-700">這支影片多長？</p>
            <p className="mt-1 text-sm text-gray-500">選錯了可以再跟我們說。</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {(['under60', 'over60'] as DurationTier[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSubmitTier(t)}
                  className={`p-4 rounded-2xl border-2 text-left transition-all ${
                    submitTier === t
                      ? 'border-[#5A5A40] bg-[#5A5A40]/5'
                      : 'border-black/10 hover:border-black/20'
                  }`}
                >
                  <span className="block text-base font-bold text-[#1a1a1a]">{DURATION_TIER_LABEL[t]}</span>
                </button>
              ))}
            </div>

            <p className="mt-5 text-sm text-gray-500">
              送出後會移到「待上傳雲端」。若誤按，在尚未上傳前都可以自己撤回。
            </p>
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => setSubmitAsset(null)} disabled={!!busyId}
                className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-700 font-bold disabled:opacity-40">
                取消
              </button>
              <button type="button" onClick={confirmSubmit} disabled={!!busyId}
                className="flex-1 py-3 rounded-xl bg-[#5A5A40] text-white font-bold disabled:opacity-40">
                {busyId ? '送出中…' : '確定送審'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
