import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { addDays, format, parseISO } from 'date-fns';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import { auth, db } from '../firebase';
import { Asset, Editor, Post, Vendor } from '../types';
import { useLiveCollection } from '../lib/liveData';
import { isInternalWork } from '../lib/editorRoster';
import { progressStatus, StatusPill, VideoSteps } from './VideoProgressSteps';
import { assetOfPost, auditCounts, auditProgress, buildAuditRows, captionChecks, computePrecheck, precheckFreshness, TONE, tiktokNextCheck, type PrecheckDoc } from '../lib/publishAuditRows';
import {
  AUDIT_STATUS_ICON, AUDIT_STATUS_LABEL, AUDITABLE_PLATFORMS, describeAudit, type AuditStatus, type PlatformAudit,
} from '../lib/publishAudit';
import { describePrecheck, mergeCalendars, unmatchedCards, type VendorCalendar } from '../lib/publishPrecheck';

/**
 * 發布稽核（2026-11-05）：某一天排定的貼文，IG/FB 實際有沒有發、發在哪、時間對不對。
 * 資料是伺服器每分鐘寫進 posts.publishAudit 的；這頁只負責顯示，不另外算。
 * 18:00 日報的文字與「系統沒排的貼文」存在 publishAuditReports/{日期}。
 */

type Report = { text?: string; reportSentAt?: string; unscheduled?: { vendorId: string; platform: string; publishedAt: string; caption: string; permalink?: string }[] };

const todayTaipei = () => format(new Date(), 'yyyy-MM-dd');

