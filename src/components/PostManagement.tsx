import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  orderBy 
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
  ArrowDown
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { format, isPast, isToday, addDays, parseISO, getDay, setHours, setMinutes, startOfDay, isSameDay, startOfMonth, endOfMonth, eachMonthOfInterval, subMonths, addMonths } from 'date-fns';
import toast from 'react-hot-toast';
import TrackingExportModal from './TrackingExportModal';
import { DismissedHabit } from '../types';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function PostManagement() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;

    try {
      const data = {
        ...formData,
        scheduledAt: formData.scheduledAt || '',
        targetMonth: formData.targetMonth || selectedMonth,
        createdBy: auth.currentUser.uid,
        createdAt: editingPost?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (editingPost) {
        // If changing asset, update old and new asset status
        if (editingPost.assetId && editingPost.assetId !== formData.assetId && editingPost.assetId !== 'to_be_added') {
          await updateDoc(doc(db, 'assets', editingPost.assetId), { status: 'available', usedInPostId: null });
        }
        if (formData.assetId && formData.assetId !== 'to_be_added' && editingPost.assetId !== formData.assetId) {
          await updateDoc(doc(db, 'assets', formData.assetId), { status: 'used', usedInPostId: editingPost.id });
        }
        await updateDoc(doc(db, 'posts', editingPost.id!), data);
        toast.success('貼文已更新');
      } else {
        const docRef = await addDoc(collection(db, 'posts'), data);
        if (formData.assetId && formData.assetId !== 'to_be_added') {
          await updateDoc(doc(db, 'assets', formData.assetId), { status: 'used', usedInPostId: docRef.id });
        }
        toast.success('貼文已建立');
      }
      setIsModalOpen(false);
      setEditingPost(null);
    } catch (error) {
      toast.error('儲存失敗');
    }
  };

  const toggleStatus = async (post: Post, newStatus: PostStatus) => {
    if (newStatus === 'published') {
      if (!post.clientConfirmed) {
        toast.error('必須先經業主審核確認後才可發布');
        return;
      }
      
      // Check if the linked asset is approved
      if (post.assetId && post.assetId !== 'to_be_added') {
        const asset = assets.find(a => a.id === post.assetId);
        if (asset && !asset.approved) {
          toast.error('素材尚未通過審核，無法發布');
          return;
        }
      }
    }

    if (newStatus === 'scheduled') {
      // Warning if asset not approved, but don't block
      if (post.assetId && post.assetId !== 'to_be_added') {
        const asset = assets.find(a => a.id === post.assetId);
        if (asset && !asset.approved) {
          toast('提醒：成片素材尚未審核', { icon: '⚠️', duration: 4000 });
        }
      }
    }
    
    try {
      await updateDoc(doc(db, 'posts', post.id!), { status: newStatus });
      toast.success(`狀態已更新為 ${newStatus}`);

      // Trigger Make Webhook if status is scheduled or published
      if (newStatus === 'scheduled' || newStatus === 'published') {
        const vendor = vendors.find(v => v.id === post.vendorId);
        const webhookData = {
          action: 'status_change',
          postId: post.id,
          status: newStatus,
          title: post.title,
          content: post.content,
          scheduledAt: post.scheduledAt,
          vendorName: vendor?.name,
          platforms: post.platforms,
          type: post.type,
          contentType: post.contentType
        };

        // Try calling the proxy first, then fallback to direct call if configured
        const fetchFn = globalThis.fetch || window.fetch;
        fetchFn('/api/webhook/make', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookData)
        }).then(res => {
          if (!res.ok) throw new Error('Proxy failed');
        }).catch(err => {
          console.warn('Webhook proxy failed, checking for direct URL...', err);
          // Fallback to direct URL if set in environment (VITE_ prefix for client-side)
          const directUrl = (import.meta as any).env?.VITE_MAKE_WEBHOOK_URL;
          if (directUrl) {
            fetchFn(directUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(webhookData)
            }).catch(e => console.error('Direct webhook call failed', e));
          }
        });
      }
    } catch (error) {
      toast.error('更新失敗');
    }
  };

  const toggleConfirmation = async (post: Post, field: 'clientConfirmed' | 'internalConfirmed') => {
    try {
      await updateDoc(doc(db, 'posts', post.id!), { [field]: !post[field] });
    } catch (error) {
      toast.error('更新失敗');
    }
  };

  const togglePlatformPublished = async (post: Post, platform: string) => {
    try {
      const current = post.publishedPlatforms || [];
      const updated = current.includes(platform)
        ? current.filter(p => p !== platform)
        : [...current, platform];
      
      await updateDoc(doc(db, 'posts', post.id!), { publishedPlatforms: updated });
      toast.success(`${platform} 發布狀態已更新`);
    } catch (error) {
      toast.error('更新失敗');
    }
  };

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

  // Statistics calculation
  const vendorStats = vendors.map(vendor => {
    const vendorMonthPosts = posts.filter(p => {
      if (p.vendorId !== vendor.id) return false;
      const month = p.targetMonth || (p.scheduledAt ? format(parseISO(p.scheduledAt), 'yyyy-MM') : null);
      return month === selectedMonth;
    });
    
    const postCount = vendorMonthPosts.filter(p => p.contentType === 'post').length;
    const videoCount = vendorMonthPosts.filter(p => p.contentType === 'video').length;
    
    const targetPosts = vendor.monthlyTargetPosts || 0;
    const targetVideos = vendor.monthlyTargetVideos || 0;
    const totalTarget = targetPosts + targetVideos || 8; // Fallback to 8 if no target set
    
    const totalCount = vendorMonthPosts.length;
    const percentage = Math.min(Math.round((totalCount / totalTarget) * 100), 100);
    
    const hasPosts = vendor.cooperationItems?.includes('graphic_post');
    const hasVideos = vendor.cooperationItems?.includes('short_video');
    
    return {
      id: vendor.id,
      name: vendor.name,
      count: totalCount,
      postCount,
      videoCount,
      target: totalTarget,
      targetPosts,
      targetVideos,
      percentage,
      hasPosts,
      hasVideos
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
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">本月進度</div>
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
            <BellRing size={18} className="mr-2" /> 催片導出
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
                vendorId: vendors[0]?.id || '',
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
                const matchesMonth = (p.targetMonth || (p.scheduledAt ? format(parseISO(p.scheduledAt), 'yyyy-MM') : null)) === selectedMonth;
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
        {vendors.map(vendor => (
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
                              {(['draft', 'scheduled', 'published', 'recognized', 'pending'] as PostStatus[]).map(s => (
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
                        {post.scheduledAt ? format(parseISO(post.scheduledAt), 'MM/dd') : (
                          <span className="text-gray-400 italic">未定</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400">
                        {post.scheduledAt ? format(parseISO(post.scheduledAt), 'HH:mm') : (
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
                              {(['draft', 'scheduled', 'published', 'recognized', 'pending'] as PostStatus[]).map(s => (
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
            <p className="text-gray-500 text-center text-sm mb-8">此動作將永久刪除這則貼文，且無法復原。</p>
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
                    await deleteDoc(doc(db, 'posts', deletingPostId));
                    toast.success('已刪除貼文');
                    setDeletingPostId(null);
                  } catch (error) {
                    toast.error('刪除失敗');
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
                      {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
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
                          onClick={() => setFormData({ ...formData, contentType: type as 'post' | 'video', assetId: undefined })}
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
                          (a.status === 'available' || a.id === formData.assetId) &&
                          a.stage === 'finished'
                        )
                        .map(a => (
                          <option key={a.id} value={a.id}>
                            [{a.category || '未分類'}] {a.title} {a.status === 'used' ? '(已使用)' : ''} {!a.approved ? '(待審核)' : ''}
                          </option>
                        ))
                      }
                    </select>
                    {assets.filter(a => a.vendorId === formData.vendorId && a.type === formData.contentType && a.status === 'available' && a.stage === 'finished').length === 0 && (
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
        vendors={vendors}
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
