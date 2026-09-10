import { addDays, format, parseISO, startOfDay } from 'date-fns';
import { Asset, Post, ShootBooking, deriveFlowStage } from '../types';
import { buildPostIndex, isAssetSelectable, PostIndex } from './vendorStatus';
import { PlannedSlot } from './plannedSlots';

/**
 * 「這一格排程，素材從哪裡來」的唯一計算入口。
 *
 * 上片排程表原本只回答「幾號要發」，剪輯師拿到圖看不出那一格要不要他動手：
 * 需求（貼文／預排時段）在社群日曆這邊，供給（待剪素材、成片庫存、預約拍攝）
 * 在素材庫與拍攝進度那邊，兩邊從來沒有接起來。這支就是那條接線。
 *
 * ⚠️ 這裡只做「配對」，不碰任何庫存/欠片公式。庫存要算幾支一律走 vendorStatus，
 *    不要在這裡另外數一份 —— 那正是月報踩過的「兩處各算一份而對不起來」。
 */

/**
 * 素材狀態只判斷「從今天起這麼多天」內的格子，範圍固定，**不隨畫面上顯示的區間改變**。
 *
 * ⚠️ 這是「剪輯師看到的」與「小編導出的」不會互相打架的關鍵。
 *    如果配對只在各自顯示的區間內做，同一天在「導出下週」與「剪輯師看整個月」
 *    會得到不同答案（月曆多算了前面幾格，庫存更早被吃完 → 同一格一邊寫「庫存有4支待剪」、
 *    一邊寫「還沒有片」）。同一件事兩個答案，這張表就沒人敢信。
 *    所以配對一律在同一個固定視窗上做，畫面只是決定「顯示哪幾格」。
 *
 * 28 天＝四週，剛好蓋住「下週／下下週要拍什麼」這個實際用途。
 * 超出這個範圍的格子不給答案（顯示「—」）：那麼遠的片本來就預期由還沒發生的拍攝供應，
 * 硬要判斷只會整片變紅色警告，把真正近期的缺口淹掉。
 */
export const SUPPLY_HORIZON_DAYS = 28;

/** 配對視窗：今天起算 SUPPLY_HORIZON_DAYS 天（含今天）。過去的日子不判斷素材狀態。 */
export function getSupplyHorizon(now: Date = new Date()): { start: Date; end: Date } {
  const start = startOfDay(now);
  return { start, end: addDays(start, SUPPLY_HORIZON_DAYS - 1) };
}

/**
 * 需求的識別碼。兩個畫面都必須用這一組產生，配對結果才對得上 ——
 * 各自組字串的話，只要有一邊多帶了顯示用的日期，查表就會全部落空而靜靜顯示「—」。
 */
export function postDemandId(postId: string): string {
  return `post_${postId}`;
}

export function slotDemandId(slot: Pick<PlannedSlot, 'vendorId' | 'time' | 'fromDate'>): string {
  // 用 fromDate（時段的身分證）而不是它現在落在哪天：被拖到別天之後仍然是同一格
  return `slot_${slot.vendorId}_${slot.time}_${slot.fromDate}`;
}

/**
 * 把貼文與預排時段轉成配對用的需求清單。
 *
 * ⚠️ 這裡刻意**不吃**畫面上的篩選（影片/圖文、選了哪幾個 IP）：庫存夠不夠是客觀事實，
 *    不該因為小編把「圖文」的勾勾拿掉就變得比較充裕。篩選只影響顯示。
 */
export function buildHorizonDemands(opts: { posts: Post[]; slots: PlannedSlot[]; now?: Date }): DemandItem[] {
  const { start, end } = getSupplyHorizon(opts.now);
  const demands: DemandItem[] = [];

  for (const post of opts.posts) {
    if (!post.scheduledAt) continue;
    const date = startOfDay(parseISO(post.scheduledAt));
    if (date < start || date > end) continue;
    const hasAsset = post.assetId && post.assetId !== 'to_be_added';
    demands.push({
      id: postDemandId(post.id!),
      vendorId: post.vendorId,
      date: parseISO(post.scheduledAt),
      contentType: post.contentType === 'post' ? 'post' : 'video',
      attachedAssetId: hasAsset ? post.assetId! : undefined,
    });
  }

  for (const slot of opts.slots) {
    const date = startOfDay(slot.date);
    if (date < start || date > end) continue;
    demands.push({
      id: slotDemandId(slot),
      vendorId: slot.vendorId,
      date: slot.date,
      contentType: slot.habit.contentTypes?.[0] === 'post' ? 'post' : 'video',
    });
  }

  return demands;
}

