import React, { useState, useRef, useEffect } from 'react';
import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy 
} from 'firebase/firestore';
import { db } from '../firebase';
import { Post, Vendor, Asset, Editor, DismissedHabit, PlannedSlotMove, ShootBooking } from '../types';
import { trackedVendors } from '../lib/vendorStatus';
import { listPlannedSlots } from '../lib/plannedSlots';
import {
  buildSupplyPlan, describeSupply, buildHorizonDemands,
  postDemandId, slotDemandId, SUPPLY_HORIZON_DAYS,
} from '../lib/materialSupply';
import {
  format,
  addDays,
  startOfWeek,
  parseISO,
  isSameDay,
  getDay,
  startOfDay,
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
  Square,
  Scissors,
  Camera,
  AlertTriangle,
  Minus
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
  slotMoves: PlannedSlotMove[];
  shootBookings: ShootBooking[];
}

export default function TrackingExportModal({
  isOpen,
  onClose,
  posts,
  vendors,
  assets,
  dismissedHabits,
  slotMoves,
  shootBookings
}: TrackingExportModalProps) {
  const [editors, setEditors] = useState<Editor[]>([]);
  const [selectedEditorId, setSelectedEditorId] = useState<string>('all');
  const [exportMode, setExportMode] = useState<'missing' | 'all' | 'schedule'>('missing');
  const [showVideos, setShowVideos] = useState(true);
  const [showPosts, setShowPosts] = useState(true);
  const [startDate, setStartDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState<string>(format(addDays(new Date(), 7), 'yyyy-MM-dd'));
  const [selectedWeekStart, setSelectedWeekStart] = useState<Date>(
    startOfWeek(addDays(new Date(), 7), { weekStartsOn: 1 }) // 預設下週一，日常快速選週用
  );
  const [trackingRangeDays, setTrackingRangeDays] = useState<number>(7);
  const [useCustomRange, setUseCustomRange] = useState(false); // 平常用快速選週，偶爾突發案例才切自訂起訖日
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

  // 發片清單模式本來就是給業主的自訂區間；待補影片/全部排程預設走快速選週，
  // 但使用者可以按「自訂起訖日」切換，應付突發的非固定區間需求
  const isCustomRange = exportMode === 'schedule' || useCustomRange;
  const rangeStart = isCustomRange ? (startDate ? parseISO(startDate) : new Date()) : selectedWeekStart;
  const rangeEnd = isCustomRange
    ? (endDate ? parseISO(endDate) : rangeStart)
    : addDays(selectedWeekStart, trackingRangeDays - 1);
  const rangeDaySpan = Math.max(1, Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const weekDays = Array.from({ length: rangeDaySpan }, (_, i) => addDays(rangeStart, i));

  const enableCustomRange = () => {
    setStartDate(format(selectedWeekStart, 'yyyy-MM-dd'));
    setEndDate(format(addDays(selectedWeekStart, trackingRangeDays - 1), 'yyyy-MM-dd'));
    setUseCustomRange(true);
  };

  const activeVendors = filteredVendors.filter(v => selectedVendorIds.includes(v.id));

  const trackingData: any[] = [];

  weekDays.forEach(day => {
    const dateStr = format(day, 'yyyy-MM-dd');

    activeVendors.forEach(vendor => {
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
            const key = postDemandId(post.id!);
            trackingData.push({
              id: key,
              date: day,
              scheduledAt: post.scheduledAt,
              vendorId: vendor.id,
              vendorName: vendor.name,
              type: post.contentType,
              title: post.title,
              status: post.status,
              isMissing: false,
              isHabit: false,
              attachedAssetId: hasAsset ? post.assetId : undefined,
              post: post
            });
          }
        } else if (exportMode === 'all' || isMissingVideo) {
          const key = postDemandId(post.id!);
          trackingData.push({
            id: key,
            date: day,
            scheduledAt: post.scheduledAt,
            vendorId: vendor.id,
            vendorName: vendor.name,
            type: post.contentType,
            title: post.title,
            status: post.status,
            isMissing: isMissingVideo,
            isHabit: false,
            attachedAssetId: hasAsset ? post.assetId : undefined,
            post: post
          });
        }
      });

    });
  });

  // 2. 預排時段（日曆上的橘色卡）。發片清單是給業主的，不列預排。
  //
  // ⚠️ 這裡以前是自己照 postingHabits 重算一份，結果在日曆上把預排拖到別天之後，
  //    導出的圖還是印原本那天 —— 同一件事兩個答案。現在一律走 listPlannedSlots()，
  //    它才是「這天有哪些預排」的唯一入口（含單次調整 plannedSlotMoves）。
  // ⚠️ 預排只算 trackedVendors：冷凍中/不列入統計的廠商在日曆上本來就不畫橘卡，
  //    導出卻照印的話，剪輯師會被叫去追一個根本沒在發片的 IP。
  //    已經排好的貼文不受影響（上面那圈用的是完整清單）。
  if (exportMode !== 'schedule') {
    listPlannedSlots({
      vendors: trackedVendors(activeVendors),
      moves: slotMoves,
      dismissed: dismissedHabits,
      posts,
      rangeStart,
      rangeEnd,
      fulfilledWindowDays: 1, // 沿用日曆的「前後一天內有發就不用再提醒」
    }).forEach(slot => {
      const habitType = slot.habit.contentTypes[0] || 'video';
      if (habitType === 'video' && !showVideos) return;
      if (habitType === 'post' && !showPosts) return;

      trackingData.push({
        id: slotDemandId(slot),
        date: startOfDay(slot.date),
        vendorId: slot.vendorId,
        vendorName: slot.vendorName,
        type: habitType,
        title: `[預排] ${slot.time}`, // 用日曆同一套用詞；夠短才不會在窄欄裡被拆成「預 / 計發片」
        status: 'missing',
        isMissing: true,
        isHabit: true,
        habit: slot.habit
      });
    });
  }

  // Sort by date and time
  trackingData.sort((a, b) => {
    const dateA = a.scheduledAt ? parseISO(a.scheduledAt).getTime() : a.date.getTime();
    const dateB = b.scheduledAt ? parseISO(b.scheduledAt).getTime() : b.date.getTime();
    return dateA - dateB;
  });

  // 需求（這幾天幾號要上片）配上供給（成片庫存／待剪素材／預約拍攝），
  // 讓剪輯師看得出每一格是「他要剪」、「等業主」還是「料根本還沒拍」。
  // ⚠️ 配對範圍就是這張表的區間：區間外的排程不參與競爭。這張表本來就只回答「這幾天」，
  //    要看整體庫存夠不夠撐請看拍攝進度頁（那邊才是欠片公式的權威）。
  // ⚠️ 配對是在「今天起 SUPPLY_HORIZON_DAYS 天」這個固定視窗上做，**不是**在畫面選的區間上做。
  //    區間長短一變答案就跟著變的話，剪輯師看月曆與這裡導出的一週會對同一天講不同的話。
  //    這裡只負責顯示，查不到配對（區間落在視窗外或在過去）就顯示「—」。
  const supplyPlan = buildSupplyPlan({
    demands: buildHorizonDemands({
      posts,
      slots: listPlannedSlots({
        vendors: trackedVendors(vendors),
        moves: slotMoves,
        dismissed: dismissedHabits,
        posts,
        rangeStart: new Date(),
        rangeEnd: addDays(new Date(), SUPPLY_HORIZON_DAYS),
        fulfilledWindowDays: 1,
      }),
    }),
    assets,
    posts,
    bookings: shootBookings,
  });

  // 發片清單是要給業主看的，不該把內部的待剪/庫存攤在上面
  const showSupply = exportMode !== 'schedule';

  const stockRows = showSupply
    ? Array.from(new Set(trackingData.map(item => item.vendorId as string)))
        .map(vendorId => {
          const vendor = activeVendors.find(v => v.id === vendorId);
          const summary = supplyPlan.stock.get(vendorId);
          const hasGap = trackingData.some(item => {
            if (item.vendorId !== vendorId) return false;
            const kind = supplyPlan.assignments.get(item.id)?.kind;
            return kind === 'none' || kind === 'booked_late';
          });
          return { vendorId, name: vendor?.name || '未知', summary, hasGap };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    : [];

  const handleRemarkChange = (id: string, value: string) => {
    setCustomRemarks(prev => ({ ...prev, [id]: value }));
  };

  const handleExport = async () => {
    if (!exportRef.current) return;
    
    const loadingToast = toast.loading('正在準備導出圖片...');

    try {
      const element = exportRef.current;

      // 字體(Noto Serif TC)是異步載入的，沒等它就直接量測尺寸/截圖，
      // 常常會抓到「字體還沒到位、排版還沒定案」那一刻的高度，
      // 導致截圖留白或跟實際內容對不齊。先確保字體就緒、再等一個畫面更新，才量測+截圖。
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const rect = element.getBoundingClientRect();

      const dataUrl = await toJpeg(element, {
        quality: 1,
        backgroundColor: '#F5F5F0',
        pixelRatio: 3,
        width: rect.width,
        height: rect.height,
        style: {
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
      const fileName = `上片排程表_${editorName}_${format(rangeStart, 'MMdd')}-${format(rangeEnd, 'MMdd')}.jpg`;

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
              <h2 className="text-xl font-bold text-[#5A5A40]">上片排程表導出</h2>
              <p className="text-xs text-gray-400">彙整指定區間的上片排程與待補影片提醒</p>
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
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center">
                <CalendarIcon className="w-3 h-3 mr-1" /> 追蹤時間
              </label>
              {exportMode !== 'schedule' && (
                <button
                  onClick={() => useCustomRange ? setUseCustomRange(false) : enableCustomRange()}
                  className="text-[10px] font-bold text-[#8B7355] hover:underline"
                >
                  {useCustomRange ? '改用快速選週' : '自訂起訖日'}
                </button>
              )}
            </div>

            {isCustomRange ? (
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
              <>
                <div className="flex bg-[#F5F5F0] p-1 rounded-2xl">
                  {[
                    { label: '1週', days: 7 },
                    { label: '2週', days: 14 },
                    { label: '1個月', days: 30 },
                  ].map(opt => (
                    <button
                      key={opt.days}
                      onClick={() => setTrackingRangeDays(opt.days)}
                      className={clsx(
                        "flex-1 py-1.5 rounded-xl text-[10px] font-bold transition-all",
                        trackingRangeDays === opt.days ? "bg-white text-[#8B7355] shadow-sm" : "text-gray-400"
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => setSelectedWeekStart(subDays(selectedWeekStart, trackingRangeDays))}
                    className="p-3 bg-[#F5F5F0] rounded-2xl hover:bg-gray-200"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <div className="flex-1 p-3 bg-[#F5F5F0] rounded-2xl text-center text-sm font-medium">
                    {format(rangeStart, 'MM/dd')} - {format(rangeEnd, 'MM/dd')}
                  </div>
                  <button
                    onClick={() => setSelectedWeekStart(addDays(selectedWeekStart, trackingRangeDays))}
                    className="p-3 bg-[#F5F5F0] rounded-2xl hover:bg-gray-200"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </>
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
          {/* 這層只負責畫面上的置中留白，不參與截圖，避免導出的 JPG 兩側多出跟卡片本身無關的空白 */}
          <div className="min-w-full p-4 sm:p-8">
            {/* 多了「素材狀態」一欄，800px 會把內容標題擠到剩兩個字；加寬到 900 讓每欄都讀得完整。
                發片清單沒有那一欄，維持原本 800px，不然右邊會空出一大塊 */}
            <div
              ref={exportRef}
              className={clsx(
                'bg-[#F5F5F0] shadow-none border-none overflow-hidden w-full mx-auto',
                showSupply ? 'max-w-[900px]' : 'max-w-[800px]'
              )}
            >
              {/* JPG Header */}
              <div className="p-12 bg-[#5A5A40] text-white">
                <div className="flex justify-between items-end">
                  <div>
                    <h1 className="text-5xl font-black tracking-tighter mb-2">
                      {exportMode === 'schedule' ? 'SCHEDULE LIST' : 'CONTENT SCHEDULE'}
                    </h1>
                    <p className="text-xl opacity-80 font-medium tracking-wide">
                      {selectedEditorId !== 'all' && editors.find(e => e.id === selectedEditorId)?.name}
                      {exportMode === 'schedule' ? ' 發片排程清單' : ' 上片排程表'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm opacity-60 uppercase tracking-widest mb-1">Timeframe</p>
                    <p className="text-2xl font-bold">
                      {format(rangeStart, 'yyyy/MM/dd')} - {format(rangeEnd, 'yyyy/MM/dd')}
                    </p>
                  </div>
                </div>
              </div>

              {/* JPG Content */}
              <div className="p-12">
                {/* 每個 IP 手上有什麼料。逐格看得到「這格誰負責」，這裡看得到「總共還有多少可以動用」 */}
                {showSupply && stockRows.length > 0 && (
                  <div className="mb-8 pb-6 border-b-2 border-[#5A5A40]/20">
                    <p className="text-xs font-black text-[#5A5A40] uppercase tracking-widest mb-3">每個 IP 手上有什麼</p>
                    {/* 這裡刻意**不**用下面欄位那種「你要剪」的祈使句：
                        這幾行是在描述一家 IP 目前的狀態，不是在指派誰做什麼。
                        但用詞一樣要白話 ——「庫存成片／已交片」是內部流程術語，改成看得懂的講法。 */}
                    <div className="space-y-1.5">
                      {stockRows.map(row => (
                        <div key={row.vendorId} className="flex items-baseline justify-between">
                          <span className="text-sm font-bold text-[#5A5A40] w-[130px] shrink-0">{row.name}</span>
                          <span className="flex-1 text-xs font-medium text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
                            <span>成片 <span className={clsx('font-black', (row.summary?.ready || 0) > 0 ? 'text-emerald-600' : 'text-gray-300')}>{row.summary?.ready || 0}</span> 支</span>
                            <span>待剪 <span className={clsx('font-black', (row.summary?.toEdit || 0) > 0 ? 'text-amber-600' : 'text-gray-300')}>{row.summary?.toEdit || 0}</span> 支</span>
                            {(row.summary?.inProgress || 0) > 0 && (
                              <span>等業主審 <span className="font-black text-sky-600">{row.summary?.inProgress}</span> 支</span>
                            )}
                            <span>
                              {row.summary?.nextBookingDate
                                ? <>下次拍攝 <span className={clsx('font-black', row.summary.nextBookingOverdue ? 'text-red-600' : 'text-[#5A5A40]')}>
                                    {format(parseISO(row.summary.nextBookingDate), 'MM/dd')}{row.summary.nextBookingOverdue ? '（已過期）' : ''}
                                  </span></>
                                : <span className={clsx('font-black', row.hasGap ? 'text-red-600' : 'text-gray-400')}>還沒安排拍攝</span>}
                            </span>
                          </span>
                          {row.hasGap && (
                            <span className="flex items-center text-[10px] font-black text-red-600 ml-3 shrink-0 whitespace-nowrap">
                              <AlertTriangle className="w-3 h-3 mr-1" /> 有幾天沒片
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {trackingData.length > 0 ? (
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b-2 border-[#5A5A40]/20">
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[105px]">發布日期</th>
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[110px]">廠商 (IP)</th>
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[48px]">類型</th>
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest">內容標題 / 狀態</th>
                        {showSupply && (
                          <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[170px]">素材狀態</th>
                        )}
                        <th className="py-4 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest w-[110px]">備註</th>
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
                            {item.scheduledAt && item.scheduledAt.length > 0 
                              ? format(parseISO(item.scheduledAt), 'MM/dd HH:mm') 
                              : format(item.date, 'MM/dd') + ' (待定)'}
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
                        <td className="py-5 align-top pr-3">
                          {/* ⚠️ 這裡原本只要 isMissing 就把標題換成「待補影片素材」。
                              加上素材狀態欄之後那句話會直接打架 —— 同一列左邊寫「待補影片素材」、
                              右邊寫「已交片・審核中」，剪輯師不知道該信哪個。
                              「缺不缺料」現在由右邊那欄負責回答，這裡一律顯示這格本來的內容。 */}
                          <div className="text-sm font-medium text-gray-700 mb-1">
                            {showSupply ? item.title : (item.isMissing ? '待補影片素材' : item.title)}
                          </div>
                          <div className="flex items-center space-x-2">
                            {/* 這裡原本掛一個綠色「素材已到位」，它其實只代表「這列不是待補」，
                                對預排時段一律說謊。真正的素材真相改由右邊那欄回答。 */}
                            {item.status === 'draft' && (
                              <span className="flex items-center text-[10px] font-bold text-blue-500">
                                <Clock className="w-3 h-3 mr-1" /> 尚未排程
                              </span>
                            )}
                          </div>
                        </td>
                        {showSupply && (() => {
                          const assignment = supplyPlan.assignments.get(item.id);
                          const supply = describeSupply(assignment);
                          // 「已有成片」刻意是灰的：整欄掃下來眼睛要先跳到有待剪庫存跟「還沒有片」那幾格，
                          // 把不用動手的那些染成綠色只會搶走注意力
                          const tone = {
                            editor: 'text-amber-600',
                            waiting: 'text-sky-600',
                            alert: 'text-red-600',
                            idle: 'text-gray-400',
                          }[supply.tone];
                          // 圖示照「這格在等什麼」選，不能照顏色選：
                          // 審核中跟等拍攝都是 waiting，但一個是等業主回覆、一個是等相機，不該長同一個樣子
                          const Icon = {
                            attached: CheckCircle2,
                            ready: CheckCircle2,
                            in_progress: Clock,
                            to_edit: Scissors,
                            booked: Camera,
                            booked_late: AlertTriangle,
                            none: AlertTriangle,
                            not_video: Minus,
                          }[assignment?.kind || 'not_video'];
                          const emphasise = supply.tone === 'editor' || supply.tone === 'alert';
                          return (
                            <td className="py-5 align-top pr-3">
                              <div className={clsx('flex items-start text-xs', emphasise ? 'font-black' : 'font-bold', tone)}>
                                {/* 圖文沒有影片庫存可言，一個破折號就夠，不用再配一個圖示 */}
                                {assignment?.kind !== 'not_video' && <Icon className="w-3.5 h-3.5 mr-1.5 mt-[1px] shrink-0" />}
                                <span>{supply.label}</span>
                              </div>
                              {supply.detail && (
                                /* 刻意單行截斷：片名在這格換行會把「名額」「公式」這種詞拆成上下兩行，
                                   老闆對中文孤字斷行特別敏感，寧可用 ... 收掉 */
                                <div className="text-[10px] text-gray-400 font-medium mt-1 pl-5 truncate">
                                  {supply.detail}
                                </div>
                              )}
                            </td>
                          );
                        })()}
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
                  <p className="text-gray-400 font-medium">所選區間內無符合項目</p>
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
        <div className="p-6 bg-[#F5F5F0]/50 border-t border-gray-100 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-xs text-gray-400 text-center sm:text-left">
            {`* 系統將自動彙整 ${format(rangeStart, 'MM/dd')} - ${format(rangeEnd, 'MM/dd')} 區間的排程${exportMode === 'schedule' ? '' : '與待補提醒'}`}
          </p>
          <div className="flex space-x-3 w-full sm:w-auto">
            <button 
              onClick={onClose}
              className="flex-1 sm:flex-none px-6 py-3 rounded-2xl text-sm font-bold text-gray-500 hover:bg-gray-100 transition-all"
            >
              取消
            </button>
            <button 
              onClick={handleExport}
              disabled={trackingData.length === 0}
              className="flex-1 sm:flex-none px-8 py-3 bg-[#5A5A40] text-white rounded-2xl text-sm font-bold shadow-lg shadow-[#5A5A40]/20 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:hover:scale-100 whitespace-nowrap"
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
