/**
 * 客戶端（業主看的那一面，/c/<代碼>）：伺服器要回哪些欄位、給業主看的文字（2026-11-16）。
 *
 * ⚠️ 業主的瀏覽器不直接讀資料庫：廠商／素材／貼文文件裡有合約、剪輯費、剪輯師、欠片、內部備註，
 *    資料庫權限沒辦法只開一部分欄位。一律由伺服器用這裡的函式**白名單挑欄位**後回傳。
 *    要多給業主一個欄位＝在 toClientPost 明確加一行，並更新 __tests__/clientPortal.test.ts 的白名單。
 * ⚠️ 不放任何稽核訊號（各平台查核、機器人確認時間、警示符號）——使用者 11-16：那是內部在看的，
 *    TikTok 常常誤報，業主只需要知道「已發布」。
 * ⚠️ 純函式、不 import 任何執行期的東西（server.ts 在 Vercel 原生 ESM 下載入）。
 */

export type ClientFlow = 'to_edit' | 'revising' | 'client_review' | 'to_upload' | 'ready';

/** 文案在業主眼中的狀態 */
/** revising＝業主留言要改、小編還沒重送（11-18 改成在網頁留言，不在 LINE 收） */
export type ClientCaptionState = 'preparing' | 'waiting' | 'revising' | 'approved' | 'published';

export interface ClientVideo {
  assetId: string;
  /** r2＝<video> 直接播；drive＝Google 雲端播放器（舊片） */
  kind: 'r2' | 'drive';
  url: string;
  version: number;
}

export interface ClientPost {
  id: string;
  title: string;
  scheduledAt: string;
  platforms: string[];
  status: 'draft' | 'pending' | 'scheduled' | 'published';
  /** 這篇掛的片走到哪（沒有片＝null）。五站進度由前端用跟公司端同一個 videoProgress() 算 */
  flow: ClientFlow | null;
  /** 內部剪輯（不用上傳雲端）：業主通過後直接到「小編排程」 */
  internal: boolean;
  captionState: ClientCaptionState;
  /** 小編送審之後才有；還在寫的草稿不給業主看 */
  caption: string;
  /** 待審片時才有 */
  video: ClientVideo | null;
  /** 已發布貼文的連結 */
  links: { pf: string; url: string }[];
  /** 業主確認之後小編又改過文字（小改不強制重審，但要讓業主知道看到的不是他當初確認的那版） */
  editedAfterApproval: boolean;
}

export interface ClientShoot {
  date: string;
  time: string;
  done: boolean;
}

export interface ClientPortalData {
  vendorName: string;
  month: string;
  posts: ClientPost[];
  shoots: ClientShoot[];
  /** 今天以後最近的一次拍攝 */
  nextShoot: ClientShoot | null;
  /** 最近一次已經拍完的拍攝 */
  lastShoot: ClientShoot | null;
  /** 目前庫存（不分月份，永遠是「現在」） */
  stock: ClientStock;
  /** 這個 IP 的 TikTok 帳號首頁；沒設定是空字串（TikTok 拿不到單篇網址，只能連首頁） */
  tiktokUrl: string;
  /** 通知（右上角鈴鐺）：近 30 天、不分月份、新的在前 */
  notices: ClientNotice[];
}

/**
 * 客戶端通知（11-19）：業主打開頁面時右上角鈴鐺＋一次提示，不佔版面。
 * 全部由現有資料推出來（送審時間、審片檔上傳時間、發布、拍攝預約），不另外存一份通知。
 * billing＝之後的付款通知，先留型別。已讀與否存在業主自己的瀏覽器（沒有登入帳號）。
 */
export type ClientNoticeKind = 'caption' | 'video' | 'published' | 'shoot' | 'billing';
export interface ClientNotice {
  id: string;
  kind: ClientNoticeKind;
  /** ISO 時間（排序、算「幾小時前」用） */
  at: string;
  title: string;
  /** 第二行：哪一篇／哪一天 */
  detail: string;
  /** 點了打開哪一篇（拍攝通知沒有） */
  postId?: string;
  /** 那一篇在哪個月（點通知要換月份才找得到） */
  month?: string;
  /** 要業主做的事已經做完（確認過、審過）：清單上灰掉，不算「等您處理」 */
  done: boolean;
}

