import React, { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { addDays, format, getDay, isSameMonth, parseISO } from 'date-fns';
import { ArrowRight, Camera, CheckCircle2, ChevronDown, ChevronUp, ClipboardCheck, Download, Radio } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db } from '../firebase';
import { Asset, BillingContract, BillingRecord, DismissedHabit, Editor, Post, ShootBooking, UserRole, Vendor } from '../types';
import { useLiveCollection } from '../lib/liveData';
import { isInternalWork } from '../lib/editorRoster';
import { getAvailableVideoAssets, getOwedVideoCount, getVideoStockAlert, hasVideoTrackingScope, trackedVendors } from '../lib/vendorStatus';
import { buildDeficitRows } from '../lib/vendorDeficitRows';
import { AUDIT_STATUS_ICON, AUDIT_STATUS_LABEL } from '../lib/publishAudit';
import { assetOfPost, auditCounts, auditProgress, buildAuditRows, captionChecks, computePrecheck, type PrecheckDoc } from '../lib/publishAuditRows';
import { VIDEO_STEPS } from './VideoProgressSteps';
import EditReminderExportModal from './EditReminderExportModal';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 儀表板＝快速導覽（2026-11-06 改版）。一眼看完四件事：
 *  1. 今天的片發布到哪一站（跟發布稽核同一套算法，lib/publishAuditRows）
 *  2. 待處理：跟 LINE 通知講的同一類事情（稽核出錯、後台沒排、片沒好、文案沒寫、缺排程、催剪輯）
 *  3. 近 7 天排程＋拍攝總覽
 *  4. 哪個 IP 要約拍（跟製作進度同一套 buildDeficitRows）
 * 這頁只讀資料不寫入；多讀的只有今天的 publishPrechecks 一份文件。
 */

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

type Todo = { tone: 'red' | 'amber' | 'gray'; text: string; sub?: string; tab?: string };
const TODO_DOT = { red: 'bg-rose-500', amber: 'bg-amber-500', gray: 'bg-gray-300' };

