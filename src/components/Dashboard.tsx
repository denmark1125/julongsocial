import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  orderBy,
  limit 
} from 'firebase/firestore';
import { db } from '../firebase';
import { Post, Vendor, Asset, DismissedHabit } from '../types';
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
  subDays
} from 'date-fns';
import { 
  AlertTriangle, 
  Clock, 
  ArrowRight,
  ListTodo,
  BellRing,
  Plus,
  AlertCircle
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

export default function Dashboard({ setActiveTab }: { setActiveTab: (tab: string) => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);

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

    return () => {
      vUnsubscribe();
      pUnsubscribe();
      aUnsubscribe();
      dUnsubscribe();
    };
  }, []);

  const stats = [
    { label: '合作廠商', value: vendors.length, icon: PartnerIcon, color: 'text-[#5A5A40]', bg: 'bg-[#5A5A40]/10' },
    { label: '本月貼文', value: posts.length, icon: GrowthIcon, color: 'text-[#8B7355]', bg: 'bg-[#8B7355]/10' },
    { label: '已發布', value: posts.filter(p => p.status === 'published').length, icon: SuccessIcon, color: 'text-[#8A8A6A]', bg: 'bg-[#8A8A6A]/10' },
    { label: '素材庫存', value: assets.filter(a => a.status === 'available').length, icon: InventoryIcon, color: 'text-[#A67C52]', bg: 'bg-[#A67C52]/10' },
  ];

  // Low Video Stock Alert (fewer than 2 videos)
  const lowStockVendors = vendors.map(vendor => {
    const stock = assets.filter(a => a.vendorId === vendor.id && a.type === 'video' && a.status === 'available').length;
    return { ...vendor, stock };
  }).filter(v => v.stock < 2);

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
    
    vendors.forEach(vendor => {
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
    const d = parseISO(p.scheduledAt);
    return isAfter(d, weekStart) && isBefore(d, weekEnd);
  });

  const todoList = {
    needsInternal: thisWeekPosts.filter(p => !p.internalConfirmed),
    needsClient: thisWeekPosts.filter(p => p.internalConfirmed && !p.clientConfirmed),
    readyToSchedule: thisWeekPosts.filter(p => p.internalConfirmed && p.clientConfirmed && p.status === 'draft')
  };

  return (
    <div className="space-y-8">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <div key={i} className="bg-white p-6 rounded-[32px] shadow-sm border border-black/5 flex items-center space-x-4">
            <div className={`${stat.bg} p-4 rounded-2xl`}>
              <stat.icon className={stat.color} size={24} />
            </div>
            <div>
              <p className="text-sm text-gray-500 font-medium">{stat.label}</p>
              <p className="text-2xl font-bold">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Main Column - To-Do & Activity */}
        <div className="lg:col-span-8 space-y-8">
          {/* Weekly To-Do */}
          <div className="bg-white p-8 rounded-[40px] border border-black/5 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold serif flex items-center">
                <ListTodo className="text-[#5A5A40] mr-2" size={24} />
                本週工作清單
              </h3>
              <span className="text-xs text-gray-400 font-medium">
                {format(weekStart, 'MM/dd')} - {format(weekEnd, 'MM/dd')}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { label: '待主管審核', count: todoList.needsInternal.length, color: 'bg-purple-500', list: todoList.needsInternal },
                { label: '待客戶審核', count: todoList.needsClient.length, color: 'bg-blue-500', list: todoList.needsClient },
                { label: '待排程發布', count: todoList.readyToSchedule.length, color: 'bg-green-500', list: todoList.readyToSchedule }
              ].map((group, idx) => (
                <div key={idx} className="bg-[#F5F5F0] p-5 rounded-3xl space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center">
                      <span className={`w-2 h-2 ${group.color} rounded-full mr-2`}></span>
                      {group.label}
                    </p>
                    <span className="text-xs font-bold text-gray-400">{group.count}</span>
                  </div>
                  <div className="space-y-2">
                    {group.list.slice(0, 3).map(p => (
                      <div key={p.id} className="bg-white p-3 rounded-xl text-[10px] shadow-sm border border-black/5">
                        <p className="font-bold truncate mb-1">{p.title}</p>
                        <p className="text-gray-400 flex items-center">
                          <Clock size={10} className="mr-1" />
                          {format(parseISO(p.scheduledAt), 'MM/dd HH:mm')}
                        </p>
                      </div>
                    ))}
                    {group.count === 0 && <p className="text-[10px] text-gray-400 italic text-center py-4">無待辦事項</p>}
                    {group.count > 3 && <p className="text-[10px] text-center text-[#5A5A40] font-bold">還有 {group.count - 3} 項...</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="bg-white p-8 rounded-[40px] border border-black/5 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold serif">近期排程概覽</h3>
              <button onClick={() => setActiveTab('posts')} className="text-sm text-[#5A5A40] font-bold hover:underline flex items-center">
                查看全部 <ArrowRight size={14} className="ml-1" />
              </button>
            </div>
            <div className="space-y-4">
              {posts.slice(0, 5).map(post => {
                const vendor = vendors.find(v => v.id === post.vendorId);
                return (
                  <div key={post.id} className="flex items-center justify-between p-4 rounded-3xl hover:bg-[#F5F5F0] transition-colors group">
                    <div className="flex items-center space-x-4">
                      <div className="w-14 h-14 bg-[#F5F5F0] group-hover:bg-white rounded-2xl flex flex-col items-center justify-center text-[#5A5A40] transition-colors">
                        <span className="text-[10px] font-bold uppercase">{format(parseISO(post.scheduledAt), 'MMM')}</span>
                        <span className="text-xl font-bold leading-none">{format(parseISO(post.scheduledAt), 'dd')}</span>
                      </div>
                      <div>
                        <p className="font-bold text-sm truncate max-w-[200px]">{post.title}</p>
                        <p className="text-xs text-gray-400">{vendor?.name} • {post.platforms.join(', ')}</p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-4">
                      <span className={cn(
                        "text-[10px] px-3 py-1 rounded-full font-bold uppercase tracking-wider",
                        post.status === 'published' ? "bg-green-100 text-green-700" : 
                        post.status === 'scheduled' ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"
                      )}>
                        {post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : '草稿'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Sidebar Column - Alerts & Stock */}
        <div className="lg:col-span-4 space-y-8">
          {/* Video Stock Alert */}
          <div className="bg-[#5A5A40] p-8 rounded-[40px] text-white space-y-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold serif flex items-center">
                <AlertCircle className="mr-2" size={20} />
                影片素材警示
              </h3>
              <span className="bg-white/20 px-2 py-1 rounded-lg text-xs font-bold">
                低於 2 部
              </span>
            </div>
            <div className="space-y-3">
              {lowStockVendors.length > 0 ? lowStockVendors.map(v => (
                <div key={v.id} className="bg-white/10 p-4 rounded-2xl flex justify-between items-center backdrop-blur-sm">
                  <div>
                    <p className="font-bold text-sm">{v.name}</p>
                    <p className="text-xs text-white/60">目前庫存：{v.stock} 部</p>
                  </div>
                  <button 
                    onClick={() => setActiveTab('videos')}
                    className="bg-white text-[#5A5A40] p-2 rounded-xl hover:scale-105 transition-transform"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              )) : (
                <div className="text-center py-4 text-white/60 italic text-sm">
                  目前庫存充足
                </div>
              )}
            </div>
          </div>

          {/* Missing Schedules */}
          <div className="bg-white p-8 rounded-[40px] border border-black/5 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold serif flex items-center">
                <BellRing className="text-[#A67C52] mr-2" size={20} />
                缺漏排程提醒
              </h3>
              <span className="bg-[#A67C52]/10 text-[#A67C52] text-xs font-bold px-2 py-1 rounded-full">
                {missingSchedules.length}
              </span>
            </div>
            <div className="space-y-3">
              {missingSchedules.slice(0, 5).map((miss, idx) => (
                <div key={idx} className="p-4 bg-[#F5F5F0] rounded-2xl flex justify-between items-center">
                  <div>
                    <p className="text-xs font-bold text-gray-700">{miss.vendorName}</p>
                    <p className="text-[10px] text-gray-400">
                      {format(miss.date, 'MM/dd (eee)')} {miss.habit.time}
                    </p>
                  </div>
                  <button onClick={() => setActiveTab('posts')} className="text-[#5A5A40] hover:scale-110 transition-transform">
                    <Plus size={16} />
                  </button>
                </div>
              ))}
              {missingSchedules.length === 0 && (
                <div className="text-center py-8 text-gray-400 italic text-sm">
                  排程已全數完成
                </div>
              )}
            </div>
          </div>

          {/* Urgent Approvals */}
          <div className="bg-white p-8 rounded-[40px] border border-black/5 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold serif flex items-center">
                <AlertTriangle className="text-[#8B4513] mr-2" size={20} />
                緊急審核
              </h3>
              <span className="bg-[#8B4513]/10 text-[#8B4513] text-xs font-bold px-2 py-1 rounded-full">
                {approvalReminders.length}
              </span>
            </div>
            <div className="space-y-3">
              {approvalReminders.slice(0, 3).map(post => (
                <div key={post.id} className="p-4 border border-[#8B4513]/10 rounded-2xl bg-[#8B4513]/5 space-y-2">
                  <p className="text-xs font-bold truncate">{post.title}</p>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-gray-400">{format(parseISO(post.scheduledAt), 'MM/dd HH:mm')}</span>
                    <button onClick={() => setActiveTab('posts')} className="text-xs text-[#8B4513] font-bold">
                      處理
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
