import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { addDays, format, parseISO } from 'date-fns';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import { auth, db } from '../firebase';
import { Post, Vendor } from '../types';
import {
  AUDIT_STATUS_ICON, AUDIT_STATUS_LABEL, AUDITABLE_PLATFORMS, describeAudit, type AuditStatus, type PlatformAudit,
} from '../lib/publishAudit';
import { describePrecheck, PRECHECK_ICON, precheckAll, unmatchedCards, type PrecheckResult, type VendorCalendar } from '../lib/publishPrecheck';

/**
 * 發布稽核（2026-11-05）：某一天排定的貼文，IG/FB 實際有沒有發、發在哪、時間對不對。
 * 資料是伺服器每分鐘寫進 posts.publishAudit 的；這頁只負責顯示，不另外算。
 * 18:00 日報的文字與「系統沒排的貼文」存在 publishAuditReports/{日期}。
 */

type Report = { text?: string; reportSentAt?: string; unscheduled?: { vendorId: string; platform: string; publishedAt: string; caption: string; permalink?: string }[] };

// 問題排前面，眼睛先看到要處理的
const SEVERITY: Record<AuditStatus, number> = {
  wrong_account: 0, missing: 1, not_seen: 2, content_mismatch: 3, time_mismatch: 4, pending: 5, ok: 6, skipped: 7, unsupported: 8,
};
const TONE: Record<AuditStatus, string> = {
  wrong_account: 'bg-red-50 text-red-700 border-red-100',
  missing: 'bg-red-50 text-red-700 border-red-100',
  not_seen: 'bg-amber-50 text-amber-700 border-amber-100',
  content_mismatch: 'bg-amber-50 text-amber-700 border-amber-100',
  time_mismatch: 'bg-amber-50 text-amber-700 border-amber-100',
  pending: 'bg-gray-50 text-gray-500 border-black/5',
  ok: 'bg-green-50 text-green-700 border-green-100',
  skipped: 'bg-gray-50 text-gray-400 border-black/5',
  unsupported: 'bg-gray-50 text-gray-300 border-black/5',
};

const todayTaipei = () => format(new Date(), 'yyyy-MM-dd');

