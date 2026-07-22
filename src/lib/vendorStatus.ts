import { format } from 'date-fns';
import { Vendor, Asset, Post } from '../types';

// 該廠商在指定月份的「有效影音目標」= 月目標 + 該月所有加贈/扣片調整加總（不影響其他月份，月份一過自動失效）
// 合作起始月之前一律回傳0：新客戶還沒開始拍，不該有任何目標/欠片
export function getEffectiveMonthlyTarget(
  vendor: Pick<Vendor, 'monthlyTargetVideos' | 'monthlyAdjustments' | 'cooperationStartMonth'>,
  month: string
): number {
  if (vendor.cooperationStartMonth && month < vendor.cooperationStartMonth) return 0;
  const base = vendor.monthlyTargetVideos || 0;
  const delta = (vendor.monthlyAdjustments || [])
    .filter(a => a.month === month)
    .reduce((sum, a) => sum + (a.videoDelta || 0), 0);
  return Math.max(0, base + delta);
}

export type EffectiveVendorStatus = 'active' | 'paused' | 'ended';

// 冷凍期到期即視為 active，不需要寫回資料庫
export function getEffectiveVendorStatus(vendor: Pick<Vendor, 'status' | 'pausedUntil'>): EffectiveVendorStatus {
  if (vendor.status === 'ended') return 'ended';
  if (vendor.status === 'paused') {
    const today = format(new Date(), 'yyyy-MM-dd');
    if (vendor.pausedUntil && vendor.pausedUntil <= today) return 'active';
    return 'paused';
  }
  return 'active';
}

// 前端列表/選單用：排除已終止，冷凍中仍可見可選
export function visibleVendors(vendors: Vendor[]): Vendor[] {
  return vendors.filter(v => getEffectiveVendorStatus(v) !== 'ended');
}

// 目標/欠片/提醒追蹤用：排除已終止、冷凍中，以及手動標記「不列入統計」的廠商（如內部帳號）
export function trackedVendors(vendors: Vendor[]): Vendor[] {
  return vendors.filter(v => getEffectiveVendorStatus(v) === 'active' && !v.excludeFromStats);
}

// 冷凍區間是否跟指定月份有重疊；抽出來共用，isVendorTrackedInMonth 跟 getWeeklyPace 都要用同一套判斷，
// 不然會出現「這個月不列入欠片統計，但撐幾天/催片提醒卻還是照正常節奏算」的自相矛盾
function pauseOverlapsMonth(pauseHistory: Pick<Vendor, 'pauseHistory'>['pauseHistory'], month: string): boolean {
  const monthStart = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const monthEnd = format(new Date(y, m, 0), 'yyyy-MM-dd'); // 該月最後一天

  return (pauseHistory || []).some(rec => {
    const from = rec.from;
    const until = rec.until || '9999-12-31'; // 尚未恢復＝視為持續到未來
    // until 是「恢復日」本身已經算active，所以要嚴格大於月初才算還在冷凍區間內
    return from <= monthEnd && until > monthStart;
  });
}

// 針對「特定月份」判斷該廠商是否要計入目標/欠片統計：
// 只要 pauseHistory 裡任一段冷凍區間與該月有重疊，這個月就整月排除（不論當下即時 status 是否已恢復）
// 合作起始月之前也整月排除（新客戶還沒開始合作）
export function isVendorTrackedInMonth(vendor: Pick<Vendor, 'status' | 'excludeFromStats' | 'pauseHistory' | 'cooperationStartMonth'>, month: string): boolean {
  if (vendor.status === 'ended') return false;
  if (vendor.excludeFromStats) return false;
  if (vendor.cooperationStartMonth && month < vendor.cooperationStartMonth) return false;
  return !pauseOverlapsMonth(vendor.pauseHistory, month);
}

// 目標/欠片統計用（可指定月份版）：排除已終止、該月落在冷凍區間內、以及「不列入統計」的廠商
export function trackedVendorsForMonth(vendors: Vendor[], month: string): Vendor[] {
  return vendors.filter(v => isVendorTrackedInMonth(v, month));
}

