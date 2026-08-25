import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  query,
  onSnapshot,
  where,
  updateDoc,
  doc,
  addDoc,
  deleteDoc
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Post, Vendor, Asset, DismissedHabit, PlannedSlotMove } from '../types';
import { visibleVendors, trackedVendors } from '../lib/vendorStatus';
import { listPlannedSlots, groupSlotsByDay, PlannedSlot } from '../lib/plannedSlots';
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
import { ChevronLeft, ChevronRight, Clock, Plus, Download, X, Calendar as CalendarIcon, BellRing, Image as ImageIcon, Video } from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import * as XLSX from 'xlsx';
import TrackingExportModal from './TrackingExportModal';

/** 從日曆帶去「新增貼文」的預填內容（點橘色預排時用） */
export interface PostPrefill {
  vendorId: string;
  scheduledAt: string; // yyyy-MM-dd'T'HH:mm
  contentType?: 'post' | 'video';
  platforms?: string[];
}

interface CalendarViewProps {
  /** 有帶就表示外層接得住「去建立貼文」，橘色預排才會變成可點 */
  onPlanPost?: (prefill: PostPrefill) => void;
}

export default function CalendarView({ onPlanPost }: CalendarViewProps = {}) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);
  const [slotMoves, setSlotMoves] = useState<PlannedSlotMove[]>([]);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>('calendar');
  const [isTrackingModalOpen, setIsTrackingModalOpen] = useState(false);
  const [selectedVendorId, setSelectedVendorId] = useState<string>('all');

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

    const mUnsubscribe = onSnapshot(collection(db, 'plannedSlotMoves'), (snapshot) => {
      setSlotMoves(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PlannedSlotMove)));
    });

    return () => {
      vUnsubscribe();
      pUnsubscribe();
      aUnsubscribe();
      dUnsubscribe();
      mUnsubscribe();
    };
  }, []);

  /**
   * 把某一次預排挪到別天。
   *
   * ⚠️ 這裡刻意**不動** vendor.postingHabits：那是「每週三 11:30」的規則，改下去等於
   *    連過去每一個月的日曆一起改掉。只記一筆單次調整，下週照原規則出現。
   * ⚠️ 也刻意不建立貼文：橘色＝還沒決定要發什麼的預留時段，一旦變成貼文就會進入
   *    交付/欠片/ERP 的計算，那是「已經有這則」的意思，語意完全不同。
   */
  const movePlannedSlot = async (slot: PlannedSlot, targetDate: Date) => {
    const toDate = format(targetDate, 'yyyy-MM-dd');
    if (toDate === slot.toDate) return; // 拖回原地，不用寫

    try {
      if (toDate === slot.fromDate) {
        // 拖回它原本該在的那天＝取消這次調整，記錄本身就不該留著
        if (slot.moveId) await deleteDoc(doc(db, 'plannedSlotMoves', slot.moveId));
        toast.success('已移回原本的預排日');
        return;
      }

      if (slot.moveId) {
        await updateDoc(doc(db, 'plannedSlotMoves', slot.moveId), {
          toDate,
          movedBy: auth.currentUser?.uid || '',
          updatedAt: new Date().toISOString(),
        });
      } else {
        await addDoc(collection(db, 'plannedSlotMoves'), {
          vendorId: slot.vendorId,
          habitTime: slot.time,
          fromDate: slot.fromDate,
          toDate,
          movedBy: auth.currentUser?.uid || '',
          createdAt: new Date().toISOString(),
        });
      }
      toast.success(`預排已移到 ${format(targetDate, 'MM/dd')}`);
    } catch (error) {
      console.error('Move planned slot failed:', error);
      const code = (error as { code?: string })?.code;
      toast.error(code === 'permission-denied' ? '移動失敗：權限不足' : '移動預排失敗');
    }
  };

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
      // 舊行為是在這裡直接建一則草稿貼文（橘色變灰色）。使用者的實際意圖是
      // 「這次的預排改到那天」，還沒要決定發什麼，所以改成只搬預排、維持橘色。
      const slot = JSON.parse(dataStr) as PlannedSlot;
      await movePlannedSlot(slot, date);
    }
  };

  /**
   * 「這次不用發」。
   * ⚠️ 記的日期一律是 fromDate（原本該出現的那天）而不是它現在被挪到哪一天：
   *    fromDate 才是這個時段的身分，這樣舊資料也完全對得上，不需要 migration。
   */
  const dismissSlot = async (slot: PlannedSlot) => {
    try {
      await addDoc(collection(db, 'dismissedHabits'), {
        vendorId: slot.vendorId,
        habitTime: slot.time,
        date: slot.fromDate,
        createdAt: new Date().toISOString()
      });
      // 已經不顯示了，調整紀錄留著只會變成孤兒資料
      if (slot.moveId) {
        try {
          await deleteDoc(doc(db, 'plannedSlotMoves', slot.moveId));
        } catch (cleanupError) {
          console.warn('Dismissed slot but failed to clean up its move record:', cleanupError);
        }
      }
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
        '發布狀態': post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : post.status === 'pending' ? '待補中' : '草稿',
        '預計發布時間': (post.scheduledAt && post.scheduledAt.length > 0) ? format(parseISO(post.scheduledAt), 'yyyy-MM-dd HH:mm') : '-',
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

  // 整個月的預排一次算完再依日期分組；每格各跑一次等於同樣的掃描做 30 遍。
  const slotsByDay = useMemo(() => groupSlotsByDay(listPlannedSlots({
    vendors: trackedVendors(vendors).filter(v => selectedVendorId === 'all' || v.id === selectedVendorId),
    moves: slotMoves,
    dismissed: dismissedHabits,
    posts,
    rangeStart: monthStart,
    rangeEnd: monthEnd,
    fulfilledWindowDays: 1, // 沿用原本「前後一天內有發就不用再提醒」
  })), [vendors, selectedVendorId, slotMoves, dismissedHabits, posts, monthStart, monthEnd]);

  const filteredPosts = posts.filter(p => {
    const postMonth = p.targetMonth || (p.scheduledAt && p.scheduledAt.length > 0 ? format(parseISO(p.scheduledAt), 'yyyy-MM') : null);
    const matchesVendor = selectedVendorId === 'all' || p.vendorId === selectedVendorId;
    return postMonth === format(currentDate, 'yyyy-MM') && matchesVendor;
  }).sort((a, b) => {
    if (!a.scheduledAt || a.scheduledAt.length === 0) return 1;
    if (!b.scheduledAt || b.scheduledAt.length === 0) return -1;
    return parseISO(a.scheduledAt).getTime() - parseISO(b.scheduledAt).getTime();
  });

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
              <BellRing size={16} className="mr-2" /> 上片排程表
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

      {/* Vendor Filter Bar */}
      <div className="flex items-center space-x-2 overflow-x-auto px-4 sm:px-6 py-3 border-b border-black/5 bg-white scrollbar-hide">
        <button
          onClick={() => setSelectedVendorId('all')}
          className={clsx(
            "px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap border",
            selectedVendorId === 'all'
              ? "bg-[#5A5A40] text-white border-[#5A5A40]"
              : "bg-white text-gray-500 border-black/5 hover:border-gray-300"
          )}
        >
          全部IP
        </button>
        {visibleVendors(vendors).map(vendor => (
          <button
            key={vendor.id}
            onClick={() => setSelectedVendorId(vendor.id!)}
            className={clsx(
              "px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap border",
              selectedVendorId === vendor.id
                ? "bg-[#5A5A40] text-white border-[#5A5A40]"
                : "bg-white text-gray-500 border-black/5 hover:border-gray-300"
            )}
          >
            {vendor.name}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {viewMode === 'calendar' ? (
          <div className="min-w-[800px] xl:min-w-0">
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
                
                const dayPosts = posts.filter(p =>
                  p.scheduledAt &&
                  isSameDay(parseISO(p.scheduledAt), day) &&
                  (selectedVendorId === 'all' || p.vendorId === selectedVendorId)
                );
                // 預排（含被挪過來的）；冷凍中/已終止的廠商在共用層就排除掉了
                const daySlots = slotsByDay.get(format(day, 'yyyy-MM-dd')) || [];

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
                      {/* Posting Habits Reminders（預排時段，拖到別天仍然是預排） */}
                      {daySlots.map((slot, hIdx) => (
                        <div
                          key={`slot-${slot.vendorId}-${slot.time}-${slot.fromDate}-${hIdx}`}
                          draggable
                          onDragStart={(e) => handleDragStart(e, 'habit', `slot-${hIdx}`, slot)}
                          onDragEnd={handleDragEnd}
                          onClick={onPlanPost ? () => onPlanPost({
                            vendorId: slot.vendorId,
                            scheduledAt: format(slot.date, "yyyy-MM-dd'T'HH:mm"),
                            contentType: slot.habit.contentTypes?.[0] === 'video' ? 'video' : 'post',
                            platforms: slot.habit.platforms,
                          }) : undefined}
                          title={onPlanPost
                            ? `點一下用這個時段建立貼文${slot.isMoved ? `（原訂 ${slot.fromDate}）` : ''}`
                            : undefined}
                          className={clsx(
                            "group/habit relative text-[9px] p-1 rounded bg-orange-50 text-orange-700 border flex items-center opacity-70 cursor-grab active:cursor-grabbing hover:opacity-100 transition-opacity",
                            slot.isMoved ? "border-orange-300 border-dashed" : "border-orange-100"
                          )}
                        >
                          <span className="font-bold mr-1">{slot.time}</span>
                          <span className="truncate flex-1">
                            {slot.isMoved ? '↪' : '🔔'} {slot.vendorName}: {slot.habit.contentTypes.map(t => t === 'post' ? '貼' : '影').join('/')}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              dismissSlot(slot);
                            }}
                            className="hidden group-hover/habit:flex ml-1 p-0.5 hover:bg-orange-200 rounded-full transition-colors"
                          >
                            <X size={8} />
                          </button>
                        </div>
                      ))}

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
                              <span className="font-bold flex-shrink-0">{post.scheduledAt ? format(parseISO(post.scheduledAt), 'HH:mm') : '-'}</span>
                              <span className="flex items-center gap-0.5 opacity-70 flex-shrink-0">
                                {post.contentType === 'post' ? <ImageIcon size={9} /> : <Video size={9} />}
                                [{post.contentType === 'post' ? '圖文' : '影'}]
                              </span>
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
                const showDateHeader = !prevPost || (post.scheduledAt && prevPost.scheduledAt && !isSameDay(parseISO(post.scheduledAt), parseISO(prevPost.scheduledAt))) || (!post.scheduledAt && prevPost.scheduledAt);

                return (
                  <div key={post.id} className="space-y-2">
                    {showDateHeader && (
                      <div className="sticky top-0 bg-white/90 backdrop-blur-sm py-2 z-10 flex items-center">
                        <div className="w-1 h-4 bg-[#5A5A40] rounded-full mr-2" />
                        <span className="text-xs font-bold text-gray-500">
                          {post.scheduledAt && post.scheduledAt.length > 0 
                            ? `${format(parseISO(post.scheduledAt), 'MM月dd日')} (${weekDays[getDay(parseISO(post.scheduledAt))]})` 
                            : `未定日期 / ${post.targetMonth || '本月'} 待排程`}
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
                        <div className="text-sm font-bold text-gray-900">{post.scheduledAt ? format(parseISO(post.scheduledAt), 'HH:mm') : '-'}</div>
                        <div className="flex items-center justify-center gap-1 text-[10px] font-bold text-gray-400 uppercase">
                          {post.contentType === 'post' ? <ImageIcon size={10} /> : <Video size={10} />}
                          {post.contentType === 'post' ? '圖文' : '短影音'}
                        </div>
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

      {selectedPost && (() => {
        // selectedPost 是點開當下拍的快照，在 modal 裡改完狀態不會自己更新；改抓 posts 這份即時資料，
        // 不然按了「已發布」畫面還停在「草稿」。貼文剛好被別人刪掉時退回快照，modal 才不會突然空掉。
        const livePost = posts.find(p => p.id === selectedPost.id) || selectedPost;
        return (
          <PostDetailModal
            post={livePost}
            vendor={vendors.find(v => v.id === livePost.vendorId)}
            asset={assets.find(a => a.id === livePost.assetId)}
            // 帶 assets/vendors 進去＝開啟可編輯模式（改狀態要檢查素材審核、要組 webhook）
            assets={assets}
            vendors={vendors}
            onClose={() => setSelectedPost(null)}
          />
        );
      })()}
      {/* Tracking Export Modal */}
      <TrackingExportModal 
        isOpen={isTrackingModalOpen}
        onClose={() => setIsTrackingModalOpen(false)}
        posts={posts}
        vendors={visibleVendors(vendors)}
        assets={assets}
        dismissedHabits={dismissedHabits}
      />
    </div>
  );
}
