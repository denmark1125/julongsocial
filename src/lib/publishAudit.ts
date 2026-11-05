import { titleSimilarity } from './postMatch.js';

/**
 * 發布稽核（2026-11-05）：系統排的貼文 vs 平台上實際發出去的貼文。
 *
 * 起因：同事在 Meta Business Suite／TikTok 後台**再手動排一次**，抄錯帳號、時間、封面，被客戶申訴。
 * Meta 不開放讀 Business Suite「排好還沒發」的內容（24 個粉專實測），所以只能在發出去之後馬上比。
 *
 * ⚠️ 這裡只「回報」不「判誰的錯」：
 *   - 時間對不上＝**排程沒更新**（使用者 11-05 確認：多半是實際就是要 20:00 發、系統沒改），不叫發錯
 *   - 平台多出系統沒排的貼文＝可能是業主自己發的，只能標 ❓，不能判錯
 *   - 彈性 IP（如自然風，做不出來就不發）沒發不算錯
 *
 * 本檔是純函式，伺服器排程與畫面共用；不要在別處另寫一套比對。
 */

export type AuditPlatform = 'IG' | 'FB' | 'TikTok';
/** 每分鐘稽核（Meta API）查得到的平台；TikTok 只能靠機器人抄回來的卡片，另外由 auditTikTok 呼叫（allowTikTok） */
export const AUDITABLE_PLATFORMS: AuditPlatform[] = ['IG', 'FB'];

/** 平台上抓回來的一則貼文 */
export interface LivePost {
  platform: AuditPlatform;
  id: string;
  vendorId: string;     // 這則是在哪個 IP 的帳號上看到的
  publishedAt: string;  // ISO，含時區
  permalink?: string;
  caption?: string;
  thumbnailUrl?: string;
}

export type AuditStatus =
  | 'pending'        // 還沒到時間，或剛過、還在等平台出現（5 分鐘內）
  | 'ok'             // 有發、帳號對、時間對（彈性 IP 不看時間）
  | 'time_mismatch'  // 有發，但跟排程時間差超過容許值 → 請更新排程
  | 'not_seen'       // 準時 IP 已過 5 分鐘還沒看到 → 推 LINE
  | 'missing'        // 準時 IP 整天都沒看到（日報用）
  | 'skipped'        // 彈性 IP 過了時間沒發 → 不算錯
  | 'wrong_account'  // 自己帳號找不到，但在別的 IP 帳號上找到很像的 → 疑似發錯 IP
  | 'content_mismatch' // 排定時間前後有發一則，但文案跟系統不同 → 可能發錯片、也可能只是系統沒更新／手機另寫文案（廣信 FB）
  | 'unsupported';   // 這個平台還沒接（TikTok/YT/LINE）

export interface PlatformAudit {
  status: AuditStatus;
  livePostId?: string;
  permalink?: string;
  actualAt?: string;
  diffMinutes?: number;       // 實際 − 排程，正數＝晚發
  foundOnVendorId?: string;   // wrong_account 時：在誰的帳號上看到
  thumbnailUrl?: string;
  checkedAt: string;
  alertedAt?: string;         // 已經推過 LINE（同一個問題只推一次）
  /** 稽核當時的排程時間。小編照提醒改了排程 → 跟現在對不上 → 整筆重查、可以再推一次 */
  forScheduledAt?: string;
}

export type PublishAudit = Partial<Record<string, PlatformAudit>>;

/** 時間差超過幾分鐘算「排程沒更新」 */
export const TIME_TOLERANCE_MIN = 15;
/** 排定時間過了幾分鐘還沒看到才警示 */
export const NOT_SEEN_AFTER_MIN = 5;
/** 文案像到什麼程度算同一則 */
export const CAPTION_MATCH = 0.5;
/** 在別人帳號找到時要更嚴格，免得兩家剛好都寫「新品上市」就誤判 */
export const WRONG_ACCOUNT_MATCH = 0.7;
/** 文案比不出來時，只認排定時間前後這麼多分鐘內的貼文 */
export const TIME_ONLY_WINDOW_MIN = 90; // 紅茶造咖常排 19:00 實際 20:01，60 分鐘會漏
/** 只在排程時間前後這段時間內找對應的貼文 */
export const SEARCH_WINDOW_HOURS = 18;

