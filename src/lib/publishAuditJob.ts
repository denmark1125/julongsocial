import { deriveFlowStage } from '../types.js';
import {
  AUDIT_STATUS_ICON, AUDITABLE_PLATFORMS, auditOne, describeAudit, isSettled, shouldAlert, taipeiDay, taipeiTime,
  taipeiToDate, type LivePost, type PlatformAudit,
} from './publishAudit.js';
import { fetchFacebookPosts, fetchInstagramPosts, listMetaPages, type MetaPage } from './metaGraph.js';
import { describePrecheck, PRECHECK_ICON, precheckAll, unmatchedCards, type VendorCalendar } from './publishPrecheck.js';

/**
 * 發布稽核的排程工作（伺服器用，2026-11-05）。由 /api/cron/publish-audit 每分鐘呼叫一次。
 *
 * 每一次：
 *  1. 找「排定時間在 26 小時內、已到點、還沒定案」的貼文 —— 沒有就直接結束（大部分分鐘都是這樣，不打 Meta）
 *  2. 只抓需要的 IP 的 IG/FB；自己帳號找不到時才去抓全部 IP 找「是不是發到別人那裡」
 *  3. 結果有變才寫回 posts.publishAudit.<平台>；該警示的合成一則 LINE
 *  4. 台北時間過 18:00 出日報（一天一次）、過 19:00 檢查今晚準時 IP 的片好了沒（一天一次）
 *
 * 判斷規則全部在 publishAudit.ts，這裡只負責搬資料。
 */

export interface JobDeps {
  db: any;                                  // firebase-admin Firestore
  metaToken: string;
  push: (text: string) => Promise<number>;  // 推 LINE，回傳推給幾個人
  now?: Date;
  dryRun?: boolean;                         // 只算不寫、不推（本機預覽／手動測試用）
  appUrl?: string;
}

export interface JobResult {
  checked: number;
  changed: number;
  alerts: string[];
  report?: string;
  reminder?: string;
  precheck?: string;   // 這一輪發布前檢查要推的文字（沒有問題就沒有）
  rows: AuditRow[];
}

export interface AuditRow {
  postId: string;
  vendorId: string;
  vendorName: string;
  title: string;
  scheduledAt: string;
  platform: string;
  audit: PlatformAudit;
}

/** 往回看幾小時的排程：叫醒時間最晚到排定後 180 分鐘，4 小時夠了（少讀資料庫） */
const LOOKBACK_HOURS = 4;
const REPORT_AT = '18:00';
/** 中午提醒「今天要發哪些片」（11-05 使用者要求；原本 19:00 的提醒拿掉：那時多半已經下班關機） */
const NOON_AT = '12:00';

/** 台北時間的「yyyy-MM-ddTHH:mm」，跟 posts.scheduledAt 同格式，可以直接字串比大小 */
function taipeiStamp(d: Date): string {
  return `${taipeiDay(d)}T${taipeiTime(d)}`;
}

interface VendorInfo { id: string; name: string; strict: boolean; fbPageId?: string; igPageId?: string }

// IP 名單幾乎不變：同一台伺服器 10 分鐘內重複用，不要每次叫醒都重讀 20 幾筆（省資料庫讀取）
let vendorCache: { at: number; map: Map<string, VendorInfo> } | null = null;

async function loadVendors(db: any): Promise<Map<string, VendorInfo>> {
  if (vendorCache && Date.now() - vendorCache.at < 10 * 60_000) return vendorCache.map;
  const map = await loadVendorsFresh(db);
  vendorCache = { at: Date.now(), map };
  return map;
}

async function loadVendorsFresh(db: any): Promise<Map<string, VendorInfo>> {
  const snap = await db.collection('vendors').get();
  return new Map(snap.docs.map((d: any) => {
    const v = d.data() || {};
    return [d.id, {
      id: d.id, name: v.name || d.id, strict: !!v.strictTiming,
      fbPageId: v.metaFbPageId || undefined, igPageId: v.metaIgPageId || v.metaFbPageId || undefined,
    }];
  }));
}

/** 一個 IP 的 IG＋FB 近期貼文。粉專不在這把 token 底下就回空（畫面上會顯示「沒有對應粉專」） */
async function fetchVendorLive(v: VendorInfo, pages: Map<string, MetaPage>, sinceIso: string): Promise<LivePost[]> {
  const out: LivePost[] = [];
  const fb = v.fbPageId ? pages.get(v.fbPageId) : undefined;
  const ig = v.igPageId ? pages.get(v.igPageId) : undefined;
  const tasks: Promise<LivePost[]>[] = [];
  if (fb) tasks.push(fetchFacebookPosts(fb, v.id, sinceIso));
  if (ig) tasks.push(fetchInstagramPosts(ig, v.id, sinceIso));
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === 'fulfilled') out.push(...r.value);
    else console.error('publish-audit fetch failed', v.name, r.reason?.message);
  }
  return out;
}