export default function Dashboard({ setActiveTab, currentUserRole }: { setActiveTab: (tab: string) => void; currentUserRole?: UserRole }) {
  const posts = useLiveCollection<Post>('posts');
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const editors = useLiveCollection<Editor>('editors');
  const dismissedHabits = useLiveCollection<DismissedHabit>('dismissedHabits');
  const billingRecords = useLiveCollection<BillingRecord>('billingRecords');
  const contracts = useLiveCollection<BillingContract>('billingContracts');
  const bookings = useLiveCollection<ShootBooking>('shootBookings');
  const [precheckDoc, setPrecheckDoc] = useState<PrecheckDoc | null>(null);
  const [showAllTodos, setShowAllTodos] = useState(false);
  const [isEditReminderModalOpen, setIsEditReminderModalOpen] = useState(false);
  // 每分鐘重算一次「現在」，今晚的片過了時間會自己往下一站走
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  const today = format(now, 'yyyy-MM-dd');
  const nowStamp = format(now, "yyyy-MM-dd'T'HH:mm");
  const canAudit = currentUserRole === 'engineer' || currentUserRole === 'manager';

  useEffect(() => onSnapshot(doc(db, 'publishPrechecks', today), s => setPrecheckDoc(s.exists() ? (s.data() as PrecheckDoc) : null), () => setPrecheckDoc(null)), [today]);

  const vmap = useMemo(() => new Map(vendors.map(v => [v.id!, v])), [vendors]);
  const name = (id: string) => vmap.get(id)?.name || '未知IP';

  // ── 1. 今天的片 ──
  const todayPosts = useMemo(() => posts.filter(p => (p.scheduledAt || '').slice(0, 10) === today && vmap.has(p.vendorId)), [posts, today, vmap]);
  const precheck = useMemo(() => computePrecheck(precheckDoc, todayPosts, vmap), [precheckDoc, todayPosts, vmap]);
  const auditRows = useMemo(() => buildAuditRows(todayPosts, vmap), [todayPosts, vmap]);
  const counts = useMemo(() => auditCounts(auditRows), [auditRows]);
  const live = useMemo(() => auditRows
    .map(r => {
      const asset = assetOfPost(r.p, assets);
      const prog = auditProgress(r.p, r.cells, precheck, asset, !!asset && isInternalWork(asset, vendors, editors));
      // 系統是「已排程」但機器人看到後台沒排＝兩邊說法不同，以後台為準顯示紅字（還沒到時間才講）
      const notScheduled = r.p.scheduledAt > nowStamp && prog.current < 5
        ? r.cells.filter(c => precheck.get(`${r.p.id}|${c.pf}`)?.status === 'not_scheduled').map(c => c.pf) : [];
      const note = notScheduled.length ? `${notScheduled.join('/')} 後台還沒排`
        : prog.note.startsWith('已排程') ? `已排程・今天 ${r.p.scheduledAt.slice(11, 16)} 發布` : prog.note;
      return { ...r, prog: { current: prog.current, note }, notScheduled };
    })
    .sort((a, b) => a.p.scheduledAt.localeCompare(b.p.scheduledAt)),
  [auditRows, assets, precheck, vendors, editors, nowStamp]);
  const doneToday = live.filter(r => r.prog.current >= 5).length;

  // ── 4. 拍攝：哪個 IP 要約拍（製作進度同一套）＋庫存撐不到 14 天的 ──
  const deficitRows = useMemo(() => buildDeficitRows(vendors, posts, assets, bookings, today), [vendors, posts, assets, bookings, today]);
  const stock = useMemo(() => {
    const month = today.slice(0, 7);
    return new Map(vendors.filter(v => hasVideoTrackingScope(v, month)).map(v => {
      const free = getAvailableVideoAssets(v.id!, assets, posts);
      const owed = getOwedVideoCount(v, posts, assets, free.length);
      return [v.id!, getVideoStockAlert(v, free, owed)] as const;
    }));
  }, [vendors, assets, posts, today]);
  const needShoot = deficitRows
    .filter(r => !r.active && !r.isEnded && (r.owed > 0 || stock.get(r.vendor.id!)?.severity === 'shoot'))
    .map(r => {
      const s = stock.get(r.vendor.id!);
      const days = s?.totalRunwayDays != null ? Math.max(0, Math.floor(s.totalRunwayDays)) : null;
      return { r, days, urgent: r.sev === 'crit' || (days != null && days <= 7) };
    })
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.r.owed - a.r.owed);
  const overdueShoots = deficitRows.filter(r => r.overdue);
  const horizon = format(addDays(now, 14), 'yyyy-MM-dd');
  const upcomingShoots = bookings
    .filter(b => b.status === 'booked' && b.scheduledDate >= today && b.scheduledDate <= horizon)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || (a.startTime || '').localeCompare(b.startTime || ''));

  // ── 3. 近 7 天 ──
  const days = Array.from({ length: 7 }, (_, i) => format(addDays(now, i), 'yyyy-MM-dd'));
  const missing = useMemo(() => {
    const out: { vendorId: string; date: string; time: string }[] = [];
    for (const date of days) {
      const dow = getDay(parseISO(date));
      for (const v of trackedVendors(vendors)) {
        for (const h of (v.postingHabits || []).filter(h => h.daysOfWeek.includes(dow))) {
          if (dismissedHabits.some(d => d.vendorId === v.id && d.habitTime === h.time && d.date === date)) continue;
          // 前後一天有排就算有（沿用原本缺漏排程的判斷）
          const near = [format(addDays(parseISO(date), -1), 'yyyy-MM-dd'), date, format(addDays(parseISO(date), 1), 'yyyy-MM-dd')];
          if (posts.some(p => p.vendorId === v.id && near.includes((p.scheduledAt || '').slice(0, 10)))) continue;
          out.push({ vendorId: v.id!, date, time: h.time });
        }
      }
    }
    return out;
  }, [vendors, posts, dismissedHabits, days.join()]);

  // ── 2. 待處理（跟 LINE 通知同類的事） ──
  const todos: Todo[] = [];
  for (const r of live) {
    const t = r.p.scheduledAt.slice(11, 16);
    for (const c of r.cells) {
      if (['wrong_account', 'missing', 'no_caption'].includes(c.status)) todos.push({ tone: 'red', text: `${r.v?.name} ${c.pf} ${AUDIT_STATUS_LABEL[c.status]}`, sub: `今天 ${t}「${r.p.title}」`, tab: 'publishAudit' });
      else if (['not_seen', 'content_mismatch', 'time_mismatch'].includes(c.status)) todos.push({ tone: 'amber', text: `${r.v?.name} ${c.pf} ${AUDIT_STATUS_LABEL[c.status]}`, sub: `今天 ${t}「${r.p.title}」`, tab: 'publishAudit' });
    }
    if (r.p.scheduledAt > nowStamp && r.prog.current < 5) {
      if (r.notScheduled.length) todos.push({ tone: 'red', text: `${r.v?.name} 今天 ${t} ${r.notScheduled.join('/')} 後台還沒排`, sub: `機器人 ${precheckDoc?.fetchedAt ? format(parseISO(precheckDoc.fetchedAt), 'HH:mm') : ''} 看的・「${r.p.title}」`, tab: 'publishAudit' });
      else if (r.prog.current < 4) todos.push({ tone: r.prog.current < 3 ? 'red' : 'amber', text: `${r.v?.name} 今天 ${t}：${r.prog.note}`, sub: `「${r.p.title}」`, tab: 'publishAudit' });
    }
  }
  const tomorrow = days[1];
  for (const p of posts.filter(p => (p.scheduledAt || '').slice(0, 10) === tomorrow && vmap.has(p.vendorId) && p.status !== 'published')) {
    const stuck = captionChecks(p).filter(c => !c.ok).map(c => c.label);
    if (stuck.length) todos.push({ tone: 'amber', text: `${name(p.vendorId)} 明天 ${p.scheduledAt.slice(11, 16)} 文案待完成：${stuck.join('、')}`, sub: `「${p.title}」`, tab: 'posts' });
  }
  for (const r of overdueShoots) todos.push({ tone: 'amber', text: `${r.vendor.name} ${md(r.active!.scheduledDate)} 的拍攝還沒回報結果`, sub: '到製作進度按「拍完／延期／取消」', tab: 'shootBookings' });
  for (const m of missing) todos.push({ tone: 'amber', text: `${name(m.vendorId)} ${md(m.date)}（${WEEK[getDay(parseISO(m.date))]}）${m.time} 還沒排程`, sub: '依發片習慣應該要有一支', tab: 'posts' });
  const editAlerts = vendors.filter(v => stock.get(v.id!)?.severity === 'edit');
  for (const v of editAlerts) {
    const s = stock.get(v.id!)!;
    todos.push({ tone: 'amber', text: `${v.name} 成片只夠撐 ${Math.max(0, Math.floor(s.finishedRunwayDays!))} 天`, sub: `另有 ${s.rawStock} 部待剪，請催剪輯優先處理`, tab: 'videos' });
  }
  const in30 = format(addDays(now, 30), 'yyyy-MM-dd');
  for (const c of contracts.filter(c => c.status === 'active' && c.endDate && c.endDate >= today && c.endDate <= in30)) {
    todos.push({ tone: 'gray', text: `${name(c.vendorId)} 合約 ${md(c.endDate!)} 到期`, tab: 'billing' });
  }
  const unpaid = billingRecords.filter(r => r.status !== 'paid' && r.dueDate && isSameMonth(parseISO(r.dueDate), now));
  if (unpaid.length) todos.push({ tone: 'gray', text: `本月還有 ${unpaid.length} 筆帳款未收`, sub: `共 $${unpaid.reduce((s, r) => s + (r.amount || 0), 0).toLocaleString()}`, tab: 'billing' });
  const toneRank = { red: 0, amber: 1, gray: 2 };
  todos.sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
  const shownTodos = showAllTodos ? todos : todos.slice(0, 7);
  const redCount = todos.filter(t => t.tone === 'red').length;

  const weekShoots = bookings.filter(b => b.status === 'booked' && b.scheduledDate >= today && b.scheduledDate <= days[6]).length;
  const kpis = [
    { label: '今天要發', value: live.length, sub: live.length ? `已確認發出 ${doneToday} 支` : '今天沒有排程', tone: 'text-[#1a1a1a]', tab: canAudit ? 'publishAudit' : 'posts' },
    { label: '待處理', value: todos.filter(t => t.tone !== 'gray').length, sub: redCount ? `其中 ${redCount} 件要馬上處理` : '沒有緊急的事', tone: redCount ? 'text-rose-600' : 'text-[#1a1a1a]' },
    { label: '需要約拍', value: needShoot.length, sub: needShoot.length ? `${needShoot.filter(x => x.urgent).length} 個 IP 很急` : '每個 IP 都有安排', tone: needShoot.some(x => x.urgent) ? 'text-orange-600' : 'text-[#1a1a1a]', tab: 'shootBookings' },
    { label: '7 天內拍攝', value: weekShoots, sub: `14 天內共 ${upcomingShoots.length} 場`, tone: 'text-[#1a1a1a]', tab: 'shootCalendar' },
  ];

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xl md:text-2xl font-bold serif text-[#5A5A40] whitespace-nowrap">{md(today)}（{WEEK[getDay(now)]}）今日概況</h2>
        <span className="text-[13px] text-gray-400 whitespace-nowrap">{format(now, 'HH:mm')} 更新</span>
      </div>

      {/* 四個數字 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map(k => (
          <button key={k.label} onClick={() => k.tab && setActiveTab(k.tab)} disabled={!k.tab}
            className="text-left bg-white rounded-2xl border border-black/5 shadow-sm px-4 py-3 md:px-5 md:py-4 enabled:hover:border-[#5A5A40]/30 transition-colors">
            <p className="text-[13px] font-bold text-gray-400 whitespace-nowrap">{k.label}</p>
            <p className={cn('text-2xl md:text-3xl font-bold tabular-nums leading-tight', k.tone)}>{k.value}</p>
            <p className="text-[12px] text-gray-500 truncate">{k.sub}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6">
        {/* 今日發布即時動態 */}
        <section className="lg:col-span-8 bg-white rounded-3xl border border-black/5 shadow-sm p-4 md:p-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base md:text-lg font-bold serif flex items-center gap-2 whitespace-nowrap">
              <Radio size={18} className="text-[#5A5A40]" /> 今日發布動態
            </h3>
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-[12px] text-gray-400 truncate hidden sm:inline">
                {precheckDoc?.fetchedAt ? `機器人 ${format(parseISO(precheckDoc.fetchedAt), 'HH:mm')} 看過後台排程` : '機器人今天還沒看過後台排程'}
                {counts.problem > 0 && <span className="text-rose-600 font-bold">・{counts.problem} 項要注意</span>}
              </span>
              {canAudit && <GoLink onClick={() => setActiveTab('publishAudit')}>發布稽核</GoLink>}
            </div>
          </div>
          {live.length === 0 ? (
            <p className="py-8 text-center text-[14px] text-gray-400">今天沒有排程</p>
          ) : (
            <ul className="divide-y divide-black/5">
              {live.map(({ p, v, cells, prog, notScheduled }) => {
                const bad = notScheduled.length > 0 || cells.some(c => ['wrong_account', 'missing', 'no_caption'].includes(c.status));
                return (
                  <li key={p.id} className="py-3 grid grid-cols-[48px_1fr] gap-x-3 gap-y-1.5">
                    <span className={cn('text-[15px] font-bold tabular-nums', p.scheduledAt <= nowStamp ? 'text-gray-400' : 'text-[#1a1a1a]')}>{p.scheduledAt.slice(11, 16)}</span>
                    <div className="min-w-0 flex items-baseline gap-2">
                      <span className="text-[14px] font-bold whitespace-nowrap">{v?.name}</span>
                      {v?.strictTiming && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-[#5A5A40]/10 text-[#5A5A40] font-bold whitespace-nowrap">準時</span>}
                      <span className="text-[13px] text-gray-500 truncate min-w-0">{p.title}</span>
                    </div>
                    <span />
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4 min-w-0">
                      <MiniSteps current={prog.current} />
                      <span className={cn('text-[13px] font-bold truncate min-w-0', bad ? 'text-rose-600' : prog.current >= 5 ? 'text-[#5A5A40]' : 'text-orange-700')}>{prog.note}</span>
                      <div className="flex gap-1.5 sm:ml-auto shrink-0">
                        {cells.filter(c => c.status !== 'unsupported').map(c => (
                          <span key={c.pf} title={`${c.pf}：${AUDIT_STATUS_LABEL[c.status]}`}
                            className={cn('text-[12px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap border',
                              c.status === 'ok' ? 'bg-green-50 text-green-700 border-green-100'
                                : c.status === 'pending' ? 'bg-gray-50 text-gray-400 border-black/5'
                                : ['wrong_account', 'missing', 'no_caption'].includes(c.status) ? 'bg-red-50 text-red-700 border-red-100'
                                : 'bg-amber-50 text-amber-700 border-amber-100')}>
                            {c.status === 'pending' ? '' : `${AUDIT_STATUS_ICON[c.status]} `}{c.pf}
                          </span>
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 待處理 */}
        <section className="lg:col-span-4 bg-white rounded-3xl border border-black/5 shadow-sm p-4 md:p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base md:text-lg font-bold serif flex items-center gap-2 whitespace-nowrap">
              <ClipboardCheck size={18} className="text-[#5A5A40]" /> 待處理
            </h3>
          </div>
          {todos.length === 0 ? (
            <p className="py-8 text-center text-[14px] text-gray-400 flex items-center justify-center gap-1.5"><CheckCircle2 size={16} className="text-emerald-500" /> 目前沒有要處理的事</p>
          ) : (
            <>
              <ul className="space-y-1">
                {shownTodos.map((t, i) => (
                  <li key={i}>
                    <button onClick={() => t.tab && setActiveTab(t.tab === 'publishAudit' && !canAudit ? 'posts' : t.tab)}
                      className="w-full text-left flex items-start gap-2.5 px-2 py-2 rounded-xl hover:bg-[#F5F5F0] transition-colors">
                      <span className="relative flex w-2.5 h-2.5 mt-1.5 shrink-0">
                        {t.tone === 'red' && <span className="absolute inline-flex w-full h-full rounded-full bg-rose-400 opacity-50 animate-ping" />}
                        <span className={cn('relative inline-flex w-2.5 h-2.5 rounded-full', TODO_DOT[t.tone])} />
                      </span>
                      <span className="min-w-0">
                        <span className={cn('block text-[14px] font-bold', t.tone === 'gray' ? 'text-gray-500' : 'text-gray-800')}>{t.text}</span>
                        {t.sub && <span className="block text-[12px] text-gray-400 truncate">{t.sub}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {todos.length > 7 && (
                <button onClick={() => setShowAllTodos(x => !x)} className="w-full text-[13px] font-bold text-[#5A5A40] flex items-center justify-center gap-1 py-1">
                  {showAllTodos ? <>收起 <ChevronUp size={14} /></> : <>還有 {todos.length - 7} 件 <ChevronDown size={14} /></>}
                </button>
              )}
              {editAlerts.length > 0 && (
                <button onClick={() => setIsEditReminderModalOpen(true)} className="w-full text-[13px] font-bold text-gray-500 hover:text-[#5A5A40] flex items-center justify-center gap-1.5 py-1">
                  <Download size={14} /> 導出催剪輯清單
                </button>
              )}
            </>
          )}
        </section>

        {/* 近 7 天排程＋拍攝 */}
        <section className="lg:col-span-8 bg-white rounded-3xl border border-black/5 shadow-sm p-4 md:p-6 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base md:text-lg font-bold serif whitespace-nowrap">近 7 天排程總覽</h3>
            <GoLink onClick={() => setActiveTab('calendar')}>排程行事曆</GoLink>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-gray-400">
            <Legend cls="bg-[#5A5A40]">已排程</Legend>
            <Legend cls="bg-emerald-500">已發布</Legend>
            <Legend cls="bg-gray-300">草稿</Legend>
            <Legend cls="bg-rose-500">文案未完成（今明兩天）</Legend>
            <span className="flex items-center gap-1"><Camera size={12} /> 拍攝</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
            {days.map((d, i) => {
              const dayPosts = posts.filter(p => (p.scheduledAt || '').slice(0, 10) === d && vmap.has(p.vendorId)).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
              const dayShoots = bookings.filter(b => b.status === 'booked' && b.scheduledDate === d);
              const dayMissing = missing.filter(m => m.date === d);
              return (
                <div key={d} className={cn('rounded-2xl p-2 min-w-0 space-y-1', i === 0 ? 'bg-[#5A5A40]/[0.07] ring-1 ring-[#5A5A40]/20' : 'bg-[#F5F5F0]')}>
                  <p className="text-[13px] font-bold text-gray-600 whitespace-nowrap px-1">
                    {i === 0 ? '今天' : i === 1 ? '明天' : md(d)} <span className="text-gray-400 font-normal">{WEEK[getDay(parseISO(d))]}</span>
                    <span className="sm:hidden text-gray-400 font-normal">　{dayPosts.length} 支</span>
                  </p>
                  {dayShoots.map(b => (
                    <div key={b.id} title={b.title || ''} className="flex items-center gap-1 text-[12px] px-1.5 py-1 rounded-lg bg-white border border-[#5A5A40]/20 text-[#5A5A40] font-bold min-w-0">
                      <Camera size={12} className="shrink-0" />
                      <span className="truncate">{b.startTime ? `${b.startTime} ` : ''}{name(b.vendorId)}</span>
                    </div>
                  ))}
                  {dayPosts.map(p => {
                    const captionDone = captionChecks(p).every(c => c.ok);
                    const dot = p.status === 'published' ? 'bg-emerald-500' : p.status === 'scheduled' ? 'bg-[#5A5A40]' : 'bg-gray-300';
                    return (
                      <div key={p.id} title={`${p.title}${captionDone ? '' : `（文案未完成：${captionChecks(p).filter(c => !c.ok).map(c => c.label).join('、')}）`}`} className="flex items-center gap-1.5 text-[12px] px-1.5 py-0.5 min-w-0">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', dot)} />
                        <span className="tabular-nums text-gray-400 shrink-0">{p.scheduledAt.slice(11, 16)}</span>
                        <span className="truncate text-gray-700">{name(p.vendorId)}</span>
                        {!captionDone && i <= 1 && p.status !== 'published' && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />}
                      </div>
                    );
                  })}
                  {dayMissing.map((m, j) => (
                    <div key={j} className="text-[12px] px-1.5 py-0.5 rounded-lg border border-dashed border-amber-300 text-amber-700 truncate" title="依發片習慣這天應該要有一支">
                      {m.time} {name(m.vendorId)} 缺
                    </div>
                  ))}
                  {!dayPosts.length && !dayShoots.length && !dayMissing.length && <p className="text-[12px] text-gray-300 px-1">—</p>}
                </div>
              );
            })}
          </div>
        </section>

        {/* 拍攝安排 */}
        <section className="lg:col-span-4 bg-white rounded-3xl border border-black/5 shadow-sm p-4 md:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base md:text-lg font-bold serif flex items-center gap-2 whitespace-nowrap"><Camera size={18} className="text-[#5A5A40]" /> 拍攝安排</h3>
            <GoLink onClick={() => setActiveTab('shootBookings')}>製作進度</GoLink>
          </div>
          <div className="space-y-1.5">
            <p className="text-[13px] font-bold text-gray-400">還沒約拍的 IP</p>
            {needShoot.length === 0 ? (
              <p className="text-[13px] text-gray-400 py-2">每個要拍的 IP 都已經約好了</p>
            ) : needShoot.map(({ r, days: left, urgent }) => (
              <button key={r.vendor.id} onClick={() => setActiveTab('shootBookings')}
                className={cn('w-full text-left flex items-center justify-between gap-2 px-3 py-2 rounded-xl', urgent ? 'bg-orange-50' : 'bg-[#F5F5F0]')}>
                <span className="text-[14px] font-bold truncate min-w-0 flex items-center gap-2">
                  {urgent && <span className="relative flex w-2 h-2 shrink-0"><span className="absolute inline-flex w-full h-full rounded-full bg-orange-400 opacity-60 animate-ping" /><span className="relative inline-flex w-2 h-2 rounded-full bg-orange-500" /></span>}
                  {r.vendor.name}
                </span>
                <span className={cn('text-[12px] font-bold whitespace-nowrap', urgent ? 'text-orange-700' : 'text-gray-500')}>
                  {[r.owed > 0 ? `欠 ${r.owed} 支` : '', left != null ? `庫存剩 ${left} 天` : `庫存 ${r.stock} 支`].filter(Boolean).join('・')}
                </span>
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <p className="text-[13px] font-bold text-gray-400">接下來 14 天</p>
            {upcomingShoots.length === 0 ? (
              <p className="text-[13px] text-gray-400 py-2">還沒有約好的拍攝</p>
            ) : upcomingShoots.slice(0, 6).map(b => (
              <div key={b.id} className="flex items-baseline gap-3 px-1 text-[13px] min-w-0">
                <span className="font-bold tabular-nums whitespace-nowrap w-[72px] shrink-0">{b.scheduledDate === today ? '今天' : md(b.scheduledDate)}（{WEEK[getDay(parseISO(b.scheduledDate))]}）</span>
                <span className="tabular-nums text-gray-400 w-10 shrink-0">{b.startTime || ''}</span>
                <span className="font-bold truncate min-w-0">{name(b.vendorId)}</span>
                {b.crew && <span className="text-gray-400 truncate">{b.crew}</span>}
              </div>
            ))}
            {upcomingShoots.length > 6 && <GoLink onClick={() => setActiveTab('shootCalendar')}>還有 {upcomingShoots.length - 6} 場，看拍攝行事曆</GoLink>}
          </div>
        </section>
      </div>

      <EditReminderExportModal isOpen={isEditReminderModalOpen} onClose={() => setIsEditReminderModalOpen(false)} vendors={vendors} assets={assets} posts={posts} />
    </div>
  );
}

/** 五站縮小版：小圓點＋線，目前這站橘色呼吸燈（完整版在發布稽核頁） */
function MiniSteps({ current }: { current: number }) {
  return (
    <div className="flex items-center shrink-0" title={VIDEO_STEPS.map((s, i) => `${i < current ? '✓' : i === current ? '▶' : '・'}${s}`).join(' ')}>
      {VIDEO_STEPS.map((s, i) => (
        <React.Fragment key={s}>
          <span className="relative flex w-3 h-3">
            {i === current && <span className="absolute inline-flex w-full h-full rounded-full bg-orange-400 opacity-50 animate-ping" />}
            <span className={cn('relative inline-flex w-3 h-3 rounded-full border-2',
              i < current ? 'bg-[#5A5A40] border-[#5A5A40]' : i === current ? 'bg-orange-500 border-orange-500' : 'bg-white border-gray-200')} />
          </span>
          {i < VIDEO_STEPS.length - 1 && <span className={cn('w-4 h-[2px]', i < current ? 'bg-[#5A5A40]' : 'bg-gray-200')} />}
        </React.Fragment>
      ))}
    </div>
  );
}

function GoLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="text-[13px] text-[#5A5A40] font-bold hover:underline flex items-center gap-0.5 whitespace-nowrap">
      {children} <ArrowRight size={13} />
    </button>
  );
}

function Legend({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className="flex items-center gap-1"><span className={cn('w-2 h-2 rounded-full', cls)} />{children}</span>;
}
