import { addDays, format, parseISO } from 'date-fns';
import { Asset, Post, Vendor } from '../types';
import { AUDITABLE_PLATFORMS, type AuditStatus, type PlatformAudit } from './publishAudit';
import { mergeCalendars, precheckAll, type PrecheckResult, type VendorCalendar } from './publishPrecheck';
import { videoProgress } from '../components/VideoProgressSteps';

/**
 * 發布稽核頁與儀表板共用的「每支片一列」計算（2026-11-06 從 PublishAuditPage 抽出）。
 * 兩個畫面一定要同一個答案，不准各寫一套。
 */

export type PrecheckDoc = { fetchedAt?: string; tiktokFetchedAt?: string; vendors?: Record<string, VendorCalendar>; tiktok?: Record<string, VendorCalendar> };

// 問題排前面，眼睛先看到要處理的
export const SEVERITY: Record<AuditStatus, number> = {
  wrong_account: 0, no_caption: 0, missing: 1, not_seen: 2, content_mismatch: 3, time_mismatch: 4, pending: 5, ok: 6, skipped: 7, unsupported: 8,
};
export const TONE: Record<AuditStatus, string> = {
  wrong_account: 'bg-red-50 text-red-700 border-red-100',
  missing: 'bg-red-50 text-red-700 border-red-100',
  not_seen: 'bg-amber-50 text-amber-700 border-amber-100',
  content_mismatch: 'bg-amber-50 text-amber-700 border-amber-100',
  no_caption: 'bg-red-50 text-red-700 border-red-100',
  time_mismatch: 'bg-amber-50 text-amber-700 border-amber-100',
  pending: 'bg-gray-50 text-gray-500 border-black/5',
  ok: 'bg-green-50 text-green-700 border-green-100',
  skipped: 'bg-gray-50 text-gray-400 border-black/5',
  unsupported: 'bg-gray-50 text-gray-300 border-black/5',
};

export type AuditCell = { pf: string; a: PlatformAudit | undefined; status: AuditStatus; configured: boolean };
export type AuditRow = { p: Post; v: Vendor | undefined; cells: AuditCell[]; worst: number };

/** 準時 IP 的貼文對上機器人抄回來的後台排程（跟伺服器同一個 precheckAll） */
export function computePrecheck(precheckDoc: PrecheckDoc | null, posts: Post[], vmap: Map<string, Vendor>): Map<string, PrecheckResult> {
  if (!precheckDoc?.vendors && !precheckDoc?.tiktok) return new Map();
  const cals = mergeCalendars(precheckDoc.vendors, precheckDoc.tiktok);
  const strictPosts = posts.filter(p => vmap.get(p.vendorId)?.strictTiming && cals[p.vendorId]);
  return new Map(precheckAll(strictPosts as any, cals).map(r => [`${r.postId}|${r.platform}`, r.result]));
}

/** 草稿也列：排上片日自動建的貼文一開始就是草稿，小編不一定會改成已排程，但那天一樣要發 */
export function buildAuditRows(posts: Post[], vmap: Map<string, Vendor>, preview: Record<string, PlatformAudit> = {}): AuditRow[] {
  return posts
    .map(p => {
      const v = vmap.get(p.vendorId);
      // 平台順序固定 IG → FB → TikTok → 其他（資料裡的順序是小編點選的順序，每列不一樣很難對照）
      const order = (pf: string) => { const i = ['IG', 'FB', 'TikTok'].indexOf(pf); return i < 0 ? 9 : i; };
      const cells = [...(p.platforms || [])].sort((a, b) => order(a) - order(b)).map(pf => {
        const fresh = preview[`${p.id}|${pf}`];
        const saved = p.publishAudit?.[pf];
        const a = fresh || (saved && saved.forScheduledAt === p.scheduledAt ? saved : undefined);
        // TikTok 靠機器人抄卡片（隔天早上 09:35 才查得到晚上的片），IG/FB 靠 Meta API 每分鐘查
        const isTikTok = pf === 'TikTok';
        const configured = isTikTok ? !!v?.tiktokBsId : !!v?.metaFbPageId;
        const supported = isTikTok || AUDITABLE_PLATFORMS.includes(pf as any);
        // 沒設粉專／帳號＝根本沒在查，不能顯示成「等待中」騙人，跟尚未支援的平台一樣灰掉、不計數
        const status: AuditStatus = !supported || !configured ? 'unsupported' : (a?.status || 'pending');
        return { pf, a, status, configured };
      });
      const worst = Math.min(...cells.map(c => SEVERITY[c.status]), 99);
      return { p, v, cells, worst };
    })
    .sort((a, b) => a.worst - b.worst || a.p.scheduledAt.localeCompare(b.p.scheduledAt));
}

export function auditCounts(rows: AuditRow[]) {
  const c = { problem: 0, ok: 0, pending: 0 };
  for (const r of rows) for (const x of r.cells) {
    if (x.status === 'unsupported' || x.status === 'skipped') continue;
    if (x.status === 'ok') c.ok++; else if (x.status === 'pending') c.pending++; else c.problem++;
  }
  return c;
}

/** 貼文掛的那支片：直接掛在貼文上，或「排上片日」指到這篇（asset.plannedPostId） */
export function assetOfPost(p: Post, assets: Asset[]): Asset | undefined {
  return (p.assetId && p.assetId !== 'to_be_added' ? assets.find(a => a.id === p.assetId) : undefined)
    || assets.find(a => a.plannedPostId === p.id && !a.voidedAt);
}