export async function runPublishAudit(deps: JobDeps): Promise<JobResult> {
  const { db, metaToken, push, dryRun } = deps;
  const now = deps.now || new Date();
  const nowStamp = taipeiStamp(now);
  const fromStamp = taipeiStamp(new Date(now.getTime() - LOOKBACK_HOURS * 3600_000));
  const result: JobResult = { checked: 0, changed: 0, alerts: [], rows: [] };

  const postSnap = await db.collection('posts')
    .where('scheduledAt', '>=', fromStamp).where('scheduledAt', '<=', nowStamp).get();
  const posts = postSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((p: any) => p.scheduledAt) // 草稿也查：排上片日自動建的貼文一開始就是草稿，小編不一定會改成已排程（11-05 好正點）
    .sort((a: any, b: any) => a.scheduledAt.localeCompare(b.scheduledAt));

  const open = posts.filter((p: any) => (p.platforms || []).some((pf: string) =>
    AUDITABLE_PLATFORMS.includes(pf as any) && !isSettled(p.publishAudit?.[pf], now, p.scheduledAt)));

  let vendors: Map<string, VendorInfo> | null = null;
  const getVendors = async () => (vendors ||= await loadVendors(db));

  if (open.length) {
    const vmap = await getVendors();
    const pages = new Map((await listMetaPages(metaToken, now.getTime())).map(p => [p.id, p]));
    const sinceIso = new Date(taipeiToDate(fromStamp).getTime() - 18 * 3600_000).toISOString();
    const liveBy = new Map<string, LivePost[]>();
    const liveOf = async (vid: string) => {
      if (!liveBy.has(vid)) {
        const v = vmap.get(vid);
        liveBy.set(vid, v ? await fetchVendorLive(v, pages, sinceIso) : []);
      }
      return liveBy.get(vid)!;
    };
    let allFetched = false;
    const fetchAll = async () => {
      if (allFetched) return;
      allFetched = true;
      await Promise.all([...vmap.values()].filter(v => v.fbPageId).map(v => liveOf(v.id)));
    };

    // 已經定案的貼文認走的 livePostId 先佔住，避免同一則被兩筆排程配到
    const claimed = new Set<string>();
    for (const p of posts) for (const a of Object.values<any>(p.publishAudit || {})) {
      if (a?.livePostId && a.forScheduledAt === p.scheduledAt) claimed.add(a.livePostId);
    }

    const alertLines: { postId: string; pf: string; line: string }[] = [];
    for (const p of open) {
      const v = vmap.get(p.vendorId);
      if (!v?.fbPageId) continue; // 還沒設定粉專的 IP 不稽核（畫面會提示去設定）
      for (const pf of (p.platforms || []) as string[]) {
        if (!AUDITABLE_PLATFORMS.includes(pf as any)) continue;
        const prev: PlatformAudit | undefined = p.publishAudit?.[pf];
        if (isSettled(prev, now, p.scheduledAt)) continue;
        if (prev?.livePostId) claimed.delete(prev.livePostId); // 自己上次配到的那則可以再配給自己

        let live = await liveOf(p.vendorId);
        let audit = auditOne({ post: p, platform: pf, strictTiming: v.strict, live, now, claimed, previous: prev });
        // 自己帳號找不到 → 去別的 IP 帳號找（只在需要時才抓全部，省 Meta 呼叫）
        if (!audit.livePostId && audit.status !== 'pending') {
          await fetchAll();
          live = [...liveBy.values()].flat();
          audit = auditOne({ post: p, platform: pf, strictTiming: v.strict, live, now, claimed, previous: prev });
        }
        if (audit.livePostId) claimed.add(audit.livePostId);
        result.checked++;

        if (shouldAlert(audit)) {
          const text = `${AUDIT_STATUS_ICON[audit.status]} ${v.name} {PF}「${(p.title || '').slice(0, 20)}」${describeAudit(audit, p.scheduledAt, id => vmap.get(id)?.name || id)}`;
          alertLines.push({ postId: p.id, pf, line: text });
          audit.alertedAt = now.toISOString();
        }
        result.rows.push({ postId: p.id, vendorId: p.vendorId, vendorName: v.name, title: p.title || '', scheduledAt: p.scheduledAt, platform: pf, audit });

        const changed = !prev || prev.status !== audit.status || prev.livePostId !== audit.livePostId
          || prev.thumbnailUrl !== audit.thumbnailUrl || prev.alertedAt !== audit.alertedAt
          || prev.forScheduledAt !== audit.forScheduledAt;
        if (changed) {
          result.changed++;
          if (!dryRun) await db.collection('posts').doc(p.id).update({ [`publishAudit.${pf}`]: stripUndefined(audit) });
        }
      }
    }

    if (alertLines.length) {
      // 同一則貼文 IG/FB 同一句話 → 併成「IG/FB」一行
      const grouped = new Map<string, string[]>();
      for (const a of alertLines) grouped.set(`${a.postId}|${a.line}`, [...(grouped.get(`${a.postId}|${a.line}`) || []), a.pf]);
      result.alerts = [...grouped].map(([k, pfs]) => k.slice(k.indexOf('|') + 1).replace('{PF}', pfs.join('/')));
      const text = ['🔔 發布稽核', ...result.alerts, deps.appUrl ? `詳情：${deps.appUrl}/?tab=publishAudit` : ''].filter(Boolean).join('\n');
      if (!dryRun) await push(text);
    }
  }

  // 發布前檢查：RPA 機器人（rpa/meta_calendar.py）抄回新的 Meta 日曆就比一次（每抄一次最多推一則）
  try {
    const pre = await evaluatePrecheck(db, await getVendors(), now, !!dryRun);
    if (pre) {
      result.precheck = pre;
      if (!dryRun) await push(pre);
    }
  } catch (e: any) {
    console.error('publish-precheck failed', e?.message);
  }

  // 一天一次的工作：用 publishAuditReports/{日期} 記「推過了」，每分鐘的呼叫只有第一次會真的做
  const day = taipeiDay(now);
  const hhmm = taipeiTime(now);
  if (hhmm >= NOON_AT) {
    const ref = db.collection('publishAuditReports').doc(day);
    const meta = (await ref.get()).data() || {};
    if (hhmm < REPORT_AT && (!meta.noonSentAt || dryRun)) {
      const brief = await buildNoonBrief(db, await getVendors(), now);
      result.reminder = brief || undefined;
      if (!dryRun) {
        await ref.set({ day, noonSentAt: now.toISOString() }, { merge: true });
        if (brief) await push(brief);
      }
    }
    if (hhmm >= REPORT_AT && (!meta.reportSentAt || dryRun)) {
      const fresh = new Map(result.rows.map(r => [`${r.postId}|${r.platform}`, r.audit] as [string, PlatformAudit]));
      const report = await buildDailyReport(db, await getVendors(), now, metaToken, deps.appUrl, fresh);
      result.report = report.text;
      if (!dryRun) {
        await ref.set({ day, reportSentAt: now.toISOString(), text: report.text, unscheduled: report.unscheduled }, { merge: true });
        await push(report.text);
      }
    }
  }
  return result;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** 今晚（from 之後）還沒到時間的準時 IP 貼文，片子好了沒 */
async function upcomingReadiness(db: any, vmap: Map<string, VendorInfo>, now: Date, allVendors = false) {
  const nowStamp = taipeiStamp(now);
  const endStamp = `${taipeiDay(now)}T23:59`;
  const snap = await db.collection('posts').where('scheduledAt', '>', nowStamp).where('scheduledAt', '<=', endStamp).get();
  const posts = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((p: any) => vmap.has(p.vendorId) && (allVendors || (p.contentType !== 'post' && vmap.get(p.vendorId)?.strict)))
    .sort((a: any, b: any) => a.scheduledAt.localeCompare(b.scheduledAt));
  const out: { post: any; vendor: VendorInfo; ready: boolean; label: string }[] = [];
  for (const p of posts) {
    let ready = false; let label = '還沒有片';
    // 片可能直接掛在貼文上，也可能是「排上片日」指到這篇（asset.plannedPostId），兩邊都要找（11-05 康青龍）
    let a: any = null;
    if (p.assetId && p.assetId !== 'to_be_added') a = (await db.collection('assets').doc(p.assetId).get()).data();
    if (!a) {
      const s = await db.collection('assets').where('plannedPostId', '==', p.id).limit(3).get();
      a = s.docs.map((d: any) => d.data()).find((x: any) => !x.voidedAt) || null;
    }
    {
      if (a) {
        const stage = deriveFlowStage(a);
        if (stage === 'ready') { ready = true; label = '成片已好'; }
        else if (stage === 'to_upload') { label = '業主已過，成片還沒上傳'; }
        else if (stage === 'client_review') { label = '還在等業主審'; }
        else { label = '還在剪'; }
      }
    }
    out.push({ post: p, vendor: vmap.get(p.vendorId)!, ready, label });
  }
  return out;
}

/**
 * 12:00「今天要發哪些片」：今天還沒到時間的所有排程（每個 IP 都列，準時 IP 加標記），
 * 片子好了沒、Meta 上排了沒（機器人 11:55 看過的話）。沒有排程就不推。
 */
async function buildNoonBrief(db: any, vmap: Map<string, VendorInfo>, now: Date): Promise<string | null> {
  const items = await upcomingReadiness(db, vmap, now, true);
  if (!items.length) return null;
  const day = taipeiDay(now);
  const pre = (await db.collection('publishPrechecks').doc(day).get()).data();
  const calendars: Record<string, VendorCalendar> = pre?.vendors || {};
  const meta = new Map(precheckAll(items.filter(x => x.vendor.strict && calendars[x.vendor.id]).map(x => x.post), calendars)
    .map(r => [`${r.postId}|${r.platform}`, r.result]));
  const lines = items.map(x => {
    const p = x.post;
    const pfs = (p.platforms || []).join('/');
    const metaBits = (p.platforms || []).map((pf: string) => meta.get(`${p.id}|${pf}`)).filter(Boolean);
    const metaText = !metaBits.length ? '' : metaBits.every((r: any) => r.status === 'scheduled') ? '｜Meta 已排好 ✓'
      : `｜Meta ${metaBits.some((r: any) => r.status === 'unreadable') ? '讀不到' : '還沒排好'} ⚠️`;
    return `・${p.scheduledAt.slice(11, 16)} ${x.vendor.name}${x.vendor.strict ? '（準時）' : ''}「${(p.title || '').slice(0, 16)}」${pfs}｜${x.ready ? '成片已好 ✓' : `${x.label} ⚠️`}${metaText}`;
  });
  const extra = unmatchedCards(items.filter(x => x.vendor.strict).map(x => x.post), calendars, day, taipeiTime(now))
    .map(x => `❓ ${vmap.get(x.vendorId)?.name || ''} ${x.card.platform} Meta 排了 ${x.card.time}，系統今天沒有對應的排程 → 請確認`);
  return [`☀️ ${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} 今天要發的片（${items.length} 支）`, ...lines, ...extra].join('\n');
}

/**
 * 下班日報：昨天 18:00 ～ 今天 18:00 排定的貼文結果 ＋ 今晚準時 IP 的片好了沒 ＋ 準時 IP 系統沒排的貼文。
 * 晚上 20:00 的片在日報當下還沒發，所以**昨晚的結果放今天的日報**，今晚的只報「片好了沒」。
 */
export async function buildDailyReport(
  db: any, vmap: Map<string, VendorInfo>, now: Date, metaToken: string, appUrl?: string,
  fresh: Map<string, PlatformAudit> = new Map(), // 這一輪剛算、還沒寫回（或 dryRun 不寫）的結果優先
) {
  const fromStamp = taipeiStamp(new Date(now.getTime() - 24 * 3600_000));
  const nowStamp = taipeiStamp(now);
  const snap = await db.collection('posts').where('scheduledAt', '>', fromStamp).where('scheduledAt', '<=', nowStamp).get();
  const posts = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((p: any) => vmap.get(p.vendorId)?.fbPageId)
    .sort((a: any, b: any) => a.scheduledAt.localeCompare(b.scheduledAt));

  const lines: string[] = [];
  let okCount = 0;
  const claimed = new Set<string>();
  for (const p of posts) {
    const v = vmap.get(p.vendorId)!;
    // 同一則貼文 IG/FB 結果一樣就併成一行
    const byStatus = new Map<string, string[]>();
    let anyOk = false;
    for (const pf of (p.platforms || []) as string[]) {
      let a: PlatformAudit | undefined = fresh.get(`${p.id}|${pf}`) ?? p.publishAudit?.[pf];
      if (!a || a.status === 'unsupported' || a.forScheduledAt !== p.scheduledAt) continue;
      // 叫醒時間只到排定後 3 小時：前一晚的「還沒看到」到日報時就是整天沒發
      if (a.status === 'not_seen' && p.scheduledAt.slice(0, 10) < taipeiDay(now)) a = { ...a, status: 'missing' };
      if (a.livePostId) claimed.add(a.livePostId);
      if (a.status === 'ok' || a.status === 'skipped') { if (a.status === 'ok') anyOk = true; continue; }
      const text = describeAudit(a, p.scheduledAt, id => vmap.get(id)?.name || id);
      const key = `${AUDIT_STATUS_ICON[a.status]}|${text}`;
      byStatus.set(key, [...(byStatus.get(key) || []), pf]);
    }
    if (anyOk && !byStatus.size) okCount++;
    for (const [key, pfs] of byStatus) {
      const [icon, text] = key.split('|');
      lines.push(`${icon} ${v.name} ${pfs.join('/')}「${(p.title || '').slice(0, 16)}」${text}`);
    }
  }

  // 準時 IP 上系統沒排的貼文（可能是業主自己發的）→ 只列數量，細節看頁面
  const unscheduled: { vendorId: string; platform: string; publishedAt: string; caption: string; permalink?: string }[] = [];
  try {
    const pages = new Map((await listMetaPages(metaToken, now.getTime())).map(p => [p.id, p]));
    const sinceIso = taipeiToDate(fromStamp).toISOString();
    for (const v of [...vmap.values()].filter(v => v.strict && v.fbPageId)) {
      const live = (await fetchVendorLive(v, pages, sinceIso)).filter(l => l.publishedAt <= now.toISOString());
      for (const l of live.filter(l => !claimed.has(l.id))) {
        unscheduled.push({ vendorId: v.id, platform: l.platform, publishedAt: l.publishedAt, caption: (l.caption || '').slice(0, 60), permalink: l.permalink });
      }
    }
  } catch (e: any) {
    console.error('publish-audit unscheduled scan failed', e?.message);
  }

  const upcoming = await upcomingReadiness(db, vmap, now);
  const d = taipeiDay(now);
  const text = [
    `📋 ${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} 發布稽核（昨天 18:00～今天 18:00）`,
    ...(lines.length ? lines : ['沒有要注意的']),
    okCount ? `✅ 其他 ${okCount} 支正確` : '',
    unscheduled.length ? `❓ 準時 IP 有 ${unscheduled.length} 則系統沒排的貼文（可能是業主自己發的）` : '',
    upcoming.length ? '🌙 今晚待發' : '',
    ...upcoming.map(x => `・${x.vendor.name} ${x.post.scheduledAt.slice(11, 16)}「${(x.post.title || '').slice(0, 16)}」${x.ready ? '成片已好 ✓' : `${x.label} ⚠️`}`),
    appUrl ? `詳情：${appUrl}/?tab=publishAudit` : '',
  ].filter(Boolean).join('\n');
  return { text, unscheduled };
}

/**
 * 拿機器人抄回來的 Meta 日曆比今天還沒到時間的準時 IP 排程。
 * 同一份抄本只比一次（evaluatedFetchedAt），結果寫回同一份文件給頁面看。回傳要推的 LINE 文字（沒問題回 null）。
 */
async function evaluatePrecheck(db: any, vmap: Map<string, VendorInfo>, now: Date, dryRun: boolean): Promise<string | null> {
  const day = taipeiDay(now);
  const ref = db.collection('publishPrechecks').doc(day);
  const doc = (await ref.get()).data();
  if (!doc?.fetchedAt || (!dryRun && doc.evaluatedFetchedAt === doc.fetchedAt)) return null;

  const calendars: Record<string, VendorCalendar> = doc.vendors || {};
  const nowStamp = taipeiStamp(now);
  const snap = await db.collection('posts').where('scheduledAt', '>=', `${day}T00:00`).where('scheduledAt', '<=', `${day}T23:59`).get();
  const dayPosts = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((p: any) => vmap.get(p.vendorId)?.strict && vmap.get(p.vendorId)?.fbPageId);
  const posts = dayPosts.filter((p: any) => p.scheduledAt > nowStamp); // 已過時間的交給發布後稽核
  const rows = precheckAll(posts, calendars);
  const extra = unmatchedCards(dayPosts, calendars, day, taipeiTime(now));

  const titleOf = new Map(posts.map((p: any) => [p.id, p]));
  const lines: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    if (r.result.status === 'scheduled') continue;
    const p: any = titleOf.get(r.postId);
    const key = `${r.postId}|${PRECHECK_ICON[r.result.status]} ${vmap.get(r.vendorId)?.name || ''} {PF}「${(p?.title || '').slice(0, 16)}」${describePrecheck(r.result, p.scheduledAt)}`;
    grouped.set(key, [...(grouped.get(key) || []), r.platform]);
  }
  for (const [k, pfs] of grouped) lines.push(k.slice(k.indexOf('|') + 1).replace('{PF}', pfs.join('/')));
  for (const x of extra) {
    lines.push(`❓ ${vmap.get(x.vendorId)?.name || ''} ${x.card.platform} Meta 排了 ${x.card.time}，系統今天沒有對應的排程 → 請確認（業主自己排的就不用管）`);
  }

  if (!dryRun) {
    await ref.set({
      evaluatedFetchedAt: doc.fetchedAt,
      evaluatedAt: now.toISOString(),
      results: Object.fromEntries(rows.map(r => [`${r.postId}|${r.platform}`, r.result])),
      extra: extra.map(x => ({ vendorId: x.vendorId, ...x.card })),
    }, { merge: true });
  }
  if (!lines.length) return null;
  const at = taipeiTime(new Date(doc.fetchedAt));
  // 中午前那一輪（11:55）的結果併進 12:00「今天要發的片」，不另外推，免得 5 分鐘內收兩則
  if (at < NOON_AT) return null;
  return [`🗓️ 發布前檢查（${at} 看 Meta 排程）`, ...lines].join('\n');
}

