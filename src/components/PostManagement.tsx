import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc,
  doc,
  orderBy,
  writeBatch
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Post, Vendor, PostStatus, Asset } from '../types';
import { 
  Plus, 
  Search, 
  Filter, 
  CheckCircle2, 
  Clock, 
  FileEdit, 
  Calendar as CalendarIcon,
  ChevronDown,
  MoreVertical,
  CheckSquare,
  Square,
  ExternalLink,
  Video as VideoIcon,
  Download,
  Trash2,
  Copy,
  ChevronLeft,
  ChevronRight,
  BellRing,
  ArrowUp,
  ArrowDown,
  Gift
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { format, isPast, isToday, addDays, parseISO, getDay, setHours, setMinutes, startOfDay, isSameDay, startOfMonth, endOfMonth, eachMonthOfInterval, subMonths, addMonths } from 'date-fns';
import toast from 'react-hot-toast';
import TrackingExportModal from './TrackingExportModal';
import { DismissedHabit, MonthlyAdjustment } from '../types';
import { visibleVendors, trackedVendorsForMonth, getEffectiveMonthlyTarget, isAssetFree, buildPostIndex } from '../lib/vendorStatus';
import { setPostStatus, togglePostConfirmation, togglePostPlatformPublished } from '../lib/postActions';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function PostManagement() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  // 判斷素材還能不能用要看貼文現況（掛在草稿的仍算可用、掛的貼文被刪掉的自動放回），先建索引避免每個 option 都掃一次
  const postIndex = React.useMemo(() => buildPostIndex(posts), [posts]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isTrackingModalOpen, setIsTrackingModalOpen] = useState(false);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedVendorId, setSelectedVendorId] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedMonth, setSelectedMonth] = useState<string>(format(new Date(), 'yyyy-MM'));
  const [openStatusId, setOpenStatusId] = useState<string | null>(null);
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
  const [adjustModalVendor, setAdjustModalVendor] = useState<Vendor | null>(null);
  const [adjustDelta, setAdjustDelta] = useState<number>(1);
  const [adjustReason, setAdjustReason] = useState('');

  const [sortConfig, setSortConfig] = useState<{
    field: 'platforms' | 'contentType' | 'status' | 'scheduledAt' | 'title' | 'vendorName' | 'clientConfirmed' | 'internalConfirmed' | 'createdAt';
    direction: 'asc' | 'desc';
  }>({ field: 'createdAt', direction: 'desc' });

  const [formData, setFormData] = useState<Partial<Post>>({
    vendorId: '',
    title: '',
    content: '',
    status: 'draft',
    scheduledAt: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
    targetMonth: format(new Date(), 'yyyy-MM'),
    type: '專業',
    contentType: 'post',
    postUrl: '',
    clientConfirmed: false,
    internalConfirmed: false,
    platforms: ['IG']
  });

  const [suggestedDates, setSuggestedDates] = useState<{date: Date, habit: any}[]>([]);

  useEffect(() => {
    if (!formData.vendorId) {
      setSuggestedDates([]);
      return;
    }

    const vendor = vendors.find(v => v.id === formData.vendorId);
    if (!vendor || !vendor.postingHabits) {
      setSuggestedDates([]);
      return;
    }

    const suggestions: {date: Date, habit: any}[] = [];
    const today = startOfDay(new Date());

    // Look ahead 14 days
    for (let i = 0; i < 14; i++) {
      const checkDate = addDays(today, i);
      const dayOfWeek = getDay(checkDate);

      vendor.postingHabits.forEach(habit => {
        if (habit.daysOfWeek.includes(dayOfWeek)) {
          // If contentType is specified, filter by it
          if (formData.contentType && habit.contentTypes && !habit.contentTypes.includes(formData.contentType)) {
            return;
          }

          const [hours, minutes] = habit.time.split(':').map(Number);
          let suggestedDate = setHours(checkDate, hours);
          suggestedDate = setMinutes(suggestedDate, minutes);

          // Check if this slot is already taken by another post (optional but helpful)
          const isTaken = posts.some(p => 
            p.vendorId === vendor.id && 
            isSameDay(parseISO(p.scheduledAt), suggestedDate) &&
            p.id !== editingPost?.id
          );

          if (!isTaken) {
            suggestions.push({ date: suggestedDate, habit });
          }
        }
      });
    }

    setSuggestedDates(suggestions.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 6));
  }, [formData.vendorId, formData.contentType, vendors, posts, editingPost]);

  const postTypes = ['專業', '生活', '促銷', '知識', '活動', '教學'];

  const setQuickTime = (hours: number) => {
    const current = formData.scheduledAt ? parseISO(formData.scheduledAt) : new Date();
    const updated = new Date(current);
    updated.setHours(hours, 0, 0, 0);
    setFormData({ ...formData, scheduledAt: format(updated, "yyyy-MM-dd'T'HH:mm") });
  };

  useEffect(() => {
    const vQuery = query(collection(db, 'vendors'));
    const vUnsubscribe = onSnapshot(vQuery, (snapshot) => {
      setVendors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Vendor)));
    });

    const pQuery = query(collection(db, 'posts'), orderBy('createdAt', 'desc'));
    const pUnsubscribe = onSnapshot(pQuery, (snapshot) => {
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

  const handleCopyContent = (content: string) => {
    if (!content) {
      toast.error('無文案內容可複製');
      return;
    }
    navigator.clipboard.writeText(content).then(() => {
      toast.success('文案已複製到剪貼簿');
    }).catch(() => {
      toast.error('複製失敗');
    });
  };

  const openAdjustModal = (vendor: Vendor) => {
    setAdjustModalVendor(vendor);
    setAdjustDelta(1);
    setAdjustReason('');
  };

  const handleAddAdjustment = async () => {
    if (!adjustModalVendor?.id) return;
    if (!adjustDelta) {
      toast.error('請輸入要調整的支數');
      return;
    }
    if (!adjustReason.trim()) {
      toast.error('請輸入原因，方便之後回查');
      return;
    }
    try {
      const newRecord: MonthlyAdjustment = {
        month: selectedMonth,
        videoDelta: adjustDelta,
        reason: adjustReason.trim(),
        createdAt: new Date().toISOString()
      };
      // adjustModalVendor 是開彈窗當下拍的快照，存過一次之後就過期了；改抓 vendors 這份即時資料才不會覆蓋掉剛存的紀錄
      const liveVendor = vendors.find(v => v.id === adjustModalVendor.id) || adjustModalVendor;
      const history = liveVendor.monthlyAdjustments || [];
      await updateDoc(doc(db, 'vendors', adjustModalVendor.id), {
        monthlyAdjustments: [...history, newRecord]
      });
      toast.success('已新增本月調整');
      setAdjustDelta(1);
      setAdjustReason('');
    } catch (error) {
      toast.error('新增失敗');
    }
  };

  const handleDeleteAdjustment = async (vendor: Vendor, index: number) => {
    if (!vendor.id) return;
    try {
      const history = (vendor.monthlyAdjustments || []).filter((_, i) => i !== index);
      await updateDoc(doc(db, 'vendors', vendor.id), { monthlyAdjustments: history });
      toast.success('已刪除該筆調整');
    } catch (error) {
      toast.error('刪除失敗');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;

    try {
      const raw = {
        ...formData,
        scheduledAt: formData.scheduledAt || '',
        targetMonth: formData.targetMonth || selectedMonth,
        createdBy: auth.currentUser.uid,
        createdAt: editingPost?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      // formData 是 Partial<Post>，任何一個沒填的欄位都可能是 undefined，
      // 而 Firestore SDK 預設寫入 undefined 會直接丟例外（安全規則根本輪不到）。
      // 這裡統一濾掉，避免「某個欄位剛好沒值」就整筆存不進去。
      // 要「清空」某個欄位請明確寫 ''，不要靠 undefined。
      const data = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== undefined)
      ) as typeof raw;

      // 貼文與素材的掛載狀態一定要一起成功或一起失敗。
      // 舊寫法是三個 await 依序打，只要後面那步被規則擋下（例如素材缺欄位驗證不過），
      // 前面「把舊素材放回庫存」已經生效了 —— 貼文沒改到，素材卻被放掉，兩邊就此對不起來。
      const batch = writeBatch(db);
      const postRef = editingPost ? doc(db, 'posts', editingPost.id!) : doc(collection(db, 'posts'));
      const usable = (id?: string) => !!id && id !== 'to_be_added';

      if (editingPost) {
        batch.update(postRef, data);
        if (usable(editingPost.assetId) && editingPost.assetId !== formData.assetId) {
          batch.update(doc(db, 'assets', editingPost.assetId!), { status: 'available', usedInPostId: null });
        }
        if (usable(formData.assetId) && editingPost.assetId !== formData.assetId) {
          batch.update(doc(db, 'assets', formData.assetId), { status: 'used', usedInPostId: postRef.id });
        }
      } else {
        batch.set(postRef, data);
        if (usable(formData.assetId)) {
          batch.update(doc(db, 'assets', formData.assetId), { status: 'used', usedInPostId: postRef.id });
        }
      }

      await batch.commit();
      toast.success(editingPost ? '貼文已更新' : '貼文已建立');
      setIsModalOpen(false);
      setEditingPost(null);
    } catch (error) {
      // 原本只丟一句「儲存失敗」，錯誤整個被吞掉，出事時完全查不出是哪一步、為什麼。
      // 權限被拒是這裡最常見的死因（素材缺欄位過不了 isValidAsset），要講白讓人能回報。
      console.error('Post save failed:', error);
      const code = (error as { code?: string })?.code;
      toast.error(
        code === 'permission-denied'
          ? '儲存失敗：權限被拒，通常是這則貼文掛的素材資料不完整，請把貼文標題回報給工程師'
          : `儲存失敗${code ? `（${code}）` : ''}`
      );
    }
  };

  // 這三個動作的實作搬到 src/lib/postActions.ts 共用，社群日曆的貼文詳情也要用同一套
  // （發布前必須過業主審核、素材沒審核不能發、排程/發布要打 Make webhook 的規則只留一份）
  const toggleStatus = (post: Post, newStatus: PostStatus) => setPostStatus(post, newStatus, { assets, vendors });
  const toggleConfirmation = (post: Post, field: 'clientConfirmed' | 'internalConfirmed') => togglePostConfirmation(post, field);
  const togglePlatformPublished = (post: Post, platform: string) => togglePostPlatformPublished(post, platform);

  const exportToExcel = () => {
    const exportData = posts.map(post => {
      const vendor = vendors.find(v => v.id === post.vendorId);
      const asset = assets.find(a => a.id === post.assetId);
      return {
        '廠商名稱': vendor?.name || '未知',
        '貼文標題': post.title,
        '內容類型': post.contentType === 'video' ? '短影音' : '圖文',
        '發布狀態': post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : '草稿',
        '預計發布時間': post.scheduledAt ? format(parseISO(post.scheduledAt), 'yyyy-MM-dd HH:mm') : '-',
        '發布平台': post.platforms.join(', '),
        '業主審核': post.clientConfirmed ? '已確認' : '待確認',
        '內部檢核': post.internalConfirmed ? '已檢核' : '待檢核',
        '素材標題': asset?.title || '無',
        '素材連結': post.postUrl || '',
        '建立時間': format(parseISO(post.createdAt), 'yyyy-MM-dd HH:mm')
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "貼文清單");
    XLSX.writeFile(workbook, `貼文管理匯出_${format(new Date(), 'yyyyMMdd')}.xlsx`);
  };

  const filteredPosts = posts.filter(post => {
    const matchesSearch = post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      vendors.find(v => v.id === post.vendorId)?.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesVendor = selectedVendorId === 'all' || post.vendorId === selectedVendorId;
    const matchesStatus = selectedStatus === 'all' || post.status === selectedStatus;
    const matchesMonth = (post.targetMonth || (post.scheduledAt ? format(parseISO(post.scheduledAt), 'yyyy-MM') : null)) === selectedMonth;
    return matchesSearch && matchesVendor && matchesStatus && matchesMonth;
  });

  const sortedPosts = [...filteredPosts].sort((a, b) => {
    const { field, direction } = sortConfig;
    let valA: any = a[field as keyof Post];
    let valB: any = b[field as keyof Post];

    if (field === 'vendorName') {
      valA = vendors.find(v => v.id === a.vendorId)?.name || '';
      valB = vendors.find(v => v.id === b.vendorId)?.name || '';
    } else if (field === 'platforms') {
      valA = a.platforms.join(',');
      valB = b.platforms.join(',');
    }

    if (valA === undefined || valA === null) valA = '';
    if (valB === undefined || valB === null) valB = '';

    if (valA < valB) return direction === 'asc' ? -1 : 1;
    if (valA > valB) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (field: typeof sortConfig.field) => {
    setSortConfig(prev => ({
      field,
      direction: prev.field === field && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const SortIcon = ({ field }: { field: typeof sortConfig.field }) => {
    if (sortConfig.field !== field) return <ChevronDown size={12} className="ml-1 opacity-20" />;
    return sortConfig.direction === 'asc' 
      ? <ArrowUp size={12} className="ml-1 text-[#5A5A40]" /> 
      : <ArrowDown size={12} className="ml-1 text-[#5A5A40]" />;
  };

  const months = Array.from({ length: 7 }, (_, i) => {
    const baseDate = parseISO(`${selectedMonth}-01`);
    const date = addMonths(subMonths(baseDate, 3), i);
    return format(date, 'yyyy-MM');
  });

  const getStatusBadge = (status: PostStatus, onClick?: () => void) => {
    const baseClasses = "px-3 py-1 rounded-full text-[10px] font-bold flex items-center w-fit cursor-pointer transition-all hover:shadow-sm active:scale-95 border";
    switch (status) {
      case 'published': return <span onClick={onClick} className={cn(baseClasses, "bg-green-100 text-green-700 border-green-200")}><CheckCircle2 size={12} className="mr-1" /> 已發布 <ChevronDown size={10} className="ml-1 opacity-50" /></span>;
      case 'scheduled': return <span onClick={onClick} className={cn(baseClasses, "bg-blue-100 text-blue-700 border-blue-200")}><Clock size={12} className="mr-1" /> 已排程 <ChevronDown size={10} className="ml-1 opacity-50" /></span>;
      case 'pending': return <span onClick={onClick} className={cn(baseClasses, "bg-orange-100 text-orange-700 border-orange-200")}><BellRing size={12} className="mr-1" /> 待補中 <ChevronDown size={10} className="ml-1 opacity-50" /></span>;
      case 'draft': return <span onClick={onClick} className={cn(baseClasses, "bg-gray-100 text-gray-700 border-gray-200")}><FileEdit size={12} className="mr-1" /> 草稿 <ChevronDown size={10} className="ml-1 opacity-50" /></span>;
    }
  };

  // Statistics calculation（排除該月落在冷凍區間內/已終止的廠商，避免被誤判欠片）
  const vendorStats = trackedVendorsForMonth(vendors, selectedMonth).map(vendor => {
    const vendorMonthPosts = posts.filter(p => {
      if (p.vendorId !== vendor.id) return false;
      const month = p.targetMonth || (p.scheduledAt ? format(parseISO(p.scheduledAt), 'yyyy-MM') : null);
      return month === selectedMonth;
    });
    
    const postCount = vendorMonthPosts.filter(p => p.contentType === 'post').length;
    const videoCount = vendorMonthPosts.filter(p => p.contentType === 'video').length;
    
    const targetPosts = vendor.monthlyTargetPosts || 0;
    const targetVideos = getEffectiveMonthlyTarget(vendor, selectedMonth);
    // 只有廠商從來沒設定過任何基本目標時才 fallback 成8；如果基本目標有設定、只是這個月被加贈/扣片調整打到0，
    // 要如實顯示0，不能被fallback蓋掉——否則會跟拍攝進度頁算出來的「這個月目標其實是0」互相矛盾
    const hasBaseTarget = (vendor.monthlyTargetPosts || 0) > 0 || (vendor.monthlyTargetVideos || 0) > 0;
    const totalTarget = hasBaseTarget ? (targetPosts + targetVideos) : 8;

    const totalCount = vendorMonthPosts.length;
    // totalTarget 現在有可能真的是0（被扣片調整打到0，不是fallback漏接），除以0要另外處理避免出現 Infinity/NaN
    const percentage = totalTarget > 0 ? Math.min(Math.round((totalCount / totalTarget) * 100), 100) : (totalCount > 0 ? 100 : 0);

    const hasPosts = vendor.cooperationItems?.includes('graphic_post');
    const hasVideos = vendor.cooperationItems?.includes('short_video');

    const monthAdjustments = (vendor.monthlyAdjustments || []).filter(a => a.month === selectedMonth);

    return {
      id: vendor.id,
      vendor,
      name: vendor.name,
      count: totalCount,
      postCount,
      videoCount,
      target: totalTarget,
      targetPosts,
      targetVideos,
      percentage,
      hasPosts,
      hasVideos,
      monthAdjustments
    };
  });

  return (
    <div className="space-y-6">
      {/* Statistics Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {vendorStats.map(stat => (
          <div key={stat.id} className="bg-white p-4 rounded-3xl border border-black/5 shadow-sm">
            <div className="flex justify-between items-start mb-2">
              <div className="font-bold text-sm truncate pr-2">{stat.name}</div>
              <div className="flex items-center gap-1.5 shrink-0">
                {stat.monthAdjustments.length > 0 && (
                  <span className="text-[10px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full border border-amber-100">
                    {stat.monthAdjustments.reduce((s, a) => s + a.videoDelta, 0) > 0 ? '+' : ''}
                    {stat.monthAdjustments.reduce((s, a) => s + a.videoDelta, 0)}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => openAdjustModal(stat.vendor)}
                  className="p-1 text-gray-300 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                  title="本月加贈／扣片調整"
                >
                  <Gift size={13} />
                </button>
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">本月進度</div>
              </div>
            </div>
            <div className="flex items-end justify-between mb-1">
              <div className="text-2xl font-bold serif">{stat.count} <span className="text-xs text-gray-400 font-sans">/ {stat.target}</span></div>
              <div className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded-full",
                stat.count >= stat.target ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
              )}>
                {stat.percentage}%
              </div>
            </div>
            <div className="flex gap-2 mb-2">
              {stat.hasPosts && (
                <div className="flex-1">
                  <div className="flex justify-between text-[8px] font-bold text-blue-400 mb-0.5">
                    <span>圖文</span>
                    <span>{stat.postCount}/{stat.targetPosts}</span>
                  </div>
                  <div className="w-full h-1 bg-blue-50 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-blue-400 transition-all duration-500"
                      style={{ width: `${stat.targetPosts > 0 ? Math.min((stat.postCount / stat.targetPosts) * 100, 100) : 0}%` }}
                    />
                  </div>
                </div>
              )}
              {stat.hasVideos && (
                <div className="flex-1">
                  <div className="flex justify-between text-[8px] font-bold text-orange-400 mb-0.5">
                    <span>影音</span>
                    <span>{stat.videoCount}/{stat.targetVideos}</span>
                  </div>
                  <div className="w-full h-1 bg-orange-50 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-orange-400 transition-all duration-500"
                      style={{ width: `${stat.targetVideos > 0 ? Math.min((stat.videoCount / stat.targetVideos) * 100, 100) : 0}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div 
                className={cn(
                  "h-full transition-all duration-500",
                  stat.count >= stat.target ? "bg-green-500" : "bg-[#5A5A40]"
                )}
                style={{ width: `${stat.percentage}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">貼文管理</h2>
          <p className="text-sm text-gray-500">追蹤所有貼文的發布狀態與成效</p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <button 
            onClick={() => setIsTrackingModalOpen(true)}
            className="flex-1 sm:flex-none flex items-center justify-center px-4 py-2 bg-orange-50 text-orange-600 rounded-xl shadow-sm border border-orange-100 hover:bg-orange-100 transition-all text-sm font-bold"
          >
            <BellRing size={18} className="mr-2" /> 上片排程表
          </button>
          <button 
            onClick={exportToExcel}
            className="flex-1 sm:flex-none flex items-center justify-center px-4 py-2 bg-white text-gray-600 rounded-xl shadow-sm border border-black/5 hover:bg-gray-50 transition-all text-sm"
          >
            <Download size={18} className="mr-2" /> 匯出 Excel
          </button>
          <button 
            onClick={() => {
              setEditingPost(null);
              setFormData({
                vendorId: visibleVendors(vendors)[0]?.id || '',
                title: '',
                content: '',
                status: 'draft',
                scheduledAt: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
                targetMonth: selectedMonth,
                type: '專業',
                clientConfirmed: false,
                internalConfirmed: false,
                platforms: ['IG'],
                postUrl: ''
              });
              setIsModalOpen(true);
            }}
            className="flex-1 sm:flex-none flex items-center justify-center px-6 py-2 bg-[#5A5A40] text-white rounded-xl shadow-lg hover:bg-[#4a4a35] transition-all text-sm font-bold"
          >
            <Plus size={18} className="mr-2" /> 新增貼文
          </button>
        </div>
      </div>

      {/* Month Selector */}
      <div className="flex flex-col sm:flex-row items-center justify-between bg-white p-4 rounded-2xl border border-black/5 shadow-sm gap-4">
        <div className="flex items-center space-x-4 w-full sm:w-auto justify-between sm:justify-start">
          <button 
            onClick={() => {
              const prev = subMonths(parseISO(`${selectedMonth}-01`), 1);
              setSelectedMonth(format(prev, 'yyyy-MM'));
            }}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="text-lg font-bold serif">
            {format(parseISO(`${selectedMonth}-01`), 'yyyy年 MM月')}
          </div>
          <button 
            onClick={() => {
              const next = addMonths(parseISO(`${selectedMonth}-01`), 1);
              setSelectedMonth(format(next, 'yyyy-MM'));
            }}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="flex space-x-1 overflow-x-auto w-full sm:w-auto pb-2 sm:pb-0 scrollbar-hide">
          {months.map(m => (
            <button
              key={m}
              onClick={() => setSelectedMonth(m)}
              className={cn(
                "px-3 py-1 rounded-lg text-xs font-bold transition-all whitespace-nowrap",
                selectedMonth === m ? "bg-[#5A5A40] text-white" : "text-gray-400 hover:bg-gray-100"
              )}
            >
              {format(parseISO(`${m}-01`), 'MM月')}
            </button>
          ))}
        </div>
      </div>

      {/* Status Filter Bar */}
      <div className="flex items-center space-x-2 overflow-x-auto pb-2 scrollbar-hide">
        {[
          { id: 'all', label: '全部狀態' },
          { id: 'draft', label: '草稿' },
          { id: 'scheduled', label: '已排程' },
          { id: 'published', label: '已發布' },
          { id: 'pending', label: '待補中' }
        ].map(status => (
          <button
            key={status.id}
            onClick={() => setSelectedStatus(status.id)}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap border flex items-center",
              selectedStatus === status.id 
                ? "bg-[#5A5A40] text-white border-[#5A5A40]" 
                : "bg-white text-gray-500 border-black/5 hover:border-gray-300"
            )}
          >
            {status.id === 'draft' && <FileEdit size={12} className="mr-1.5" />}
            {status.id === 'scheduled' && <Clock size={12} className="mr-1.5" />}
            {status.id === 'published' && <CheckCircle2 size={12} className="mr-1.5" />}
            {status.label}
            <span className="ml-1.5 opacity-50 text-[10px]">
              ({posts.filter(p => {
                const matchesSearch = p.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                  vendors.find(v => v.id === p.vendorId)?.name.toLowerCase().includes(searchTerm.toLowerCase());
                const matchesVendor = selectedVendorId === 'all' || p.vendorId === selectedVendorId;
                const matchesMonth = (p.targetMonth || (p.scheduledAt && p.scheduledAt.length > 0 ? format(parseISO(p.scheduledAt), 'yyyy-MM') : null)) === selectedMonth;
                const matchesStatus = status.id === 'all' || p.status === status.id;
                return matchesSearch && matchesVendor && matchesMonth && matchesStatus;
              }).length})
            </span>
          </button>
        ))}
      </div>

      {/* Vendor Filter Bar */}
      <div className="flex items-center space-x-2 overflow-x-auto pb-2 scrollbar-hide">
        <button
          onClick={() => setSelectedVendorId('all')}
          className={cn(
            "px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap border",
            selectedVendorId === 'all' 
              ? "bg-[#5A5A40] text-white border-[#5A5A40]" 
              : "bg-white text-gray-500 border-black/5 hover:border-gray-300"
          )}
        >
          全部廠商
        </button>
        {visibleVendors(vendors).map(vendor => (
          <button
            key={vendor.id}
            onClick={() => setSelectedVendorId(vendor.id!)}
            className={cn(
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

      <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
        {/* Desktop Table View */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#F5F5F0] border-b border-black/5">
                <th 
                  className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => handleSort('platforms')}
                >
                  <div className="flex items-center">發布社群 <SortIcon field="platforms" /></div>
                </th>
                <th 
                  className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => handleSort('contentType')}
                >
                  <div className="flex items-center">內容類型 <SortIcon field="contentType" /></div>
                </th>
                <th 
                  className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => handleSort('status')}
                >
                  <div className="flex items-center">發布狀態 <SortIcon field="status" /></div>
                </th>
                <th 
                  className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => handleSort('scheduledAt')}
                >
                  <div className="flex items-center">發布時間 <SortIcon field="scheduledAt" /></div>
                </th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">貼文位置</th>
                <th 
                  className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => handleSort('title')}
                >
                  <div className="flex items-center">文案標題 / 內容 <SortIcon field="title" /></div>
                </th>
                <th 
                  className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => handleSort('clientConfirmed')}
                >
                  <div className="flex items-center justify-center">客戶確認 <SortIcon field="clientConfirmed" /></div>
                </th>
                <th 
                  className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => handleSort('internalConfirmed')}
                >
                  <div className="flex items-center justify-center">內部檢核 <SortIcon field="internalConfirmed" /></div>
                </th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {sortedPosts.map((post, index) => {
                const vendor = vendors.find(v => v.id === post.vendorId);
                const isNearBottom = index >= sortedPosts.length - 3 && sortedPosts.length > 3;
                
                return (
                  <tr key={post.id} className="hover:bg-gray-50 transition-colors">
                    <td className="p-4">
                      {vendor?.selfPublishing ? (
                        <div className="flex flex-col gap-1">
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-bold w-fit">廠商自行發布專案</span>
                          <span className="text-[9px] text-gray-400">認列：{post.platforms.join(', ')}</span>
                          <div className="text-xs text-gray-400 truncate max-w-[100px]">{vendor?.name}</div>
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-1 mb-1">
                            {post.platforms.map(p => {
                              const isPublished = post.publishedPlatforms?.includes(p);
                              return (
                                <button
                                  key={p}
                                  onClick={() => togglePlatformPublished(post, p)}
                                  className={cn(
                                    "text-[10px] px-1.5 py-0.5 rounded font-bold transition-all flex items-center gap-1",
                                    isPublished 
                                      ? "bg-green-100 text-green-700 border border-green-200" 
                                      : "bg-gray-100 text-gray-400 border border-gray-200 hover:border-gray-400"
                                  )}
                                  title={isPublished ? `已在 ${p} 發布` : `標記 ${p} 為已發布`}
                                >
                                  {isPublished && <CheckCircle2 size={8} />}
                                  {p}
                                </button>
                              );
                            })}
                          </div>
                          <div className="text-xs text-gray-400 truncate max-w-[100px]">{vendor?.name}</div>
                        </>
                      )}
                    </td>
                    <td className="p-4">
                      <span className={cn(
                        "text-[10px] px-2 py-0.5 rounded font-bold",
                        post.contentType === 'video' ? "bg-orange-100 text-orange-700" : "bg-blue-100 text-blue-700"
                      )}>
                        {post.contentType === 'video' ? '短影音' : '圖文'}
                      </span>
                    </td>
                    <td className="p-4">
                      <div className="relative">
                        {getStatusBadge(post.status, () => setOpenStatusId(openStatusId === post.id ? null : post.id!))}
                        {openStatusId === post.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setOpenStatusId(null)} />
                            <div className={cn(
                              "absolute left-0 bg-white shadow-2xl rounded-2xl border border-black/5 py-2 z-20 min-w-[120px] animate-in fade-in duration-200",
                              isNearBottom 
                                ? "bottom-full mb-1 slide-in-from-bottom-2" 
                                : "top-full mt-1 slide-in-from-top-2"
                            )}>
                              <div className="px-3 py-1 text-[9px] font-bold text-gray-400 uppercase tracking-widest border-b border-black/5 mb-1">變更狀態</div>
                              {(['draft', 'scheduled', 'published', 'pending'] as PostStatus[]).map(s => (
                                <button 
                                  key={s}
                                  onClick={() => {
                                    toggleStatus(post, s);
                                    setOpenStatusId(null);
                                  }}
                                  className={cn(
                                    "block w-full text-left px-4 py-2.5 text-xs hover:bg-[#F5F5F0] transition-colors",
                                    post.status === s ? "font-bold text-[#5A5A40] bg-[#F5F5F0]" : "text-gray-600"
                                  )}
                                >
                                  {s === 'draft' ? '草稿' : s === 'scheduled' ? '已排程' : s === 'published' ? '已發布' : '待補中'}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="text-sm font-medium">
                        {post.scheduledAt && post.scheduledAt.length > 0 ? format(parseISO(post.scheduledAt), 'MM/dd') : (
                          <span className="text-gray-400 italic">未定</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400">
                        {post.scheduledAt && post.scheduledAt.length > 0 ? format(parseISO(post.scheduledAt), 'HH:mm') : (
                          <span className="text-[10px]">歸檔: {post.targetMonth}</span>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      {post.postUrl ? (
                        <a 
                          href={post.postUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="flex items-center text-blue-500 hover:text-blue-700 font-bold text-xs"
                        >
                          <ExternalLink size={14} className="mr-1" /> 前往位置
                        </a>
                      ) : (
                        <span className="text-gray-300 text-xs italic">未設定</span>
                      )}
                    </td>
                    <td className="p-4 max-w-xs">
                      <div className="font-bold text-sm truncate">{post.title}</div>
                      <div className="text-xs text-gray-500 line-clamp-2 mt-1">{post.content}</div>
                    </td>
                    <td className="p-4 text-center">
                      <button onClick={() => toggleConfirmation(post, 'clientConfirmed')}>
                        {post.clientConfirmed ? <CheckSquare className="mx-auto text-green-500" size={20} /> : <Square className="mx-auto text-gray-300" size={20} />}
                      </button>
                    </td>
                    <td className="p-4 text-center">
                      <button onClick={() => toggleConfirmation(post, 'internalConfirmed')}>
                        {post.internalConfirmed ? <CheckSquare className="mx-auto text-green-500" size={20} /> : <Square className="mx-auto text-gray-300" size={20} />}
                      </button>
                    </td>
                    <td className="p-4">
                      <div className="flex space-x-1">
                        <button 
                          onClick={() => handleCopyContent(post.content)}
                          className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                          title="複製文案"
                        >
                          <Copy size={16} />
                        </button>
                        <button 
                          onClick={() => {
                            setEditingPost(post);
                            setFormData(post);
                            setIsModalOpen(true);
                          }}
                          className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg transition-colors"
                          title="編輯"
                        >
                          <FileEdit size={16} />
                        </button>
                        <button 
                          onClick={() => setDeletingPostId(post.id!)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          title="刪除"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile Card View */}
        <div className="md:hidden divide-y divide-black/5">
          {sortedPosts.length === 0 ? (
            <div className="p-8 text-center text-gray-400 italic">本月尚無貼文</div>
          ) : (
            sortedPosts.map((post, index) => {
              const vendor = vendors.find(v => v.id === post.vendorId);
              const isNearTop = index < 2 && sortedPosts.length > 2;

              return (
                <div key={post.id} className="p-4 space-y-3">
                  <div className="flex justify-between items-start">
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-gray-400">{vendor?.name}</span>
                        <div className="flex gap-1">
                          {post.platforms.map(p => (
                            <span key={p} className="bg-gray-100 text-[9px] px-1 py-0.5 rounded font-bold">{p}</span>
                          ))}
                        </div>
                      </div>
                      <h4 className="font-bold text-sm">{post.title}</h4>
                    </div>
                    <div className="flex space-x-1">
                      <button 
                        onClick={() => handleCopyContent(post.content)}
                        className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg"
                        title="複製文案"
                      >
                        <Copy size={16} />
                      </button>
                      <button 
                        onClick={() => {
                          setEditingPost(post);
                          setFormData(post);
                          setIsModalOpen(true);
                        }}
                        className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg"
                      >
                        <FileEdit size={16} />
                      </button>
                      <button 
                        onClick={() => setDeletingPostId(post.id!)}
                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs pt-2 border-t border-black/5">
                    <div className="flex items-center space-x-3">
                      <div className="flex items-center text-gray-500">
                        <CalendarIcon size={12} className="mr-1" />
                        {post.scheduledAt ? format(parseISO(post.scheduledAt), 'MM/dd HH:mm') : '-'}
                      </div>
                      <div className="relative">
                        {getStatusBadge(post.status, () => setOpenStatusId(openStatusId === post.id ? null : post.id!))}
                        {openStatusId === post.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setOpenStatusId(null)} />
                            <div className={cn(
                              "absolute left-0 bg-white shadow-2xl rounded-2xl border border-black/5 py-2 z-20 min-w-[120px] animate-in fade-in duration-200",
                              isNearTop
                                ? "top-full mt-1 slide-in-from-top-2"
                                : "bottom-full mb-1 slide-in-from-bottom-2"
                            )}>
                              <div className="px-3 py-1 text-[9px] font-bold text-gray-400 uppercase tracking-widest border-b border-black/5 mb-1">變更狀態</div>
                              {(['draft', 'scheduled', 'published', 'pending'] as PostStatus[]).map(s => (
                                <button 
                                  key={s}
                                  onClick={() => {
                                    toggleStatus(post, s);
                                    setOpenStatusId(null);
                                  }}
                                  className={cn(
                                    "block w-full text-left px-4 py-2.5 text-xs hover:bg-[#F5F5F0] transition-colors",
                                    post.status === s ? "font-bold text-[#5A5A40] bg-[#F5F5F0]" : "text-gray-600"
                                  )}
                                >
                                  {s === 'draft' ? '草稿' : s === 'scheduled' ? '已排程' : s === 'published' ? '已發布' : '待補中'}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="flex items-center space-x-1">
                        <span className="text-[9px] text-gray-400">客:</span>
                        <button onClick={() => toggleConfirmation(post, 'clientConfirmed')}>
                          {post.clientConfirmed ? <CheckSquare className="text-green-500" size={14} /> : <Square className="text-gray-300" size={14} />}
                        </button>
                      </div>
                      <div className="flex items-center space-x-1">
                        <span className="text-[9px] text-gray-400">內:</span>
                        <button onClick={() => toggleConfirmation(post, 'internalConfirmed')}>
                          {post.internalConfirmed ? <CheckSquare className="text-green-500" size={14} /> : <Square className="text-gray-300" size={14} />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-black/5">
                    <div className="flex space-x-4">
                      <button 
                        onClick={() => toggleConfirmation(post, 'clientConfirmed')}
                        className="flex items-center space-x-1"
                      >
                        {post.clientConfirmed ? <CheckSquare className="text-green-500" size={16} /> : <Square className="text-gray-300" size={16} />}
                        <span className="text-[10px] text-gray-500">業主</span>
                      </button>
                      <button 
                        onClick={() => toggleConfirmation(post, 'internalConfirmed')}
                        className="flex items-center space-x-1"
                      >
                        {post.internalConfirmed ? <CheckSquare className="text-green-500" size={16} /> : <Square className="text-gray-300" size={16} />}
                        <span className="text-[10px] text-gray-500">內部</span>
                      </button>
                    </div>
                    {post.postUrl && (
                      <a 
                        href={post.postUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-blue-500 font-bold text-[10px] flex items-center"
                      >
                        <ExternalLink size={12} className="mr-1" /> 連結
                      </a>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deletingPostId && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-[32px] w-full max-w-sm p-8 shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
              <Trash2 className="text-red-500" size={32} />
            </div>
            <h3 className="text-xl font-bold text-center mb-2 serif">確定要刪除嗎？</h3>
            <p className="text-gray-500 text-center text-sm mb-8">
              此動作將永久刪除這則貼文，且無法復原。
              <br />
              <span className="text-green-700">掛在上面的成片素材會自動放回庫存</span>，可以重新排程，不會報廢。
            </p>
            <div className="flex space-x-3">
              <button 
                onClick={() => setDeletingPostId(null)}
                className="flex-1 py-3 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
              >
                取消
              </button>
              <button 
                onClick={async () => {
                  try {
                    const target = posts.find(p => p.id === deletingPostId);
                    await deleteDoc(doc(db, 'posts', deletingPostId));
                    // 貼文刪掉，掛在上面的素材一定要放回庫存，否則它會永遠停在 used、
                    // 排程選單再也挑不到，等於按錯一次就報廢一支成片。
                    // 先刪貼文再放素材：萬一這步失敗，素材變成「掛著一個已不存在的貼文」，
                    // isAssetOrphaned() 會自動把它當回庫存，不會卡死——所以這裡各自 try，
                    // 放素材失敗不能報成「刪除失敗」，貼文明明已經刪掉了，講反了使用者會重按。
                    if (target?.assetId && target.assetId !== 'to_be_added') {
                      try {
                        await updateDoc(doc(db, 'assets', target.assetId), { status: 'available', usedInPostId: null });
                        toast.success('已刪除貼文，素材已放回庫存可重新排程');
                      } catch {
                        toast.success('已刪除貼文（素材狀態沒更新成功，但系統會自動視為可用）');
                      }
                    } else {
                      toast.success('已刪除貼文');
                    }
                    setDeletingPostId(null);
                  } catch (error) {
                    // 不要再把錯誤吞掉：之前只丟一句「刪除失敗」，
                    // 完全查不出是權限被拒、還是資料格式被 SDK 擋下。
                    console.error('Post delete failed:', error);
                    const code = (error as { code?: string })?.code;
                    // 刪貼文的規則是 isManager()，員工(employee)按下去一定被拒。
                    // 以前只回一句「刪除失敗」，當事人只會以為系統壞了，一直重按。
                    toast.error(
                      code === 'permission-denied'
                        ? '刪除失敗：你的帳號沒有刪除貼文的權限（需要主管以上），請找主管處理'
                        : `刪除失敗${code ? `（${code}）` : ''}`
                    );
                  }
                }}
                className="flex-1 bg-red-500 text-white py-3 rounded-2xl font-bold shadow-lg hover:bg-red-600 transition-all"
              >
                確認刪除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 本月加贈／扣片調整 Modal */}
      {adjustModalVendor && (() => {
        const liveVendor = vendors.find(v => v.id === adjustModalVendor.id) || adjustModalVendor;
        const history = [...(liveVendor.monthlyAdjustments || [])].sort((a, b) => b.month.localeCompare(a.month) || b.createdAt.localeCompare(a.createdAt));
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-3xl w-full max-w-md max-h-[90vh] overflow-auto shadow-2xl">
              <div className="p-6">
                <div className="flex justify-between items-center mb-1">
                  <h3 className="text-lg font-bold serif flex items-center"><Gift size={18} className="mr-2 text-amber-500" />{liveVendor.name}</h3>
                  <button onClick={() => setAdjustModalVendor(null)} className="p-2 hover:bg-gray-100 rounded-full">
                    <X size={20} />
                  </button>
                </div>
                <p className="text-xs text-gray-400 mb-5">套用月份：{format(parseISO(`${selectedMonth}-01`), 'yyyy年 MM月')}（只調整這個月自己的目標數字，月份一過自動失效；不會動到已經回填的起始欠片，要沖銷/抵銷欠片請去拍攝進度頁的「校正起始欠片」填負數）</p>

                <div className="bg-amber-50/50 p-4 rounded-2xl border border-amber-100 space-y-3 mb-5">
                  <div>
                    <label className="block text-xs font-medium text-amber-800 mb-1">影音支數調整（加贈填正數，扣片填負數）</label>
                    <input
                      type="number"
                      value={adjustDelta}
                      onChange={(e) => setAdjustDelta(parseInt(e.target.value) || 0)}
                      className="w-full p-3 bg-white rounded-xl border border-amber-200 focus:ring-2 focus:ring-amber-400"
                      placeholder="例如：3"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-amber-800 mb-1">原因</label>
                    <input
                      type="text"
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      className="w-full p-3 bg-white rounded-xl border border-amber-200 focus:ring-2 focus:ring-amber-400"
                      placeholder="例如：開會決議加贈3支"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAddAdjustment}
                    className="w-full bg-amber-500 text-white py-2.5 rounded-xl font-bold text-sm shadow hover:bg-amber-600 transition-all"
                  >
                    新增這筆調整
                  </button>
                </div>

                <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">歷史調整紀錄</div>
                {history.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">目前沒有任何調整紀錄</p>
                ) : (
                  <div className="space-y-2">
                    {history.map((adj, idx) => {
                      const originalIndex = (liveVendor.monthlyAdjustments || []).indexOf(adj);
                      return (
                        <div key={idx} className="flex items-start justify-between gap-2 p-3 bg-[#F5F5F0] rounded-xl text-sm">
                          <div>
                            <div className="font-bold">
                              {format(parseISO(`${adj.month}-01`), 'yyyy/MM')}
                              <span className={cn("ml-2", adj.videoDelta >= 0 ? "text-green-600" : "text-red-500")}>
                                {adj.videoDelta > 0 ? '+' : ''}{adj.videoDelta} 支
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">{adj.reason}</div>
                          </div>
                          <button
                            onClick={() => handleDeleteAdjustment(liveVendor, originalIndex)}
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

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-3xl max-h-[90vh] overflow-auto shadow-2xl">
            <div className="p-8">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-bold serif">{editingPost ? '編輯貼文' : '新增貼文'}</h3>
                <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full">
                  <X size={24} />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">所屬廠商</label>
                    <select 
                      required
                      value={formData.vendorId}
                      onChange={(e) => {
                        const vendorId = e.target.value;
                        const selectedVendor = vendors.find(v => v.id === vendorId);
                        let defaultContentType = formData.contentType || 'post';
                        
                        if (selectedVendor?.postingHabits && selectedVendor.postingHabits.length > 0) {
                          const habitTypes = Array.from(new Set(selectedVendor.postingHabits.flatMap(h => h.contentTypes || [])));
                          if (habitTypes.length === 1) {
                            defaultContentType = habitTypes[0] as 'post' | 'video';
                          }
                        }
                        
                        setFormData({ ...formData, vendorId, contentType: defaultContentType });
                      }}
                      className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none"
                    >
                      <option value="">請選擇廠商</option>
                      {visibleVendors(vendors).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">目標月份 (計算KPI用)</label>
                    <select 
                      required
                      value={formData.targetMonth}
                      onChange={(e) => setFormData({ ...formData, targetMonth: e.target.value })}
                      className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none"
                    >
                      {months.map(m => (
                        <option key={m} value={m}>
                          {format(parseISO(`${m}-01`), 'yyyy年 MM月')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">文案標題</label>
                    <input 
                      type="text" 
                      required
                      value={formData.title}
                      onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                      className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none"
                      placeholder="輸入標題..."
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">內容類型</label>
                    <div className="flex gap-2">
                      {['post', 'video'].map(type => (
                        <button
                          key={type}
                          type="button"
                          // 用 '' 而不是 undefined：Firestore SDK 預設寫入 undefined 會直接丟例外
                          // （連安全規則都碰不到），以前切換內容類型後存檔必炸、還被 catch 吞成「儲存失敗」。
                          onClick={() => setFormData({ ...formData, contentType: type as 'post' | 'video', assetId: '' })}
                          className={cn(
                            "flex-1 py-2 rounded-xl text-sm font-bold transition-all",
                            formData.contentType === type ? "bg-[#5A5A40] text-white" : "bg-gray-100 text-gray-400"
                          )}
                        >
                          {type === 'post' ? '圖文' : '短影音'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">發布狀態</label>
                    <div className="flex flex-wrap gap-2">
                      {(['draft', 'scheduled', 'published', 'pending'] as PostStatus[]).map(s => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setFormData({ ...formData, status: s })}
                          className={cn(
                            "flex-1 py-2 rounded-xl text-[10px] font-bold transition-all border",
                            formData.status === s 
                              ? "bg-[#5A5A40] text-white border-[#5A5A40]" 
                              : "bg-gray-50 text-gray-400 border-black/5 hover:border-gray-200"
                          )}
                        >
                          {s === 'draft' ? '草稿' : s === 'scheduled' ? '已排程' : s === 'published' ? '已發布' : '待補中'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      選擇{formData.contentType === 'video' ? '影片' : '貼文'}素材 (庫存)
                    </label>
                    <select 
                      value={formData.assetId || ''}
                      onChange={(e) => {
                        const aid = e.target.value;
                        if (aid === 'to_be_added') {
                          setFormData({ ...formData, assetId: aid });
                          return;
                        }
                        const asset = assets.find(a => a.id === aid);
                        setFormData({ 
                          ...formData, 
                          assetId: aid,
                          postUrl: asset?.url || formData.postUrl,
                          title: formData.title || asset?.title || ''
                        });
                      }}
                      className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none"
                    >
                      <option value="">選擇現有素材...</option>
                      <option value="to_be_added" className="text-blue-600 font-bold">✨ 待補上 (稍後上傳)</option>
                      {assets
                        .filter(a =>
                          a.vendorId === formData.vendorId &&
                          a.type === formData.contentType &&
                          // 用共用的 isAssetFree()，不要自己寫 status==='available'——
                          // 那樣會漏掉「掛的貼文已被刪掉」的素材，選單永遠挑不到它
                          (isAssetFree(a, postIndex) || a.id === formData.assetId) &&
                          a.stage === 'finished'
                        )
                        .map(a => (
                          <option key={a.id} value={a.id}>
                            [{a.category || '未分類'}] {a.title} {!isAssetFree(a, postIndex) ? '(已使用)' : ''} {!a.approved ? '(待審核)' : ''}
                          </option>
                        ))
                      }
                    </select>
                    {assets.filter(a => a.vendorId === formData.vendorId && a.type === formData.contentType && isAssetFree(a, postIndex) && a.stage === 'finished').length === 0 && (
                      <p className="text-[10px] text-red-500 mt-1 font-bold">⚠️ 此廠商目前無可用{formData.contentType === 'video' ? '影片' : '貼文'}成片素材，請先至資料庫上架</p>
                    )}
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="block text-sm font-medium text-gray-700">預計發布時間 (選填)</label>
                      <div className="flex gap-1">
                        {formData.scheduledAt && (
                          <button 
                            type="button"
                            onClick={() => setFormData({ ...formData, scheduledAt: '' })}
                            className="text-[10px] text-red-500 hover:underline font-bold mr-2"
                          >
                            清除
                          </button>
                        )}
                        <button 
                          type="button" 
                          onClick={() => setQuickTime(20)}
                          className="text-[10px] bg-gray-100 px-2 py-0.5 rounded hover:bg-gray-200"
                        >
                          20:00
                        </button>
                        <button 
                          type="button" 
                          onClick={() => setQuickTime(21)}
                          className="text-[10px] bg-gray-100 px-2 py-0.5 rounded hover:bg-gray-200"
                        >
                          21:00
                        </button>
                      </div>
                    </div>
                    <input 
                      type="datetime-local" 
                      value={formData.scheduledAt || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        const newTargetMonth = val ? format(parseISO(val), 'yyyy-MM') : formData.targetMonth;
                        setFormData({ 
                          ...formData, 
                          scheduledAt: val,
                          targetMonth: newTargetMonth
                        });
                      }}
                      className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none mb-2"
                    />
                    
                    {suggestedDates.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">建議發布時間 (依發布習慣)</p>
                        <div className="flex flex-wrap gap-1">
                          {suggestedDates.map((s, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => {
                                setFormData({ 
                                  ...formData, 
                                  scheduledAt: format(s.date, "yyyy-MM-dd'T'HH:mm"),
                                  platforms: s.habit.platforms || formData.platforms
                                });
                              }}
                              className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-1 rounded-lg hover:bg-emerald-100 transition-colors"
                            >
                              {format(s.date, 'MM/dd (eee) HH:mm')}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">貼文類型 (可自訂)</label>
                    <div className="relative">
                      <input 
                        type="text"
                        list="post-types"
                        value={formData.type}
                        onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                        className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none"
                        placeholder="輸入或選擇類型..."
                      />
                      <datalist id="post-types">
                        {postTypes.map(t => <option key={t} value={t} />)}
                      </datalist>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">文案內容</label>
                    <textarea 
                      rows={6}
                      value={formData.content}
                      onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                      className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none resize-none"
                      placeholder="輸入貼文內容..."
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">貼文位置連結 (如 Drive/Notion/社群連結)</label>
                    <div className="relative">
                      <ExternalLink className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                      <input 
                        type="url" 
                        value={formData.postUrl}
                        onChange={(e) => setFormData({ ...formData, postUrl: e.target.value })}
                        className="w-full pl-10 pr-4 py-2 bg-[#F5F5F0] rounded-xl border-none"
                        placeholder="https://..."
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">發布平台</label>
                    {vendors.find(v => v.id === formData.vendorId)?.selfPublishing ? (
                      <div className="bg-green-50 p-4 rounded-2xl border border-green-100 mb-2">
                        <p className="text-xs text-green-800 font-bold mb-1">✓ 廠商自行發布模式</p>
                        <p className="text-[10px] text-green-600/70">此廠商設定為自行發布。系統將僅記錄用於服務次數認列。您仍可選取預計認列的平台：</p>
                        <div className="flex flex-wrap gap-2 mt-3">
                          {['IG', 'FB', 'TikTok', 'YT', 'LINE'].map(p => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => {
                                const newPlatforms = formData.platforms?.includes(p)
                                  ? formData.platforms.filter(x => x !== p)
                                  : [...(formData.platforms || []), p];
                                setFormData({ ...formData, platforms: newPlatforms });
                              }}
                              className={cn(
                                "px-3 py-1 rounded-full text-xs font-bold transition-all",
                                formData.platforms?.includes(p) ? "bg-green-600 text-white" : "bg-white text-green-300 border border-green-100"
                              )}
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {['IG', 'FB', 'TikTok', 'YT', 'LINE'].map(p => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => {
                              const newPlatforms = formData.platforms?.includes(p)
                                  ? formData.platforms.filter(x => x !== p)
                                  : [...(formData.platforms || []), p];
                              setFormData({ ...formData, platforms: newPlatforms });
                            }}
                            className={cn(
                              "px-3 py-1 rounded-full text-xs font-bold transition-all",
                              formData.platforms?.includes(p) ? "bg-[#5A5A40] text-white" : "bg-gray-100 text-gray-400"
                            )}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="md:col-span-2 flex justify-end space-x-4 pt-4">
                  <button 
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-6 py-2 text-gray-500 font-medium"
                  >
                    取消
                  </button>
                  <button 
                    type="submit"
                    className="bg-[#5A5A40] text-white px-8 py-2 rounded-xl font-bold shadow-lg"
                  >
                    儲存貼文
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
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

function X({ size, className }: { size?: number, className?: string }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width={size || 24} 
      height={size || 24} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
    >
      <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
    </svg>
  );
}