/**
 * TikTok 沒有官方讀取管道，靠電腦上的機器人（09:35／11:55／17:30／18:00，見 rpa-profiles/run-meta-precheck.cmd）。
 * 排定時間之後、現在之後的第一輪就是會確認的時間；18:00 之後發的片要等隔天 09:35（下班關機）。
 */
const TIKTOK_ROBOT_TIMES = ['09:35', '11:55', '17:30', '18:00'];
export function tiktokNextCheck(scheduledAt: string): string {
  const now = format(new Date(), "yyyy-MM-dd'T'HH:mm");
  const from = scheduledAt > now ? scheduledAt : now;
  const day = from.slice(0, 10);
  const t = TIKTOK_ROBOT_TIMES.find(x => `${day}T${x}` > from);
  if (t) return `機器人 ${day === now.slice(0, 10) ? '今天' : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`} ${t} 確認`;
  const next = format(addDays(parseISO(day), 1), 'yyyy-MM-dd');
  return `機器人 ${next === format(addDays(new Date(), 1), 'yyyy-MM-dd') ? '明天' : `${Number(next.slice(5, 7))}/${Number(next.slice(8, 10))}`} 09:35 確認（18:00 後發的片下班後查不到）`;
}

/**
 * 稽核頁的五站進度：跟董事行事曆同一套（videoProgress），再加上稽核頁才有的兩個訊號——
 * 機器人看到後台各平台都排好了（草稿也算到「小編排程」完成），系統查到各平台都發出去了（就算還沒改綠色也算發布完成）。
 */
export function auditProgress(
  p: Post, cells: { pf: string; status: AuditStatus; configured: boolean }[], precheck: Map<string, PrecheckResult>,
  asset: Asset | undefined, internal: boolean,
): { current: number; note: string } {
  const today = format(new Date(), 'yyyy-MM-dd');
  const base = videoProgress(p, asset, today, () => '', internal);
  // 跟自動改綠色同一個規則：有 IG/FB 就只看 IG/FB，TikTok 不擋
  const all = cells.filter(c => c.configured && c.status !== 'unsupported');
  const metaCells = all.filter(c => c.pf === 'IG' || c.pf === 'FB');
  const checked = metaCells.length ? metaCells : all;
  if (base.current < 5 && checked.length && checked.every(c => c.status === 'ok' || c.status === 'time_mismatch')) {
    return { current: 5, note: '各平台都確認發出去了' };
  }
  const pre = cells.map(c => precheck.get(`${p.id}|${c.pf}`)).filter(Boolean) as PrecheckResult[];
  if (base.current < 4 && pre.length && pre.every(r => r.status === 'scheduled')) {
    return { current: 4, note: `後台已排好，${p.scheduledAt.slice(11, 16)} 發布` };
  }
  // 片好了不一定是小編沒排：常常卡在文案還沒寫、內部還沒檢核、業主還沒審文案（11-06 使用者）。照順序講第一個卡住的
  if (base.current === 3) {
    const stuck = captionChecks(p).find(c => !c.ok);
    return { current: 3, note: stuck ? `成片已完成・${stuck.wait}` : '成片與文案皆已確認・待小編排程' };
  }
  return base;
}

/** 貼文本身的三個關卡（貼文詳細頁的「內部檢核」「業主審核」兩個勾選＋文案有沒有寫） */
export function captionChecks(p: Post): { label: string; ok: boolean; wait: string }[] {
  return [
    { label: '文案', ok: !!(p.content || '').trim(), wait: '待補文案' },
    { label: '內部檢核', ok: !!p.internalConfirmed, wait: '待內部檢核文案' },
    { label: '業主審文案', ok: !!p.clientConfirmed, wait: '待業主審核文案' },
  ];
}

/**
 * 機器人看到「後台沒排」這個結果可不可信（11-06 小編誤會：12:12 看時沒排，小編下午才排，畫面卻一直寫「後台還沒排」）。
 * 機器人只在固定時間看（見 rpa-profiles），看完之後小編才排的它不知道。
 * 可信＝傍晚那兩輪（17:00 後）看的，或離發布不到 2.5 小時看的；不然只能說「機器人 HH:mm 看時還沒排」，等下一輪。
 */
const META_ROBOT_TIMES = ['09:35', '11:55', '17:30', '18:00'];
export function precheckFreshness(fetchedAt: string | undefined, scheduledAt: string, now = new Date()): { fresh: boolean; seenAt: string; next: string | null } {
  if (!fetchedAt) return { fresh: false, seenAt: '', next: null };
  const seen = parseISO(fetchedAt);
  const seenAt = format(seen, 'HH:mm');
  const sched = parseISO(scheduledAt);
  const fresh = (format(seen, 'yyyy-MM-dd') === scheduledAt.slice(0, 10) && seenAt >= '17:00')
    || (sched.getTime() - seen.getTime()) <= 150 * 60 * 1000;
  const nowHm = format(now, 'HH:mm');
  const next = META_ROBOT_TIMES.find(t => t > nowHm && t < scheduledAt.slice(11, 16)) || null;
  return { fresh, seenAt, next };
}
