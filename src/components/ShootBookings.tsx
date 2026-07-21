import React, { useState, useEffect } from 'react';
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Vendor, Asset, Post, ShootBooking, BookingReason, UserProfile, DeficitEntry } from '../types';
import { getDeficitBreakdown, getEffectiveMonthlyTarget, getAvailableVideoAssets, hasVideoTrackingScope, isVendorTrackedInMonth } from '../lib/vendorStatus';
import { Film, Plus, Check, CalendarClock, AlertTriangle, Pencil, X, Trash2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import toast from 'react-hot-toast';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Severity = 'crit' | 'warn' | 'good';
type PanelType = 'book' | 'done' | 'delay' | 'delayDate';

const SEV_STYLES: Record<Severity, { chip: string; bar: string; label: string }> = {
  crit: { chip: 'bg-red-100 text-red-700 border border-red-200', bar: 'bg-red-500', label: '需處理' },
  warn: { chip: 'bg-amber-100 text-amber-700 border border-amber-200', bar: 'bg-amber-500', label: '落後' },
  good: { chip: 'bg-green-100 text-green-700 border border-green-200', bar: 'bg-green-500', label: '正常' },
};

// 回填欠片明細通常是針對已結束的月份，預設帶上個月，減少每次都要手動改月份
function currentMonthDefault(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function ShootBookings() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [bookings, setBookings] = useState<ShootBooking[]>([]);
  const [me, setMe] = useState<UserProfile | null>(null);

  const [openPanel, setOpenPanel] = useState<{ vendorId: string; type: PanelType } | null>(null);
  const [pendingReason, setPendingReason] = useState<BookingReason | null>(null);
  const [dateInput, setDateInput] = useState(new Date().toISOString().split('T')[0]);
  const [countInput, setCountInput] = useState(1);
  const [deficitModalVendor, setDeficitModalVendor] = useState<Vendor | null>(null);
  const [deficitMonth, setDeficitMonth] = useState(currentMonthDefault());
  const [deficitOwed, setDeficitOwed] = useState(1);
  const [deficitNote, setDeficitNote] = useState('');

  useEffect(() => {
    const vU = onSnapshot(collection(db, 'vendors'), (s) => setVendors(s.docs.map(d => ({ id: d.id, ...d.data() } as Vendor))));
    const aU = onSnapshot(collection(db, 'assets'), (s) => setAssets(s.docs.map(d => ({ id: d.id, ...d.data() } as Asset))));
    const pU = onSnapshot(collection(db, 'posts'), (s) => setPosts(s.docs.map(d => ({ id: d.id, ...d.data() } as Post))));
    const bU = onSnapshot(query(collection(db, 'shootBookings')), (s) => setBookings(s.docs.map(d => ({ id: d.id, ...d.data() } as ShootBooking))));
    return () => { vU(); aU(); pU(); bU(); };
  }, []);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    return onSnapshot(doc(db, 'users', uid), (snap) => {
      if (snap.exists()) setMe(snap.data() as UserProfile);
    });
  }, []);

  const today = new Date().toISOString().split('T')[0];
  const currentMonth = today.slice(0, 7);

  const rows = vendors
    // 要不要出現在這個清單，用 hasVideoTrackingScope（本來有沒有在拍影音+合作開始了沒+沒終止/排除統計）判斷，
    // 故意不用 trackedVendors——那個會用即時 status 把「還在冷凍中、還沒解凍」的廠商整批擋掉，
    // 但冷凍中如果之前留有欠片，卡片還是要在，才能繼續管理/沖銷；這個月本身不會疊加新短缺的邏輯在 getDeficitBreakdown 內部處理
    .filter(v => hasVideoTrackingScope(v, currentMonth))
    .map(v => {
      const target = getEffectiveMonthlyTarget(v, currentMonth);
      const delivered = posts.filter(p =>
        p.vendorId === v.id && p.contentType === 'video' &&
        (p.status === 'published' || p.status === 'scheduled') &&
        (p.targetMonth ? p.targetMonth === currentMonth : (p.scheduledAt || '').slice(0, 7) === currentMonth)
      ).length;
      const stock = getAvailableVideoAssets(v.id!, assets, posts).length;
      const breakdown = getDeficitBreakdown(v, posts, currentMonth);
      const owed = Math.max(0, breakdown.totalShortfall - stock);
      const active = bookings
        .filter(b => b.vendorId === v.id && b.status === 'booked')
        .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0] || null;
      const overdue = !!active && active.scheduledDate < today;
      // 這個廠商本來就在追蹤範圍內(hasVideoTrackingScope)，但這個月本身可能因為冷凍期而不計入新短缺——
      // 用來讓畫面清楚標示「這個月冷凍中」，不要讓人誤會本月的target/delivered是真的有在要求
      const frozenThisMonth = !isVendorTrackedInMonth(v, currentMonth);
      let sev: Severity = 'good';
      if (overdue) sev = 'crit';
      else if (owed > 0 && !active) sev = owed >= 4 ? 'crit' : 'warn';
      else if (owed > 0) sev = 'warn';
      return { vendor: v, target, delivered, stock, baseline: breakdown.baseline, breakdown, owed, active, overdue, frozenThisMonth, sev };
    })
    .sort((a, b) => (b.sev === 'crit' ? 2 : b.sev === 'warn' ? 1 : 0) - (a.sev === 'crit' ? 2 : a.sev === 'warn' ? 1 : 0) || b.owed - a.owed);

  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);
  const urgentCount = rows.filter(r => r.sev === 'crit').length;

  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name || '未知IP';
  const history = bookings
    .filter(b => b.status !== 'booked' && b.resolvedAt?.slice(0, 7) === currentMonth)
    .sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));

  function openDeficitModal(vendor: Vendor) {
    setDeficitModalVendor(vendor);
    setDeficitMonth(currentMonthDefault());
    setDeficitOwed(1);
    setDeficitNote('');
  }

  async function addDeficitEntry() {
    if (!deficitModalVendor?.id) return;
    if (!deficitMonth) {
      toast.error('請選擇月份');
      return;
    }
    if (deficitOwed == null) {
      toast.error('請輸入支數（沒有欠可以填0，要沖銷可以填負數）');
      return;
    }
    try {
      const entry: DeficitEntry = {
        month: deficitMonth,
        owed: deficitOwed,
        createdAt: new Date().toISOString(),
        ...(deficitNote.trim() ? { note: deficitNote.trim() } : {})
      };
      // deficitModalVendor 是開彈窗當下拍的快照，存過一次之後就過期了；改抓 vendors 這份即時資料才不會覆蓋掉剛存的紀錄
      const liveVendor = vendors.find(v => v.id === deficitModalVendor.id) || deficitModalVendor;
      const history = liveVendor.deficitEntries || [];
      await updateDoc(doc(db, 'vendors', deficitModalVendor.id), {
        deficitEntries: [...history, entry]
      });
      toast.success('已新增該月積欠紀錄');
      setDeficitOwed(1);
      setDeficitNote('');
    } catch (e) {
      toast.error('新增失敗');
    }
  }

  async function deleteDeficitEntry(vendor: Vendor, index: number) {
    if (!vendor.id) return;
    try {
      const history = (vendor.deficitEntries || []).filter((_, i) => i !== index);
      await updateDoc(doc(db, 'vendors', vendor.id), { deficitEntries: history });
      toast.success('已刪除該筆紀錄');
    } catch (e) {
      toast.error('刪除失敗');
    }
  }

  function closePanel() {
    setOpenPanel(null);
    setPendingReason(null);
    setDateInput(new Date().toISOString().split('T')[0]);
    setCountInput(1);
  }

  async function confirmBook(vendorId: string) {
    if (!me) return;
    try {
      await addDoc(collection(db, 'shootBookings'), {
        vendorId,
        scheduledDate: dateInput,
        status: 'booked',
        bookedByUid: auth.currentUser!.uid,
        bookedByName: me.displayName,
        createdAt: new Date().toISOString()
      });
      toast.success('已登記預約');
      closePanel();
    } catch (e) {
      toast.error('登記失敗');
    }
  }

  async function confirmDone(row: (typeof rows)[number]) {
    if (!row.active) return;
    try {
      await updateDoc(doc(db, 'shootBookings', row.active.id!), {
        status: 'completed',
        deliveredCount: countInput,
        resolvedAt: new Date().toISOString()
      });
      toast.success('已記錄完成');
      closePanel();
    } catch (e) {
      toast.error('記錄失敗');
    }
  }

  async function quickCancelBooking(bookingId: string) {
    if (!window.confirm('確定要取消這筆預約嗎？（單純手滑誤按用這個，不會記錄原因）')) return;
    try {
      await deleteDoc(doc(db, 'shootBookings', bookingId));
      toast.success('已取消預約');
    } catch (e) {
      toast.error('取消失敗');
    }
  }

  async function chooseReason(reason: BookingReason) {
    setPendingReason(reason);
    setOpenPanel(prev => prev ? { ...prev, type: 'delayDate' } : prev);
  }

  async function confirmReschedule(row: (typeof rows)[number]) {
    if (!row.active || !me || !pendingReason) return;
    try {
      await updateDoc(doc(db, 'shootBookings', row.active.id!), {
        status: 'postponed',
        reason: pendingReason,
        resolvedAt: new Date().toISOString()
      });
      await addDoc(collection(db, 'shootBookings'), {
        vendorId: row.vendor.id,
        scheduledDate: dateInput,
        status: 'booked',
        bookedByUid: auth.currentUser!.uid,
        bookedByName: me.displayName,
        previousBookingId: row.active.id,
        createdAt: new Date().toISOString()
      });
      toast.success('已改期');
      closePanel();
    } catch (e) {
      toast.error('操作失敗');
    }
  }

  async function confirmCancel(row: (typeof rows)[number]) {
    if (!row.active || !pendingReason) return;
    try {
      await updateDoc(doc(db, 'shootBookings', row.active.id!), {
        status: 'cancelled',
        reason: pendingReason,
        resolvedAt: new Date().toISOString()
      });
      toast.success('已取消預約');
      closePanel();
    } catch (e) {
      toast.error('操作失敗');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">拍攝進度</h2>
          <p className="text-sm text-gray-500">每個 IP 扣掉庫存後，此時此刻還要再拍幾支 Reels、目前有沒有排定拍攝</p>
          <p className="text-[11px] text-gray-400">拍完只要照平常習慣把素材上傳到「素材資料庫」，這裡的預約會自動標記完成，不用多跑一步</p>
        </div>
        <div className="flex gap-4">
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm flex items-center space-x-3">
            <div className="bg-red-50 p-2 rounded-lg text-red-600"><AlertTriangle size={18} /></div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">全部 IP 合計還要再拍</p>
              <p className="text-lg font-bold leading-none">{totalOwed} <span className="text-xs font-normal text-gray-400">支</span></p>
            </div>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm flex items-center space-x-3">
            <div className="bg-red-50 p-2 rounded-lg text-red-600"><Film size={18} /></div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">需處理</p>
              <p className="text-lg font-bold leading-none">{urgentCount} <span className="text-xs font-normal text-gray-400">個 IP</span></p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {rows.map(row => {
          const s = SEV_STYLES[row.sev];
          const isOpen = openPanel?.vendorId === row.vendor.id;
          return (
            <div key={row.vendor.id} className="bg-white rounded-[32px] border border-black/5 shadow-sm overflow-hidden">
              <div className={cn('h-1', s.bar)} />
              <div className="p-6 space-y-4">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-lg font-bold flex items-center gap-1.5">
                      {row.vendor.name}
                      {row.frozenThisMonth && (
                        <span className="text-[10px] font-bold text-cyan-700 bg-cyan-50 px-1.5 py-0.5 rounded-full border border-cyan-100">冷凍中</span>
                      )}
                    </h3>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {row.frozenThisMonth
                        ? `本月冷凍中，不列入新短缺・已交 ${row.delivered} 支・庫存 ${row.stock}`
                        : `本月 ${row.delivered}/${row.target} 支・庫存 ${row.stock}`}
                    </p>
                  </div>
                  <span className={cn('px-3 py-1 rounded-full text-[10px] font-bold', s.chip)}>{s.label}</span>
                </div>

                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">此時此刻還要再拍</p>
                  <p className="text-4xl font-bold leading-none mt-1">
                    {row.owed} <span className="text-sm font-normal text-gray-400">支 Reels</span>
                  </p>
                  <p className="text-[10.5px] text-gray-400 mt-1.5">
                    起始欠 {row.baseline}
                    {row.breakdown.monthlyShortfalls.map(ms => (
                      <span key={ms.month}>
                        {' '}{ms.delta >= 0 ? '+' : '−'} {ms.month.slice(5)}月{row.breakdown.monthlyShortfalls.length === 1 ? '未達標' : ''} {Math.abs(ms.delta)}
                      </span>
                    ))}
                    {' '}− 已有庫存 {row.stock}
                    {(row.vendor.deficitEntries?.length || row.vendor.manualDeficitUpdatedAt) && (
                      <span className="ml-1 text-gray-300">
                        ・{row.vendor.deficitEntries?.length
                          ? `已回填 ${row.vendor.deficitEntries.length} 個月`
                          : `起始校正於 ${row.vendor.manualDeficitUpdatedAt!.slice(0, 10)}`}
                      </span>
                    )}
                  </p>
                  {row.breakdown.gapMonths.length > 0 && (
                    <p className="text-[10px] text-amber-600 mt-1">
                      ⚠ {row.breakdown.gapMonths.join('、')} 尚未回填，暫不計入合計
                    </p>
                  )}
                  {me && (me.role === 'engineer' || me.canEditDeficitBaseline) && (
                    <button
                      onClick={() => openDeficitModal(row.vendor)}
                      className="flex items-center gap-1 mt-2 text-[11px] font-bold text-gray-400 hover:text-[#5A5A40]"
                    >
                      <Pencil size={11} />校正起始欠片
                    </button>
                  )}
                </div>

                <div className={cn(
                  'rounded-xl px-3 py-2.5 text-xs flex items-center justify-between',
                  row.overdue ? 'bg-red-50 text-red-700' : row.active ? 'bg-[#F5F5F0] text-gray-700' : 'bg-[#F5F5F0] text-gray-400'
                )}>
                  {row.active ? (
                    <>
                      <span>
                        {row.overdue ? '⚠ 逾期未回報　' : '已預約　'}
                        <span className="font-mono font-bold">{row.active.scheduledDate.slice(5).replace('-', '/')}</span>
                        　由 {row.active.bookedByName}
                      </span>
                      <button
                        onClick={() => quickCancelBooking(row.active!.id!)}
                        title="手滑誤按？直接取消，不用選原因"
                        className="p-1 -m-1 text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </>
                  ) : <span>尚無有效預約</span>}
                </div>

                {!isOpen && (
                  <div className={cn('grid gap-2', row.active ? 'grid-cols-2' : 'grid-cols-1')}>
                    {!row.active && (
                      <button onClick={() => setOpenPanel({ vendorId: row.vendor.id, type: 'book' })}
                        className="border border-black/10 rounded-lg py-2 text-[11px] font-bold hover:border-[#5A5A40] hover:text-[#5A5A40] transition-colors">
                        約時間
                      </button>
                    )}
                    {row.active && (
                      <>
                        <button onClick={() => setOpenPanel({ vendorId: row.vendor.id, type: 'done' })}
                          title="正常不用按這顆——去素材資料庫上傳這次拍的素材，系統會自動核銷預約。這顆只是備用，用在忘記上素材庫或要手動補登的狀況"
                          className="border border-black/10 rounded-lg py-2 text-[11px] font-bold hover:border-[#5A5A40] hover:text-[#5A5A40] transition-colors">
                          拍完了
                        </button>
                        <button onClick={() => setOpenPanel({ vendorId: row.vendor.id, type: 'delay' })}
                          className="border border-black/10 rounded-lg py-2 text-[11px] font-bold hover:border-red-400 hover:text-red-500 transition-colors">
                          延期/取消
                        </button>
                      </>
                    )}
                  </div>
                )}

                {isOpen && openPanel!.type === 'book' && (
                  <div className="bg-[#F5F5F0] rounded-xl p-3 space-y-2 border border-dashed border-black/10">
                    <input type="date" value={dateInput} onChange={e => setDateInput(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-black/10 text-sm font-mono" />
                    <div className="flex gap-2">
                      <button onClick={closePanel} className="flex-1 py-2 text-xs font-bold text-gray-400">取消</button>
                      <button onClick={() => confirmBook(row.vendor.id)} className="flex-[2] py-2 text-xs font-bold bg-[#5A5A40] text-white rounded-lg">確認約定</button>
                    </div>
                  </div>
                )}

                {isOpen && openPanel!.type === 'done' && (
                  <div className="bg-[#F5F5F0] rounded-xl p-3 space-y-2 border border-dashed border-black/10">
                    <div className="flex items-center justify-between text-xs">
                      <span>這次交了幾支？</span>
                      <div className="flex items-center gap-3">
                        <button onClick={() => setCountInput(c => Math.max(1, c - 1))} className="w-7 h-7 rounded-lg border border-black/10 font-bold">−</button>
                        <span className="font-mono font-bold w-4 text-center">{countInput}</span>
                        <button onClick={() => setCountInput(c => c + 1)} className="w-7 h-7 rounded-lg border border-black/10 font-bold">＋</button>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={closePanel} className="flex-1 py-2 text-xs font-bold text-gray-400">取消</button>
                      <button onClick={() => confirmDone(row)} className="flex-[2] py-2 text-xs font-bold bg-[#5A5A40] text-white rounded-lg flex items-center justify-center gap-1"><Check size={14} />確認完成</button>
                    </div>
                  </div>
                )}

                {isOpen && openPanel!.type === 'delay' && (
                  <div className="bg-[#F5F5F0] rounded-xl p-3 space-y-2 border border-dashed border-black/10">
                    <p className="text-xs text-gray-500">原因？</p>
                    <div className="flex gap-2">
                      <button onClick={() => chooseReason('client')} className="flex-1 py-2 text-xs font-bold border border-black/10 rounded-lg hover:border-[#5A5A40]">客戶因素</button>
                      <button onClick={() => chooseReason('internal')} className="flex-1 py-2 text-xs font-bold border border-black/10 rounded-lg hover:border-[#5A5A40]">我方因素</button>
                    </div>
                    <button onClick={closePanel} className="w-full py-1 text-[11px] text-gray-400">取消操作</button>
                  </div>
                )}

                {isOpen && openPanel!.type === 'delayDate' && (
                  <div className="bg-[#F5F5F0] rounded-xl p-3 space-y-2 border border-dashed border-black/10">
                    <input type="date" value={dateInput} onChange={e => setDateInput(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-black/10 text-sm font-mono" />
                    <button onClick={() => confirmReschedule(row)} className="w-full py-2 text-xs font-bold bg-[#5A5A40] text-white rounded-lg flex items-center justify-center gap-1">
                      <CalendarClock size={14} />重新約日期
                    </button>
                    <button onClick={() => confirmCancel(row)} className="w-full py-1 text-[11px] text-gray-400 underline">或先不約，取消這次</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="col-span-full py-20 text-center space-y-4 bg-white rounded-[40px] border border-dashed border-gray-200">
            <Plus size={48} className="mx-auto text-gray-300" />
            <p className="text-gray-500">目前沒有設定影片配額的 IP</p>
          </div>
        )}
      </div>

      <div className="bg-white rounded-[32px] border border-black/5 shadow-sm p-6 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-[#5A5A40]">本月歷史紀錄</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">每筆預約完成／延期／取消都會留下時間戳記，不會憑空消失</p>
        </div>
        <div className="space-y-2">
          {history.map(b => {
            const badge = b.status === 'completed'
              ? { icon: Check, label: `完成・交${b.deliveredCount ?? 0}支`, cls: 'text-green-600 bg-green-50' }
              : b.status === 'postponed'
                ? { icon: CalendarClock, label: '延期', cls: 'text-amber-600 bg-amber-50' }
                : { icon: X, label: '取消', cls: 'text-red-500 bg-red-50' };
            const Icon = badge.icon;
            const reasonLabel = b.reason === 'client' ? '客戶因素' : b.reason === 'internal' ? '我方因素' : b.reason ? '其他' : null;
            return (
              <div key={b.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-[#F5F5F0] text-xs">
                <div className="flex items-center gap-3">
                  <span className={cn('p-1.5 rounded-lg', badge.cls)}><Icon size={14} /></span>
                  <span className="font-bold text-gray-700">{vendorName(b.vendorId)}</span>
                  <span className="text-gray-400">原定 {b.scheduledDate.slice(5).replace('-', '/')}</span>
                  {reasonLabel && <span className="text-gray-400">・{reasonLabel}</span>}
                </div>
                <div className="flex items-center gap-3 text-gray-400">
                  <span>{badge.label}</span>
                  <span className="font-mono">{b.resolvedAt ? new Date(b.resolvedAt).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                  <span>由 {b.bookedByName}</span>
                </div>
              </div>
            );
          })}
          {history.length === 0 && (
            <p className="text-center py-8 text-gray-400 text-sm">這個月還沒有結案的預約紀錄</p>
          )}
        </div>
      </div>

      {/* 校正起始欠片：逐月回填明細，系統自動加總 */}
      {deficitModalVendor && (() => {
        const liveVendor = vendors.find(v => v.id === deficitModalVendor.id) || deficitModalVendor;
        const entries = [...(liveVendor.deficitEntries || [])].sort((a, b) => b.month.localeCompare(a.month));
        const total = entries.reduce((s, e) => s + (e.owed || 0), 0);
        const gapMonths = getDeficitBreakdown(liveVendor, posts, currentMonth).gapMonths;
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-3xl w-full max-w-md max-h-[90vh] overflow-auto shadow-2xl">
              <div className="p-6">
                <div className="flex justify-between items-center mb-1">
                  <h3 className="text-lg font-bold serif">{liveVendor.name}・校正起始欠片</h3>
                  <button onClick={() => setDeficitModalVendor(null)} className="p-2 hover:bg-gray-100 rounded-full">
                    <X size={20} />
                  </button>
                </div>
                <p className="text-xs text-gray-400 mb-5">
                  逐月填寫已確定積欠的支數，系統自動加總成起始欠片，不用再猜一個總數；要沖銷/抵銷欠片也是填負數在這裡，不要跑去用「本月加贈/扣片」——那個只會改當月目標，不會動到這裡的起始欠片。
                  {entries.length === 0 && liveVendor.manualDeficitBaseline
                    ? `目前沿用舊版數字：${liveVendor.manualDeficitBaseline}（校正於 ${liveVendor.manualDeficitUpdatedAt?.slice(0, 10) || '未知'}）。新增任何一筆之後就會改用這裡的逐月明細。`
                    : ''}
                </p>
                {gapMonths.length > 0 && (
                  <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2 mb-4">
                    ⚠ {gapMonths.join('、')} 還沒填，目前不計入合計（沒有欠也要填0，系統不會幫你猜）
                  </p>
                )}

                <div className="bg-amber-50/50 p-4 rounded-2xl border border-amber-100 space-y-3 mb-5">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-amber-800 mb-1">月份</label>
                      <input
                        type="month"
                        value={deficitMonth}
                        onChange={(e) => setDeficitMonth(e.target.value)}
                        className="w-full p-3 bg-white rounded-xl border border-amber-200 focus:ring-2 focus:ring-amber-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-amber-800 mb-1">支數（欠填正數，沖銷填負數）</label>
                      <input
                        type="number"
                        value={deficitOwed}
                        onChange={(e) => setDeficitOwed(parseInt(e.target.value) || 0)}
                        className="w-full p-3 bg-white rounded-xl border border-amber-200 focus:ring-2 focus:ring-amber-400"
                        placeholder="欠3支填3，沖銷2支填-2"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-amber-800 mb-1">備註（選填）</label>
                    <input
                      type="text"
                      value={deficitNote}
                      onChange={(e) => setDeficitNote(e.target.value)}
                      className="w-full p-3 bg-white rounded-xl border border-amber-200 focus:ring-2 focus:ring-amber-400"
                      placeholder="例如：客戶因素延誤"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={addDeficitEntry}
                    className="w-full bg-amber-500 text-white py-2.5 rounded-xl font-bold text-sm shadow hover:bg-amber-600 transition-all"
                  >
                    新增這筆紀錄
                  </button>
                </div>

                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">逐月明細</div>
                  <div className="text-xs font-bold text-[#5A5A40]">加總 {total} 支</div>
                </div>
                {entries.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">目前沒有任何回填紀錄</p>
                ) : (
                  <div className="space-y-2">
                    {entries.map((e, idx) => {
                      const originalIndex = (liveVendor.deficitEntries || []).indexOf(e);
                      return (
                        <div key={idx} className="flex items-start justify-between gap-2 p-3 bg-[#F5F5F0] rounded-xl text-sm">
                          <div>
                            <div className="font-bold">
                              {e.month}
                              {e.owed >= 0 ? (
                                <span className="ml-2 text-red-500">欠 {e.owed} 支</span>
                              ) : (
                                <span className="ml-2 text-green-600">沖銷 {Math.abs(e.owed)} 支</span>
                              )}
                            </div>
                            {e.note && <div className="text-xs text-gray-500 mt-0.5">{e.note}</div>}
                          </div>
                          <button
                            onClick={() => deleteDeficitEntry(liveVendor, originalIndex)}
                            className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                            title="刪除這筆"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
