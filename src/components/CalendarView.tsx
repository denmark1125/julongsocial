import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  where,
  updateDoc, 
  doc, 
  addDoc
} from 'firebase/firestore';
import { db } from '../firebase';
import { Post, Vendor, Asset, DismissedHabit } from '../types';
import PostDetailModal from './PostDetailModal';
import { 
  format, 
  startOfMonth, 
  endOfMonth, 
  eachDayOfInterval, 
  isSameDay, 
  addMonths, 
  subMonths,
  getDay,
  parseISO,
  subDays,
  addDays
} from 'date-fns';
import { ChevronLeft, ChevronRight, Clock, Plus, Download, X, Calendar as CalendarIcon, BellRing } from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import * as XLSX from 'xlsx';
import TrackingExportModal from './TrackingExportModal';

export default function CalendarView() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('calendar');
  const [isTrackingModalOpen, setIsTrackingModalOpen] = useState(false);

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

  const handleDragStart = (e: React.DragEvent, type: 'post' | 'habit', id: string, data?: any) => {
    e.stopPropagation();
    e.dataTransfer.setData('type', type);
    e.dataTransfer.setData('id', id);
    if (data) e.dataTransfer.setData('data', JSON.stringify(data));
    
    // Add visual feedback
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.4';
    }
  };

  const handleDragEnd = (e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
  };

  const handleDrop = async (e: React.DragEvent, date: Date) => {
    e.preventDefault();
    e.stopPropagation();
    
    const type = e.dataTransfer.getData('type');
    const id = e.dataTransfer.getData('id');
    const dataStr = e.dataTransfer.getData('data');

    if (!type || !id) return;

    if (type === 'post') {
      try {
        const post = posts.find(p => p.id === id);
        if (post) {
          const oldDate = parseISO(post.scheduledAt);
          const newDate = new Date(date);
          newDate.setHours(oldDate.getHours(), oldDate.getMinutes());
          
          // Only update if the date actually changed to avoid unnecessary writes
          if (!isSameDay(oldDate, newDate)) {
            await updateDoc(doc(db, 'posts', id), { 
              scheduledAt: format(newDate, "yyyy-MM-dd'T'HH:mm"),
              // Ensure we don't accidentally create a new one by being explicit
            });
            toast.success('已移動貼文');
          }
        }
      } catch (error) {
        console.error('Move error:', error);
        toast.error('移動失敗');
      }
    } else if (type === 'habit') {
      const habit = JSON.parse(dataStr);
      try {
        // Create a draft post based on habit
        const newDate = new Date(date);
        const [hours, minutes] = habit.time.split(':').map(Number);
        newDate.setHours(hours, minutes);

        await addDoc(collection(db, 'posts'), {
          vendorId: habit.vendorId,
          title: `[預約] ${habit.vendorName} - ${habit.contentTypes.join('/')}`,
          content: '',
          status: 'draft',
          scheduledAt: format(newDate, "yyyy-MM-dd'T'HH:mm"),
          type: 'social',
          contentType: habit.contentTypes[0] === 'video' ? 'video' : 'post',
          clientConfirmed: false,
          internalConfirmed: false,
          platforms: habit.platforms || ['Instagram', 'Facebook'],
          createdBy: 'system',
          createdAt: new Date().toISOString()
        });
        toast.success('已根據習慣建立草稿');
      } catch (error) {
        toast.error('建立失敗');
      }
    }
  };

  const dismissHabit = async (vendorId: string, habitTime: string, date: Date) => {
    try {
      await addDoc(collection(db, 'dismissedHabits'), {
        vendorId,
        habitTime,
        date: format(date, 'yyyy-MM-dd'),
        createdAt: new Date().toISOString()
      });
      toast.success('已刪除預定排程');
    } catch (error) {
      toast.error('刪除失敗');
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const exportToExcel = () => {
    const exportData = posts.map(post => {
      const vendor = vendors.find(v => v.id === post.vendorId);
      return {
        '廠商名稱': vendor?.name || '未知',
        '貼文標題': post.title,
        '內容類型': post.contentType === 'video' ? '短影音' : '圖文',
        '發布狀態': post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : '草稿',
        '預計發布時間': format(parseISO(post.scheduledAt), 'yyyy-MM-dd HH:mm'),
        '發布平台': post.platforms?.join(', ') || '',
        '業主審核': post.clientConfirmed ? '已確認' : '待確認',
        '內部檢核': post.internalConfirmed ? '已檢核' : '待檢核',
        '建立時間': format(parseISO(post.createdAt), 'yyyy-MM-dd HH:mm')
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "貼文排程");
    XLSX.writeFile(workbook, `社群日曆匯出_${format(new Date(), 'yyyyMMdd')}.xlsx`);
  };

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  
  const startDay = getDay(monthStart);
  const paddingDays = Array.from({ length: startDay }).map((_, i) => null);
  const calendarDays = [...paddingDays, ...days];

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];

  const filteredPosts = posts.filter(p => 
    format(parseISO(p.scheduledAt), 'yyyy-MM') === format(currentDate, 'yyyy-MM')
  ).sort((a, b) => parseISO(a.scheduledAt).getTime() - parseISO(b.scheduledAt).getTime());

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden flex flex-col h-full">
      <div className="p-4 sm:p-6 flex flex-col sm:flex-row items-center justify-between border-b border-black/5 gap-4 bg-white sticky top-0 z-20">
        <div className="flex items-center justify-between w-full sm:w-auto">
          <div className="flex items-center space-x-4">
            <h3 className="text-xl font-bold serif">{format(currentDate, 'yyyy年 MM月')}</h3>
            <button 
              onClick={() => setIsTrackingModalOpen(true)}
              className="hidden sm:flex bg-orange-50 text-orange-600 px-4 py-1.5 rounded-xl items-center shadow-sm border border-orange-100 hover:bg-orange-100 transition-all text-xs font-bold"
            >
              <BellRing size={16} className="mr-2" /> 催片導出
            </button>
            <button 
              onClick={exportToExcel}
              className="hidden sm:flex bg-white text-gray-600 px-4 py-1.5 rounded-xl items-center shadow-sm border border-black/5 hover:bg-gray-50 transition-all text-xs font-bold"
            >
              <Download size={16} className="mr-2" /> 匯出 Excel
            </button>
          </div>
          
          {/* View Mode Toggle - Mobile Only */}
          <div className="flex bg-gray-100 p-1 rounded-xl md:hidden">
            <button 
              onClick={() => setViewMode('calendar')}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                viewMode === 'calendar' ? "bg-white text-[#5A5A40] shadow-sm" : "text-gray-400"
              )}
            >
              日曆
            </button>
            <button 
              onClick={() => setViewMode('list')}
              className={clsx(
                "px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all",
                viewMode === 'list' ? "bg-white text-[#5A5A40] shadow-sm" : "text-gray-400"
              )}
            >
              清單
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between w-full sm:w-auto space-x-2">
          <div className="flex space-x-1">
            <button 
              onClick={() => setCurrentDate(subMonths(currentDate, 1))}
              className="p-2 hover:bg-[#F5F5F0] rounded-xl transition-colors"
            >
              <ChevronLeft size={20} />
            </button>
            <button 
              onClick={() => setCurrentDate(new Date())}
              className="px-4 py-2 text-sm font-bold hover:bg-[#F5F5F0] rounded-xl transition-colors"
            >
              今天
            </button>
            <button 
              onClick={() => setCurrentDate(addMonths(currentDate, 1))}
              className="p-2 hover:bg-[#F5F5F0] rounded-xl transition-colors"
            >
              <ChevronRight size={20} />
            </button>
          </div>
          
          <button 
            onClick={exportToExcel}
            className="sm:hidden p-2 text-gray-600 hover:bg-gray-100 rounded-xl border border-black/5"
          >
            <Download size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {viewMode === 'calendar' ? (
          <div className="min-w-[700px] md:min-w-0">
            <div className="grid grid-cols-7 border-b border-black/5 bg-gray-50/50">
              {weekDays.map(day => (
                <div key={day} className="p-4 text-center text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                  {day}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 auto-rows-[minmax(120px,auto)]">
              {calendarDays.map((day, idx) => {
                if (!day) return <div key={`pad-${idx}`} className="bg-gray-50/30 border-r border-b border-black/5"></div>;
                
                const dayPosts = posts.filter(p => isSameDay(parseISO(p.scheduledAt), day));
                const dayOfWeek = getDay(day);
                
                // Find habits for this day
                const dayHabits = vendors.flatMap(v => 
                  (v.postingHabits || [])
                    .filter(h => h.daysOfWeek.includes(dayOfWeek))
                    .map(h => ({ ...h, vendorName: v.name, vendorId: v.id }))
                );
                
                return (
                  <div 
                    key={day.toString()} 
                    onDragOver={onDragOver}
                    onDrop={(e) => handleDrop(e, day)}
                    className="border-r border-b border-black/5 p-2 overflow-y-auto hover:bg-gray-50 transition-colors group min-h-[120px]"
                  >
                    <div className={clsx(
                      "text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full mb-1",
                      isSameDay(day, new Date()) ? "bg-[#5A5A40] text-white" : "text-gray-400"
                    )}>
                      {format(day, 'd')}
                    </div>
                    <div className="space-y-1">
                      {/* Posting Habits Reminders */}
                      {dayHabits.map((habit, hIdx) => {
                        const isDismissed = dismissedHabits.some(d => 
                          d.vendorId === habit.vendorId && 
                          d.habitTime === habit.time && 
                          d.date === format(day, 'yyyy-MM-dd')
                        );

                        if (isDismissed) return null;

                        const isFulfilled = posts.some(p => 
                          p.vendorId === habit.vendorId && 
                          (
                            isSameDay(parseISO(p.scheduledAt), day) || 
                            isSameDay(parseISO(p.scheduledAt), subDays(day, 1)) ||
                            isSameDay(parseISO(p.scheduledAt), addDays(day, 1))
                          )
                        );
                        
                        if (isFulfilled) return null;

                        return (
                          <div 
                            key={`habit-${hIdx}`} 
                            draggable
                            onDragStart={(e) => handleDragStart(e, 'habit', `habit-${hIdx}`, habit)}
                            onDragEnd={handleDragEnd}
                            className="group/habit relative text-[9px] p-1 rounded bg-orange-50 text-orange-700 border border-orange-100 flex items-center opacity-70 cursor-grab active:cursor-grabbing hover:opacity-100 transition-opacity"
                          >
                            <span className="font-bold mr-1">{habit.time}</span>
                            <span className="truncate flex-1">🔔 {habit.vendorName}: {habit.contentTypes.map(t => t === 'post' ? '貼' : '影').join('/')}</span>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                dismissHabit(habit.vendorId, habit.time, day);
                              }}
                              className="hidden group-hover/habit:flex ml-1 p-0.5 hover:bg-orange-200 rounded-full transition-colors"
                            >
                              <X size={8} />
                            </button>
                          </div>
                        );
                      })}

                      {/* Actual Posts */}
                      {dayPosts.map(post => {
                        const vendor = vendors.find(v => v.id === post.vendorId);
                        return (
                          <div 
                            key={post.id} 
                            draggable
                            onDragStart={(e) => handleDragStart(e, 'post', post.id!)}
                            onDragEnd={handleDragEnd}
                            onClick={() => setSelectedPost(post)}
                            className={clsx(
                              "text-[9px] p-1 rounded border flex flex-col leading-tight mb-1 cursor-pointer hover:shadow-md transition-all",
                              post.status === 'published' ? "bg-green-50 text-green-700 border-green-100" : 
                              post.status === 'scheduled' ? "bg-blue-50 text-blue-700 border-blue-100" : 
                              post.status === 'pending' ? "bg-orange-50 text-orange-700 border-orange-100" :
                              "bg-gray-50 text-gray-600 border-gray-200"
                            )}
                          >
                            <div className="flex items-center gap-1 overflow-hidden">
                              <span className="font-bold flex-shrink-0">{format(parseISO(post.scheduledAt), 'HH:mm')}</span>
                              <span className="opacity-70 flex-shrink-0">[{post.contentType === 'post' ? '圖文' : '影'}]</span>
                              <span className="truncate font-bold">{vendor?.name}</span>
                            </div>
                            <div className="truncate opacity-90">{post.title}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {filteredPosts.length > 0 ? (
              filteredPosts.map((post, idx) => {
                const vendor = vendors.find(v => v.id === post.vendorId);
                const prevPost = idx > 0 ? filteredPosts[idx - 1] : null;
                const showDateHeader = !prevPost || !isSameDay(parseISO(post.scheduledAt), parseISO(prevPost.scheduledAt));

                return (
                  <div key={post.id} className="space-y-2">
                    {showDateHeader && (
                      <div className="sticky top-0 bg-white/90 backdrop-blur-sm py-2 z-10 flex items-center">
                        <div className="w-1 h-4 bg-[#5A5A40] rounded-full mr-2" />
                        <span className="text-xs font-bold text-gray-500">
                          {format(parseISO(post.scheduledAt), 'MM月dd日')} ({weekDays[getDay(parseISO(post.scheduledAt))]})
                        </span>
                      </div>
                    )}
                    <div 
                      onClick={() => setSelectedPost(post)}
                      className={clsx(
                        "p-4 rounded-2xl border shadow-sm flex items-center space-x-4 active:scale-[0.98] transition-all",
                        post.status === 'published' ? "bg-green-50/50 border-green-100" : 
                        post.status === 'scheduled' ? "bg-blue-50/50 border-blue-100" : 
                        post.status === 'pending' ? "bg-orange-50/50 border-orange-100" :
                        "bg-white border-black/5"
                      )}
                    >
                      <div className="text-center min-w-[50px]">
                        <div className="text-sm font-bold text-gray-900">{format(parseISO(post.scheduledAt), 'HH:mm')}</div>
                        <div className="text-[10px] font-bold text-gray-400 uppercase">{post.contentType === 'post' ? '圖文' : '短影音'}</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-2 mb-0.5">
                          <span className="text-[10px] font-bold text-[#5A5A40] truncate">{vendor?.name}</span>
                          <div className="flex gap-1">
                            {post.platforms.map(p => (
                              <span key={p} className="bg-gray-200/50 text-[8px] px-1 py-0.5 rounded font-bold text-gray-500">{p}</span>
                            ))}
                          </div>
                        </div>
                        <h4 className="font-bold text-sm text-gray-800 truncate">{post.title}</h4>
                        <div className="flex items-center mt-1">
                          <span className={clsx(
                            "text-[8px] font-bold px-1.5 py-0.5 rounded-full",
                            post.status === 'published' ? "bg-green-100 text-green-700" : 
                            post.status === 'scheduled' ? "bg-blue-100 text-blue-700" : 
                            post.status === 'pending' ? "bg-orange-100 text-orange-700" :
                            "bg-gray-100 text-gray-700"
                          )}>
                            {post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : post.status === 'pending' ? '待補中' : '草稿'}
                          </span>
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-gray-300" />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                <CalendarIcon size={48} className="mb-4 opacity-20" />
                <p className="text-sm italic">本月尚無排程貼文</p>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedPost && (
        <PostDetailModal 
          post={selectedPost}
          vendor={vendors.find(v => v.id === selectedPost.vendorId)}
          asset={assets.find(a => a.id === selectedPost.assetId)}
          onClose={() => setSelectedPost(null)}
        />
      )}
      {/* Tracking Export Modal */}
      <TrackingExportModal 
        isOpen={isTrackingModalOpen}
        onClose={() => setIsTrackingModalOpen(false)}
        posts={posts}
        vendors={vendors}
        assets={assets}
        dismissedHabits={dismissedHabits}
      />
    </div>
  );
}