const NOTICE_DAYS = 30;
const NOTICE_MAX = 30;
/** scheduledAt 是台灣時間字面值 'YYYY-MM-DDTHH:mm' → ISO */
const taipeiIso = (local: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local) ? new Date(`${local.slice(0, 16)}:00+08:00`).toISOString() : '');

export function buildClientNotices(
  posts: any[], assets: any[], bookings: any[],
  opts: { now: Date; today: string; flowOf: (asset: any) => ClientFlow | null },
): ClientNotice[] {
  const since = opts.now.getTime() - NOTICE_DAYS * 86400_000;
  const recent = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= since && t <= opts.now.getTime() + 60_000; };
  const monthOf = (p: any) => (/^\d{4}-\d{2}/.test(str(p?.scheduledAt)) ? str(p.scheduledAt).slice(0, 7) : str(p?.targetMonth));
  const label = (p: any) => `${clientDayLabel(str(p?.scheduledAt)) || '上片日未定'}《${str(p?.title) || '未命名'}》`;
  const out: ClientNotice[] = [];

  for (const p of posts) {
    const cr = p?.captionReview || {};
    // 文案送審（小編按飛機）：每次送審一則；重送＝修改版
    if (str(cr.sentAt) && recent(cr.sentAt) && p.status !== 'published') {
      const state = clientCaptionState(p);
      out.push({
        id: `cap_${p.id}_${cr.sentAt}`, kind: 'caption', at: cr.sentAt,
        title: (Number(cr.sendCount) || 1) > 1 ? '修改後的文案等您確認' : '文案等您確認',
        detail: label(p), postId: p.id, month: monthOf(p), done: state !== 'waiting',
      });
    }
    // 已發布：以實際發出時間為準，查不到用排定時間
    if (p.status === 'published') {
      const actual = Object.values<any>(p.publishAudit || {}).map(a => str(a?.actualAt)).filter(Boolean).sort()[0];
      const at = actual || taipeiIso(str(p.scheduledAt));
      if (at && recent(at)) {
        out.push({ id: `pub_${p.id}`, kind: 'published', at, title: '貼文已發布', detail: label(p), postId: p.id, month: monthOf(p), done: true });
      }
    }
  }

  // 審片：剪輯師每交一版審片檔一則；掛在哪篇貼文就點開哪篇
  const postOfAsset = new Map<string, any>();
  for (const p of posts) if (p.assetId && p.assetId !== 'to_be_added') postOfAsset.set(String(p.assetId), p);
  const postById = new Map(posts.map(p => [p.id, p]));
  for (const a of assets) {
    if (a?.voidedAt) continue;
    const latest = (a.reviewFiles || [])[(a.reviewFiles?.length || 0) - 1];
    if (!latest || !recent(str(latest.uploadedAt))) continue;
    const p = postOfAsset.get(a.id) || (a.plannedPostId ? postById.get(a.plannedPostId) : undefined);
    if (!p || p.status === 'published') continue;
    const v = Number(latest.version) || 1;
    out.push({
      id: `vid_${a.id}_${v}`, kind: 'video', at: latest.uploadedAt,
      title: v > 1 ? `影片第 ${v} 版等您審片` : '影片等您審片',
      detail: label(p), postId: p.id, month: monthOf(p), done: opts.flowOf(a) !== 'client_review',
    });
  }

  // 拍攝預約：還沒拍的才提醒
  for (const b of bookings) {
    const s = toClientShoot(b);
    if (!s || s.date < opts.today || !recent(str(b?.createdAt))) continue;
    out.push({ id: `shoot_${s.date}_${s.time}`, kind: 'shoot', at: b.createdAt, title: '拍攝已排定', detail: `${clientDayLabel(s.date)}${s.time ? ` ${s.time}` : ''}`, done: true });
  }

  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, NOTICE_MAX);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function clientCaptionState(p: any): ClientCaptionState {
  if (p?.status === 'published') return 'published';
  if (p?.clientConfirmed) return 'approved';
  // 小編按過送審才算「等您確認」；沒送審的一律是準備中（就算已經有草稿）
  if (!(p?.captionReview?.sentAt && str(p?.content).trim())) return 'preparing';
  // 業主要改（留言／舊卡片按了要修改）→ 小編重送時會清掉 changeRequestedAt
  // 跟小編端 captionStatus 的 change_requested 同一條規則：要改的時間在最後一次送審之後
  const cr = p.captionReview;
  return cr.changeRequestedAt && cr.changeRequestedAt >= cr.sentAt ? 'revising' : 'waiting';
}