// 判斷廠商「結構上」該不該出現在拍攝進度／欠片管理清單：沒終止合作 + 沒被排除統計 + 本來就有設定影音目標 + 合作關係已經開始，
// 不管現在是不是冷凍中（包含還沒解凍、正在冷凍中的廠商）。
// 跟 isVendorTrackedInMonth / trackedVendors 的差別：那兩個都會用「現在即時 status」把冷凍中的廠商整批擋掉，
// 但冷凍中如果之前留有欠片，一樣要看得到、要能繼續管理/沖銷，不能因為還沒解凍就從清單消失；
// 「這個月」本身不會疊加新短缺的邏輯在 getDeficitBreakdown 內部已經正確處理（用 isVendorTrackedInMonth 判斷）。
export function hasVideoTrackingScope(vendor: Pick<Vendor, 'status' | 'excludeFromStats' | 'monthlyTargetVideos' | 'cooperationStartMonth'>, month: string): boolean {
  if (vendor.status === 'ended') return false;
  if (vendor.excludeFromStats) return false;
  if ((vendor.monthlyTargetVideos || 0) <= 0) return false;
  if (vendor.cooperationStartMonth && month < vendor.cooperationStartMonth) return false;
  return true;
}

// 庫存警戒天數：低於這個天數就視為需要提醒盡快預約拍片
export const LOW_STOCK_RUNWAY_DAYS = 14;

// 自然月切4段，每段7天，第4段吸收月底剩餘天數（不處理跨月/合約週期，維持簡單）
export function getMonthWeekBucket(date: Date): number {
  const dayOfMonth = date.getDate();
  return Math.min(4, Math.floor((dayOfMonth - 1) / 7) + 1);
}

// 該廠商在指定日期所屬區段的「每週目標支數」：有設定週分佈就用該段，沒有就用月目標平均攤提
// 合作起始月之前、或當下正在冷凍中，一律回傳0（沒開始合作/暫停合作，沒有節奏可言）——
// 不然會出現「這個月不列入欠片統計，但撐幾天/催片提醒卻還是照正常節奏算」的自相矛盾
export function getWeeklyPace(vendor: Pick<Vendor, 'weeklyPattern' | 'monthlyTargetVideos' | 'cooperationStartMonth' | 'pauseHistory'>, date: Date = new Date()): number {
  const month = format(date, 'yyyy-MM');
  if (vendor.cooperationStartMonth && month < vendor.cooperationStartMonth) return 0;
  if (pauseOverlapsMonth(vendor.pauseHistory, month)) return 0;
  const pattern = vendor.weeklyPattern;
  if (pattern && pattern.length === 4) {
    const bucket = getMonthWeekBucket(date);
    return pattern[bucket - 1] || 0;
  }
  return (vendor.monthlyTargetVideos || 0) / 4;
}

// 目前庫存量還能撐幾天；沒有設定任何發片目標時無法評估，回傳 null
export function getStockRunwayDays(vendor: Pick<Vendor, 'weeklyPattern' | 'monthlyTargetVideos' | 'cooperationStartMonth' | 'pauseHistory'>, stock: number, date: Date = new Date()): number | null {
  const weeklyPace = getWeeklyPace(vendor, date);
  if (weeklyPace <= 0) return null;
  return stock / (weeklyPace / 7);
}

