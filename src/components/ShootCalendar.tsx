import React, { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, X, Check, CalendarClock } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db, auth } from '../firebase';
import { useLiveCollection } from '../lib/liveData';
import { BookingReason, CalendarEvent, CalendarEventCategory, ShootBooking, UserProfile, Vendor } from '../types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 拍攝行事曆（製作進度的子分頁，2026-10-29）。
// 拍攝預約＝shootBookings（系統內 IP，TimeTree 自動匯入＋這裡手動約）；
// 諮詢／簽約／會議／數據＝calendarEvents（TimeTree 同步過來，這裡唯讀）。

type Filter = '拍攝' | Exclude<CalendarEventCategory, '拍攝'>;
const FILTERS: Filter[] = ['拍攝', '諮詢', '簽約', '會議', '數據分析'];
const EVENT_STYLE: Record<CalendarEventCategory, string> = {
  拍攝: 'bg-[#E8E6D9] text-[#5A5A40]',
  諮詢: 'bg-sky-100 text-sky-700',
  簽約: 'bg-emerald-100 text-emerald-700',
  會議: 'bg-gray-100 text-gray-600',
  數據分析: 'bg-violet-100 text-violet-700',
};
const BOOKING_STYLE = {
  booked: 'bg-[#5A5A40] text-white',
  completed: 'bg-green-100 text-green-700',
} as const;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

type Item =
  | { kind: 'booking'; date: string; time?: string; label: string; booking: ShootBooking }
  | { kind: 'event'; date: string; time?: string; label: string; event: CalendarEvent };

type Draft = {
  id?: string;
  vendorId: string;
  scheduledDate: string;
  startTime: string;
  location: string;
  crew: string;
  expectedCount: string;
  note: string;
};

const emptyDraft = (date: string): Draft => ({ vendorId: '', scheduledDate: date, startTime: '', location: '', crew: '', expectedCount: '', note: '' });