/**
 * 一篇貼文給業主看的樣子。**只有這裡列出的欄位會離開伺服器。**
 * `flow`／`internal`／`video` 由伺服器算好傳進來（要查素材與剪輯師名冊，這裡不碰資料庫）。
 */
export function toClientPost(p: any, extra: { flow: ClientFlow | null; internal: boolean; video: ClientVideo | null }): ClientPost {
  const state = clientCaptionState(p);
  const scheduledAt = str(p?.scheduledAt);
  const links: { pf: string; url: string }[] = [];
  if (p?.status === 'published') {
    for (const pf of ['IG', 'FB', 'TikTok']) {
      const a = p?.publishAudit?.[pf];
      // 稽核查到的那一則必須是「這個排程時間」的，改過上片日的舊紀錄不算
      if (a?.permalink && a.forScheduledAt === scheduledAt && /^https:\/\//.test(a.permalink)) links.push({ pf, url: a.permalink });
    }
    // 稽核沒查到（11-05 以前發的、或那個 IP 沒設粉專）就退回小編手填的「貼文位置連結」——同公司端 publishedPostUrl。
    // 11-16 正式資料已發布 114 篇有 51 篇只有手填的。但手填欄位常放雲端／Notion 等內部連結，只認社群網站
    if (!links.length) {
      const pf = socialPlatformOf(str(p?.postUrl));
      if (pf) links.push({ pf, url: str(p.postUrl) });
    }
  }
  const status = ['draft', 'pending', 'scheduled', 'published'].includes(p?.status) ? p.status : 'draft';
  return {
    id: str(p?.id),
    title: str(p?.title),
    scheduledAt,
    platforms: Array.isArray(p?.platforms) ? p.platforms.filter((x: unknown) => typeof x === 'string') : [],
    status,
    flow: status === 'published' ? null : extra.flow,
    internal: extra.internal,
    captionState: state,
    caption: state === 'preparing' ? '' : str(p?.content),
    // 只有「等業主審片」那一刻才給播放網址
    video: status !== 'published' && extra.flow === 'client_review' ? extra.video : null,
    links,
    editedAfterApproval: state === 'approved' && typeof p?.captionReview?.approvedContent === 'string' && p.captionReview.approvedContent !== str(p?.content),
  };
}

/**
 * TikTok 帳號首頁網址（11-18）。TikTok 沒有官方 API、機器人也只抄得到時間，**拿不到單篇貼文網址**
 * （11-16 正式資料：已發布有排 TikTok 的 113 次，有網址 0 次），所以客戶端改連帳號首頁：網址固定、不會失效。
 * 吃廠商管理填的帳號名稱，可以是 dafacar、@dafacar 或整串 tiktok.com/@dafacar 網址。
 * ⚠️ 社群帳號清單的 TikTok「帳號」多半是登入用 email（大發、CWORKS），組出來是錯網址 → 不合帳號格式一律回空字串。
 */
export function tiktokProfileUrl(raw: unknown): string {
  let h = str(raw).trim();
  const m = /tiktok\.com\/@([^/?#\s]+)/i.exec(h);
  if (m) h = m[1];
  h = h.replace(/^@/, '');
  return /^[A-Za-z0-9._]{2,24}$/.test(h) ? `https://www.tiktok.com/@${h}` : '';
}

/** 手填網址是不是社群貼文：是就回平台名，不是（雲端、Notion、亂填）回空字串 */
export function socialPlatformOf(url: string): string {
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  } catch {
    return '';
  }
  if (host === 'instagram.com') return 'IG';
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'fb.com') return 'FB';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'TikTok';
  if (host === 'threads.net' || host === 'threads.com') return 'Threads';
  return '';
}

/** 拍攝預約：只給日期與時間。TimeTree 標題裡有同事名字（例「大發超哥拍攝-Kai」），不給 */
export function toClientShoot(b: any): ClientShoot | null {
  const date = str(b?.scheduledDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (b?.status !== 'booked' && b?.status !== 'completed') return null; // 延期、取消的不顯示
  return { date, time: /^\d{2}:\d{2}$/.test(str(b?.startTime)) ? b.startTime : '', done: b.status === 'completed' };
}

export function pickNextShoot(shoots: ClientShoot[], today: string): ClientShoot | null {
  // 看日期（11-19）：今天以後的都是接下來的拍攝；今天的還沒按完成也算
  return shoots.filter(s => s.date > today || (s.date === today && !s.done)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0] || null;
}

/**
 * 最近一次已經拍過的（標成完成的，或日期已經過了的）。
 * filmedDates＝素材的拍攝日：預約系統很少人用，只看預約會讓業主看到很久以前的日子
 * （11-18 大發 9、10 月拍了四場，預約只有 7/24 → 客戶端寫「上次 7/24」）。同一天有預約的話用預約那筆（有時間）。
 */
export function pickLastShoot(shoots: ClientShoot[], today: string, filmedDates: string[] = []): ClientShoot | null {
  const filmed = filmedDates
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today)
    .map(date => ({ date, time: '', done: true }));
  // 看日期（11-19）：日子過了就是拍過；今天的要按了完成才算（未來的被誤標完成也不算）
  return [...shoots.filter(s => s.date < today || (s.date === today && s.done)), ...filmed]
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))[0] || null;
}