/**
 * 系統的 scheduledAt 是「yyyy-MM-ddTHH:mm」不帶時區、一律是台北時間。
 * ⚠️ 伺服器（Vercel）跑在 UTC，直接 new Date(s) 會差 8 小時，一律走這裡。
 */
export function taipeiToDate(scheduledAt: string): Date {
  const s = scheduledAt.length === 16 ? `${scheduledAt}:00` : scheduledAt.slice(0, 19);
  return new Date(`${s}+08:00`);
}

/** Date → 台北時間「yyyy-MM-dd」 */
export function taipeiDay(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** Date → 台北時間「HH:mm」 */
export function taipeiTime(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(11, 16);
}

export interface AuditPostInput {
  id: string;
  vendorId: string;
  scheduledAt: string;
  title?: string;
  content?: string;
}

function captionScore(post: AuditPostInput, live: LivePost): number {
  const cap = live.caption || '';
  if (!cap.trim()) return 0;
  // 文案前段最有鑑別度；長文案後半段常是 hashtag 與固定聯絡資訊，會讓不相干的兩則看起來很像
  const head = cap.slice(0, 120);
  return Math.max(
    post.content ? titleSimilarity(post.content.slice(0, 120), head) : 0,
    post.title ? titleSimilarity(post.title, head) : 0,
  );
}

/**
 * 在「這個 IP 這個平台」的貼文裡，用**文案**替一筆排程找它對應的那一則（≥ CAPTION_MATCH 取最像的）。
 * 文案配不到時由 findOwnByTime 用時間退一步找。
 *
 * `claimed`：已經被別筆排程認走的 livePostId，不能重複配。
 */
export function findOwnLivePost(
  post: AuditPostInput,
  platform: AuditPlatform,
  live: LivePost[],
  claimed: Set<string> = new Set(),
): LivePost | null {
  const at = taipeiToDate(post.scheduledAt).getTime();
  const win = SEARCH_WINDOW_HOURS * 3600_000;
  const cands = live.filter(l =>
    l.platform === platform && l.vendorId === post.vendorId && !claimed.has(l.id)
    && Math.abs(new Date(l.publishedAt).getTime() - at) <= win);
  if (!cands.length) return null;

  const scored = cands.map(l => ({ l, s: captionScore(post, l), d: Math.abs(new Date(l.publishedAt).getTime() - at) }))
    .sort((a, b) => b.s - a.s || a.d - b.d);
  if (scored[0].s >= CAPTION_MATCH) return scored[0].l;

  return null;
}

/**
 * 文案配不到時的退路：排定時間前後 TIME_ONLY_WINDOW_MIN 分鐘內、時間最近的那一則。
 * 回傳 `textComparable`：兩邊都有文案卻比不像 → 呼叫端標 content_mismatch；
 * 任一邊沒文案（CWORKS 10/21 系統沒填文案、11/2 那支 Reel 沒寫文案）→ 無從比較，算配到。
 */
export function findOwnByTime(
  post: AuditPostInput, platform: AuditPlatform, live: LivePost[], claimed: Set<string> = new Set(),
): { live: LivePost; textComparable: boolean } | null {
  const at = taipeiToDate(post.scheduledAt).getTime();
  const best = live
    .filter(l => l.platform === platform && l.vendorId === post.vendorId && !claimed.has(l.id))
    .map(l => ({ l, d: Math.abs(new Date(l.publishedAt).getTime() - at) }))
    .filter(x => x.d <= TIME_ONLY_WINDOW_MIN * 60_000)
    .sort((a, b) => a.d - b.d)[0];
  if (!best) return null;
  const textComparable = !!(post.content || '').trim() && (best.l.caption || '').trim().length >= 10;
  return { live: best.l, textComparable };
}

/** 自己帳號找不到時，到別的 IP 帳號找很像的（只認文案，不認時間——別家同時段本來就會有自己的貼文） */
export function findOnOtherAccount(post: AuditPostInput, platform: AuditPlatform, live: LivePost[]): LivePost | null {
  const at = taipeiToDate(post.scheduledAt).getTime();
  const win = SEARCH_WINDOW_HOURS * 3600_000;
  let best: { l: LivePost; s: number } | null = null;
  for (const l of live) {
    if (l.platform !== platform || l.vendorId === post.vendorId) continue;
    if (Math.abs(new Date(l.publishedAt).getTime() - at) > win) continue;
    const s = captionScore(post, l);
    if (s >= WRONG_ACCOUNT_MATCH && (!best || s > best.s)) best = { l, s };
  }
  return best?.l ?? null;
}

export interface AuditOneArgs {
  post: AuditPostInput;
  platform: string;
  strictTiming: boolean;
  live: LivePost[];
  now: Date;
  claimed?: Set<string>;
  previous?: PlatformAudit;
  /** TikTok 的 live 由機器人卡片組成（發布後隔天檢查）時才允許 */
  allowTikTok?: boolean;
}

/** 一筆排程的一個平台 → 稽核結果。不決定要不要推 LINE（那是 shouldAlert 的事） */
export function auditOne(args: AuditOneArgs): PlatformAudit {
  const prev = args.previous?.forScheduledAt === args.post.scheduledAt ? args.previous : undefined;
  return { ...auditCore({ ...args, previous: prev }), forScheduledAt: args.post.scheduledAt };
}

function auditCore({ post, platform, strictTiming, live, now, claimed, previous, allowTikTok }: AuditOneArgs): PlatformAudit {
  const checkedAt = now.toISOString();
  if (!AUDITABLE_PLATFORMS.includes(platform as AuditPlatform) && !(allowTikTok && platform === 'TikTok')) {
    return { status: 'unsupported', checkedAt };
  }
  const p = platform as AuditPlatform;
  const at = taipeiToDate(post.scheduledAt);
  const keep = previous?.alertedAt ? { alertedAt: previous.alertedAt } : {};

  const byText = findOwnLivePost(post, p, live, claimed);
  const byTime = byText ? null : findOwnByTime(post, p, live, claimed);
  const own = byText || byTime?.live || null;
  if (own) {
    const diffMinutes = Math.round((new Date(own.publishedAt).getTime() - at.getTime()) / 60_000);
    const late = strictTiming && Math.abs(diffMinutes) > TIME_TOLERANCE_MIN;
    const mismatch = !!byTime?.textComparable;
    return {
      status: mismatch ? 'content_mismatch' : late ? 'time_mismatch' : 'ok',
      livePostId: own.id, permalink: own.permalink, actualAt: own.publishedAt, diffMinutes,
      thumbnailUrl: own.thumbnailUrl, checkedAt, ...keep,
    };
  }

  const minutesPast = (now.getTime() - at.getTime()) / 60_000;
  // 還沒到時間：不去別人帳號找。提早發到別人帳號的情況，等到點後一樣抓得到
  if (minutesPast < 0) return { status: 'pending', checkedAt, ...keep };

  const other = findOnOtherAccount(post, p, live);
  if (other) {
    return {
      status: 'wrong_account', livePostId: other.id, permalink: other.permalink, actualAt: other.publishedAt,
      foundOnVendorId: other.vendorId, thumbnailUrl: other.thumbnailUrl, checkedAt, ...keep,
    };
  }

  if (minutesPast < NOT_SEEN_AFTER_MIN) return { status: 'pending', checkedAt, ...keep };
  if (!strictTiming) return { status: 'skipped', checkedAt, ...keep };
  // 當天結束還沒有＝漏發；當天之內＝還沒看到（可能平台慢、也可能真的漏）
  const dayOver = taipeiDay(now) > taipeiDay(at);
  return { status: dayOver ? 'missing' : 'not_seen', checkedAt, ...keep };
}

/** 這個結果要不要推 LINE。同一筆同一平台只推一次；之後補出現只改頁面、不再推 */
export function shouldAlert(a: PlatformAudit): boolean {
  if (a.alertedAt) return false;
  return a.status === 'not_seen' || a.status === 'wrong_account' || a.status === 'time_mismatch';
}

/** 結果還會不會變（不會變就不用每分鐘再查） */
export function isSettled(a: PlatformAudit | undefined, now: Date, scheduledAt: string): boolean {
  if (!a || a.forScheduledAt !== scheduledAt) return false;
  if (a.status === 'unsupported' || a.status === 'missing') return true;
  if (a.status === 'skipped') return taipeiDay(now) > taipeiDay(taipeiToDate(scheduledAt));
  if (a.status === 'ok' || a.status === 'time_mismatch' || a.status === 'wrong_account' || a.status === 'content_mismatch') {
    // 封面縮圖 IG 偶爾要幾分鐘才出來：拿到縮圖、或已過 15 分鐘就算定了
    return !!a.thumbnailUrl || now.getTime() - taipeiToDate(scheduledAt).getTime() > 15 * 60_000;
  }
  return false;
}

/**
 * 平台上有、但沒對到任何一筆排程的貼文 → 日報標 ❓（可能是業主自己發的）。
 * `matchedIds`：今天所有排程認走的 livePostId（含 wrong_account 認到的）。
 */
export function unscheduledLivePosts(live: LivePost[], matchedIds: Set<string>, day: string): LivePost[] {
  return live.filter(l => !matchedIds.has(l.id) && taipeiDay(new Date(l.publishedAt)) === day);
}

export const AUDIT_STATUS_LABEL: Record<AuditStatus, string> = {
  pending: '等待發布',
  ok: '正確',
  time_mismatch: '排程時間跟實際不同',
  not_seen: '還沒看到',
  missing: '沒有發',
  skipped: '沒發（彈性）',
  wrong_account: '疑似發到別的帳號',
  content_mismatch: '文案跟系統不同',
  unsupported: '尚未支援',
};

export const AUDIT_STATUS_ICON: Record<AuditStatus, string> = {
  pending: '⏳', ok: '✅', time_mismatch: '⏰', not_seen: '⚠️', missing: '❌',
  skipped: '➖', wrong_account: '❌', content_mismatch: '⚠️', unsupported: '—',
};

/** 一行人看得懂的說明（LINE 與頁面共用） */
export function describeAudit(a: PlatformAudit, scheduledAt: string, vendorName: (id: string) => string): string {
  const plan = scheduledAt.slice(11, 16);
  const actual = a.actualAt ? taipeiTime(new Date(a.actualAt)) : '';
  switch (a.status) {
    case 'ok': return actual ? `${actual} 發布` : '正確';
    case 'time_mismatch': return `排程寫 ${plan}，實際 ${actual} 發 → 請更新排程`;
    case 'not_seen': return `排 ${plan}，過了 ${NOT_SEEN_AFTER_MIN} 分鐘還沒看到`;
    case 'missing': return `排 ${plan}，整天都沒看到`;
    case 'skipped': return `排 ${plan}，沒發（彈性 IP 不算錯）`;
    case 'wrong_account': return `自己帳號找不到，在「${vendorName(a.foundOnVendorId || '')}」帳號看到很像的一則`;
    case 'content_mismatch': return `${actual} 有發一則，但文案跟系統排的不同 → 請確認是不是發錯片`;
    case 'pending': return `排 ${plan}`;
    case 'unsupported': return '這個平台還沒接稽核';
  }
}