// 列出 startMonth 到 endMonth（含頭尾）之間所有 YYYY-MM
function monthsBetweenInclusive(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  let [y, m] = startMonth.split('-').map(Number);
  const [endY, endM] = endMonth.split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export interface DeficitBreakdown {
  baseline: number; // 歷史債總額（deficitEntries 加總，或舊版 manualDeficitBaseline）
  monthlyShortfalls: { month: string; target: number; delivered: number; delta: number; expectedByNow?: number }[]; // 即時追蹤的月份短缺明細（從最後一筆明細的下個月起連續累加到現在，可能為負＝該月超額交付）；expectedByNow只有「進行中的當月」那筆會有值
  totalShortfall: number; // baseline + monthlyShortfalls 加總（還沒扣庫存）
  gapMonths: string[]; // 填過的月份「中間」還缺的月份（例如填了2月跟6月但漏了3~5月），純粹提醒還沒回填，不計入總數；最後一筆之後到現在的月份不算在這裡，那段是連續自動累加的
}

type OwedVendor = Pick<Vendor, 'id' | 'weeklyPattern' | 'monthlyTargetVideos' | 'manualDeficitBaseline' | 'manualDeficitUpdatedAt' | 'deficitEntries' | 'monthlyAdjustments' | 'status' | 'excludeFromStats' | 'pauseHistory' | 'cooperationStartMonth'>;
type OwedPost = Pick<Post, 'vendorId' | 'contentType' | 'status' | 'targetMonth' | 'scheduledAt'>;

// 進行中的當月「照週節奏累積到今天應該交幾支」，取代整月目標去跟已交比較——
// 不然月初delivered=0時會直接背整月欠帳，要到月底才會補回準確。跟撐幾天用同一套四段週節奏(getMonthWeekBucket)，
// 沒設weeklyPattern就用effectiveMonthlyTarget/4平均攤提，維持跟舊版fallback邏輯一致。
function getExpectedDeliveredSoFar(weeklyPattern: number[] | undefined, effectiveMonthlyTarget: number, date: Date): number {
  const pattern = (weeklyPattern && weeklyPattern.length === 4) ? weeklyPattern : Array(4).fill(effectiveMonthlyTarget / 4);
  const dayOfMonth = date.getDate();
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const currentBucket = getMonthWeekBucket(date);

  let expected = 0;
  for (let i = 0; i < currentBucket - 1; i++) expected += pattern[i];

  const bucketStartDay = (currentBucket - 1) * 7 + 1;
  const bucketLength = currentBucket === 4 ? daysInMonth - bucketStartDay + 1 : 7;
  const daysIntoBucket = dayOfMonth - bucketStartDay + 1;
  expected += pattern[currentBucket - 1] * (daysIntoBucket / bucketLength);

  return expected;
}

// 起始欠片有兩種來源（deficitEntries 存在就優先用，忽略舊版單一數字）：
// 1) deficitEntries：逐月手動回填的歷史積欠明細（含填0/負數沖銷），加總成 baseline；從「最後一筆的下個月」開始，
//    每個月各自的短缺(target-已交)連續自動累加到現在為止，直到你拍掉或另外新增沖銷紀錄，累加才會停止——
//    這是故意設計成一直往下滾的，不會因為換月份就歸零或需要每個月手動重填。
//    只有填過的月份「中間」缺的（例如填了2月跟6月但漏了3~5月）才會被列進 gapMonths 提醒，不計入總數。
// 2) 舊版 manualDeficitBaseline 單一數字：同樣邏輯，從 manualDeficitUpdatedAt 校正當下那個月起連續自動累加到現在
//    （相容尚未遷移的舊資料）。
export function getDeficitBreakdown(
  vendor: OwedVendor,
  posts: OwedPost[],
  month: string = format(new Date(), 'yyyy-MM'),
  date: Date = new Date()
): DeficitBreakdown {
  const entries = vendor.deficitEntries || [];
  const currentRealMonth = format(date, 'yyyy-MM');

  const deliveredInMonth = (m: string) => posts.filter(p =>
    p.vendorId === vendor.id && p.contentType === 'video' &&
    (p.status === 'published' || p.status === 'scheduled') &&
    (p.targetMonth ? p.targetMonth === m : (p.scheduledAt || '').slice(0, 7) === m)
  ).length;

  const liveShortfall = (m: string): { month: string; target: number; delivered: number; delta: number; expectedByNow?: number } => {
    const target = getEffectiveMonthlyTarget(vendor, m);
    const delivered = deliveredInMonth(m);
    // 只有「進行中的當月」才用prorate，已經過完的月份維持原邏輯(整月目標 vs 已交)，那些月份本來就該交滿
    if (m === month && m === currentRealMonth) {
      const expectedByNow = getExpectedDeliveredSoFar(vendor.weeklyPattern, target, date);
      return { month: m, target, delivered, delta: expectedByNow - delivered, expectedByNow };
    }
    return { month: m, target, delivered, delta: target - delivered };
  };

  let baseline: number;
  let anchorMonth: string; // 從這個月開始連續自動累加到 month 為止
  let gapMonths: string[] = [];

  if (entries.length > 0) {
    baseline = entries.reduce((s, e) => s + (e.owed || 0), 0);
    const enteredMonths = new Set(entries.map(e => e.month));
    const earliestEntryMonth = entries.reduce((min, e) => (e.month < min ? e.month : min), entries[0].month);
    const latestEntryMonth = entries.reduce((max, e) => (e.month > max ? e.month : max), entries[0].month);

    // 只提醒「已填月份區間中間」缺的洞（例如填了2月跟6月但漏了3~5月），不含最後一筆之後到現在——那段本來就會自動連續累加
    gapMonths = monthsBetweenInclusive(earliestEntryMonth, latestEntryMonth)
      .filter(m => !enteredMonths.has(m) && isVendorTrackedInMonth(vendor, m));

    anchorMonth = nextMonth(latestEntryMonth);
  } else {
    baseline = vendor.manualDeficitBaseline || 0;
    anchorMonth = vendor.manualDeficitUpdatedAt ? format(new Date(vendor.manualDeficitUpdatedAt), 'yyyy-MM') : month;
  }

  const months = anchorMonth <= month ? monthsBetweenInclusive(anchorMonth, month) : [];

  const monthlyShortfalls = months
    .filter(m => isVendorTrackedInMonth(vendor, m)) // 冷凍月不計入短缺
    .map(liveShortfall);

  const totalShortfall = baseline + monthlyShortfalls.reduce((s, x) => s + x.delta, 0);
  return { baseline, monthlyShortfalls, totalShortfall, gapMonths };
}

// 算庫存的影音素材：不是單純看 status==='available'。
// 素材一旦被掛到任何貼文就會變成 status='used'，但貼文還是「草稿」代表根本還沒定案（隨時可能被刪掉/換素材），
// 這種情況下素材其實還沒有真的離開庫存，只是被貼文管理頁的 UI 標成「used」而已。
// 判斷邏輯（跟月份無關）：available（完全沒掛貼文）＝算庫存；掛在草稿貼文＝也算庫存；
// 只要掛的貼文已經是「已排程」或「已發布」（不論哪個月），就是真的用掉了，永久從庫存扣掉——
// 這部分會透過「已交」被算進它排定的那個月，不會漏算也不會跟庫存重複算。
type StockAsset = Pick<Asset, 'vendorId' | 'type' | 'status' | 'usedInPostId' | 'stage'>;

export function getAvailableVideoAssets<A extends StockAsset>(
  vendorId: string,
  assets: A[],
  posts: Pick<Post, 'id' | 'status'>[]
): A[] {
  const draftPostIds = new Set(posts.filter(p => p.status === 'draft').map(p => p.id));

  return assets.filter(a =>
    a.vendorId === vendorId &&
    a.type === 'video' &&
    (a.status === 'available' || (a.status === 'used' && !!a.usedInPostId && draftPostIds.has(a.usedInPostId)))
  );
}

// 積欠支數（跟「拍攝進度」頁同一套公式，抽出來共用，避免兩處各算一份而對不起來）：
// getDeficitBreakdown 算出的累積短缺 - 目前庫存(不分成片/原始素材)
export function getOwedVideoCount(
  vendor: OwedVendor,
  posts: OwedPost[],
  totalStock: number,
  month: string = format(new Date(), 'yyyy-MM')
): number {
  const { totalShortfall } = getDeficitBreakdown(vendor, posts, month);
  return Math.max(0, totalShortfall - totalStock);
}

export type VideoStockSeverity = 'shoot' | 'edit' | null;

export interface VideoStockAlert {
  severity: VideoStockSeverity; // 'shoot'=連原始素材都不夠或有積欠，急迫要拍片／'edit'=素材夠但沒剪完，催剪輯優先處理
  finishedStock: number;   // 成片（可直接發布）
  rawStock: number;        // 原始素材（還沒給剪輯師剪）
  finishedRunwayDays: number | null; // 只算成片能撐幾天
  totalRunwayDays: number | null;    // 成片+原始素材合計能撐幾天
  owed: number;             // 積欠支數（含起始欠片baseline），>0 一律視為要拍片
}

// 素材分「成片(finished)」跟「原始素材(raw)」；沒有 stage 欄位的舊資料視為成片（沿用 AssetDatabase 既有慣例）。
// 判斷邏輯：積欠>0，或合計都撐不到2週 → 真的不夠，最急迫，要安排拍攝；
//          不欠、合計夠但成片撐不到2週 → 素材躺著沒剪，去催剪輯師優先處理即可，不必額外約拍。
export function getVideoStockAlert(
  vendor: Pick<Vendor, 'weeklyPattern' | 'monthlyTargetVideos' | 'cooperationStartMonth' | 'pauseHistory'>,
  vendorVideoAssets: Pick<Asset, 'stage'>[],
  owed: number = 0,
  date: Date = new Date()
): VideoStockAlert {
  const finishedStock = vendorVideoAssets.filter(a => a.stage === 'finished' || !a.stage).length;
  const rawStock = vendorVideoAssets.filter(a => a.stage === 'raw').length;
  const finishedRunwayDays = getStockRunwayDays(vendor, finishedStock, date);
  const totalRunwayDays = getStockRunwayDays(vendor, finishedStock + rawStock, date);

  let severity: VideoStockSeverity = null;
  if (owed > 0 || (totalRunwayDays !== null && totalRunwayDays < LOW_STOCK_RUNWAY_DAYS)) {
    severity = 'shoot';
  } else if (finishedRunwayDays !== null && finishedRunwayDays < LOW_STOCK_RUNWAY_DAYS) {
    severity = 'edit';
  }
  return { severity, finishedStock, rawStock, finishedRunwayDays, totalRunwayDays, owed };
}