/* ───────────── 給業主看的文字 ───────────── */

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** '2026-11-25' → '11/25（三）' */
export function clientDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
  if (!m) return '';
  return `${Number(m[2])}/${Number(m[3])}（${WEEK[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]}）`;
}

export type ClientTone = 'done' | 'scheduled' | 'waiting' | 'working' | 'idle' | 'action';

/**
 * 五站走到第 `current` 站（0 拍攝、1 剪輯、2 業主審片、3 小編排程、4 已排程、5 已發布——同 videoProgress）時，
 * 給業主看的狀態標籤。不帶剪輯師名字、不用內部用語；要業主動手的用 action（畫面上最醒目）。
 */
export function clientStageLabel(p: Pick<ClientPost, 'flow' | 'captionState' | 'scheduledAt'>, current: number): { tone: ClientTone; label: string; detail: string } {
  const when = p.scheduledAt ? `${Number(p.scheduledAt.slice(5, 7))}/${Number(p.scheduledAt.slice(8, 10))} ${p.scheduledAt.slice(11, 16)}` : '';
  if (current >= 5) return { tone: 'done', label: '已發布', detail: '' };
  // 影片這條線走到哪（不管文案）
  const film = current === 4 ? { tone: 'scheduled' as const, label: '已排程', detail: when ? `${when} 發布` : '' }
    : p.flow === 'client_review' ? { tone: 'action' as const, label: '等您審片', detail: '' }
      : current === 3 || p.flow === 'to_upload'
        ? { tone: 'waiting' as const, label: p.flow === 'to_upload' ? '審片已通過' : '準備排程', detail: p.captionState === 'preparing' ? '文案準備中' : p.captionState === 'revising' ? '文案修改中' : '' }
        : current === 1 ? { tone: 'working' as const, label: p.flow === 'revising' ? '依您的意見修改中' : '剪輯中', detail: '' }
          : { tone: 'idle' as const, label: '等拍攝', detail: '' };
  // 文案可以比影片先好、先審（使用者 11-16：不一定要等影片出來）。只要有文案在等業主，標籤就講文案，
  // 影片走到哪放在後面的灰字，業主才不會看到「剪輯中」就以為沒他的事
  if (p.captionState === 'waiting') {
    if (film.label === '等您審片') return { tone: 'action', label: '等您審片・確認文案', detail: '' };
    const filmNote = film.tone === 'scheduled' ? film.detail
      : film.label === '剪輯中' || film.label === '依您的意見修改中' || film.label === '等拍攝' ? `影片${film.label}`
        : film.label;
    return { tone: 'action', label: '等您確認文案', detail: filmNote };
  }
  return film;
}

/** 這一篇有沒有事情等業主做 */
export function clientTodo(p: Pick<ClientPost, 'flow' | 'captionState' | 'status'>): { video: boolean; caption: boolean } {
  if (p.status === 'published') return { video: false, caption: false };
  return { video: p.flow === 'client_review', caption: p.captionState === 'waiting' };
}