export type SupplyKind =
  | 'attached'    // 這格已經指定好素材了
  | 'ready'       // 有成片庫存可以直接排
  | 'in_progress' // 剪輯師已交片，審核中／待上傳雲端
  | 'to_edit'     // 有待剪素材 —— 這格要剪輯師動手
  | 'booked'      // 沒庫存，但預約拍攝日在上片日之前
  | 'booked_late' // 有預約，但排在上片日之後，這格趕不上
  | 'none'        // 沒庫存也沒預約
  | 'not_video';  // 圖文，不吃影片庫存

/** 一格「幾號要上片」的需求。貼文與日曆上的橘色預排都轉成這個形狀。 */
export interface DemandItem {
  id: string;
  vendorId: string;
  /** 這格要上片的那一天 */
  date: Date;
  contentType: 'video' | 'post';
  /** 已經掛在這格上的素材 id（有值就不會再去吃庫存） */
  attachedAssetId?: string;
}

export interface SupplyAssignment {
  kind: SupplyKind;
  /** ready / in_progress / to_edit 時，配到的是哪一支 */
  assetId?: string;
  assetTitle?: string;
  /** booked / booked_late 時的預約拍攝日 YYYY-MM-DD */
  bookingDate?: string;
  /** 預約日已經過了但還沒回報完成 —— 料其實還沒到 */
  bookingOverdue?: boolean;
  /**
   * 這家 IP 的待剪庫存總支數（to_edit 才有）。
   * ⚠️ 刻意是**固定的總數**，不是「配到這格時還剩幾支」：表格上方的彙總寫「等剪輯 4 支」，
   *    同一張圖裡兩個地方寫不同數字，這張表就沒人敢信了。
   *    夠不夠用不是靠這個數字表達，是靠後面的格子變成「還沒有片」。
   */
  stockCount?: number;
}

export interface VendorStockSummary {
  vendorId: string;
  ready: number;       // 成片庫存（小編可直接排）
  inProgress: number;  // 已交片，業主審核中／待上傳雲端
  toEdit: number;      // 待剪（球在剪輯師）
  nextBookingDate: string | null;
  nextBookingOverdue: boolean;
}

export interface SupplyPlan {
  /** demand.id → 這格的素材來源 */
  assignments: Map<string, SupplyAssignment>;
  /** vendorId → 這家的庫存與預約概況（表格上方的彙總列） */
  stock: Map<string, VendorStockSummary>;
}

interface VendorPool {
  ready: Asset[];
  inProgress: Asset[];
  toEdit: Asset[];
  bookings: { date: string; overdue: boolean }[];
}

/**
 * 排隊順序：急件優先，其次先建立的先出。
 * 用「先進先出」而不是隨資料庫回傳順序，是為了讓同一份排程表重跑兩次得到同一張圖 ——
 * 剪輯師會拿它跟上週的對照，順序每次都跳等於這張表不能信。
 */
function queueOrder(a: Asset, b: Asset): number {
  if (!!a.isUrgent !== !!b.isUrgent) return a.isUrgent ? -1 : 1;
  return (a.createdAt || '').localeCompare(b.createdAt || '');
}

/**
 * 分池。
 *
 * ⚠️ 這裡用 isAssetSelectable() 而**不是** isAssetFree()：兩者對「掛在草稿貼文上的片」
 *    答案剛好相反（見 vendorStatus 那兩個函式的註解）。掛草稿的片在這張表上會以
 *    「那則草稿貼文自己那一列」出現，若這裡再用 isAssetFree 把它算回池子，
 *    同一支片會同時填掉兩格，整張表就開始騙人。
 */
