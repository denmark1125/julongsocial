import { deriveFlowStage } from '../types.js';
import {
  AUDIT_STATUS_ICON, AUDITABLE_PLATFORMS, auditOne, describeAudit, isSettled, shouldAlert, taipeiDay, taipeiTime,
  taipeiToDate, type LivePost, type PlatformAudit,
} from './publishAudit.js';
import { fetchFacebookPosts, fetchInstagramPosts, listMetaPages, type MetaPage } from './metaGraph.js';

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

const LOOKBACK_HOURS = 26;
const REPORT_AT = '18:00';
const REMINDER_AT = '19:00';

/** 台北時間的「yyyy-MM-ddTHH:mm」，跟 posts.scheduledAt 同格式，可以直接字串比大小 */
function taipeiStamp(d: Date): string {
  return `${taipeiDay(d)}T${taipeiTime(d)}`;
}

interface VendorInfo { id: string; name: string; strict: boolean; fbPageId?: string; igPageId?: string }

async function loadVendors(db: any): Promise<Map<string, VendorInfo>> {
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
    .filter((p: any) => p.status !== 'draft' && p.scheduledAt)
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

  // 一天一次的工作：用 publishAuditReports/{日期} 記「推過了」，每分鐘的呼叫只有第一次會真的做
  const day = taipeiDay(now);
  const hhmm = taipeiTime(now);
  if (hhmm >= REPORT_AT) {
    const ref = db.collection('publishAuditReports').doc(day);
    const meta = (await ref.get()).data() || {};
    if (hhmm >= REPORT_AT && (!meta.reportSentAt || dryRun)) {
      const fresh = new Map(result.rows.map(r => [`${r.postId}|${r.platform}`, r.audit] as [string, PlatformAudit]));
      const report = await buildDailyReport(db, await getVendors(), now, metaToken, deps.appUrl, fresh);
      result.report = report.text;
      if (!dryRun) {
        await ref.set({ day, reportSentAt: now.toISOString(), text: report.text, unscheduled: report.unscheduled }, { merge: true });
        await push(report.text);
      }
    }
    if (hhmm >= REMINDER_AT && hhmm < '23:00' && (!meta.reminderSentAt || dryRun)) {
      const reminder = await buildReadinessReminder(db, await getVendors(), now, REMINDER_AT);
      result.reminder = reminder || undefined;
      if (!dryRun) {
        await ref.set({ day, reminderSentAt: now.toISOString() }, { merge: true });
        if (reminder) await push(reminder);
      }
    }
  }
  return result;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** 今晚（from 之後）還沒到時間的準時 IP 貼文，片子好了沒 */
async function upcomingReadiness(db: any, vmap: Map<string, VendorInfo>, now: Date) {
  const nowStamp = taipeiStamp(now);
  const endStamp = `${taipeiDay(now)}T23:59`;
  const snap = await db.collection('posts').where('scheduledAt', '>', nowStamp).where('scheduledAt', '<=', endStamp).get();
  const posts = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
    .filter((p: any) => p.status !== 'draft' && p.contentType !== 'post' && vmap.get(p.vendorId)?.strict)
    .sort((a: any, b: any) => a.scheduledAt.localeCompare(b.scheduledAt));
  const out: { post: any; vendor: VendorInfo; ready: boolean; label: string }[] = [];
  for (const p of posts) {
    let ready = false; let label = '還沒有片';
    if (p.assetId && p.assetId !== 'to_be_added') {
      const a = (await db.collection('assets').doc(p.assetId).get()).data();
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

async function buildReadinessReminder(db: any, vmap: Map<string, VendorInfo>, now: Date, at: string): Promise<string | null> {
  const items = (await upcomingReadiness(db, vmap, now)).filter(x => !x.ready);
  if (!items.length) return null;
  return [`⏳ ${at} 提醒：今晚準時 IP 還有片沒好`,
    ...items.map(x => `・${x.vendor.name} ${x.post.scheduledAt.slice(11, 16)}「${(x.post.title || '').slice(0, 20)}」${x.label}`)].join('\n');
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
    .filter((p: any) => p.status !== 'draft' && vmap.get(p.vendorId)?.fbPageId)
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
      const a: PlatformAudit | undefined = fresh.get(`${p.id}|${pf}`) ?? p.publishAudit?.[pf];
      if (!a || a.status === 'unsupported' || a.forScheduledAt !== p.scheduledAt) continue;
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