export default function PublishAuditPage({ isEngineer = false }: { isEngineer?: boolean }) {
  const [day, setDay] = useState(todayTaipei());
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  // 發布前檢查：RPA 機器人（11:55、17:30、18:00）抄回來的 Meta 排程日曆
  const [precheckDoc, setPrecheckDoc] = useState<PrecheckDoc | null>(null);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  // 「立刻檢查」的結果（不寫資料庫、不推 LINE），蓋在畫面上直到換日期
  const [preview, setPreview] = useState<Record<string, PlatformAudit>>({});

  useEffect(() => onSnapshot(collection(db, 'vendors'), s => setVendors(s.docs.map(d => ({ id: d.id, ...d.data() } as Vendor)))), []);
  useEffect(() => {
    setPreview({});
    const q = query(collection(db, 'posts'), where('scheduledAt', '>=', `${day}T00:00`), where('scheduledAt', '<=', `${day}T23:59`));
    return onSnapshot(q, s => setPosts(s.docs.map(d => ({ id: d.id, ...d.data() } as Post))), e => console.warn('讀取貼文失敗', e));
  }, [day]);
  useEffect(() => onSnapshot(doc(db, 'publishAuditReports', day), s => setReport(s.exists() ? (s.data() as Report) : null), () => setReport(null)), [day]);
  useEffect(() => onSnapshot(doc(db, 'publishPrechecks', day), s => setPrecheckDoc(s.exists() ? (s.data() as any) : null), () => setPrecheckDoc(null)), [day]);

  const vmap = useMemo(() => new Map(vendors.map(v => [v.id!, v])), [vendors]);
  // 每支片的五站進度（跟董事行事曆同一套圓圈，11-06 使用者要求）
  const assets = useLiveCollection<Asset>('assets');
  const editors = useLiveCollection<Editor>('editors');
  // 跟伺服器用同一個 precheckAll 算，畫面不另外寫一套
  const precheck = useMemo(() => computePrecheck(precheckDoc, posts, vmap), [precheckDoc, posts, vmap]);
  // Meta 排了、系統當天卻沒有的（看機器人抄的那一刻之後的）
  const precheckExtra = useMemo(() => {
    if ((!precheckDoc?.vendors && !precheckDoc?.tiktok) || !(precheckDoc.fetchedAt || precheckDoc.tiktokFetchedAt)) return [];
    const strictPosts = posts.filter(p => vmap.get(p.vendorId)?.strictTiming);
    return unmatchedCards(strictPosts as any, mergeCalendars(precheckDoc.vendors, precheckDoc.tiktok), day,
      format(parseISO((precheckDoc.fetchedAt || precheckDoc.tiktokFetchedAt)!), 'HH:mm'));
  }, [precheckDoc, posts, vmap, day]);
  const vendorName = (id: string) => vmap.get(id)?.name || id;

  const rows = useMemo(() => buildAuditRows(posts, vmap, preview), [posts, vmap, preview]);
  const counts = useMemo(() => auditCounts(rows), [rows]);

  // 準時 IP 卻沒設粉專＝整家都沒在稽核，要讓人看得到
  // 只發 TikTok 的（依妍／縈寶）本來就不需要 FB 粉專，不能叫人去設
  const unconfigured = vendors.filter(v => v.strictTiming && !v.metaFbPageId && v.status !== 'ended'
    && [...(v.defaultPlatforms?.video || []), ...(v.defaultPlatforms?.post || [])].some(pf => pf === 'IG' || pf === 'FB'));

  const runNow = async () => {
    setRunning(true); setRunMsg('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const r = await fetch('/api/admin/publish-audit/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, dryRun: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `伺服器回 ${r.status}`);
      setPreview(Object.fromEntries((d.rows || []).map((x: any) => [`${x.postId}|${x.platform}`, x.audit])));
      setRunMsg(`查了 ${d.checked} 項（只檢查，不寫入、不推 LINE）`);
    } catch (e: any) {
      setRunMsg(e?.message || '檢查失敗');
    } finally {
      setRunning(false);
    }
  };

  const shift = (n: number) => setDay(format(addDays(parseISO(day), n), 'yyyy-MM-dd'));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div className="hidden md:block space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">發布稽核</h2>
          <p className="text-sm text-gray-500">排定時間一到，系統自動去 IG/FB 看有沒有發、發到哪個帳號、時間對不對；TikTok 由電腦上的機器人檢查（晚上的片隔天早上確認）。</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-white p-1 rounded-xl border border-black/5 shadow-sm">
            <button onClick={() => shift(-1)} className="p-1.5 rounded-lg text-gray-500 hover:text-[#1a1a1a]" title="前一天"><ChevronLeft size={16} /></button>
            <input type="date" value={day} onChange={e => e.target.value && setDay(e.target.value)} className="px-2 py-1 text-[13px] font-bold bg-transparent focus:outline-none" />
            <button onClick={() => shift(1)} className="p-1.5 rounded-lg text-gray-500 hover:text-[#1a1a1a]" title="後一天"><ChevronRight size={16} /></button>
          </div>
          {isEngineer && (
            <button onClick={runNow} disabled={running} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-black/5 shadow-sm text-[13px] font-bold text-gray-600 hover:text-[#5A5A40] whitespace-nowrap disabled:opacity-50" title="只檢查、不寫入、不推 LINE">
              <RefreshCw size={14} className={running ? 'animate-spin' : ''} /> 立刻檢查
            </button>
          )}
        </div>
      </div>
      {runMsg && <p className="text-[13px] text-gray-500 -mt-3">{runMsg}</p>}

      <div className="grid grid-cols-3 gap-3">
        {([['要注意', counts.problem, 'text-red-600'], ['正確', counts.ok, 'text-green-700'], ['還沒到／等待中', counts.pending, 'text-gray-500']] as const).map(([l, v, c]) => (
          <div key={l} className="bg-white rounded-2xl border border-black/5 shadow-sm px-5 py-4">
            <p className="text-[13px] font-bold text-gray-400 whitespace-nowrap">{l}</p>
            <p className={`text-2xl font-bold tabular-nums mt-0.5 ${c}`}>{v}</p>
          </div>
        ))}
      </div>

      {counts.problem + counts.ok === 0 && counts.pending > 0 && (
        <p className="text-[13px] text-gray-500 -mt-3">這天的片都還沒到發布時間；時間一到系統會自動去查，有問題會推 LINE。</p>
      )}
      <p className="text-[13px] text-gray-400 -mt-3">
        發布前檢查：{precheckDoc?.fetchedAt ? `機器人 ${format(parseISO(precheckDoc.fetchedAt), 'HH:mm')} 看過 Meta 排程` : '這天機器人還沒看過 Meta 排程（每天 09:35、11:55、17:30、18:00 自動看，電腦要開著）'}
        {(() => {
          const bad = [...Object.values<VendorCalendar>(precheckDoc?.vendors || {}).filter(v => !v.ok).map(v => `${v.name} Meta（${v.error}）`),
            ...Object.values<VendorCalendar>(precheckDoc?.tiktok || {}).filter(v => !v.ok).map(v => `${v.name} TikTok（${v.error}）`)];
          return bad.length ? <span className="text-red-500">　讀不到：{bad.join('、')}</span> : null;
        })()}
      </p>

      {precheckExtra.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-2xl px-5 py-3 text-[13px] text-amber-800 space-y-1">
          <p className="font-bold">❓ Meta 上排了、系統今天沒有對應的排程（業主自己排的就不用管）</p>
          {precheckExtra.map((x, i) => (
            <p key={i}>{vmap.get(x.vendorId)?.name} {x.card.platform} {x.card.time}</p>
          ))}
        </div>
      )}

      {unconfigured.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-2xl px-5 py-3 text-[13px] text-amber-800">
          這些準時 IP 還沒設定 FB 粉專，所以沒有在稽核：{unconfigured.map(v => v.name).join('、')}（到廠商管理 → 編輯 → 發布稽核設定）
        </div>
      )}

      <div className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-400">這天沒有排程</p>
        ) : (
          <ul className="divide-y divide-black/5">
            {rows.map(({ p, v, cells }) => {
              const asset = assetOfPost(p, assets);
              const prog = auditProgress(p, cells, precheck, asset, !!asset && isInternalWork(asset, vendors, editors));
              return (
              <li key={p.id} className="px-5 py-4 space-y-2">
                <div className="flex items-baseline gap-3 min-w-0">
                  <span className="text-[15px] font-bold tabular-nums whitespace-nowrap">{p.scheduledAt.slice(11, 16)}</span>
                  <span className="text-[15px] font-bold whitespace-nowrap">{v?.name || '（未知 IP）'}</span>
                  {v?.strictTiming && <span className="text-[12px] px-2 py-0.5 rounded-full bg-[#5A5A40]/10 text-[#5A5A40] font-bold whitespace-nowrap">準時</span>}
                  {p.status === 'draft' && <span className="text-[12px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-bold whitespace-nowrap" title="系統裡這則還是草稿，一樣會稽核">草稿</span>}
                  {p.autoPublished && <span className="text-[12px] px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-bold whitespace-nowrap" title="各平台都確認發出去，系統自動改成已發布">系統確認已發布</span>}
                  {p.autoPublished?.missingConfirm && <span className="text-[12px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-bold whitespace-nowrap" title="影片已經上線，但系統裡內部檢核或業主審核沒有勾">發了但沒勾審核</span>}
                  {!(p.content || '').trim() && p.status !== 'published' && <span className="text-[12px] px-2 py-0.5 rounded-full bg-red-50 text-red-600 font-bold whitespace-nowrap" title="系統裡這則還沒有文案，發的時候很容易忘了貼（11-05 好正點）">系統還沒填文案</span>}
                  <span className="text-[14px] text-gray-500 truncate min-w-0">{p.title}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 py-1">
                  <div className="w-full max-w-[400px]"><VideoSteps current={prog.current} /></div>
                  <div className="space-y-1">
                    <StatusPill {...progressStatus(prog.current, prog.note, p.scheduledAt)} />
                    {prog.current < 5 && (
                      // 文案三關：小燈號就好（11-06 使用者：標籤太複雜）。綠＝過了，紅色呼吸燈＝還沒
                      <div className="flex flex-wrap items-center gap-3">
                        {captionChecks(p).map(c => (
                          <span key={c.label} className="flex items-center gap-1.5 text-[13px] text-gray-500 whitespace-nowrap" title={c.ok ? `${c.label}：已完成` : c.wait}>
                            <span className="relative flex w-2.5 h-2.5">
                              {!c.ok && <span className="absolute inline-flex w-full h-full rounded-full bg-rose-400 opacity-50 animate-ping" />}
                              <span className={`relative inline-flex w-2.5 h-2.5 rounded-full ${c.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                            </span>
                            {c.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {cells.some(c => precheck.has(`${p.id}|${c.pf}`)) && (
                  // 後台排程：跟文案三關一樣用小燈號（11-06 使用者：整句「IG 後台還沒排（系統寫 19:00）」×3 太雜）。
                  // 綠＝排好、紅色呼吸燈＝還沒排、橘＝時間跟系統不同（後面寫後台的時間）、灰＝讀不到；滑過看完整說明
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-gray-500">
                    <span className="font-bold whitespace-nowrap">後台排程</span>
                    {(() => {
                      // 機器人看完之後才排的它不知道：舊結果的「沒排」用琥珀色、不閃，旁邊註明幾點看的（11-06 小編誤會）
                      const fr = precheckFreshness(precheckDoc?.fetchedAt || precheckDoc?.tiktokFetchedAt, p.scheduledAt);
                      const stale = !fr.fresh && cells.some(c => precheck.get(`${p.id}|${c.pf}`)?.status === 'not_scheduled');
                      return stale ? <span className="order-last text-[#80653A]">待確認・最後檢查 {fr.seenAt}{fr.next ? `・下次 ${fr.next}` : ''}</span> : null;
                    })()}
                    {cells.map(({ pf }) => {
                      const r = precheck.get(`${p.id}|${pf}`);
                      if (!r) return null;
                      const stale = r.status === 'not_scheduled' && !precheckFreshness(precheckDoc?.fetchedAt || precheckDoc?.tiktokFetchedAt, p.scheduledAt).fresh;
                      const dot = r.status === 'scheduled' ? 'bg-emerald-500' : r.status === 'not_scheduled' ? (stale ? 'bg-amber-400' : 'bg-rose-500') : r.status === 'time_diff' ? 'bg-amber-500' : 'bg-gray-300';
                      return (
                        <span key={pf} className="flex items-center gap-1.5 whitespace-nowrap" title={describePrecheck(r, p.scheduledAt)}>
                          <span className="relative flex w-2.5 h-2.5">
                            {r.status === 'not_scheduled' && !stale && <span className="absolute inline-flex w-full h-full rounded-full bg-rose-400 opacity-50 animate-ping" />}
                            <span className={`relative inline-flex w-2.5 h-2.5 rounded-full ${dot}`} />
                          </span>
                          {pf}{r.status === 'time_diff' && <span className="text-amber-700">（後台 {r.metaTime}）</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
                {/* 封面檢查（rpa/cover_check.py 在電腦上算，正式站沒有 ffmpeg）：發布後隔天早上 09:35 前會補上 */}
                {cells.some(c => p.coverCheck?.[c.pf]) && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-gray-500">
                    <span className="font-bold whitespace-nowrap">封面</span>
                    {cells.map(({ pf }) => {
                      const c = p.coverCheck?.[pf];
                      if (!c) return null;
                      const text = c.status === 'ok' ? '✅ 是影片第一幀'
                        : c.status === 'mismatch' ? `❌ 不是影片第一幀（差 ${c.distance}）`
                        : c.status === 'review' ? '👀 封面另外設計，請目視'
                        : c.status === 'skipped' ? `— ${c.note || '不檢查'}`
                        : `⚠️ ${c.note || '檢查失敗'}`;
                      return (
                        <span key={pf} className={`whitespace-nowrap ${c.status === 'mismatch' ? 'text-red-600 font-bold' : ''}`}>
                          {pf} {text}
                          {c.coverUrl && <a href={c.coverUrl} target="_blank" rel="noreferrer" className="ml-1 underline text-gray-400 hover:text-[#5A5A40]">看封面</a>}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {cells.map(({ pf, a, status, configured }) => {
                    const text = !configured && (pf === 'TikTok' || AUDITABLE_PLATFORMS.includes(pf as any))
                      ? (pf === 'TikTok' ? '這個 IP 還沒設定 TikTok 帳號' : '這個 IP 還沒設定粉專')
                      : a ? describeAudit(a, p.scheduledAt, vendorName)
                      : pf === 'TikTok' && status === 'pending' ? tiktokNextCheck(p.scheduledAt) : AUDIT_STATUS_LABEL[status];
                    return (
                      <div key={pf} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[13px] ${TONE[status]}`}>
                        <span className="font-bold whitespace-nowrap">{AUDIT_STATUS_ICON[status]} {pf}</span>
                        <span className="min-w-0">{text}</span>
                        {a?.permalink && (
                          <a href={a.permalink} target="_blank" rel="noreferrer" className="shrink-0 opacity-60 hover:opacity-100" title="打開這則貼文"><ExternalLink size={13} /></a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </div>

      {report && <DailyReportCard report={report} vendorName={vendorName} />}
    </div>
  );
}

/** 日報文字（跟 LINE 同一份）→ 一列一列的小卡。舊格式（沒有「｜」）就把最後一個」後面當狀態 */
function parseReportLine(line: string) {
  const m = line.match(/^(\p{Extended_Pictographic}️?|・)\s*/u);
  const icon = m ? m[1] : '';
  const body = m ? line.slice(m[0].length) : line;
  let [main, ...status] = body.split('｜');
  if (!status.length) {
    const i = main.lastIndexOf('」');
    if (i > 0 && i < main.length - 1) { status = [main.slice(i + 1).trim()]; main = main.slice(0, i + 1); }
  }
  return { icon, main, status };
}

function pillTone(s: string) {
  if (/❌/u.test(s)) return 'bg-red-50 text-red-700';
  if (/⚠️|⏰|❓/u.test(s)) return 'bg-amber-50 text-amber-700';
  if (/✓|✅/u.test(s)) return 'bg-green-50 text-green-700';
  return 'bg-gray-50 text-gray-600';
}

function DailyReportCard({ report, vendorName }: { report: Report; vendorName: (id: string) => string }) {
  const lines = (report.text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const title = lines.shift() || '18:00 日報';
  const problems: string[] = []; const tonight: string[] = [];
  let okCount = 0; let inTonight = false;
  for (const l of lines) {
    if (l.startsWith('詳情：') || l.startsWith('❓ 準時 IP 有')) continue;
    if (l.startsWith('🌙')) { inTonight = true; continue; }
    if (l === '沒有要注意的') continue;
    const ok = l.match(/^✅ 其他 (\d+) 支正確/);
    if (ok) { okCount = Number(ok[1]); continue; }
    (inTonight ? tonight : problems).push(l);
  }
  const unscheduled = report.unscheduled || [];
  const row = (l: string, i: number) => {
    const r = parseReportLine(l);
    return (
      <li key={i} className="flex items-start gap-2 py-2">
        <span className="w-5 shrink-0 text-center">{r.icon === '・' ? '' : r.icon}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[14px] text-gray-800">{r.main}</p>
          {r.status.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {r.status.map((s, j) => <span key={j} className={`text-[12px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${pillTone(s)}`}>{s.trim()}</span>)}
            </div>
          )}
        </div>
      </li>
    );
  };
  return (
    <div className="bg-white rounded-2xl border border-black/5 shadow-sm px-5 py-4 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[15px] font-bold text-gray-700">{title.replace(/^📋\s*/u, '')}</p>
        {report.reportSentAt && <span className="text-[12px] text-gray-400 whitespace-nowrap">{format(parseISO(report.reportSentAt), 'HH:mm')} 已推 LINE</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {([['要注意', problems.length, problems.length ? 'text-red-600' : 'text-gray-300'], ['正確', okCount, 'text-green-700'], ['今晚待發', tonight.length, 'text-gray-600']] as const).map(([l, v, c]) => (
          <div key={l} className="rounded-xl bg-gray-50 px-3 py-2">
            <p className="text-[12px] font-bold text-gray-400 whitespace-nowrap">{l}</p>
            <p className={`text-xl font-bold tabular-nums ${c}`}>{v}</p>
          </div>
        ))}
      </div>
      {problems.length > 0 && <ul className="divide-y divide-black/5">{problems.map(row)}</ul>}
      {tonight.length > 0 && (
        <div>
          <p className="text-[13px] font-bold text-gray-400">🌙 今晚待發</p>
          <ul className="divide-y divide-black/5">{tonight.map(row)}</ul>
        </div>
      )}
      {unscheduled.length > 0 && (
        <details className="rounded-xl bg-gray-50 px-3 py-2">
          <summary className="cursor-pointer text-[13px] text-gray-500">
            另外有 {unscheduled.length} 則系統沒排的貼文（多半是業主自己發的，不用處理）— 點開看
          </summary>
          <div className="mt-2 space-y-1.5">
            {unscheduled.map((u, i) => (
              <div key={i} className="flex items-center gap-2 text-[13px] text-gray-600 min-w-0">
                <span className="font-bold whitespace-nowrap">{vendorName(u.vendorId)} {u.platform}</span>
                <span className="tabular-nums whitespace-nowrap text-gray-400">{format(parseISO(u.publishedAt), 'MM/dd HH:mm')}</span>
                <span className="truncate min-w-0">{u.caption || '（沒有文案）'}</span>
                {u.permalink && <a href={u.permalink} target="_blank" rel="noreferrer" className="shrink-0 text-gray-400 hover:text-[#5A5A40]"><ExternalLink size={13} /></a>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