export default function PublishAuditPage({ isEngineer = false }: { isEngineer?: boolean }) {
  const [day, setDay] = useState(todayTaipei());
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  // 發布前檢查：RPA 機器人（11:55、17:30、18:00）抄回來的 Meta 排程日曆
  const [precheckDoc, setPrecheckDoc] = useState<{ fetchedAt?: string; vendors?: Record<string, VendorCalendar> } | null>(null);
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
  // 跟伺服器用同一個 precheckAll 算，畫面不另外寫一套
  const precheck = useMemo(() => {
    if (!precheckDoc?.vendors) return new Map<string, PrecheckResult>();
    const strictPosts = posts.filter(p => vmap.get(p.vendorId)?.strictTiming && precheckDoc.vendors![p.vendorId]);
    return new Map(precheckAll(strictPosts as any, precheckDoc.vendors).map(r => [`${r.postId}|${r.platform}`, r.result]));
  }, [precheckDoc, posts, vmap]);
  // Meta 排了、系統當天卻沒有的（看機器人抄的那一刻之後的）
  const precheckExtra = useMemo(() => {
    if (!precheckDoc?.vendors || !precheckDoc.fetchedAt) return [];
    const strictPosts = posts.filter(p => vmap.get(p.vendorId)?.strictTiming);
    return unmatchedCards(strictPosts as any, precheckDoc.vendors, day, format(parseISO(precheckDoc.fetchedAt), 'HH:mm'));
  }, [precheckDoc, posts, vmap, day]);
  const vendorName = (id: string) => vmap.get(id)?.name || id;

  // 草稿也列：排上片日自動建的貼文一開始就是草稿，小編不一定會改成已排程，但那天一樣要發
  const rows = useMemo(() => posts
    .map(p => {
      const v = vmap.get(p.vendorId);
      const cells = (p.platforms || []).map(pf => {
        const fresh = preview[`${p.id}|${pf}`];
        const saved = p.publishAudit?.[pf];
        const a = fresh || (saved && saved.forScheduledAt === p.scheduledAt ? saved : undefined);
        const configured = !!v?.metaFbPageId;
        // 沒設粉專＝根本沒在查，不能顯示成「等待中」騙人，跟尚未支援的平台一樣灰掉、不計數
        const status: AuditStatus = !AUDITABLE_PLATFORMS.includes(pf as any) || !configured ? 'unsupported' : (a?.status || 'pending');
        return { pf, a, status, configured };
      });
      const worst = Math.min(...cells.map(c => SEVERITY[c.status]), 99);
      return { p, v, cells, worst };
    })
    .sort((a, b) => a.worst - b.worst || a.p.scheduledAt.localeCompare(b.p.scheduledAt)),
  [posts, vmap, preview]);

  const counts = useMemo(() => {
    const c = { problem: 0, ok: 0, pending: 0 };
    for (const r of rows) for (const x of r.cells) {
      if (x.status === 'unsupported' || x.status === 'skipped') continue;
      if (x.status === 'ok') c.ok++; else if (x.status === 'pending') c.pending++; else c.problem++;
    }
    return c;
  }, [rows]);

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
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">發布稽核</h2>
          <p className="text-sm text-gray-500">排定時間一到，系統自動去 IG/FB 看有沒有發、發到哪個帳號、時間對不對。TikTok 之後接。</p>
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

      <p className="text-[13px] text-gray-400 -mt-3">
        發布前檢查：{precheckDoc?.fetchedAt ? `機器人 ${format(parseISO(precheckDoc.fetchedAt), 'HH:mm')} 看過 Meta 排程` : '這天機器人還沒看過 Meta 排程（每天 11:55、17:30、18:00 自動看，電腦要開著）'}
        {precheckDoc?.vendors && Object.values<VendorCalendar>(precheckDoc.vendors).some(v => !v.ok) && (
          <span className="text-red-500">　讀不到：{Object.values<VendorCalendar>(precheckDoc.vendors).filter(v => !v.ok).map(v => `${v.name}（${v.error}）`).join('、')}</span>
        )}
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
            {rows.map(({ p, v, cells }) => (
              <li key={p.id} className="px-5 py-4 space-y-2">
                <div className="flex items-baseline gap-3 min-w-0">
                  <span className="text-[15px] font-bold tabular-nums whitespace-nowrap">{p.scheduledAt.slice(11, 16)}</span>
                  <span className="text-[15px] font-bold whitespace-nowrap">{v?.name || '（未知 IP）'}</span>
                  {v?.strictTiming && <span className="text-[12px] px-2 py-0.5 rounded-full bg-[#5A5A40]/10 text-[#5A5A40] font-bold whitespace-nowrap">準時</span>}
                  {p.status === 'draft' && <span className="text-[12px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-bold whitespace-nowrap" title="系統裡這則還是草稿，一樣會稽核">草稿</span>}
                  <span className="text-[14px] text-gray-500 truncate min-w-0">{p.title}</span>
                </div>
                {cells.some(c => precheck.has(`${p.id}|${c.pf}`)) && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-gray-500">
                    <span className="font-bold whitespace-nowrap">發布前（Meta 排程）</span>
                    {cells.map(({ pf }) => {
                      const r = precheck.get(`${p.id}|${pf}`);
                      return r ? <span key={pf} className="whitespace-nowrap">{PRECHECK_ICON[r.status]} {pf} {describePrecheck(r, p.scheduledAt)}</span> : null;
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
                    const text = !configured && AUDITABLE_PLATFORMS.includes(pf as any)
                      ? '這個 IP 還沒設定粉專'
                      : a ? describeAudit(a, p.scheduledAt, vendorName) : AUDIT_STATUS_LABEL[status];
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
            ))}
          </ul>
        )}
      </div>

      {report && (
        <div className="bg-white rounded-2xl border border-black/5 shadow-sm px-5 py-4 space-y-3">
          <p className="text-[13px] font-bold text-gray-400">
            18:00 日報{report.reportSentAt ? `（${format(parseISO(report.reportSentAt), 'HH:mm')} 已推 LINE）` : ''}
          </p>
          {report.text && <pre className="whitespace-pre-wrap text-[14px] leading-relaxed font-sans text-gray-700">{report.text}</pre>}
          {!!report.unscheduled?.length && (
            <div className="space-y-1.5">
              <p className="text-[13px] font-bold text-gray-500">❓ 準時 IP 上系統沒排的貼文（可能是業主自己發的）</p>
              {report.unscheduled.map((u, i) => (
                <div key={i} className="flex items-center gap-2 text-[13px] text-gray-600 min-w-0">
                  <span className="font-bold whitespace-nowrap">{vendorName(u.vendorId)} {u.platform}</span>
                  <span className="tabular-nums whitespace-nowrap text-gray-400">{format(parseISO(u.publishedAt), 'MM/dd HH:mm')}</span>
                  <span className="truncate min-w-0">{u.caption || '（沒有文案）'}</span>
                  {u.permalink && <a href={u.permalink} target="_blank" rel="noreferrer" className="shrink-0 text-gray-400 hover:text-[#5A5A40]"><ExternalLink size={13} /></a>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
