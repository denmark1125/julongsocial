import React, { useState, useRef, useEffect } from 'react';
import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy 
} from 'firebase/firestore';
import { db } from '../firebase';
import { Post, Vendor, Asset, Editor, DismissedHabit } from '../types';
import { 
  format, 
  addDays, 
  startOfWeek, 
  endOfWeek, 
  parseISO, 
  isSameDay, 
  getDay,
  subDays,
  isAfter,
  isBefore
} from 'date-fns';
import { 
  X, 
  Download, 
  Calendar as CalendarIcon, 
  User, 
  Filter,
  CheckCircle2,
  Clock,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Square
} from 'lucide-react';
import { toJpeg } from 'html-to-image';
import download from 'downloadjs';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';

interface TrackingExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  posts: Post[];
  vendors: Vendor[];
  assets: Asset[];
  dismissedHabits: DismissedHabit[];
}

export default function TrackingExportModal({ 
  isOpen, 
  onClose, 
  posts, 
  vendors, 
  assets,
  dismissedHabits
}: TrackingExportModalProps) {
  const [editors, setEditors] = useState<Editor[]>([]);
  const [selectedEditorId, setSelectedEditorId] = useState<string>('all');
  const [exportMode, setExportMode] = useState<'missing' | 'all' | 'schedule'>('missing');
  const [showVideos, setShowVideos] = useState(true);
  const [showPosts, setShowPosts] = useState(true);
  const [startDate, setStartDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState<string>(format(addDays(new Date(), 7), 'yyyy-MM-dd'));
  const [selectedWeekStart, setSelectedWeekStart] = useState<Date>(
    startOfWeek(addDays(new Date(), 7), { weekStartsOn: 1 }) // Default to next week
  );
  const [selectedVendorIds, setSelectedVendorIds] = useState<string[]>([]);
  const [customRemarks, setCustomRemarks] = useState<Record<string, string>>({});
  const exportRef = useRef<HTMLDivElement>(null);

  // Filter vendors by selected editor
  const filteredVendors = selectedEditorId === 'all' 
    ? vendors 
    : vendors.filter(v => v.editorId === selectedEditorId);

  // Sync selectedVendorIds when filteredVendors changes
  useEffect(() => {
    if (isOpen) {
      setSelectedVendorIds(filteredVendors.map(v => v.id));
    }
  }, [selectedEditorId, isOpen, vendors.length]);

  useEffect(() => {
    const q = query(collection(db, 'editors'), orderBy('name'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setEditors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Editor)));
    });
    return () => unsubscribe();
  }, []);

  if (!isOpen) return null;

  const weekEnd = endOfWeek(selectedWeekStart, { weekStartsOn: 1 });
  const weekDays = exportMode === 'schedule' 
    ? Array.from({ length: Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)) + 1 }, (_, i) => addDays(new Date(startDate), i))
    : Array.from({ length: 7 }, (_, i) => addDays(selectedWeekStart, i));

  const trackingData: any[] = [];

  weekDays.forEach(day => {
    const dateStr = format(day, 'yyyy-MM-dd');
    const dayOfWeek = getDay(day);

    filteredVendors.filter(v => selectedVendorIds.includes(v.id)).forEach(vendor => {
      // 1. Check for posts on this day
      const dayPosts = posts.filter(p => 
        p.vendorId === vendor.id && 
        p.scheduledAt && p.scheduledAt.length > 0 && isSameDay(parseISO(p.scheduledAt), day)
      );

      dayPosts.forEach(post => {
        const hasAsset = post.assetId && post.assetId !== 'to_be_added';
        const isMissingVideo = (post.contentType === 'video' && !hasAsset) || post.status === 'pending';
        
        // Content type filter
        if (post.contentType === 'video' && !showVideos) return;
        if (post.contentType === 'post' && !showPosts) return;

        if (exportMode === 'schedule') {
          // Schedule mode: Include everything EXCEPT pending (orange) items
          if (post.status !== 'pending') {
            const key = `${vendor.id}_post_${post.id}_${dateStr}`;
            trackingData.push({
              id: key,
              date: day,
              scheduledAt: post.scheduledAt,
              vendorName: vendor.name,
              type: post.contentType,
              title: post.title,
              status: post.status,
              isMissing: false,
              isHabit: false,
              post: post
            });
          }
        } else if (exportMode === 'all' || isMissingVideo) {
          const key = `${vendor.id}_post_${post.id}_${dateStr}`;
          trackingData.push({
            id: key,
            date: day,
            scheduledAt: post.scheduledAt,
            vendorName: vendor.name,
            type: post.contentType,
            title: post.title,
            status: post.status,
            isMissing: isMissingVideo,
            isHabit: false,
            post: post
          });
        }
      });

      // 2. Check for unfulfilled habits (Orange items in calendar) - Skip in schedule mode
      if (exportMode !== 'schedule') {
        const habits = (vendor.postingHabits || []).filter(h => h.daysOfWeek.includes(dayOfWeek));
        
        habits.forEach(habit => {
          const isDismissed = dismissedHabits.some(d => 
            d.vendorId === vendor.id && 
            d.habitTime === habit.time && 
            d.date === dateStr
          );

          if (isDismissed) return;

          const isFulfilled = posts.some(p => 
            p.vendorId === vendor.id && 
            (
              (p.scheduledAt && p.scheduledAt.length > 0 && isSameDay(parseISO(p.scheduledAt), day)) || 
              (p.scheduledAt && p.scheduledAt.length > 0 && isSameDay(parseISO(p.scheduledAt), subDays(day, 1))) ||
              (p.scheduledAt && p.scheduledAt.length > 0 && isSameDay(parseISO(p.scheduledAt), addDays(day, 1)))
            )
          );

          if (!isFulfilled) {
            // Content type filter for habits
            const habitType = habit.contentTypes[0] || 'video';
            if (habitType === 'video' && !showVideos) return;
            if (habitType === 'post' && !showPosts) return;

            const key = `${vendor.id}_habit_${habit.time}_${dateStr}`;
            trackingData.push({
              id: key,
              date: day,
              vendorName: vendor.name,
              type: habit.contentTypes[0] || 'video',
              title: `[提醒] ${habit.time} 預計發片`,
              status: 'missing',
              isMissing: true,
              isHabit: true,
              habit: habit
            });
          }
        });
      }
    });
  });

  // Sort by date and time
  trackingData.sort((a, b) => {
    const dateA = a.scheduledAt ? parseISO(a.scheduledAt).getTime() : a.date.getTime();
    const dateB = b.scheduledAt ? parseISO(b.scheduledAt).getTime() : b.date.getTime();
    return dateA - dateB;
  });

  const handleRemarkChange = (id: string, value: string) => {
    setCustomRemarks(prev => ({ ...prev, [id]: value }));
  };

  const handleExport = async () => {
    if (!exportRef.current) return;
    
    const loadingToast = toast.loading('正在準備導出圖片...');
    
    try {
      const element = exportRef.current;
      const rect = element.getBoundingClientRect();
      
      const dataUrl = await toJpeg(element, { 
        quality: 1, 
        backgroundColor: '#F5F5F0',
        pixelRatio: 3,
        width: rect.width,
        height: rect.height,
        style: {
          transform: 'scale(1)',
          transformOrigin: 'top left',
          margin: '0',
          padding: '0',
        },
        filter: (node) => {
          if (node instanceof HTMLElement && node.classList.contains('export-ignore')) {
            return false;
          }
          return true;
        }
      });
      
      const editorName = selectedEditorId === 'all' ? '全部' : editors.find(e => e.id === selectedEditorId)?.name;
      const fileName = `催片清單_${editorName}_${format(selectedWeekStart, 'MMdd')}-${format(weekEnd, 'MMdd')}.jpg`;
      
      download(dataUrl, fileName);
      toast.success('導出成功', { id: loadingToast });
    } catch (error) {
      console.error('Export failed:', error);
      toast.error('導出失敗', { id: loadingToast });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
      <div className="bg-white rounded-[32px] w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-[#F5F5F0]/50">
          <div className="flex items-center space-x-3">
            <div className="bg-[#8B7355] p-2 rounded-xl">
              <Download className="text-white w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-[#5A5A40]">催片清單導出</h2>
              <p className="text-xs text-gray-400">彙整下周待補影片與發片排程</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <X className="w-6 h-6 text-gray-400" />
          </button>
        </div>

        {/* Controls */}
        <div className="p-6 bg-white border-b border-gray-100 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center">
              <User className="w-3 h-3 mr-1" /> 指定剪輯師
            </label>
            <select 
              value={selectedEditorId}
              onChange={(e) => setSelectedEditorId(e.target.value)}
              className="w-full p-3 bg-[#F5F5F0] rounded-2xl border-none text-sm focus:ring-2 focus:ring-[#8B7355]"
            >
              <option value="all">全部剪輯師</option>
              {editors.map(ed => (
                <option key={ed.id} value={ed.id}>{ed.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center">
              <CalendarIcon className="w-3 h-3 mr-1" /> 追蹤時間
            </label>
            {exportMode === 'schedule' ? (
              <div className="flex items-center space-x-2">
                <input 
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="flex-1 p-3 bg-[#F5F5F0] rounded-2xl text-sm font-medium border-none focus:ring-2 focus:ring-[#8B7355]"
                />
                <span className="text-gray-400">至</span>
                <input 
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="flex-1 p-3 bg-[#F5F5F0] rounded-2xl text-sm font-medium border-none focus:ring-2 focus:ring-[#8B7355]"
                />
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <button 
                  onClick={() => setSelectedWeekStart(subDays(selectedWeekStart, 7))}
                  className="p-3 bg-[#F5F5F0] rounded-2xl hover:bg-gray-200"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="flex-1 p-3 bg-[#F5F5F0] rounded-2xl text-center text-sm font-medium">
                  {format(selectedWeekStart, 'MM/dd')} - {format(weekEnd, 'MM/dd')}
                </div>
                <button 
                  onClick={() => setSelectedWeekStart(addDays(selectedWeekStart, 7))}
                  className="p-3 bg-[#F5F5F0] rounded-2xl hover:bg-gray-200"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center">
              <Filter className="w-3 h-3 mr-1" /> 導出模式
            </label>
            <div className="flex bg-[#F5F5F0] p-1 rounded-2xl">
              <button 
                onClick={() => setExportMode('missing')}
                className={clsx(
                  "flex-1 py-2 rounded-xl text-[10px] font-bold transition-all",
                  exportMode === 'missing' ? "bg-white text-[#8B7355] shadow-sm" : "text-gray-400"
                )}
              >
                待補影片
              </button>
              <button 
                onClick={() => setExportMode('all')}
                className={clsx(
                  "flex-1 py-2 rounded-xl text-[10px] font-bold transition-all",
                  exportMode === 'all' ? "bg-white text-[#8B7355] shadow-sm" : "text-gray-400"
                )}
              >
                全部排程
              </button>
              <button 
                onClick={() => setExportMode('schedule')}
                className={clsx(
                  "flex-1 py-2 rounded-xl text-[10px] font-bold transition-all",
                  exportMode === 'schedule' ? "bg-white text-[#8B7355] shadow-sm" : "text-gray-400"
                )}
              >
                發片清單
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center">
              <CheckSquare className="w-3 h-3 mr-1" /> 內容篩選
            </label>
            <div className="flex space-x-4 bg-[#F5F5F0] p-3 rounded-2xl">
              <label className="flex items-center space-x-2 cursor-pointer group">
                <div 
                  onClick={() => setShowVideos(!showVideos)}
                  className={clsx(
                    "w-5 h-5 rounded-lg flex items-center justify-center transition-all",
                    showVideos ? "bg-[#8B7355] text-white" : "bg-white border border-gray-200"
                  )}
                >
                  {showVideos && <CheckSquare className="w-3.5 h-3.5" />}
                </div>
                <span className={clsx("text-xs font-bold", showVideos ? "text-[#5A5A40]" : "text-gray-400")}>影片</span>
              </label>
              <label className="flex items-center space-x-2 cursor-pointer group">
                <div 
                  onClick={() => setShowPosts(!showPosts)}
                  className={clsx(
                    "w-5 h-5 rounded-lg flex items-center justify-center transition-all",
                    showPosts ? "bg-[#8B7355] text-white" : "bg-white border border-gray-200"
                  )}
                >
                  {showPosts && <CheckSquare className="w-3.5 h-3.5" />}
                </div>
                <span className={clsx("text-xs font-bold", showPosts ? "text-[#5A5A40]" : "text-gray-400")}>貼文</span>
              </label>
            </div>
          </div>
        </div>

        {/* Vendor Selection */}
        <div className="px-6 pb-6 bg-white border-b border-gray-100">
          <div className="bg-[#F5F5F0]/50 p-4 rounded-2xl">
            <div className="flex justify-between items-center mb-3">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center">
                <CheckSquare className="w-3 h-3 mr-1" /> 選擇要導出的 IP 廠商
              </label>
              <div className="flex space-x-3">
                <button 
                  onClick={() => setSelectedVendorIds(filteredVendors.map(v => v.id))}
                  className="text-[10px] font-bold text-[#8B7355] hover:underline"
                >
                  全選
                </button>
                <button 
                  onClick={() => setSelectedVendorIds([])}
                  className="text-[10px] font-bold text-gray-400 hover:underline"
                >
                  全不選
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto pr-2 custom-scrollbar">
              {filteredVendors.map(vendor => (
                <button
                  key={vendor.id}
                  onClick={() => {
                    setSelectedVendorIds(prev => 
                      prev.includes(vendor.id) 
                        ? prev.filter(id => id !== vendor.id)
                        : [...prev, vendor.id]
                    );
                  }}
                  className={clsx(
                    "px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center space-x-1.5 border",
                    selectedVendorIds.includes(vendor.id)
                      ? "bg-[#8B7355] text-white border-[#8B7355]"
                      : "bg-white text-gray-400 border-gray-200 hover:border-[#8B7355]/30"
                  )}
                >
                  {selectedVendorIds.includes(vendor.id) ? (
                    <CheckSquare className="w-3 h-3" />
                  ) : (
                    <Square className="w-3 h-3" />
                  )}
                  <span>{vendor.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Preview Area */}
        <div className="flex-1 overflow-auto p-0 bg-gray-100 custom-scrollbar">
          <div 
            ref={exportRef} 
            className="bg-[#F5F5F0] flex justify-center w-full"
          >
            <div className="bg-[#F5F5F0] shadow-none border-none overflow-hidden w-full max-w-[800px]">
              {/* JPG Header */}
              <div className="p-12 bg-[#5A5A40] text-white">
                <div className="flex justify-between items-end">
                  <div>
                    <h1 className="text-5xl font-black tracking-tighter mb-2">
                      {exportMode === 'schedule' ? 'SCHEDULE LIST' : 'TRACKING LIST'}
                    </h1>
                    <p className="text-xl opacity-80 font-medium tracking-wide">
                      {selectedEditorId !== 'all' && editors.find(e => e.id === selectedEditorId)?.name} 
                      {exportMode === 'schedule' ? ' 發片排程清單' : ' 催片清單'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm opacity-60 uppercase tracking-widest mb-1">Timeframe</p>
                    <p className="text-2xl font-bold">
                      {exportMode === 'schedule' 
                        ? `${startDate ? format(parseISO(startDate), 'yyyy/MM/dd') : '-'} - ${endDate ? format(parseISO(endDate), 'yyyy/MM/dd') : '-'}`
                        : `${format(selectedWeekStart, 'yyyy/MM/dd')} - ${format(weekEnd, 'yyyy/MM/dd')}`
                      }
                    </p>
                  </div>
                </div>
              </div>

              {/* JPG Content */}
              <div className="p-12">
                {trackingData.length > 0 ? (
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b-2 border-[#5A5A40]/20">
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[120px]">發布日期</th>
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[150px]">廠商 (IP)</th>
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[60px]">類型</th>
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest">內容標題 / 狀態</th>
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[150px]">備註</th>
                      </tr>
                    </thead>
                  <tbody>
                    {trackingData.map((item, idx) => (
                      <tr key={item.id} className={clsx(
                        "border-b border-[#5A5A40]/5",
                        item.isMissing ? "bg-orange-50/50" : ""
                      )}>
                        <td className="py-5 align-top">
                          <div className="text-sm font-bold text-[#5A5A40]">
                            {item.scheduledAt && item.scheduledAt.length > 0 ? format(parseISO(item.scheduledAt), 'MM/dd HH:mm') : '-'}
                          </div>
                          <div className="text-[10px] text-gray-400 font-medium uppercase">
                            {format(item.date, 'EEEE')}
                          </div>
                        </td>
                        <td className="py-5 align-top">
                          <div className="text-sm font-bold text-[#5A5A40]">{item.vendorName}</div>
                        </td>
                        <td className="py-5 align-top">
                          <span className={clsx(
                            "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-tighter",
                            item.type === 'video' ? "bg-blue-100 text-blue-600" : "bg-purple-100 text-purple-600"
                          )}>
                            {item.type === 'video' ? '影片' : '貼文'}
                          </span>
                        </td>
                        <td className="py-5 align-top">
                          <div className="text-sm font-medium text-gray-700 mb-1">
                            {item.isMissing ? '待補影片素材' : item.title}
                          </div>
                          <div className="flex items-center space-x-2">
                            {!item.isMissing && (
                              <span className="flex items-center text-[10px] font-bold text-green-600">
                                <CheckCircle2 className="w-3 h-3 mr-1" /> 素材已到位
                              </span>
                            )}
                            {item.status === 'draft' && (
                              <span className="flex items-center text-[10px] font-bold text-blue-500">
                                <Clock className="w-3 h-3 mr-1" /> 尚未排程
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-5 align-top text-left">
                          <div className="relative">
                            <input 
                              type="text"
                              value={customRemarks[item.id] || ''}
                              onChange={(e) => handleRemarkChange(item.id, e.target.value)}
                              className="w-full text-left bg-transparent border-none focus:ring-0 text-sm font-medium text-[#5A5A40] p-0 relative z-10"
                            />
                            {!customRemarks[item.id] && (
                              <div className="absolute inset-0 pointer-events-none text-gray-300 text-sm font-medium flex items-center justify-start export-ignore">
                                輸入備註...
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="py-20 text-center">
                  <div className="bg-white/50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                    <CheckCircle2 className="text-gray-300 w-8 h-8" />
                  </div>
                  <p className="text-gray-400 font-medium">此週次無待補項目</p>
                </div>
              )}
            </div>

            {/* JPG Footer */}
            <div className="p-10 bg-white/50 border-t border-black/5 flex justify-between items-center">
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em]">
                Generated by Forest Admin System • {format(new Date(), 'yyyy/MM/dd HH:mm')}
              </div>
              <div className="text-[10px] font-black text-[#5A5A40]">
                CONFIDENTIAL
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 bg-[#F5F5F0]/50 border-t border-gray-100 flex justify-between items-center">
          <p className="text-xs text-gray-400">
            * 系統將自動彙整下周一至周日的排程與提醒
          </p>
          <div className="flex space-x-3">
            <button 
              onClick={onClose}
              className="px-6 py-3 rounded-2xl text-sm font-bold text-gray-500 hover:bg-gray-100 transition-all"
            >
              取消
            </button>
            <button 
              onClick={handleExport}
              disabled={trackingData.length === 0}
              className="px-8 py-3 bg-[#5A5A40] text-white rounded-2xl text-sm font-bold shadow-lg shadow-[#5A5A40]/20 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:hover:scale-100"
            >
              導出 JPG 清單
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
