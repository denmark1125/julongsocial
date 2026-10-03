import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, doc, onSnapshot, query, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebase';
import {
  Asset, AssetFlowStage, DURATION_TIER_LABEL, DurationTier,
  DismissedHabit, PlannedSlotMove, Post, ShootBooking, UserProfile, Vendor, deriveFlowStage,
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
import EditingBrief from './EditingBrief';
import {
  buildEditorQueue, customDeadline, deadlineStatus, deliveryDeadline, EditorQueueRow, formatDeadline,
} from '../lib/editorQueue';
import {
  buildHorizonDemands, buildSupplyPlan, describeSupply, SUPPLY_HORIZON_DAYS,
} from '../lib/materialSupply';
import { listPlannedSlots } from '../lib/plannedSlots';
import { trackedVendors, visibleVendors as visibleVendorsOf } from '../lib/vendorStatus';
import {
  Scissors, Film, CheckCircle2, UploadCloud, Clock, Flame,
  CalendarClock, Check, ChevronDown, ChevronRight, PackageCheck, Search, X,
  ExternalLink,
} from 'lucide-react';
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
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
  state, label, caption, icon, tone, busy, onClick, compact,
}: {
  state: StepState;
  label: string;
  caption: string;
  icon: ReactNode;
  tone: 'primary' | 'cloud';
  busy: boolean;
  onClick?: () => void;
  /** 排程清單裡的精簡版：電腦版收掉說明小字（那一頁上方已經講過流程），字放大 */
  compact?: boolean;
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
      <span className={`flex items-center gap-1.5 text-[13px] font-bold ${compact ? 'lg:text-[15px] lg:justify-center lg:py-1' : ''}`}>
        {state === 'done' ? <CheckCircle2 size={12} /> : icon}
        {busy && clickable ? '處理中...' : label}
      </span>
      <span className={`${state === 'active' ? 'block text-[9.5px] mt-0.5 text-white/70' : 'block text-[9.5px] mt-0.5 text-gray-500'} ${compact ? 'lg:hidden' : ''}`}>
        {caption}
      </span>
    </button>
  );
}

function FlowSteps({
  asset, busy, onAdvance, onUpload, compact,
}: {
  asset: Asset;
  busy: boolean;
  onAdvance?: () => void;
  onUpload?: () => void;
  /**
   * 排程清單裡只留當下能按的那一步。
   * ⚠️ 那邊每一張卡都停在「待剪」，第二步永遠是灰的卻佔掉一半寬度 ——
   *    一顆按不下去的按鈕不會幫人理解進度，只會讓人想按。
   *    「我的所有片」那頁維持兩段式（在那裡看得出整支片走到哪才有意義）。
   */
  compact?: boolean;
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
      {/* ⚠️ compact 時做完的那一步也收掉，不只是沒輪到的那一步。
          2026-10-02 行動版實測：待上傳的卡片上「交片送審」已是灰的按不下去，
          卻佔走一半寬度，把「上傳雲端」的說明擠成三行並留下孤字「主」。
          收掉之後剩下的那一步拿到整個寬度，字就不斷了。 */}
      {!(compact && convert === 'done') && (
      <Step
        state={convert}
        // 剪輯師端一律講「送審」——「轉成片」是我們內部的講法，對外包剪輯師不直觀
        label="交片送審"
        caption={convertCaption}
        icon={<Film size={12} />}
        tone="primary"
        busy={busy}
        onClick={onAdvance}
        compact={compact}
      />
      )}
      {!(compact && upload !== 'active') && (
        <Step
          state={upload}
          label="上傳雲端"
          caption={uploadCaption}
          icon={<UploadCloud size={12} />}
          tone="cloud"
          busy={busy}
          onClick={onUpload}
          compact={compact}
        />
      )}
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

/** 清單預設攤開幾筆。剩下的收在「後面還有 N 筆」底下 */
const QUEUE_PREVIEW = 8;
/** 電腦版一支一橫列、每列矮很多，同樣一個畫面放得下更多 */
const QUEUE_PREVIEW_DESKTOP = 12;

/** 是否為電腦版寬度（跟 Tailwind 的 lg 斷點一致：1024px） */
function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)';
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return match;
}

/**
 * 隊伍底下那幾個收合區的共用標頭。
 *
 * ⚠️ 2026-10-02 之前每一區都是一行純文字按鈕，老闆回「摺疊不太明顯」——
 *    沒有邊框、沒有箭頭，看起來就只是一行字，不像可以點。
 *    統一成有外框＋箭頭＋右側筆數的樣子，三區長一樣才看得出是同一類東西。
 */