export default function ShootCalendar() {
  const vendors = useLiveCollection<Vendor>('vendors');
  const bookings = useLiveCollection<ShootBooking>('shootBookings');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [me, setMe] = useState<UserProfile | null>(null);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [hidden, setHidden] = useState<Set<Filter>>(new Set());
  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [action, setAction] = useState<null | 'done' | 'delay' | 'cancel'>(null);
  const [reason, setReason] = useState<BookingReason>('client');
  const [newDate, setNewDate] = useState('');
  const [doneCount, setDoneCount] = useState(1);
  const [viewEvent, setViewEvent] = useState<CalendarEvent | null>(null);

  const gridStart = startOfWeek(startOfMonth(month));
  const gridEnd = endOfWeek(endOfMonth(month));
  const from = format(gridStart, 'yyyy-MM-dd');
  const to = format(gridEnd, 'yyyy-MM-dd');
  const today = format(new Date(), 'yyyy-MM-dd');

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    return onSnapshot(doc(db, 'users', uid), snap => snap.exists() && setMe(snap.data() as UserProfile));
  }, []);

  // 只讀畫面上這幾週：整本有幾百筆，每次切過來全讀會吃 Firestore 免費額度
  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'calendarEvents'), where('date', '>=', from), where('date', '<=', to)),
      snap => setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() } as CalendarEvent))),
      () => setEvents([]),
    );
  }, [from, to]);

  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name || '未知IP';
  // 跟 TimeTree 一樣寫成「IP＋事由」：TimeTree 來的照原標題，系統約的組成「大發超哥拍攝-年菜」
  const bookingLabel = (b: ShootBooking) => b.title || `${vendorName(b.vendorId)}拍攝${b.note ? `-${b.note}` : ''}`;
  const bookableVendors = useMemo(
    () => vendors.filter(v => v.status !== 'ended').sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
    [vendors],
  );

  const itemsByDate = useMemo(() => {
    const map = new Map<string, Item[]>();
    const push = (it: Item) => map.set(it.date, [...(map.get(it.date) || []), it]);
    if (!hidden.has('拍攝')) {
      for (const b of bookings) {
        if (b.status !== 'booked' && b.status !== 'completed') continue;
        if (b.scheduledDate < from || b.scheduledDate > to) continue;
        push({ kind: 'booking', date: b.scheduledDate, time: b.startTime, label: bookingLabel(b), booking: b });
      }
    }
    for (const e of events) {
      if (hidden.has(e.category as Filter)) continue;
      push({ kind: 'event', date: e.date, time: e.startTime, label: e.title, event: e });
    }
    for (const list of map.values()) list.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    return map;
  }, [bookings, events, hidden, from, to, vendors]);

  const upcoming = bookings
    .filter(b => b.status === 'booked' && b.scheduledDate >= today)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || (a.startTime || '').localeCompare(b.startTime || ''))
    .slice(0, 20);

  const days: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

  const editing = draft?.id ? bookings.find(b => b.id === draft.id) : undefined;
  const fromTimeTree = !!editing?.timetreeUuid;

  function openBooking(b: ShootBooking) {
    setAction(null);
    setDraft({
      id: b.id, vendorId: b.vendorId, scheduledDate: b.scheduledDate, startTime: b.startTime || '',
      location: b.location || '', crew: b.crew || '', expectedCount: b.expectedCount ? String(b.expectedCount) : '', note: b.note || '',
    });
  }

  function closeDraft() {
    setDraft(null);
    setAction(null);
  }

  async function saveDraft() {
    if (!draft || !me) return;
    if (!draft.vendorId) return toast.error('請選 IP');
    if (!draft.scheduledDate) return toast.error('請選日期');
    const fields = {
      startTime: draft.startTime, location: draft.location.trim(), crew: draft.crew.trim(), note: draft.note.trim(),
      expectedCount: Number(draft.expectedCount) || 0,
    };
    try {
      if (draft.id) {
        // TimeTree 來的：IP／日期／時間以 TimeTree 為準，這裡只改系統自己的欄位
        await updateDoc(doc(db, 'shootBookings', draft.id), fromTimeTree
          ? { location: fields.location, crew: fields.crew, note: fields.note, expectedCount: fields.expectedCount }
          : { ...fields, vendorId: draft.vendorId, scheduledDate: draft.scheduledDate });
        toast.success('已更新');
      } else {
        await addDoc(collection(db, 'shootBookings'), {
          ...fields, vendorId: draft.vendorId, scheduledDate: draft.scheduledDate, status: 'booked', source: 'system',
          bookedByUid: auth.currentUser!.uid, bookedByName: me.displayName, createdAt: new Date().toISOString(),
        });
        toast.success(`已約 ${vendorName(draft.vendorId)} ${draft.scheduledDate.slice(5).replace('-', '/')}${draft.startTime ? ' ' + draft.startTime : ''}`);
      }
      closeDraft();
    } catch {
      toast.error('儲存失敗');
    }
  }

  async function markDone() {
    if (!editing?.id) return;
    try {
      await updateDoc(doc(db, 'shootBookings', editing.id), { status: 'completed', deliveredCount: doneCount, resolvedAt: new Date().toISOString() });
      toast.success('已記錄拍完');
      closeDraft();
    } catch {
      toast.error('記錄失敗');
    }
  }

  // 延期／取消的寫法跟製作進度卡片一樣（舊的標 postponed，另開一筆新的並串 previousBookingId），歷史紀錄才對得起來
  async function postpone() {
    if (!editing?.id || !me || !newDate) return toast.error('請選新日期');
    try {
      await updateDoc(doc(db, 'shootBookings', editing.id), { status: 'postponed', reason, resolvedAt: new Date().toISOString() });
      const { id, status, resolvedAt, reason: _r, timetreeUuid, changeLog, ...rest } = editing;
      await addDoc(collection(db, 'shootBookings'), {
        ...rest, scheduledDate: newDate, status: 'booked', source: 'system', previousBookingId: editing.id,
        bookedByUid: auth.currentUser!.uid, bookedByName: me.displayName, createdAt: new Date().toISOString(),
      });
      toast.success(`已改到 ${newDate.slice(5).replace('-', '/')}`);
      closeDraft();
    } catch {
      toast.error('操作失敗');
    }
  }

  // 輸錯了（日期、IP 選錯）直接刪掉，不留延期／取消紀錄；跟製作進度卡片的 ✕ 一樣只有主管以上能刪
  async function deleteBooking() {
    if (!editing?.id) return;
    if (!window.confirm(`確定刪除「${bookingLabel(editing)}」${editing.scheduledDate.slice(5).replace('-', '/')}？
（輸入錯誤用這個，不會留紀錄）`)) return;
    try {
      await deleteDoc(doc(db, 'shootBookings', editing.id));
      toast.success('已刪除');
      closeDraft();
    } catch {
      toast.error('刪除失敗（只有主管可以刪，或改用「取消」）');
    }
  }

  async function cancelBooking() {
    if (!editing?.id) return;
    try {
      await updateDoc(doc(db, 'shootBookings', editing.id), { status: 'cancelled', reason, resolvedAt: new Date().toISOString() });
      toast.success('已取消');
      closeDraft();
    } catch {
      toast.error('操作失敗');
    }
  }

  const selectedItems = itemsByDate.get(selectedDate) || [];
  const input = 'w-full px-3 py-2 rounded-lg border border-black/10 text-sm bg-white disabled:bg-gray-50 disabled:text-gray-400';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">拍攝行事曆</h2>
          <p className="text-sm text-gray-500">TimeTree 登記的拍攝會自動出現；也可以點日期直接約</p>
        </div>
        <button onClick={() => setDraft(emptyDraft(selectedDate >= today ? selectedDate : today))}
          className="flex items-center gap-1.5 bg-[#5A5A40] text-white px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap">
          <Plus size={16} />約拍攝
        </button>
      </div>

      <div className="bg-white rounded-[32px] border border-black/5 shadow-sm p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setMonth(m => addMonths(m, -1))} className="p-2 rounded-lg hover:bg-gray-100"><ChevronLeft size={18} /></button>
            <span className="text-lg font-bold w-28 text-center whitespace-nowrap">{format(month, 'yyyy 年 M 月')}</span>
            <button onClick={() => setMonth(m => addMonths(m, 1))} className="p-2 rounded-lg hover:bg-gray-100"><ChevronRight size={18} /></button>
            <button onClick={() => { setMonth(startOfMonth(new Date())); setSelectedDate(today); }}
              className="ml-1 px-3 py-1.5 rounded-lg border border-black/10 text-[13px] font-bold whitespace-nowrap">今天</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map(f => (
              <button key={f} onClick={() => setHidden(h => { const n = new Set(h); n.has(f) ? n.delete(f) : n.add(f); return n; })}
                className={cn('px-2.5 py-1 rounded-full text-[13px] font-bold whitespace-nowrap border',
                  hidden.has(f) ? 'bg-white text-gray-300 border-gray-200 line-through' : f === '拍攝' ? 'bg-[#5A5A40] text-white border-transparent' : cn(EVENT_STYLE[f], 'border-transparent'))}>
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-7 text-center text-[13px] font-bold text-gray-400">
          {WEEKDAYS.map(w => <div key={w} className="py-1">{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-px bg-black/5 rounded-xl overflow-hidden">
          {days.map(d => {
            const key = format(d, 'yyyy-MM-dd');
            const items = itemsByDate.get(key) || [];
            const inMonth = isSameMonth(d, month);
            return (
              // 點空白的一天＝直接約；有行程的一天先選起來看清單，要約再按右上角的 ＋
              <div key={key} role="button" tabIndex={0}
                onClick={() => { setSelectedDate(key); if (items.length === 0) setDraft(emptyDraft(key)); }}
                className={cn('group bg-white min-h-[64px] sm:min-h-[104px] p-1 sm:p-1.5 text-left align-top flex flex-col gap-0.5 min-w-0 cursor-pointer',
                  !inMonth && 'bg-gray-50', key === selectedDate && 'ring-2 ring-inset ring-[#5A5A40]')}>
                <div className="flex items-center justify-between">
                  <span className={cn('text-[13px] font-bold w-6 h-6 flex items-center justify-center rounded-full shrink-0',
                    key === today ? 'bg-[#5A5A40] text-white' : inMonth ? 'text-gray-700' : 'text-gray-300')}>
                    {d.getDate()}
                  </span>
                  <button onClick={e => { e.stopPropagation(); setSelectedDate(key); setDraft(emptyDraft(key)); }} title="這天約拍攝"
                    className={cn('w-6 h-6 rounded-full items-center justify-center text-[#5A5A40] hover:bg-[#E8E6D9]',
                      key === selectedDate ? 'flex' : 'hidden sm:group-hover:flex')}>
                    <Plus size={14} />
                  </button>
                </div>
                {/* 手機格子太窄，只畫色點；桌機才放標籤（固定一行截斷，中文換行會斷出孤字） */}
                <div className="flex flex-wrap gap-0.5 sm:hidden">
                  {items.slice(0, 6).map((it, i) => (
                    <span key={i} className={cn('w-1.5 h-1.5 rounded-full', it.kind === 'booking' ? (it.booking.status === 'completed' ? 'bg-green-500' : 'bg-[#5A5A40]') : EVENT_STYLE[it.event.category].split(' ')[0])} />
                  ))}
                </div>
                <div className="hidden sm:flex flex-col gap-0.5 min-w-0">
                  {items.slice(0, 3).map((it, i) => (
                    <span key={i} className={cn('block truncate whitespace-nowrap rounded px-1 py-0.5 text-[12px] leading-tight',
                      it.kind === 'booking' ? BOOKING_STYLE[it.booking.status as 'booked' | 'completed'] : EVENT_STYLE[it.event.category])}>
                      {it.time ? `${it.time} ` : ''}{it.label}
                    </span>
                  ))}
                  {items.length > 3 && <span className="text-[12px] text-gray-400 px-1">還有 {items.length - 3} 筆</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-black/5 pt-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-bold text-gray-700">{selectedDate.slice(5).replace('-', '/')} 的行程</p>
            <button onClick={() => setDraft(emptyDraft(selectedDate))} className="text-[13px] font-bold text-[#5A5A40] flex items-center gap-1 whitespace-nowrap">
              <Plus size={14} />這天約拍攝
            </button>
          </div>
          {selectedItems.length === 0 && <p className="text-sm text-gray-400 py-2">這天沒有行程</p>}
          {selectedItems.map((it, i) => (
            <button key={i} onClick={() => it.kind === 'booking' ? openBooking(it.booking) : setViewEvent(it.event)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[#F5F5F0] text-left text-sm hover:bg-[#ECEBE3]">
              <span className="font-mono text-gray-500 w-12 shrink-0">{it.time || '整天'}</span>
              <span className={cn('px-2 py-0.5 rounded-full text-[12px] font-bold whitespace-nowrap shrink-0',
                it.kind === 'booking' ? BOOKING_STYLE[it.booking.status as 'booked' | 'completed'] : EVENT_STYLE[it.event.category])}>
                {it.kind === 'booking' ? (it.booking.status === 'completed' ? '已拍' : '拍攝') : it.event.category}
              </span>
              <span className="truncate min-w-0 flex-1">
                {it.label}
              </span>
              {it.kind === 'booking' && it.booking.crew && <span className="text-gray-400 whitespace-nowrap shrink-0">{it.booking.crew}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-[32px] border border-black/5 shadow-sm p-6 space-y-3">
        <div>
          <h3 className="text-lg font-bold text-[#5A5A40]">接下來的拍攝</h3>
          <p className="text-[13px] text-gray-400 mt-0.5">已約好、還沒拍的，依日期排</p>
        </div>
        {upcoming.length === 0 && <p className="text-center py-6 text-gray-400 text-sm">目前沒有約好的拍攝</p>}
        <div className="space-y-2">
          {upcoming.map(b => (
            <button key={b.id} onClick={() => openBooking(b)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-[#F5F5F0] text-left text-sm hover:bg-[#ECEBE3]">
              <span className="font-mono font-bold whitespace-nowrap">{b.scheduledDate.slice(5).replace('-', '/')} {b.startTime || ''}</span>
              <span className="font-bold truncate min-w-0 flex-1">{bookingLabel(b)}</span>
              {b.location && <span className="hidden sm:inline text-gray-500 whitespace-nowrap">{b.location}</span>}
              {b.crew && <span className="hidden sm:inline text-gray-400 whitespace-nowrap">{b.crew}</span>}
              <span className="text-[12px] text-gray-400 whitespace-nowrap">{b.timetreeUuid ? 'TimeTree' : '手動'}</span>
            </button>
          ))}
        </div>
      </div>

      {viewEvent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setViewEvent(null)}>
          <div className="bg-white rounded-3xl w-full max-w-sm p-6 space-y-3 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-start gap-2">
              <span className={cn('px-2 py-0.5 rounded-full text-[12px] font-bold', EVENT_STYLE[viewEvent.category])}>{viewEvent.category}</span>
              <button onClick={() => setViewEvent(null)} className="p-1 hover:bg-gray-100 rounded-full"><X size={18} /></button>
            </div>
            <p className="text-lg font-bold">{viewEvent.title}</p>
            <p className="text-sm text-gray-500">{viewEvent.date.replace(/-/g, '/')} {viewEvent.startTime || '整天'}</p>
            <p className="text-[13px] text-gray-400">
              {viewEvent.category === '拍攝' ? `${viewEvent.ip || '這個 IP'} 不在系統 IP 名單，只顯示、不追蹤通知。` : ''}
              來自 TimeTree，要修改請到 TimeTree。
            </p>
          </div>
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-md max-h-[90vh] overflow-auto shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold serif">{draft.id ? '拍攝預約' : '約拍攝'}</h3>
              <button onClick={closeDraft} className="p-2 hover:bg-gray-100 rounded-full"><X size={20} /></button>
            </div>
            {editing && (
              <p className="text-[13px] text-gray-400">
                {fromTimeTree ? `來自 TimeTree「${editing.title || ''}」` : `由 ${editing.bookedByName} 在系統約`}
                {editing.status === 'completed' && `・已拍完，交 ${editing.deliveredCount ?? 0} 支`}
              </p>
            )}
            {fromTimeTree && <p className="text-[13px] text-amber-700 bg-amber-50 rounded-xl px-3 py-2">IP、日期、時間以 TimeTree 為準，要改請到 TimeTree 改，這裡會自動跟著變。</p>}

            <div className="space-y-3">
              <label className="block text-xs font-bold text-gray-500">IP
                <select value={draft.vendorId} disabled={fromTimeTree} onChange={e => setDraft({ ...draft, vendorId: e.target.value })} className={cn(input, 'mt-1')}>
                  <option value="">選擇 IP</option>
                  {bookableVendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
              <div className="flex gap-2">
                <label className="flex-[3] min-w-0 block text-xs font-bold text-gray-500">日期
                  <input type="date" value={draft.scheduledDate} disabled={fromTimeTree} onChange={e => setDraft({ ...draft, scheduledDate: e.target.value })} className={cn(input, 'mt-1 font-mono')} />
                </label>
                <label className="flex-[2] min-w-0 block text-xs font-bold text-gray-500">時間
                  <input type="time" value={draft.startTime} disabled={fromTimeTree} onChange={e => setDraft({ ...draft, startTime: e.target.value })} className={cn(input, 'mt-1 font-mono')} />
                </label>
              </div>
              <label className="block text-xs font-bold text-gray-500">地點
                <input value={draft.location} onChange={e => setDraft({ ...draft, location: e.target.value })} placeholder="例：客戶店面、大寮" className={cn(input, 'mt-1')} />
              </label>
              <div className="flex gap-2">
                <label className="flex-[3] min-w-0 block text-xs font-bold text-gray-500">拍攝人員
                  <input value={draft.crew} onChange={e => setDraft({ ...draft, crew: e.target.value })} placeholder="例：彭彭、Irene" className={cn(input, 'mt-1')} />
                </label>
                <label className="flex-[2] min-w-0 block text-xs font-bold text-gray-500">預計拍幾支
                  <input type="number" min={0} value={draft.expectedCount} onChange={e => setDraft({ ...draft, expectedCount: e.target.value })} className={cn(input, 'mt-1')} />
                </label>
              </div>
              <label className="block text-xs font-bold text-gray-500">拍攝內容／備註
                <textarea rows={2} value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} placeholder="例：年菜、記者會、要帶收音" className={cn(input, 'mt-1')} />
              </label>
              <p className="text-[13px] text-gray-400">通知客戶：功能準備中（LINE 升級後開啟）</p>
            </div>

            {editing?.changeLog?.length ? (
              <div className="text-[12px] text-gray-400 space-y-0.5 border-t border-black/5 pt-3">
                {editing.changeLog.slice(-5).map((c, i) => (
                  <p key={i}>{new Date(c.at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}　{c.note}</p>
                ))}
              </div>
            ) : null}

            {action === 'done' && (
              <div className="bg-[#F5F5F0] rounded-xl p-3 flex items-center justify-between text-sm">
                <span>這次交了幾支？</span>
                <div className="flex items-center gap-3">
                  <button onClick={() => setDoneCount(c => Math.max(1, c - 1))} className="w-7 h-7 rounded-lg border border-black/10 font-bold">−</button>
                  <span className="font-mono font-bold w-4 text-center">{doneCount}</span>
                  <button onClick={() => setDoneCount(c => c + 1)} className="w-7 h-7 rounded-lg border border-black/10 font-bold">＋</button>
                  <button onClick={markDone} className="ml-2 px-3 py-1.5 bg-[#5A5A40] text-white rounded-lg text-xs font-bold flex items-center gap-1"><Check size={14} />確認</button>
                </div>
              </div>
            )}
            {(action === 'delay' || action === 'cancel') && (
              <div className="bg-[#F5F5F0] rounded-xl p-3 space-y-2 text-sm">
                <div className="flex gap-2">
                  {(['client', 'internal'] as BookingReason[]).map(r => (
                    <button key={r} onClick={() => setReason(r)}
                      className={cn('flex-1 py-2 text-xs font-bold border rounded-lg', reason === r ? 'border-[#5A5A40] text-[#5A5A40] bg-white' : 'border-black/10')}>
                      {r === 'client' ? '客戶因素' : '我方因素'}
                    </button>
                  ))}
                </div>
                {action === 'delay' ? (
                  <div className="flex gap-2">
                    <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} className={cn(input, 'flex-1 font-mono')} />
                    <button onClick={postpone} className="px-3 bg-[#5A5A40] text-white rounded-lg text-xs font-bold flex items-center gap-1 whitespace-nowrap"><CalendarClock size={14} />改到這天</button>
                  </div>
                ) : (
                  <button onClick={cancelBooking} className="w-full py-2 bg-red-500 text-white rounded-lg text-xs font-bold">確認取消這場拍攝</button>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {editing?.status === 'booked' && (
                <>
                  <button onClick={() => setAction(action === 'done' ? null : 'done')} className="px-3 py-2 border border-black/10 rounded-lg text-xs font-bold hover:border-[#5A5A40]">拍完了</button>
                  {!fromTimeTree && (
                    <>
                      <button onClick={() => { setAction(action === 'delay' ? null : 'delay'); setNewDate(''); }} className="px-3 py-2 border border-black/10 rounded-lg text-xs font-bold hover:border-amber-400">延期</button>
                      <button onClick={() => setAction(action === 'cancel' ? null : 'cancel')} className="px-3 py-2 border border-black/10 rounded-lg text-xs font-bold hover:border-red-400 hover:text-red-500">取消</button>
                      {(me?.role === 'engineer' || me?.role === 'manager') && (
                        <button onClick={deleteBooking} className="px-3 py-2 text-xs font-bold text-gray-400 hover:text-red-500">刪除（輸錯了）</button>
                      )}
                    </>
                  )}
                </>
              )}
              <button onClick={saveDraft} className="ml-auto px-5 py-2 bg-[#5A5A40] text-white rounded-lg text-sm font-bold">{draft.id ? '儲存' : '確認約定'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