/**
 * 今天「需要叫醒稽核」的時間點（台北 HH:mm）。2026-11-05 為了省資料庫讀取：
 * Cloudflare Worker 每分鐘醒來只看這份小抄（存在免費的 KV），時間點對到才叫剪輯系統，其他分鐘不碰資料庫。
 *
 * - 每支片排定時間後 0～15 分鐘每分鐘看（5 分鐘沒出現就警示、15 分鐘內補封面）
 * - 之後 20/30/45/60/75/90/120/180 分鐘再看幾次（實際常晚 1 小時才發：紅茶造咖 19:00→20:01）
 * - 機器人 11:55／17:30／18:00 讀完 Meta 排程後幾分鐘、12:00 今天要發的片、18:00 日報
 * Worker 另外每個整點會叫一次，順便更新小抄（同事中途改排程也跟得上）。
 */
const AFTER_OFFSETS = [...Array.from({ length: 16 }, (_, i) => i), 20, 30, 45, 60, 75, 90, 120, 180];
const FIXED_MINUTES = ['11:57', '11:58', '11:59', '12:00', '12:01', '17:31', '17:32', '17:33', '17:34', '18:00', '18:01', '18:02', '18:03', '18:04'];

export async function buildCheckPlan(db: any, now = new Date()): Promise<{ day: string; minutes: string[]; chaseMinutes: string[] }> {
  const day = taipeiDay(now);
  // 3 小時前排的也算進來（例如 21:00 的片晚發，凌晨前還要看幾次）；往後看 50 小時給催片算「前 48／24 小時」那一刻
  const from = taipeiStamp(new Date(now.getTime() - 3 * 3600_000));
  const snap = await db.collection('posts').where('scheduledAt', '>=', from).where('scheduledAt', '<=', taipeiStamp(new Date(now.getTime() + 50 * 3600_000))).get();
  const minutes = new Set(FIXED_MINUTES);
  const chaseMinutes = new Set<string>();
  for (const d of snap.docs) {
    const p = d.data();
    // 內部催片：上片前 48、24 小時那一刻（今天之內、還沒過的）
    if (p.contentType !== 'post') {
      for (const h of [48, 24]) {
        const t = new Date(taipeiToDate(p.scheduledAt).getTime() - h * 3600_000);
        if (taipeiDay(t) === day && t.getTime() >= now.getTime() - 60_000) chaseMinutes.add(taipeiTime(t));
      }
    }
    if (p.scheduledAt.slice(0, 10) > day) continue; // 明天以後的只為了催片
    if (!(p.platforms || []).some((pf: string) => AUDITABLE_PLATFORMS.includes(pf as any))) continue;
    const at = taipeiToDate(p.scheduledAt).getTime();
    for (const m of AFTER_OFFSETS) {
      const t = new Date(at + m * 60_000);
      if (taipeiDay(t) === day && t.getTime() >= now.getTime() - 60_000) minutes.add(taipeiTime(t));
    }
  }
  return { day, minutes: [...minutes].sort(), chaseMinutes: [...chaseMinutes].sort() };
}
