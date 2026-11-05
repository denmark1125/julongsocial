/**
 * 發布前檢查（2026-11-05）：今天的系統排程 vs Meta Business Suite 日曆上「排好還沒發」的內容。
 *
 * 資料來源是 RPA 機器人（rpa/meta_calendar.py）抄回來的卡片，存在 publishPrechecks/{日期}。
 * Meta 官方 API 讀不到 Business Suite 的待發排程，所以只能用瀏覽器看畫面。
 *
 * 只查「準時 IP」、只查今天、只查還沒到時間的貼文：已經過時間的交給發布後稽核（publishAudit.ts）。
 * 這裡只看得到：時間、FB/IG、封面縮圖。看不到文案，所以不判斷「排到別的 IP」——那個交給發布後稽核。
 */

export interface CalendarCard {
  date: string;      // yyyy-MM-dd（台北）
  time: string;      // HH:mm
  platform: 'FB' | 'IG' | '';
  cover?: string;
  status?: string;   // 畫面上的狀態字（現存／已典藏…）
  assetId?: string;
}

export interface VendorCalendar {
  ok: boolean;
  name?: string;
  error?: string;
  cards?: CalendarCard[];
}

export type PrecheckStatus =
  | 'scheduled'      // Meta 上已經排好，時間對
  | 'time_diff'      // Meta 上有排，但時間跟系統差超過容許值
  | 'not_scheduled'  // Meta 上還沒排
  | 'unreadable';    // 機器人讀不到這家的日曆（登入過期、改版…）——不能當成「沒排」

export interface PrecheckResult {
  status: PrecheckStatus;
  metaTime?: string;
  cover?: string;
  error?: string;
}

export const PRECHECK_TOLERANCE_MIN = 15;
/** 差超過這麼多就不認為是同一則（避免把早上已發的那則當成「時間排錯」） */
export const PRECHECK_MATCH_WINDOW_MIN = 180;
/** 卡片下方有這些字＝已經發出去了，不是待發排程 */
const PUBLISHED_STATUS = ['現存', '已典藏', '已發佈', '已發布'];
const PLATFORMS = ['IG', 'FB'] as const;

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export interface PrecheckPostInput { id: string; vendorId: string; scheduledAt: string; platforms?: string[]; title?: string }

/**
 * 一筆排程（某一平台）在 Meta 日曆上找得到嗎？
 * `used`：已經被同一家其他排程配走的卡片（同一家同一天排兩支時不能重複算）。
 */
export function precheckOne(
  post: PrecheckPostInput, platform: string, cal: VendorCalendar | undefined, used: Set<CalendarCard> = new Set(),
): PrecheckResult {
  if (!cal) return { status: 'unreadable', error: '機器人這一輪沒讀這家' };
  if (!cal.ok) return { status: 'unreadable', error: cal.error || '讀不到日曆' };
  const day = post.scheduledAt.slice(0, 10);
  const plan = minutes(post.scheduledAt.slice(11, 16));
  const cands = (cal.cards || [])
    .filter(c => c.date === day && c.platform === platform && !used.has(c) && !PUBLISHED_STATUS.includes(c.status || ''))
    .map(c => ({ c, d: Math.abs(minutes(c.time) - plan) }))
    .filter(x => x.d <= PRECHECK_MATCH_WINDOW_MIN)
    .sort((a, b) => a.d - b.d);
  const best = cands[0];
  if (!best) return { status: 'not_scheduled' };
  used.add(best.c);
  return {
    status: best.d <= PRECHECK_TOLERANCE_MIN ? 'scheduled' : 'time_diff',
    metaTime: best.c.time, cover: best.c.cover,
  };
}

export interface PrecheckRow { postId: string; vendorId: string; platform: string; result: PrecheckResult }

/** 配對本體：回傳每筆結果，和被配走的卡片（給 unmatchedCards 用，兩邊同一套規則） */
function runPrecheck(posts: PrecheckPostInput[], calendars: Record<string, VendorCalendar>) {
  const usedBy = new Map<string, Set<CalendarCard>>();
  const rows: PrecheckRow[] = [];
  for (const p of [...posts].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const used = usedBy.get(p.vendorId) || new Set<CalendarCard>();
    usedBy.set(p.vendorId, used);
    for (const pf of (p.platforms || []).filter(x => (PLATFORMS as readonly string[]).includes(x))) {
      rows.push({ postId: p.id, vendorId: p.vendorId, platform: pf, result: precheckOne(p, pf, calendars[p.vendorId], used) });
    }
  }
  const used = new Set<CalendarCard>();
  usedBy.forEach(u => u.forEach(c => used.add(c)));
  return { rows, used };
}

/** 今天所有準時 IP 的排程 → 每一筆每一平台的結果 */
export function precheckAll(posts: PrecheckPostInput[], calendars: Record<string, VendorCalendar>): PrecheckRow[] {
  return runPrecheck(posts, calendars).rows;
}

/**
 * Meta 上排好了、系統裡卻沒有對應排程的卡片（11-05 CWORKS：Meta 20:00 排了一則 IG，系統當天沒有排程）。
 * 可能是業主自己排的，也可能是同事排錯日期／排錯 IP —— 只提醒「請確認」，不判錯。
 * `afterHHmm`：只看還沒到時間的（早上已經發掉的不算）。
 * `posts` 要傳**當天全部**排程（含已過時間的），不然早上那支會被誤認成多出來的。
 */
export function unmatchedCards(
  posts: PrecheckPostInput[], calendars: Record<string, VendorCalendar>, day: string, afterHHmm: string,
): { vendorId: string; card: CalendarCard }[] {
  const { used } = runPrecheck(posts, calendars);
  const out: { vendorId: string; card: CalendarCard }[] = [];
  for (const [vendorId, cal] of Object.entries(calendars)) {
    if (!cal.ok) continue;
    for (const c of cal.cards || []) {
      if (c.date !== day || c.time <= afterHHmm || used.has(c) || PUBLISHED_STATUS.includes(c.status || '')) continue;
      out.push({ vendorId, card: c });
    }
  }
  return out;
}

export const PRECHECK_ICON: Record<PrecheckStatus, string> = {
  scheduled: '✅', time_diff: '⏰', not_scheduled: '⚠️', unreadable: '❔',
};

export function describePrecheck(r: PrecheckResult, scheduledAt: string): string {
  const plan = scheduledAt.slice(11, 16);
  switch (r.status) {
    case 'scheduled': return `Meta 已排好 ${r.metaTime}`;
    case 'time_diff': return `Meta 排 ${r.metaTime}，系統寫 ${plan}`;
    case 'not_scheduled': return `Meta 上還沒排（系統寫 ${plan}）`;
    case 'unreadable': return `讀不到 Meta 日曆：${r.error || ''}`;
  }
}
