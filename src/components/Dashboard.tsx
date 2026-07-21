import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  orderBy,
  limit 
} from 'firebase/firestore';
import { db } from '../firebase';
import { Post, Vendor, Asset, DismissedHabit, BillingRecord, BillingContract, ShootBooking } from '../types';
import { visibleVendors, trackedVendors, getVideoStockAlert, getOwedVideoCount, getAvailableVideoAssets, hasVideoTrackingScope, LOW_STOCK_RUNWAY_DAYS } from '../lib/vendorStatus';
import { 
  format, 
  isPast, 
  addDays, 
  parseISO,
  isAfter,
  isBefore,
  startOfWeek,
  endOfWeek,
  isSameDay,
  getDay,
  subDays,
  isSameMonth
} from 'date-fns';
import { 
  AlertTriangle, 
  Clock, 
  ArrowRight,
  ListTodo,
  BellRing,
  Plus,
  AlertCircle,
  CreditCard,
  Film,
  Scissors,
  Download
} from 'lucide-react';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import toast from 'react-hot-toast';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { 
  PartnerIcon, 
  GrowthIcon, 
  SuccessIcon, 
  InventoryIcon 
} from './CustomIcons';
import EditReminderExportModal from './EditReminderExportModal';

export default function Dashboard({ setActiveTab }: { setActiveTab: (tab: string) => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);
  const [billingRecords, setBillingRecords] = useState<BillingRecord[]>([]);
  const [contracts, setContracts] = useState<BillingContract[]>([]);
  const [bookings, setBookings] = useState<ShootBooking[]>([]);
  const [isEditReminderModalOpen, setIsEditReminderModalOpen] = useState(false);

  useEffect(() => {
    const vUnsubscribe = onSnapshot(collection(db, 'vendors'), (snapshot) => {
      setVendors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Vendor)));
    });

    const pUnsubscribe = onSnapshot(collection(db, 'posts'), (snapshot) => {
      setPosts(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Post)));
    });

    const aUnsubscribe = onSnapshot(collection(db, 'assets'), (snapshot) => {
      setAssets(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Asset)));
    });

    const dUnsubscribe = onSnapshot(collection(db, 'dismissedHabits'), (snapshot) => {
      setDismissedHabits(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as DismissedHabit)));
    });

    const brUnsubscribe = onSnapshot(collection(db, 'billingRecords'), (snapshot) => {
      setBillingRecords(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BillingRecord)));
    });

    const cUnsubscribe = onSnapshot(collection(db, 'billingContracts'), (snapshot) => {
      setContracts(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BillingContract)));
    });

    const bkUnsubscribe = onSnapshot(collection(db, 'shootBookings'), (snapshot) => {
      setBookings(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ShootBooking)));
    });

    return () => {
      vUnsubscribe();
      pUnsubscribe();
      aUnsubscribe();
      dUnsubscribe();
      brUnsubscribe();
      cUnsubscribe();
      bkUnsubscribe();
    };
  }, []);

  const stats = [
    { label: '合作廠商', value: visibleVendors(vendors).length, icon: PartnerIcon, color: 'text-[#5A5A40]', bg: 'bg-[#5A5A40]/10' },
    { label: '本月貼文', value: posts.length, icon: GrowthIcon, color: 'text-[#8B7355]', bg: 'bg-[#8B7355]/10' },
    { label: '已發布', value: posts.filter(p => p.status === 'published').length, icon: SuccessIcon, color: 'text-[#8A8A6A]', bg: 'bg-[#8A8A6A]/10' },
    { label: '素材庫存', value: assets.filter(a => a.status === 'available').length, icon: InventoryIcon, color: 'text-[#A67C52]', bg: 'bg-[#A67C52]/10' },
  ];

  // Video Stock Alert：分兩級——'shoot'=連原始素材都不夠撐 LOW_STOCK_RUNWAY_DAYS 天，要安排拍攝；
  // 'edit'=素材夠但沒剪完，成片撐不到天數，催剪輯優先處理。
  // 用 hasVideoTrackingScope 而非 trackedVendors：冷凍中的廠商如果還留有舊欠片，一樣要提醒，不能因為冷凍就從告警清單消失
  // （這個月本身不會疊加新短缺/新的撐幾天壓力，那部分邏輯在 getDeficitBreakdown/getWeeklyPace 內部已經處理）
  const dashboardMonth = format(new Date(), 'yyyy-MM');
  const stockAlertVendors = vendors.filter(v => hasVideoTrackingScope(v, dashboardMonth)).map(vendor => {
    const vendorVideoAssets = getAvailableVideoAssets(vendor.id!, assets, posts);
    const owed = getOwedVideoCount(vendor, posts, vendorVideoAssets.length);
    const alert = getVideoStockAlert(vendor, vendorVideoAssets, owed);
    const activeBooking = bookings
      .filter(b => b.vendorId === vendor.id && b.status === 'booked')
      .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate))[0] || null;
    return { ...vendor, ...alert, activeBooking };
  }).filter(v => v.severity !== null)
    .sort((a, b) => (a.severity === 'shoot' ? 0 : 1) - (b.severity === 'shoot' ? 0 : 1));

  // Reminders: Posts that need attention
  const approvalReminders = posts.filter(p => {
    const scheduledDate = parseISO(p.scheduledAt);
    const fiveDaysFromNow = addDays(new Date(), 5);
    const threeDaysFromNow = addDays(new Date(), 3);
    const twoDaysFromNow = addDays(new Date(), 2);
    
    const needsInternal = !p.internalConfirmed && isBefore(scheduledDate, fiveDaysFromNow) && isAfter(scheduledDate, new Date());
    const needsClient = !p.clientConfirmed && isBefore(scheduledDate, threeDaysFromNow) && isAfter(scheduledDate, new Date());
    const needsSchedule = p.status === 'draft' && isBefore(scheduledDate, twoDaysFromNow) && isAfter(scheduledDate, new Date());
    
    return needsInternal || needsClient || needsSchedule;
  });

  // Missing Schedule Logic: Check next 7 days
  const missingSchedules = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const checkDate = addDays(today, i);
    const dayOfWeek = getDay(checkDate);
    const dateStr = format(checkDate, 'yyyy-MM-dd');
    
    trackedVendors(vendors).forEach(vendor => {
      const habits = vendor.postingHabits || [];
      const dayHabits = habits.filter(h => h.daysOfWeek.includes(dayOfWeek));

      dayHabits.forEach(habit => {
        // Check if dismissed
        const isDismissed = dismissedHabits.some(d => 
          d.vendorId === vendor.id && 
          d.habitTime === habit.time && 
          d.date === dateStr
        );

        if (isDismissed) return;

        // Check if fulfilled (post on day +/- 1)
        const isFulfilled = posts.some(p => 
          p.vendorId === vendor.id && 
          (
            isSameDay(parseISO(p.scheduledAt), checkDate) || 
            isSameDay(parseISO(p.scheduledAt), subDays(checkDate, 1)) ||
            isSameDay(parseISO(p.scheduledAt), addDays(checkDate, 1))
          )
        );
        
        if (!isFulfilled) {
          missingSchedules.push({
            vendorId: vendor.id,
            vendorName: vendor.name,
            date: checkDate,
            habit: habit
          });
        }
      });
    });
  }

  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 });
  const thisWeekPosts = posts.filter(p => {
    if (!p.scheduledAt || p.scheduledAt.length === 0) return false;
    const d = parseISO(p.scheduledAt);
    return isAfter(d, weekStart) && isBefore(d, weekEnd);
  });

  const todoList = {
    needsInternal: thisWeekPosts.filter(p => !p.internalConfirmed),
    needsClient: thisWeekPosts.filter(p => p.internalConfirmed && !p.clientConfirmed),
    readyToSchedule: thisWeekPosts.filter(p => p.internalConfirmed && p.clientConfirmed && p.status === 'draft')
  };

  const pendingBills = billingRecords.filter(r => 
    r.status !== 'paid' && 
    isSameMonth(parseISO(r.dueDate), new Date())
  );

  // Expiring Contracts (within 30 days)
  const expiringContracts = contracts.filter(c => {
    if (!c.endDate) return false;
    const end = parseISO(c.endDate);
    const diff = addDays(new Date(), 30);
    return isBefore(end, diff) && isAfter(end, subDays(new Date(), 1)) && c.status === 'active';
  });

  return (
    <div className="space-y-4 md:space-y-8">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-6">
        {stats.map((stat, i) => (
          <div key={i} className="bg-white p-4 md:p-6 rounded-2xl md:rounded-[32px] shadow-sm border border-black/5 flex flex-col md:flex-row items-center md:items-center space-y-2 md:space-y-0 md:space-x-4 text-center md:text-left">
            <div className={`${stat.bg} p-3 md:p-4 rounded-xl md:rounded-2xl`}>
              <stat.icon className={cn(stat.color, "w-5 h-5 md:w-6 md:h-6")} />
            </div>
            <div>
              <p className="text-[10px] md:text-sm text-gray-500 font-medium">{stat.label}</p>
              <p className="text-lg md:text-2xl font-bold">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-8">
        {/* Main Column - To-Do & Activity */}
        <div className="lg:col-span-8 space-y-4 md:space-y-8">
          {/* Weekly To-Do */}
          <div className="bg-white p-5 md:p-8 rounded-3xl md:rounded-[40px] border border-black/5 shadow-sm space-y-4 md:space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg md:text-xl font-bold serif flex items-center">
                <ListTodo className="text-[#5A5A40] mr-2 w-5 h-5 md:w-6 md:h-6" />
                本週工作清單
              </h3>
              <span className="text-[10px] md:text-xs text-gray-400 font-medium">
                {format(weekStart, 'MM/dd')} - {format(weekEnd, 'MM/dd')}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              {[
                { label: '待主管審核', count: todoList.needsInternal.length, color: 'bg-purple-500', list: todoList.needsInternal },
                { label: '待客戶審核', count: todoList.needsClient.length, color: 'bg-blue-500', list: todoList.needsClient },
                { label: '待排程發布', count: todoList.readyToSchedule.length, color: 'bg-green-500', list: todoList.readyToSchedule }
              ].map((group, idx) => (
                <div key={idx} className="bg-[#F5F5F0] p-4 md:p-5 rounded-2xl md:rounded-3xl space-y-3 md:space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] md:text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center">
                      <span className={`w-1.5 h-1.5 md:w-2 md:h-2 ${group.color} rounded-full mr-1.5 md:mr-2`}></span>
                      {group.label}
                    </p>
                    <span className="text-[10px] md:text-xs font-bold text-gray-400">{group.count}</span>
                  </div>
                  <div className="space-y-2">
                    {group.list.slice(0, 3).map(p => (
                      <div key={p.id} className="bg-white p-2.5 md:p-3 rounded-xl text-[10px] shadow-sm border border-black/5">
                        <p className="font-bold truncate mb-0.5 md:mb-1">{p.title}</p>
                        <p className="text-gray-400 flex items-center">
                          <Clock size={8} md:size={10} className="mr-1" />
                          {p.scheduledAt && p.scheduledAt.length > 0 ? format(parseISO(p.scheduledAt), 'MM/dd HH:mm') : '未定'}
                        </p>
                      </div>
                    ))}
                    {group.count === 0 && <p className="text-[10px] text-gray-400 italic text-center py-2 md:py-4">無待辦事項</p>}
                    {group.count > 3 && <p className="text-[10px] text-center text-[#5A5A40] font-bold">還有 {group.count - 3} 項...</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="bg-white p-5 md:p-8 rounded-3xl md:rounded-[40px] border border-black/5 shadow-sm space-y-4 md:space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg md:text-xl font-bold serif">近期排程概覽</h3>
              <button onClick={() => setActiveTab('posts')} className="text-xs md:text-sm text-[#5A5A40] font-bold hover:underline flex items-center">
                查看全部 <ArrowRight size={12} md:size={14} className="ml-1" />
              </button>
            </div>
            <div className="space-y-2 md:space-y-4">
              {[...posts]
                .filter(p => p.scheduledAt)
                .sort((a, b) => (b.scheduledAt || '').localeCompare(a.scheduledAt || ''))
                .slice(0, 5)
                .map(post => {
                const vendor = vendors.find(v => v.id === post.vendorId);
                return (
                  <div key={post.id} className="flex items-center justify-between p-3 md:p-4 rounded-2xl md:rounded-3xl hover:bg-[#F5F5F0] transition-colors group">
                    <div className="flex items-center space-x-3 md:space-x-4">
                      <div className="w-12 h-12 md:w-14 md:h-14 bg-[#F5F5F0] group-hover:bg-white rounded-xl md:rounded-2xl flex flex-col items-center justify-center text-[#5A5A40] transition-colors">
                        <span className="text-[8px] md:text-[10px] font-bold uppercase">{post.scheduledAt ? format(parseISO(post.scheduledAt), 'MMM') : '-'}</span>
                        <span className="text-lg md:text-xl font-bold leading-none">{post.scheduledAt ? format(parseISO(post.scheduledAt), 'dd') : '-'}</span>
                      </div>
                      <div className="max-w-[140px] md:max-w-[200px]">
                        <p className="font-bold text-xs md:text-sm truncate">{post.title}</p>
                        <p className="text-[10px] md:text-xs text-gray-400 truncate">{vendor?.name} • {post.platforms.join(', ')}</p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2 md:space-x-4">
                      <span className={cn(
                        "text-[8px] md:text-[10px] px-2 md:px-3 py-0.5 md:py-1 rounded-full font-bold uppercase tracking-wider",
                        post.status === 'published' ? "bg-green-100 text-green-700" : 
                        post.status === 'scheduled' ? "bg-blue-100 text-blue-700" : 
                        post.status === 'pending' ? "bg-orange-100 text-orange-700" : 
                        "bg-gray-100 text-gray-600"
                      )}>
                        {post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : post.status === 'pending' ? '待補中' : '草稿'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Sidebar Column - Alerts & Stock */}
        <div className="lg:col-span-4 space-y-4 md:space-y-8">
          {/* Video Stock Alert */}
          <div className="bg-[#5A5A40] p-5 md:p-8 rounded-3xl md:rounded-[40px] text-white space-y-4 md:space-y-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base md:text-lg font-bold serif flex items-center">
                <AlertCircle className="mr-2" size={18} md:size={20} />
                影片素材警示
              </h3>
              <span className="bg-white/20 px-2 py-1 rounded-lg text-[10px] md:text-xs font-bold">
                低於 {LOW_STOCK_RUNWAY_DAYS} 天
              </span>
            </div>
            {stockAlertVendors.some(v => v.severity === 'edit') && (
              <button
                onClick={() => setIsEditReminderModalOpen(true)}
                className="w-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold py-2 rounded-xl transition-colors flex items-center justify-center"
              >
                <Download size={14} className="mr-1.5" /> 導出催剪輯清單
              </button>
            )}
            <div className="space-y-2 md:space-y-3">
              {stockAlertVendors.length > 0 ? stockAlertVendors.map(v => (
                <div key={v.id} className="bg-white/10 p-3 md:p-4 rounded-xl md:rounded-2xl flex justify-between items-center backdrop-blur-sm">
                  <div className="flex items-start space-x-2">
                    {v.severity === 'shoot' ? (
                      <Film size={16} className="text-red-300 mt-0.5 shrink-0" />
                    ) : (
                      <Scissors size={16} className="text-amber-300 mt-0.5 shrink-0" />
                    )}
                    <div>
                      <p className="font-bold text-xs md:text-sm">
                        {v.name}
                        <span className={cn(
                          "ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold align-middle",
                          v.severity === 'shoot' ? "bg-red-400/30 text-red-100" : "bg-amber-400/30 text-amber-100"
                        )}>
                          {v.severity === 'shoot' ? '需拍片' : '催剪輯'}
                        </span>
                      </p>
                      {v.severity === 'shoot' ? (
                        <p className="text-[10px] md:text-xs text-white/60">
                          成片+素材共 {v.finishedStock + v.rawStock} 部
                          {v.owed > 0
                            ? `，累計已欠 ${v.owed} 支`
                            : `，只夠撐 ${Math.max(0, Math.floor(v.totalRunwayDays!))} 天`}
                          ，需盡快安排拍攝
                        </p>
                      ) : (
                        <p className="text-[10px] md:text-xs text-white/60">
                          成片剩 {v.finishedStock} 部只夠撐 {Math.max(0, Math.floor(v.finishedRunwayDays!))} 天，另有 {v.rawStock} 部待剪
                          {v.editorName ? `，麻煩去催剪輯師「${v.editorName}」優先剪` : '，麻煩去催剪輯師優先剪'}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {v.activeBooking && (
                      <span className="bg-emerald-400/20 text-emerald-100 px-2 py-1 rounded-lg text-[9px] md:text-[10px] font-bold whitespace-nowrap">
                        已預約 {format(parseISO(v.activeBooking.scheduledDate), 'MM/dd')}
                      </span>
                    )}
                    <button
                      onClick={() => setActiveTab(v.severity === 'shoot' ? 'shootBookings' : 'videos')}
                      className="bg-white text-[#5A5A40] p-1.5 md:p-2 rounded-lg md:rounded-xl hover:scale-105 transition-transform shrink-0"
                    >
                      <Plus size={14} md:size={16} />
                    </button>
                  </div>
                </div>
              )) : (
                <div className="text-center py-4 text-white/60 italic text-xs md:text-sm">
                  目前庫存充足
                </div>
              )}
            </div>
          </div>

          {/* Missing Schedules */}
          <div className="bg-white p-5 md:p-8 rounded-3xl md:rounded-[40px] border border-black/5 shadow-sm space-y-4 md:space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-base md:text-lg font-bold serif flex items-center">
                <BellRing className="text-[#A67C52] mr-2" size={18} md:size={20} />
                缺漏排程提醒
              </h3>
              <span className="bg-[#A67C52]/10 text-[#A67C52] text-[10px] md:text-xs font-bold px-2 py-0.5 md:py-1 rounded-full">
                {missingSchedules.length}
              </span>
            </div>
            <div className="space-y-2 md:space-y-3">
              {missingSchedules.slice(0, 5).map((miss, idx) => (
                <div key={idx} className="p-3 md:p-4 bg-[#F5F5F0] rounded-xl md:rounded-2xl flex justify-between items-center">
                  <div>
                    <p className="text-[10px] md:text-xs font-bold text-gray-700">{miss.vendorName}</p>
                    <p className="text-[8px] md:text-[10px] text-gray-400">
                      {format(miss.date, 'MM/dd (eee)')} {miss.habit.time}
                    </p>
                  </div>
                  <button onClick={() => setActiveTab('posts')} className="text-[#5A5A40] hover:scale-110 transition-transform">
                    <Plus size={14} md:size={16} />
                  </button>
                </div>
              ))}
              {missingSchedules.length === 0 && (
                <div className="text-center py-6 md:py-8 text-gray-400 italic text-xs md:text-sm">
                  排程已全數完成
                </div>
              )}
            </div>
          </div>

          {/* Urgent Approvals */}
          <div className="bg-white p-5 md:p-8 rounded-3xl md:rounded-[40px] border border-black/5 shadow-sm space-y-4 md:space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-base md:text-lg font-bold serif flex items-center">
                <AlertTriangle className="text-[#8B4513] mr-2" size={18} md:size={20} />
                緊急審核
              </h3>
              <span className="bg-[#8B4513]/10 text-[#8B4513] text-[10px] md:text-xs font-bold px-2 py-0.5 md:py-1 rounded-full">
                {approvalReminders.length}
              </span>
            </div>
            <div className="space-y-2 md:space-y-3">
              {approvalReminders.slice(0, 3).map(post => (
                <div key={post.id} className="p-3 md:p-4 border border-[#8B4513]/10 rounded-xl md:rounded-2xl bg-[#8B4513]/5 space-y-1 md:space-y-2">
                  <p className="text-[10px] md:text-xs font-bold truncate">{post.title}</p>
                  <div className="flex justify-between items-center">
                    <span className="text-[8px] md:text-[10px] text-gray-400">{post.scheduledAt ? format(parseISO(post.scheduledAt), 'MM/dd HH:mm') : '-'}</span>
                    <button onClick={() => setActiveTab('posts')} className="text-[10px] md:text-xs text-[#8B4513] font-bold">
                      處理
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Pending Bills */}
          <div className="bg-white p-5 md:p-8 rounded-3xl md:rounded-[40px] border border-black/5 shadow-sm space-y-4 md:space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-base md:text-lg font-bold serif flex items-center">
                <CreditCard className="text-[#5A5A40] mr-2" size={18} md:size={20} />
                待核收帳款
              </h3>
              <span className="bg-[#5A5A40]/10 text-[#5A5A40] text-[10px] md:text-xs font-bold px-2 py-0.5 md:py-1 rounded-full">
                {pendingBills.length}
              </span>
            </div>
            <div className="space-y-2 md:space-y-3">
              {pendingBills.slice(0, 3).map(record => {
                const vendor = vendors.find(v => v.id === record.vendorId);
                return (
                  <div key={record.id} className="p-3 md:p-4 bg-[#F5F5F0] rounded-xl md:rounded-2xl flex justify-between items-center">
                    <div>
                      <p className="text-[10px] md:text-xs font-bold text-gray-700">{vendor?.name}</p>
                      <p className="text-[8px] md:text-[10px] text-gray-400">
                        出帳日: {format(parseISO(record.dueDate), 'MM/dd')}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-bold text-[#5A5A40]">${record.amount.toLocaleString()}</p>
                      <button onClick={() => setActiveTab('billing')} className="text-[8px] md:text-[10px] text-gray-400 hover:text-[#5A5A40] underline">
                        查看
                      </button>
                    </div>
                  </div>
                );
              })}
              {pendingBills.length === 0 && (
                <div className="text-center py-6 md:py-8 text-gray-400 italic text-xs md:text-sm">
                  本月帳款已結清
                </div>
              )}
            </div>
          </div>

          {/* Expiring Contracts */}
          {expiringContracts.length > 0 && (
            <div className="bg-white p-5 md:p-8 rounded-3xl md:rounded-[40px] border border-black/5 shadow-sm space-y-4 md:space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-base md:text-lg font-bold serif flex items-center">
                  <AlertCircle className="text-red-500 mr-2" size={18} md:size={20} />
                  合約即將到期
                </h3>
                <span className="bg-red-100 text-red-700 text-[10px] md:text-xs font-bold px-2 py-0.5 md:py-1 rounded-full">
                  {expiringContracts.length}
                </span>
              </div>
              <div className="space-y-2 md:space-y-3">
                {expiringContracts.map(contract => {
                  const vendor = vendors.find(v => v.id === contract.vendorId);
                  return (
                    <div key={contract.id} className="p-3 md:p-4 bg-red-50 rounded-xl md:rounded-2xl flex justify-between items-center">
                      <div>
                        <p className="text-[10px] md:text-xs font-bold text-red-700">{vendor?.name}</p>
                        <p className="text-[8px] md:text-[10px] text-red-400">
                          到期日: {contract.endDate}
                        </p>
                      </div>
                      <button onClick={() => setActiveTab('billing')} className="text-[8px] md:text-[10px] text-red-700 font-bold underline">
                        續約
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <EditReminderExportModal
        isOpen={isEditReminderModalOpen}
        onClose={() => setIsEditReminderModalOpen(false)}
        vendors={vendors}
        assets={assets}
        posts={posts}
      />
    </div>
  );
}