function buildPools(
  assets: Asset[],
  index: PostIndex,
  bookings: ShootBooking[],
  today: string
): Map<string, VendorPool> {
  const pools = new Map<string, VendorPool>();
  const ensure = (vendorId: string): VendorPool => {
    let pool = pools.get(vendorId);
    if (!pool) {
      pool = { ready: [], inProgress: [], toEdit: [], bookings: [] };
      pools.set(vendorId, pool);
    }
    return pool;
  };

  for (const asset of assets) {
    if (asset.type !== 'video') continue;
    if (!isAssetSelectable(asset, index)) continue;
    const pool = ensure(asset.vendorId);
    const stage = deriveFlowStage(asset);
    if (stage === 'ready') pool.ready.push(asset);
    else if (stage === 'client_review' || stage === 'to_upload') pool.inProgress.push(asset);
    else pool.toEdit.push(asset); // to_edit / revising
  }

  for (const booking of bookings) {
    // 只認還沒結案的預約：completed 的料已經變成素材躺在池子裡，
    // 再算一次等於同一次拍攝被算兩遍；postponed/cancelled 則是根本不會發生。
    if (booking.status !== 'booked') continue;
    ensure(booking.vendorId).bookings.push({
      date: booking.scheduledDate,
      overdue: booking.scheduledDate < today,
    });
  }

  for (const pool of pools.values()) {
    pool.ready.sort(queueOrder);
    pool.inProgress.sort(queueOrder);
    pool.toEdit.sort(queueOrder);
    pool.bookings.sort((a, b) => a.date.localeCompare(b.date));
  }

  return pools;
}

export interface SupplyPlanOptions {
  demands: DemandItem[];
  assets: Asset[];
  posts: Pick<Post, 'id' | 'status'>[];
  bookings: ShootBooking[];
  now?: Date;
}

/**
 * 把每一格排程配上它的素材來源。
 *
 * 配對順序：成片庫存 → 已交片(審核中/待上傳) → 待剪素材 → 預約拍攝 → 沒有。
 * 依上片日由近到遠配，所以最近要發的那格會拿到現成的片，剪輯師的截止日
 * 自然落在後面幾格 —— 這也是下一輪剪輯師後台要顯示的「這支預計上片 MM/DD」。
 *
 * ⚠️ 預約拍攝**不**從池子扣掉：一次拍攝到底產出幾支，系統沒有這個資料。
 *    硬給一個數字會讓「還缺幾支」變成憑空捏造，寧可只回答「那天拍完才有料」。
 */