function FoldHeader({ open, title, hint, count, unit = '支', tone = 'plain', icon, onToggle }: {
  open: boolean;
  title: string;
  hint?: string;
  count: number;
  unit?: string;
  /** 'cloud'＝還要他動手的那一區（待上傳），用藍色跟純資訊區分開 */
  tone?: 'plain' | 'cloud';
  icon?: ReactNode;
  onToggle: () => void;
}) {
  const cloud = tone === 'cloud';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`w-full flex items-center gap-2 px-4 py-3 rounded-2xl border shadow-sm text-left ${
        cloud
          ? 'bg-sky-50 border-sky-200 hover:border-sky-400'
          : 'bg-white border-black/10 hover:border-[#5A5A40]/30'
      }`}
    >
      {open ? <ChevronDown size={16} className={cloud ? 'shrink-0 text-sky-600' : 'shrink-0 text-gray-400'} />
            : <ChevronRight size={16} className={cloud ? 'shrink-0 text-sky-600' : 'shrink-0 text-gray-400'} />}
      <span className="min-w-0 flex-1">
        <span className={`flex items-center gap-1.5 text-sm lg:text-[15px] font-bold whitespace-nowrap ${cloud ? 'text-sky-900' : 'text-[#5A5A40]'}`}>
          {icon}{title}
        </span>
        {hint && <span className={`block text-[13px] lg:text-sm mt-0.5 ${cloud ? 'text-sky-800/80' : 'text-gray-500'}`}>{hint}</span>}
      </span>
      <span className={`shrink-0 text-[13px] lg:text-sm font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${
        cloud ? 'bg-white/70 text-sky-900' : 'bg-black/5 text-gray-500'}`}>
        {count} {unit}
      </span>
    </button>
  );
}

/** 對帳用的一行：哪天、哪個 IP。不放卡片也不放按鈕。 */
function FoldDayRow({ row, vendorName }: {
  // 這專案沒裝 @types/react，key 要自己宣告，否則 tsc 會擋（QueueRow 也是這樣）
  key?: string;
  row: EditorQueueRow;
  vendorName: string;
}) {
  return (
    <div className="px-4 py-2.5 flex items-baseline gap-2 flex-wrap">
      <span className="text-[13px] lg:text-sm font-bold text-gray-500 whitespace-nowrap">
        {row.date ? `${format(row.date, 'MM/dd')}（${'日一二三四五六'[row.date.getDay()]}）要上` : ''}
      </span>
      <span className="text-[13px] lg:text-sm text-gray-500">{vendorName}</span>
    </div>
  );
}

/**
 * 清單的一列＝社群日曆上的一格「哪天哪個 IP 要上片」。
 *
 * 三種樣子：有料要剪（帶素材卡）／還沒有片（只有一行字）／急件沒配到日期。
 * ⚠️ 用詞一律陳述事實（「10/06 要上」），不要祈使句。順序本身已經表達了先後。
 */