/**
 * 清單分三段（使用者 11-16：已發布排在最上面，當下要處理的反而要滾到下面，非常不直覺）：
 * 1. todo：等業主動手的（待審片、待確認文案），日期近的在前
 * 2. upcoming：還沒發布、不用業主動手的，日期近的在前（沒排日期的放最後）
 * 3. done：已發布，**最近發的在前**——要回頭找通常是找剛發的那幾支
 */
export function clientSections<T extends Pick<ClientPost, 'flow' | 'captionState' | 'status' | 'scheduledAt'>>(posts: T[]) {
  const asc = (a: T, b: T) => (a.scheduledAt || '9').localeCompare(b.scheduledAt || '9');
  const todo: T[] = [], upcoming: T[] = [], done: T[] = [];
  for (const p of posts) {
    const t = clientTodo(p);
    if (p.status === 'published') done.push(p);
    else if (t.video || t.caption) todo.push(p);
    else upcoming.push(p);
  }
  return { todo: todo.sort(asc), upcoming: upcoming.sort(asc), done: done.sort((a, b) => asc(b, a)) };
}

export function clientTodoSummary(posts: ClientPost[]): { video: number; caption: number; firstId: string } {
  let video = 0, caption = 0, firstId = '';
  for (const p of [...posts].sort((a, b) => (a.scheduledAt || '9').localeCompare(b.scheduledAt || '9'))) {
    const t = clientTodo(p);
    if (t.video) video++;
    if (t.caption) caption++;
    if ((t.video || t.caption) && !firstId) firstId = p.id;
  }
  return { video, caption, firstId };
}

/* ───────────── 目前庫存（使用者 11-17：客戶想看拍了多少、哪些還是素材、哪些成片可以發） ───────────── */

/** 庫存分三格：還沒剪好（含依意見修改中）、等業主審片、成片可發布（業主已通過、還沒發出去） */
export type ClientStockBucket = 'raw' | 'review' | 'ready';

export interface ClientStockItem {
  title: string;
  bucket: ClientStockBucket;
  /** 我們幫客戶排的上片日（YYYY-MM-DD 或 YYYY-MM-DDTHH:mm）；還沒排＝空字串 */
  airDate: string;
  /** 綁著的那篇貼文（點了可以打開）；沒綁＝空字串 */
  postId: string;
}

export interface ClientStock {
  total: number;
  raw: ClientStockItem[];
  review: ClientStockItem[];
  ready: ClientStockItem[];
}

export function stockBucketOf(flow: string): ClientStockBucket {
  if (flow === 'client_review') return 'review';
  if (flow === 'to_upload' || flow === 'ready') return 'ready';
  return 'raw';
}

/**
 * 把「庫存裡的片」變成業主看的樣子。**哪些片算庫存不在這裡決定**——呼叫端一律用
 * vendorStatus.getAvailableVideoAssets()（跟公司端拍攝進度頁同一套），這裡只負責分格、找上片日、挑欄位。
 * 上片日的認法同 types.ts plannedPostId 的說明：綁了貼文就以貼文的 scheduledAt 為準，沒綁才看 plannedAirDate。
 * 使用者 11-17：不算「庫存還能撐幾天」，照我們實際排給客戶的上片日標出來。
 */
export function toClientStock(
  stockAssets: any[],
  postsById: Map<string, { scheduledAt?: string }>,
  flowOf: (a: any) => string,
): ClientStock {
  const items: ClientStockItem[] = stockAssets.map(a => {
    const postId = [a?.plannedPostId, a?.usedInPostId].map(str).find(id => id && postsById.has(id)) || '';
    const fromPost = postId ? str(postsById.get(postId)?.scheduledAt) : '';
    const airDate = fromPost || (/^\d{4}-\d{2}-\d{2}/.test(str(a?.plannedAirDate)) ? str(a.plannedAirDate) : '');
    return { title: str(a?.title) || '（未命名）', bucket: stockBucketOf(flowOf(a)), airDate, postId };
  });
  // 排了上片日的照日期近到遠，還沒排的放後面
  items.sort((x, y) => (x.airDate || '9').localeCompare(y.airDate || '9') || x.title.localeCompare(y.title));
  return {
    total: items.length,
    raw: items.filter(i => i.bucket === 'raw'),
    review: items.filter(i => i.bucket === 'review'),
    ready: items.filter(i => i.bucket === 'ready'),
  };
}