export function buildSupplyPlan(opts: SupplyPlanOptions): SupplyPlan {
  const { demands, assets, posts, bookings } = opts;
  const now = opts.now ?? new Date();
  const today = format(now, 'yyyy-MM-dd');

  const index = buildPostIndex(posts);
  const pools = buildPools(assets, index, bookings, today);

  const assignments = new Map<string, SupplyAssignment>();

  const byVendor = new Map<string, DemandItem[]>();
  for (const demand of demands) {
    const list = byVendor.get(demand.vendorId);
    if (list) list.push(demand);
    else byVendor.set(demand.vendorId, [demand]);
  }

  for (const [vendorId, list] of byVendor) {
    const pool = pools.get(vendorId);
    const ready = [...(pool?.ready || [])];
    const inProgress = [...(pool?.inProgress || [])];
    const toEdit = [...(pool?.toEdit || [])];
    const vendorBookings = pool?.bookings || [];

    const ordered = [...list].sort((a, b) => a.date.getTime() - b.date.getTime());

    for (const demand of ordered) {
      if (demand.attachedAssetId) {
        assignments.set(demand.id, { kind: 'attached' });
        continue;
      }
      if (demand.contentType !== 'video') {
        assignments.set(demand.id, { kind: 'not_video' });
        continue;
      }

      const picked =
        (ready.length && { kind: 'ready' as const, asset: ready.shift()! }) ||
        (inProgress.length && { kind: 'in_progress' as const, asset: inProgress.shift()! }) ||
        (toEdit.length && { kind: 'to_edit' as const, asset: toEdit.shift()! }) ||
        null;

      if (picked) {
        assignments.set(demand.id, {
          kind: picked.kind,
          assetId: picked.asset.id,
          assetTitle: picked.asset.title,
          stockCount: pool?.toEdit.length,
        });
        continue;
      }

      const demandDate = format(startOfDay(demand.date), 'yyyy-MM-dd');
      // 趕不趕得上只比日期，不自行加剪輯工期的緩衝天數 ——
      // 系統沒有工期資料，猜一個天數只會製造假警報。
      const inTime = vendorBookings.find(b => b.date <= demandDate);
      const later = vendorBookings.find(b => b.date > demandDate);

      if (inTime) {
        assignments.set(demand.id, { kind: 'booked', bookingDate: inTime.date, bookingOverdue: inTime.overdue });
      } else if (later) {
        assignments.set(demand.id, { kind: 'booked_late', bookingDate: later.date });
      } else {
        assignments.set(demand.id, { kind: 'none' });
      }
    }
  }

  const stock = new Map<string, VendorStockSummary>();
  for (const [vendorId, pool] of pools) {
    const next = pool.bookings[0] || null;
    stock.set(vendorId, {
      vendorId,
      ready: pool.ready.length,
      inProgress: pool.inProgress.length,
      toEdit: pool.toEdit.length,
      nextBookingDate: next?.date || null,
      nextBookingOverdue: !!next?.overdue,
    });
  }
  // 完全沒有素材也沒有預約的廠商在 pools 裡不存在，但表上仍會有它的空格，
  // 彙總列少一行會讓人以為「沒問題」，所以補成全 0 的一筆。
  for (const vendorId of byVendor.keys()) {
    if (!stock.has(vendorId)) {
      stock.set(vendorId, { vendorId, ready: 0, inProgress: 0, toEdit: 0, nextBookingDate: null, nextBookingOverdue: false });
    }
  }

  return { assignments, stock };
}

/**
 * 這格的素材來源要怎麼寫在表上。
 *
 * ⚠️ **系統只回報庫存狀態，不指派工作。** 第一版寫「你要剪」「不用剪」，使用者指正：
 *    「要剪的是我同事分配，不是系統也不是我。」祈使句等於系統在派工，那是人在做的事。
 *    一律用敘述句講「現在有什麼料」。
 * ⚠️ **不要在某一格接某一支片名。** 那等於系統自己把那支片配給那一天，而那個配對
 *    根本不存在（誰剪哪一支是同事人工分配的）。只回報支數。
 * ⚠️ 「已指定素材」與「有成片庫存」對看表的人是同一件事（片已經有了），刻意不分。
 */
export function describeSupply(assignment: SupplyAssignment | undefined): {
  label: string;
  detail?: string;
  tone: 'editor' | 'waiting' | 'alert' | 'idle';
} {
  if (!assignment) return { label: '—', tone: 'idle' };

  const md = (date?: string) => (date ? format(parseISO(date), 'MM/dd') : '');

  switch (assignment.kind) {
    case 'attached':
    case 'ready':
      return { label: '已有成片', tone: 'idle' };
    case 'in_progress':
      return { label: '等業主審', tone: 'waiting' };
    case 'to_edit':
      return { label: `庫存有 ${assignment.stockCount ?? 1} 支待剪`, tone: 'editor' };
    case 'booked':
      return assignment.bookingOverdue
        ? { label: `等 ${md(assignment.bookingDate)} 拍攝`, detail: '預約日已過，還沒回報拍完', tone: 'alert' }
        : { label: `等 ${md(assignment.bookingDate)} 拍攝`, tone: 'waiting' };
    case 'booked_late':
      return { label: '趕不上', detail: `拍攝排在 ${md(assignment.bookingDate)}`, tone: 'alert' };
    case 'none':
      return { label: '還沒有片', tone: 'alert' };
    case 'not_video':
    default:
      return { label: '—', tone: 'idle' };
  }
}