function QueueRow({ row, vendorName, card, onOpenLibrary }: {
  key?: string;
  row: EditorQueueRow;
  vendorName: string;
  card: ReactNode;
  /**
   * 「沒片」那一列的出口。老闆：「可以引導她去素材庫」。
   * ⚠️ 只在那個 IP 的素材庫**真的有東西**時才傳進來 —— 點過去是空白頁等於又一條死路。
   */
  onOpenLibrary?: () => void;
}) {
  // 剪輯師只看交片期限，不看上片日（見 editorQueue.ts 的 EDIT_LEAD_WORKDAYS）
  const raw = row.deadline ? deadlineStatus(row.deadline, row.asset?.createdAt) : null;
  // 「沒片」那一列逾期不標紅：剪輯師手上沒料可剪，紅字等於怪錯人。改成橘色「盡快」，提醒同事去催料。
  const status = raw && row.kind === 'no_material' && raw.tone === 'late' ? { text: '盡快', tone: 'soon' as const } : raw;
  const toneClass = status?.tone === 'late' ? 'text-red-600' : status?.tone === 'soon' ? 'text-amber-600' : 'text-[#5A5A40]';

  return (
    // 電腦版：左邊一欄放「哪天要上」，右邊放素材卡，一支片一橫列。
    // ⚠️ 2026-10-03 老闆：電腦版卡片只用到左邊三分之一，右邊整片空著，一個畫面只看得到兩三支。
    //    手機版維持原樣（他說手機版很好用），所以全部用 lg: 前綴，不動手機的 class。
    <div className={row.kind === 'to_edit'
      ? 'bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden lg:flex lg:items-stretch'
      : 'bg-white/60 rounded-2xl border border-dashed border-black/10 px-4 py-3 lg:flex lg:items-baseline lg:gap-4'}>
      {/* ⚠️ 有片可剪時這一行只講「哪天」—— IP 與片名都在底下的素材卡上，
          兩邊都印會變成同一張卡把同一件事講兩次。 */}
      <div className={row.kind === 'to_edit'
        ? 'flex items-baseline gap-2 flex-wrap px-4 pt-3 lg:flex-col lg:items-start lg:justify-center lg:gap-0.5 lg:w-40 lg:shrink-0 lg:py-3 lg:border-r lg:border-black/5'
        : 'flex items-baseline gap-2 flex-wrap lg:w-40 lg:shrink-0 lg:flex-col lg:items-start lg:gap-0.5'}>
        {/* 急件一律只寫橘色火焰「急件」，不寫推算出來的期限。
            ⚠️ 2026-10-03 老闆：急件底下列一個早就過去的推算日期（「09/24 前交片／盡快」）看不懂，
               同一件事講兩次。急件之間的先後仍照期限排（見 buildEditorQueue），只是不印出來。
               例外：同事親手指定的交片日要印，那是特別交代的日子。 */}
        {row.urgent ? (
          <>
            <span className="inline-flex items-center gap-1 text-[13px] lg:text-[15px] font-bold text-orange-600 whitespace-nowrap">
              <Flame size={14} /> 急件
            </span>
            {row.deadline && row.deadlineSource === 'custom' && (
              <span className="text-[13px] lg:text-sm text-gray-500 whitespace-nowrap">
                {formatDeadline(row.deadline)}・同事指定
              </span>
            )}
          </>
        ) : row.deadline ? (
          <span className={`text-[13px] lg:text-[15px] font-bold whitespace-nowrap ${status?.tone === 'late' ? 'text-red-600' : 'text-[#5A5A40]'}`}>
            {formatDeadline(row.deadline)}
          </span>
        ) : null}
        {status && !row.urgent && (
          <span className={`text-[13px] lg:text-sm whitespace-nowrap ${status.tone === 'calm' ? 'text-gray-500' : `font-bold ${toneClass}`}`}>
            {status.text}
            {row.deadlineSource === 'custom' && <span className="ml-1.5 font-normal text-gray-500">同事指定</span>}
          </span>
        )}
        {row.kind !== 'to_edit' && <span className="text-[13px] lg:text-[15px] text-gray-500">{vendorName}</span>}
      </div>

      {row.kind === 'to_edit' ? <div className="lg:flex-1 lg:min-w-0">{card}</div> : (
        <div className="mt-1 flex items-baseline gap-3 flex-wrap lg:mt-0">
          {/* 老闆：「如果 10/3 沒片就寫沒片」。不要再加「等 X 日拍攝」那種推測，講不知道的事只會更亂。
              ⚠️ 真的沒片才會走到這裡 —— 已經有成片在等排程的那幾天走 has_stock，不在這份清單裡。 */}
          <p className="text-[13px] lg:text-[15px] font-medium text-amber-700">沒片</p>
          {onOpenLibrary && (
            <button
              type="button"
              onClick={onOpenLibrary}
              className="text-[13px] lg:text-sm text-gray-500 underline underline-offset-2 hover:text-[#5A5A40] whitespace-nowrap"
            >
              看 {vendorName} 的素材庫
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function AssetCard({
  asset, vendorName, posts, busy, onAdvance, onUpload, onUndoSubmit, onUndoUpload, showClientBadge,
  selected, onToggleSelect, compact, stacked, hideUrgentBadge,
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
  /**
   * 排程清單裡用的精簡版。拿掉三樣對「先剪哪支」沒有幫助、反而搶注意力的東西：
   *   ① 自己的上片日 —— 那一列的標題已經寫了，而且兩個來源可能不同（列是這一格的日期，
   *      卡片是 plannedAirDate），同一張卡兩個日子就沒人敢信
   *   ② 「停留 N 天」—— 它是全卡最搶眼的紅字，但跟「先剪哪支」無關，而且每張都紅＝沒有在警告
   *   ③ 拍攝日 —— 對剪輯師沒有意義
   * 另外片名在這裡是主角（要比 IP 大），不是配角。
   */
  compact?: boolean;
  /** 放在窄欄（電腦版右側欄）時不要排成左右一橫列，維持上下堆疊 */
  stacked?: boolean;
  /** 排程清單那一列左邊已經寫了「急件」，卡片上就不再重複一個紅色標籤 */
  hideUrgentBadge?: boolean;
}) {
  const due = getFlowDueInfo(asset, posts);
  /** 電腦版精簡卡排成「資訊在左、按鈕在右」一橫列 */
  const rowOnDesktop = compact && !stacked;
  const flowStage = deriveFlowStage(asset);
  const cardDeadline = flowStage === 'to_edit' || flowStage === 'revising'
    ? customDeadline(asset) ?? (due ? deliveryDeadline(parseISO(due.scheduledAt)) : null)
    : null;
  const cardDeadlineStatus = cardDeadline ? deadlineStatus(cardDeadline, asset.createdAt) : null;
  const days = getFlowDaysStuck(asset);
  const stale = isFlowStale(asset);

  return (
    <div className={rowOnDesktop
      ? 'p-4 space-y-3 lg:space-y-0 lg:flex lg:items-center lg:gap-4 lg:py-3'
      : 'p-4 space-y-3'}>
      <div className={rowOnDesktop ? 'min-w-0 lg:flex-1' : 'min-w-0'}>
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
          <span className={compact
            ? 'text-[13px] lg:text-[15px] font-medium text-gray-500'
            : 'font-bold text-[#5A5A40] text-base'}>{vendorName}</span>
          {asset.isUrgent && !hideUrgentBadge && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-600 text-[13px] font-bold border border-red-200 ${compact ? 'lg:text-sm' : ''}`}>
              <Flame size={9} /> 急件
            </span>
          )}
          {showClientBadge && <ClientBadge asset={asset} />}
        </div>
        {/* ⚠️ `[text-wrap:balance]` 是給中文孤字用的，別拿掉。
            中文沒有詞界，瀏覽器會一路塞到行尾才折，常常在第二行只留一個字
            （實測 390px：「跟團旅遊避雷小撇步!隱藏加價項目報你／知」）。
            balance 會把兩行拆得差不多長，最後一行就不會只剩一個字。 */}
        <p className={compact
          ? 'text-lg font-bold text-[#1a1a1a] mt-0.5 break-words [text-wrap:balance]'
          : 'text-base text-gray-600 truncate mt-0.5'}>{asset.title}</p>
        {/* 2026-10-03 老闆：剪輯師要知道素材是誰上傳的，有問題才找得到對應窗口。舊素材沒有就不顯示。 */}
        {asset.createdByName && (
          <p className={`text-[13px] text-gray-500 mt-0.5 ${compact ? 'lg:text-[15px]' : ''}`}>
            素材聯繫窗口：<span className="font-medium text-gray-700">{asset.createdByName}</span>
          </p>
        )}
        {/* 這支片的資訊，不是派工單 —— 措辭一律陳述，不要出現祈使句。
            沒填的舊素材整塊不渲染，卡片維持原本的樣子。 */}
        <EditingBrief brief={asset.editingBrief} clipNotes={asset.clipNotes} desktopLarge={compact} />

        {/* 沒有這個連結的話，系統告訴他「有 3 個片段」之後他還是得自己去 Drive 翻資料夾 ——
            整套自動歸檔的價值會在最後一哩斷掉。
            ⚠️ 舊素材的 url 可能是單一檔案或任何網址，不一定是資料夾，所以文案分兩種。
            沒有 url 就整個不渲染，舊卡片維持原樣。 */}
        {asset.url && (
          <a
            href={asset.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 mt-1.5 text-[13px] font-medium text-sky-700 hover:text-sky-900 hover:underline ${compact ? 'lg:text-[15px]' : ''}`}
          >
            <ExternalLink size={12} />
            {asset.driveFolderId ? '開啟毛片資料夾' : '開啟素材連結'}
          </a>
        )}

        {/* 每個標籤都 nowrap：中文沒有詞界，不鎖的話手機上會在「停留 12 天」中間斷成兩行留孤字。
            要換行就整個標籤換下一行。 */}
        {!compact && (
        <div className="flex items-center gap-x-3 gap-y-1 mt-1 flex-wrap">
          {/* 剪輯師只看交片期限，不看上片日（見 editorQueue.ts 的 EDIT_LEAD_WORKDAYS）。
              交出去之後期限就沒意義了，只在待剪／業主要改時顯示。 */}
          {cardDeadline && cardDeadlineStatus && (
            <span
              className={
                cardDeadlineStatus.tone === 'late'
                  ? 'inline-flex items-center gap-1 text-[13px] font-bold text-red-600 whitespace-nowrap'
                  : cardDeadlineStatus.tone === 'soon'
                    ? 'inline-flex items-center gap-1 text-[13px] font-bold text-amber-600 whitespace-nowrap'
                    : 'inline-flex items-center gap-1 text-[13px] text-gray-500 whitespace-nowrap'
              }
            >
              <CalendarClock size={10} />
              {formatDeadline(cardDeadline)}（{cardDeadlineStatus.text}）
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
        )}

      </div>

      {/* 按鈕與「按錯了」連結包成同一欄：電腦版精簡卡把這一欄放在右側固定寬度。
          手機版這層 div 的 space-y-3 跟外層一樣，間距不變。 */}
      <div className={rowOnDesktop ? 'space-y-3 lg:w-52 lg:shrink-0' : 'space-y-3'}>
      <FlowSteps asset={asset} busy={busy} onAdvance={onAdvance} onUpload={onUpload} compact={compact} />

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

export default function EditorAssetQueue({
  userProfile, mode = 'queue', jumpToVendorId, onJumpConsumed, onOpenAllAssets,
}: {
  userProfile: UserProfile | null;
  /**
   * 'queue'＝「我的剪輯任務」：照上片日排好的清單，只回答「接下來剪什麼」。
   * 'list' ＝「我的所有片」：待剪／待上傳／已完成分區與批次上傳。
   * ⚠️ 2026-10-01 拆成兩個**獨立分頁**。以前是同一頁內切換，
   *    使用者實測：「要找我的剪輯任務就找不到，還要切回排好順序。」
   */
  mode?: 'queue' | 'list';
  /** 從「上片排程」點庫存標籤跳過來時要打開的 IP（只有 list 模式用得到） */
  jumpToVendorId?: string | null;
  onJumpConsumed?: () => void;
  /**
   * queue 模式下要把人帶去「我的所有片」。
   * 帶 vendorId 時那一頁會自動展開那個 IP（App 的 editorJumpVendorId → list 模式的 jumpToVendorId）。
   */
  onOpenAllAssets?: (vendorId?: string) => void;
}) {
  const vendorIds = userProfile?.assignedVendorIds || [];
  const vendorIdsKey = [...vendorIds].sort().join(',');

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [bookings, setBookings] = useState<ShootBooking[]>([]);
  const [slotMoves, setSlotMoves] = useState<PlannedSlotMove[]>([]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);
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
  // ⚠️ 不要再把兩個畫面做成頁內切換 —— 它們現在是兩個獨立分頁，由 mode 決定要渲染哪一個。
  //    2026-10-01 之前拿掉的「IP 總覽」也不要加回來：排程清單天然跨 IP。
  /** 隊伍一次只攤開前幾支。三十張卡一次倒出來等於沒有排序 */
  const [queueExpanded, setQueueExpanded] = useState(false);
  const isDesktop = useIsDesktop();
  const previewCount = isDesktop ? QUEUE_PREVIEW_DESKTOP : QUEUE_PREVIEW;
  /** 尚未排上片日那一區是否展開 */
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  /** 隊伍頁裡「剪好了，還沒傳雲端」那一區是否展開 */
  const [showToUpload, setShowToUpload] = useState(false);
  /** 「已交片、等安排上片」那一區是否展開 */
  const [showStocked, setShowStocked] = useState(false);
  /** 「已經排好了」那一區是否展開（純對帳用） */
  const [showSettled, setShowSettled] = useState(false);
  // null＝使用者還沒自己選過，這時自動落在「有事要做」的那一頁，不要開在空白頁
  const [tab, setTab] = useState<Bucket | null>(null);
  // 總覽預設只列「有待辦」的 IP。沒事的那幾家收在一行後面 ——
  // 14 家裡常常一半寫著「目前沒有待辦」，卻跟有事的那幾家佔一樣大的版面。
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

  // 排程驅動需要的三份資料。寫法照 EditorSchedule.tsx —— 逐廠商查詢，
  // ⚠️ 剪輯師端**不可以**用未範圍限定的 collection 查詢，那會整條 permission-denied。
  useEffect(() => {
    if (vendorIds.length === 0) { setBookings([]); setSlotMoves([]); return; }
    const subscribe = <T,>(name: string, setter: (fn: (prev: T[]) => T[]) => void) =>
      vendorIds.map(vid => onSnapshot(
        query(collection(db, name), where('vendorId', '==', vid)),
        snap => setter(prev => [
          ...prev.filter((row: any) => row.vendorId !== vid),
          ...snap.docs.map(d => ({ id: d.id, ...d.data() } as T)),
        ])
      ));
    const unsubs = [
      ...subscribe<ShootBooking>('shootBookings', setBookings),
      // 小編把預排拖到別天的紀錄。沒有它，剪輯師看到的日子會停在被拖走前的舊位置。
      ...subscribe<PlannedSlotMove>('plannedSlotMoves', setSlotMoves),
    ];
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  useEffect(() => {
    // dismissedHabits 沒有 vendorId 範圍，規則對所有登入者開放讀
    const unsub = onSnapshot(collection(db, 'dismissedHabits'), snap => {
      setDismissedHabits(snap.docs.map(d => ({ id: d.id, ...d.data() } as DismissedHabit)));
    });
    return () => unsub();
  }, []);

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
    // 內部自己剪的片不進任何外包剪輯師的待辦。
    // ⚠️ 這條一定要有：editorId 空的片本來是「每個被指派這家 IP 的人都看得到」。
    !a.internalEdit &&
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

  /**
   * 跨 IP 的一條隊伍：**只有待剪（原始素材）、而且同事排過上片日的**。
   *
   * 排序只有兩條，簡單到剪輯師看一眼就知道為什麼是這個順序：
   *   1. 急件最前
   *   2. 其餘照上片日由近到遠
   *
   * ⚠️ **刻意不用 sortFlowColumn。** 那支是寫給「製作進度看板」的，主軸是「卡多久」，
   *    上片日只有在逾期或三天內才加分。結果是一支沒排上片日、卡 20 天的片（1000+20）
   *    會壓在排在十天後的片（weight 2）上面 —— 2026-10-01 實測就是這樣排錯的。
   *    隊伍的主軸跟看板正好相反，兩邊不能共用同一支排序。
   * ⚠️ 已經交片送審／待上傳雲端的不進隊伍：隊伍回答的是「先剪哪一支」，
   *    剪完的片留在上面只會佔位置。它們改用底下那一行提示帶過去。
   */
  const queuePending = displayed.filter(a => bucketOf(a) === 'to_edit');

  /**
   * 排程驅動的清單：一列＝社群日曆上的一格（哪天哪個 IP 要上片）。
   *
   * ⚠️ 配對一律在「今天起 SUPPLY_HORIZON_DAYS 天」這個**固定視窗**上算，
   *    跟小編的上片排程表、剪輯師的唯讀日曆用同一組入口，三個畫面對同一天才會講同一句話。
   */
  const queue = useMemo(() => {
    const now = new Date();
    const mine = visibleVendorsOf(vendors);
    const slots = listPlannedSlots({
      vendors: trackedVendors(mine),
      moves: slotMoves,
      dismissed: dismissedHabits,
      posts,
      rangeStart: now,
      rangeEnd: addDays(now, SUPPLY_HORIZON_DAYS),
      fulfilledWindowDays: 1,
    });
    // ⚠️ 只拿「哪天哪個 IP 要上片」這份需求，**不要**再叫 buildSupplyPlan —— 那支會把
    //    有成片庫存的格子判成「不用動手」，剪輯師手上的毛片就整列消失（連錯三版的原因）。
    const demands = buildHorizonDemands({ posts, slots, now });
    return buildEditorQueue({
      demands,
      pendingAssets: queuePending,
      // 已經剪好交出去、但還沒被排進任何貼文的片。它們補掉最近的上片日。
      // ⚠️ `!usedInPostId`：掛上貼文的片那一格早就被 demands 的 attachedAssetId 排除了，
      //    不濾掉會重複計算，把一天算成兩天有著落。
      deliveredAssets: displayed.filter(a => bucketOf(a) !== 'to_edit' && !a.usedInPostId),
    });
  }, [vendors, posts, slotMoves, dismissedHabits, queuePending, displayed]);

  const toEdit = inBucket('to_edit');
  const toUpload = inBucket('to_upload');
  // 隊伍頁（我的剪輯任務）用的版本：**不吃**「我的所有片」的 IP 篩選／搜尋／只看急件。
  // ⚠️ 兩個分頁是同一個元件、React 會沿用同一份 state：在「我的所有片」點了某個 IP 再切回來，
  //    隊伍頁的「要剪／剪好待傳」數字跟「剪好了，還沒傳雲端」那一區會被篩掉，看起來像片不見了。
  const queueToEdit = displayed.filter(a => bucketOf(a) === 'to_edit');
  const queueToUpload = sortFlowColumn(displayed.filter(a => bucketOf(a) === 'to_upload'), posts);
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

  const activeView: 'queue' | 'list' = mode;

  const openVendor = (vendorId: string) => {
    setVendorFilter(vendorId);
    // 回到「自動落在第一個有東西的分區」，否則會帶著上一家選過的分區進來、開在空白頁
    setTab(null);
  };

  // 從上片排程點「庫存有 N 支待剪」過來。直接落在那家 IP 的待剪分區，
  // 因為他點那個標籤就是想知道「是哪幾支」。
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
  /** `list` 省略時沿用分區清單；隊伍頁沒有分區，要把自己那一批傳進來 */
  const markUploadedBatch = async (list?: Asset[]) => {
    if (!auth.currentUser) return;
    const targets = (list ?? currentList).filter(a => selectedIds[a.id!]);
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

  // ── 隊伍頁的收合區。電腦版跟手機版擺的位置不同（見下方兩欄版面），
  //    所以抽成變數、兩處共用同一份，避免兩邊各改各的走樣。
  // 已交片、等安排上片
  const stockedBlock = (
    <>
          {/* 這幾天不缺片，缺的是排程 —— 而排程是小編的事，不是剪輯師的。
              老闆：「因為目前成片區已經有兩個，照理來說我會安排排程，但問題是我還沒安排」。

              ⚠️ **只列日期＋IP，不放素材卡、不放按鈕。**
              這些片同時也在下面「剪好待傳」那一區（他還要去按上傳），
              放卡片會變成同一支片在同一頁出現兩次、還有兩顆長得一樣的按鈕。
              這一區只回答一句話：這幾天不用你操心。 */}
          {queue.stocked.length > 0 && (
            <>
              <FoldHeader
                open={showStocked}
                title="已交片、等安排上片"
                hint="這幾天已經有剪好的片，等同事排程。不用你動手。"
                count={queue.stocked.length}
                unit="天"
                onToggle={() => setShowStocked(v => !v)}
              />
              {showStocked && (
                <div className="rounded-2xl bg-white/60 border border-dashed border-black/10 divide-y divide-black/5">
                  {queue.stocked.map(row => (
                    <FoldDayRow key={row.key} row={row} vendorName={vendorName(row.vendorId)} />
                  ))}
                </div>
              )}
            </>
          )}
    </>
  );
  // 已經排好了（對帳用）
  const settledBlock = (
    <>
          {/* 已經掛好素材、整件事結案的那幾天。
              ⚠️ 剪輯師不需要這一區，它存在的唯一理由是**能跟社群日曆對帳**。
              老闆 2026-10-02：「我應該 10/3 有排程，但為什麼都對不上…我就是很不放心」。
              在這之前這些天被整個藏掉，日曆上 5 筆、清單只看得到 2 筆，看起來就像漏算。 */}
          {queue.settled.length > 0 && (
            <>
              <FoldHeader
                open={showSettled}
                title="已經排好了"
                hint="貼文跟片都配好了，列在這裡只是讓你能跟社群日曆對一下。"
                count={queue.settled.length}
                unit="天"
                onToggle={() => setShowSettled(v => !v)}
              />
              {showSettled && (
                <div className="rounded-2xl bg-white/60 border border-dashed border-black/10 divide-y divide-black/5">
                  {queue.settled.map(row => (
                    <FoldDayRow key={row.key} row={row} vendorName={vendorName(row.vendorId)} />
                  ))}
                </div>
              )}
            </>
          )}
    </>
  );
  // 剪好了，還沒傳雲端
  const toUploadBlock = (
    <>
          {/* 已交片等上傳的不進清單，但不能讓它們無聲消失 ——
              沒有這一區，剪輯師在預設畫面上永遠看不到待上傳，交了片就忘了傳。

              ⚠️ 2026-10-02 從「跳到我的所有片」的按鈕改成**就地展開**。
              使用者原話：「頁面要切換很麻煩」。剪完→交片→傳雲端是同一條動線上的三步，
              前兩步在這一頁，第三步卻要換頁才做得到，等於每天都被迫跳一次。
              現在隊伍頁一頁就能走完，「我的所有片」退回成純查找用。 */}
          {queueToUpload.length > 0 && (
            <>
              <FoldHeader
                open={showToUpload}
                title="剪好了，還沒傳雲端"
                hint="檔案傳上雲端後按「上傳雲端」，不用等業主審完。"
                count={queueToUpload.length}
                tone="cloud"
                icon={<UploadCloud size={14} />}
                onToggle={() => setShowToUpload(v => !v)}
              />

              {showToUpload && (
                <div className="rounded-2xl bg-sky-50/70 border border-sky-200 p-3 space-y-3">
                  {/* 批次列：選了才出現。預設不預先全選 —— 一次改幾十支應該是他主動選的 */}
                  <div className="flex items-center justify-between gap-3 flex-wrap px-1">
                    <button
                      type="button"
                      onClick={() => {
                        const allSelected = queueToUpload.every(a => selectedIds[a.id!]);
                        const next = { ...selectedIds };
                        for (const a of queueToUpload) next[a.id!] = !allSelected;
                        setSelectedIds(next);
                      }}
                      className="text-[13px] font-bold text-sky-800 hover:text-sky-900"
                    >
                      {queueToUpload.every(a => selectedIds[a.id!]) ? '取消全選' : `選取這 ${queueToUpload.length} 支`}
                    </button>
                    {queueToUpload.filter(a => selectedIds[a.id!]).length > 0 && (
                      <button
                        type="button"
                        disabled={batchBusy}
                        onClick={() => markUploadedBatch(queueToUpload)}
                        className="px-4 py-2 rounded-xl bg-[#5A5A40] text-white text-[13px] font-bold disabled:opacity-50"
                      >
                        {batchBusy
                          ? '處理中…'
                          : `把選取的 ${queueToUpload.filter(a => selectedIds[a.id!]).length} 支標記已上傳`}
                      </button>
                    )}
                  </div>
                  <div className="space-y-3">
                    {queueToUpload.map(a => (
                      <div key={a.id} className="bg-white rounded-2xl border border-black/5 overflow-hidden">
                        {/* compact：跟上面的隊伍同一頁，就要長得像同一頁。
                            拿掉「停留 N 天」紅字（這一區每張都紅＝沒有在警告任何事）與拍攝日，
                            片名放大成主角。完整履歷留在「我的所有片」。 */}
                        <AssetCard
                          {...cardProps(a)}
                          compact
                          onUpload={() => markUploaded(a)}
                          onUndoSubmit={() => undoSubmit(a)}
                          onUndoUpload={() => undoUploaded(a)}
                          showClientBadge
                          stacked
                          selected={!!selectedIds[a.id!]}
                          onToggleSelect={() => setSelectedIds(prev => ({ ...prev, [a.id!]: !prev[a.id!] }))}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
    </>
  );
  // 還沒排到上片日
  const unassignedBlock = (
    <>
          {/* 庫存比格子多出來的片。藏起來會讓剪輯師以為沒事做，所以收合而不是拿掉。 */}
          {queue.unassigned.length > 0 && (
            <>
              <FoldHeader
                open={showUnscheduled}
                title="還沒排到上片日"
                hint="手上有這幾支，但接下來的日子已經排滿了。"
                count={queue.unassigned.length}
                onToggle={() => setShowUnscheduled(v => !v)}
              />
              {showUnscheduled && (
                <div className="space-y-3">
                  {queue.unassigned.map(a => (
                    <div key={a.id} className="bg-white/70 rounded-2xl border border-black/5 overflow-hidden">
                      <AssetCard {...cardProps(a)} compact onAdvance={() => advance(a)} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
    </>
  );
  // 到「我的所有片」的出口
  const allAssetsLink = (
    <>
          {/* 「我的所有片」退成純查找用（搜尋片名、翻已完成）。
              日常動線不需要它，但要留一個出口，不然想找舊片的人會卡住。
              ⚠️ 擺在全部收合區的最後面 —— 夾在中間會把那幾區切開，看起來像兩群不相干的東西。 */}
          {onOpenAllAssets && (
            <button
              type="button"
              onClick={() => onOpenAllAssets()}
              className="w-full py-2.5 rounded-2xl text-[13px] text-gray-500 hover:text-[#5A5A40]"
            >
              想找某一支舊片？到「我的所有片」搜尋
            </button>
          )}
    </>
  );

  return (
    // readability-surface：手機點擊區 44px、桌面 24px、輸入框 16px（避免 iOS 自動放大整頁）。
    // 規則寫在 index.css，是 opt-in 的，掛在哪一頁就只影響那一頁。
    <div className="readability-surface space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          {/* 兩個分頁共用這支元件，標題要跟側邊欄那一項一模一樣，
              不然人點了「我的所有片」卻看到「我的剪輯任務」會以為點錯 */}
          <h2 className="text-xl font-bold serif text-[#5A5A40] flex items-center gap-2">
            {activeView === 'queue'
              ? <><Scissors size={20} /> 我的剪輯任務</>
              : <><Film size={20} /> 我的所有片</>}
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {activeView === 'queue'
              // ⚠️ 陳述句，不要祈使句。「從上面開始剪」等於系統在派工，
              //    而派工是同事在做的事（見 feedback_editor_facing_wording）。
              ? '照交片期限排好，最近的在最上面。'
              : '手上全部的片。剪完按「交片送審」；檔案傳上雲端後就按「上傳雲端」，不用等我們通知。'}
          </p>
        </div>
        <div className={`flex items-center gap-2 shrink-0 ${activeView === 'queue' ? 'lg:hidden' : ''}`}>
          {/* ⚠️ 數字要對得上同一頁看得到的東西。
              原本只有一個「待處理 61 支」＝待剪＋待上傳相加，但畫面上沒有任何一處是 61，
              剪輯師無從核對。拆成兩個，各自對應下面的清單與區塊。 */}
          {/* list 模式底下本來就有「待剪／待上傳雲端／已完成」三張大卡，這裡再放一次是重複 */}
          {activeView === 'queue' && (
            <>
              <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm">
                <p className="text-[13px] font-bold text-gray-500 whitespace-nowrap">要剪</p>
                <p className="text-lg font-bold leading-none text-[#5A5A40]">
                  {queueToEdit.length} <span className="text-sm font-normal text-gray-500">支</span>
                </p>
              </div>
              <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm">
                <p className="text-[13px] font-bold text-gray-500 whitespace-nowrap">剪好待傳</p>
                <p className="text-lg font-bold leading-none text-[#5A5A40]">
                  {queueToUpload.length} <span className="text-sm font-normal text-gray-500">支</span>
                </p>
              </div>
            </>
          )}
          <div className="bg-white px-4 py-2 rounded-2xl border border-sky-200 shadow-sm">
            <p className="text-[13px] font-bold text-gray-500">本月已上傳</p>
            <p className="text-lg font-bold leading-none text-sky-700">
              {uploadedThisMonth} <span className="text-sm font-normal text-gray-500">支</span>
            </p>
          </div>
        </div>
      </div>

      {activeView === 'queue' && (
        // 電腦版兩欄：左邊只回答「接下來剪什麼」，右邊固定側欄回答「還有什麼要按、對不對得上」。
        // ⚠️ 2026-10-03 老闆：四個收合區都藏在最底下不直觀，放上面又會干擾。
        //    電腦版把「剪好待傳」與兩個對帳區搬到右欄；「還沒排到上片日」接在清單尾巴。
        //    手機版（lg 以下）維持原本由上往下的順序不變。
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6 lg:items-start">
          <div className="space-y-4 min-w-0">
          {/* 剪輯師是外包，不熟我們的後台。整套流程只有三步，一行講完就不用再問誰。
              ⚠️ 講的是「按鈕在哪、按了會怎樣」，不是「你該剪哪一支」—— 後者是同事的事。 */}
          <p className="text-[13px] text-gray-500 bg-black/[0.03] rounded-2xl px-4 py-2.5 leading-relaxed">
            剪完按<span className="font-bold text-[#5A5A40]">「交片送審」</span>，我們會拿去給業主看；
            檔案傳上雲端後再按<span className="font-bold text-[#5A5A40]">「上傳雲端」</span>。
            兩步都在這一頁。
          </p>

          {queue.rows.length === 0 ? (
            <p className="text-center text-sm text-gray-500 py-10">
              接下來沒有要上的片，手上也沒有待剪的。
            </p>
          ) : (
            <div className="space-y-3">
              {(queueExpanded ? queue.rows : queue.rows.slice(0, previewCount)).map(row => (
                <QueueRow
                  key={row.key}
                  row={row}
                  vendorName={vendorName(row.vendorId)}
                  onOpenLibrary={
                    // 只有那個 IP 在「我的所有片」裡真的有東西才給連結
                    onOpenAllAssets && displayed.some(a => a.vendorId === row.vendorId)
                      ? () => onOpenAllAssets(row.vendorId)
                      : undefined
                  }
                  card={row.asset ? (
                    <AssetCard {...cardProps(row.asset)} compact hideUrgentBadge onAdvance={() => advance(row.asset!)} />
                  ) : null}
                />
              ))}
            </div>
          )}

          {queue.rows.length > previewCount && (
            <button
              type="button"
              onClick={() => setQueueExpanded(v => !v)}
              className="w-full py-2.5 rounded-2xl text-[13px] font-bold text-gray-500 hover:text-[#5A5A40]"
            >
              {queueExpanded
                ? `收起後面 ${queue.rows.length - previewCount} 筆`
                : `後面還有 ${queue.rows.length - previewCount} 筆`}
            </button>
          )}

            {/* 手機版：這三區照原本順序排在清單下面。電腦版在右欄，這裡隱藏。 */}
            <div className="space-y-4 lg:hidden">
              {stockedBlock}
              {settledBlock}
              {toUploadBlock}
            </div>
            {unassignedBlock}
            {allAssetsLink}
          </div>

          <aside className="hidden lg:block lg:sticky lg:top-4 space-y-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            {/* 標題列那組數字在電腦版搬到這裡（標題列那組在 lg 隱藏） */}
            <div className="bg-white rounded-2xl border border-black/5 shadow-sm grid grid-cols-3 divide-x divide-black/5">
              {[
                { label: '要剪', value: queueToEdit.length, tone: 'text-[#5A5A40]' },
                { label: '剪好待傳', value: queueToUpload.length, tone: 'text-sky-700' },
                { label: '本月已上傳', value: uploadedThisMonth, tone: 'text-sky-700' },
              ].map(s => (
                <div key={s.label} className="px-2 py-3 text-center">
                  <p className="text-sm font-bold text-gray-500 whitespace-nowrap">{s.label}</p>
                  <p className={`text-xl font-bold leading-tight ${s.tone}`}>
                    {s.value} <span className="text-sm font-normal text-gray-500">支</span>
                  </p>
                </div>
              ))}
            </div>
            {/* 還要他動手的（而且跟請款有關）放最上面 */}
            {toUploadBlock}
            {(queue.stocked.length > 0 || queue.settled.length > 0) && (
              <p className="text-sm font-bold text-gray-500 px-1 pt-2">對帳用 · 不用動手</p>
            )}
            {stockedBlock}
            {settledBlock}
          </aside>
        </div>
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
