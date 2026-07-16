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
import { Vendor, Asset, Post, ShootBooking, BookingReason, UserProfile } from '../types';
import { trackedVendors } from '../lib/vendorStatus';
import { Film, Plus, Check, CalendarClock, AlertTriangle, Pencil, X } from 'lucide-react';
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
  const [editingBaselineId, setEditingBaselineId] = useState<string | null>(null);
  const [baselineInput, setBaselineInput] = useState(0);

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

  const rows = trackedVendors(vendors)
    .filter(v => (v.monthlyTargetVideos || 0) > 0)
    .map(v => {
      const target = v.monthlyTargetVideos || 0;
      const delivered = posts.filter(p =>
        p.vendorId === v.id && p.contentType === 'video' &&
        (p.status === 'published' || p.status === 'scheduled') &&
        (p.targetMonth ? p.targetMonth === currentMonth : (p.scheduledAt || '').slice(0, 7) === currentMonth)
      ).length;
      const stock = assets.filter(a => a.vendorId === v.id && a.type === 'video' && a.status === 'available').length;
      const baseline = v.manualDeficitBaseline || 0;
      const monthDelta = target - delivered; // 本月還沒交的量，交超過會是負數(倒扣)
      const owed = Math.max(0, baseline + monthDelta - stock);
      const active = bookings
        .filter(b => b.vendorId === v.id && b.status === 'booked')
        .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0] || null;
      const overdue = !!active && active.scheduledDate < today;
      let sev: Severity = 'good';
      if (overdue) sev = 'crit';
      else if (owed > 0 && !active) sev = owed >= 4 ? 'crit' : 'warn';
      else if (owed > 0) sev = 'warn';
      return { vendor: v, target, delivered, stock, baseline, owed, active, overdue, sev };
    })
    .sort((a, b) => (b.sev === 'crit' ? 2 : b.sev === 'warn' ? 1 : 0) - (a.sev === 'crit' ? 2 : a.sev === 'warn' ? 1 : 0) || b.owed - a.owed);

  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);
  const urgentCount = rows.filter(r => r.sev === 'crit').length;

  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name || '未知IP';
  const history = bookings
    .filter(b => b.status !== 'booked' && b.resolvedAt?.slice(0, 7) === currentMonth)
    .sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));

  async function saveBaseline(vendorId: string) {
    try {
      await updateDoc(doc(db, 'vendors', vendorId), {
        manualDeficitBaseline: baselineInput,
        manualDeficitUpdatedAt: new Date().toISOString()
      });
      toast.success('已更新起始欠片');
      setEditingBaselineId(null);
    } catch (e) {
      toast.error('更新失敗');
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
                    <h3 className="text-lg font-bold">{row.vendor.name}</h3>
                    <p className="text-[11px] text-gray-400 mt-0.5">本月 {row.delivered}/{row.target} 支・庫存 {row.stock}</p>
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
                    {' '}{row.target - row.delivered >= 0 ? '+' : '−'} 本月未達標 {Math.abs(row.target - row.delivered)}
                    {' '}− 已有庫存 {row.stock}
                    {row.vendor.manualDeficitUpdatedAt && (
                      <span className="ml-1 text-gray-300">・起始校正於 {row.vendor.manualDeficitUpdatedAt.slice(0, 10)}</span>
                    )}
                  </p>
                  {me && me.role !== 'employee' && (
                    editingBaselineId === row.vendor.id ? (
                      <div className="flex items-center gap-2 mt-2">
                        <input type="number" value={baselineInput} onChange={e => setBaselineInput(Number(e.target.value))}
                          className="w-20 px-2 py-1 rounded-lg border border-black/10 text-xs font-mono" autoFocus />
                        <button onClick={() => saveBaseline(row.vendor.id!)} className="text-[11px] font-bold text-[#5A5A40]">儲存</button>
                        <button onClick={() => setEditingBaselineId(null)} className="text-[11px] text-gray-400">取消</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingBaselineId(row.vendor.id!); setBaselineInput(row.baseline); }}
                        className="flex items-center gap-1 mt-2 text-[11px] font-bold text-gray-400 hover:text-[#5A5A40]"
                      >
                        <Pencil size={11} />校正起始欠片
                      </button>
                    )
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
    </div>
  );
}
