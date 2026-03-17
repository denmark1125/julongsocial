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
  Download
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { format, isPast, isToday, addDays, parseISO, getDay, setHours, setMinutes, startOfDay, isSameDay } from 'date-fns';
import toast from 'react-hot-toast';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function PostManagement() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedVendorId, setSelectedVendorId] = useState<string>('all');
  
  const [formData, setFormData] = useState<Partial<Post>>({
    vendorId: '',
    title: '',
    content: '',
    status: 'draft',
    scheduledAt: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
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

    return () => {
      vUnsubscribe();
      pUnsubscribe();
      aUnsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;

    try {
      const data = {
        ...formData,
        createdBy: auth.currentUser.uid,
        createdAt: new Date().toISOString()
      };

      if (editingPost) {
        // If changing asset, update old and new asset status
        if (editingPost.assetId && editingPost.assetId !== formData.assetId) {
          await updateDoc(doc(db, 'assets', editingPost.assetId), { status: 'available', usedInPostId: null });
        }
        if (formData.assetId && editingPost.assetId !== formData.assetId) {
          await updateDoc(doc(db, 'assets', formData.assetId), { status: 'used', usedInPostId: editingPost.id });
        }
        await updateDoc(doc(db, 'posts', editingPost.id!), data);
        toast.success('貼文已更新');
      } else {
        const docRef = await addDoc(collection(db, 'posts'), data);
        if (formData.assetId) {
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
      if (post.assetId) {
        const asset = assets.find(a => a.id === post.assetId);
        if (asset && !asset.approved) {
          toast.error('素材尚未通過審核，無法發布');
          return;
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
        fetch('/api/webhook/make', {
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
            fetch(directUrl, {
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

  const exportToExcel = () => {
    const exportData = posts.map(post => {
      const vendor = vendors.find(v => v.id === post.vendorId);
      const asset = assets.find(a => a.id === post.assetId);
      return {
        '廠商名稱': vendor?.name || '未知',
        '貼文標題': post.title,
        '內容類型': post.contentType === 'video' ? '短影音' : '圖文',
        '發布狀態': post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : '草稿',
        '預計發布時間': format(parseISO(post.scheduledAt), 'yyyy-MM-dd HH:mm'),
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
    return matchesSearch && matchesVendor;
  });

  const getStatusBadge = (status: PostStatus) => {
    switch (status) {
      case 'published': return <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-bold flex items-center w-fit"><CheckCircle2 size={12} className="mr-1" /> 已發布</span>;
      case 'scheduled': return <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold flex items-center w-fit"><Clock size={12} className="mr-1" /> 已排程</span>;
      case 'draft': return <span className="bg-gray-100 text-gray-700 px-3 py-1 rounded-full text-xs font-bold flex items-center w-fit"><FileEdit size={12} className="mr-1" /> 草稿</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="relative flex-1 w-full max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input 
            type="text" 
            placeholder="搜尋文案標題或廠商..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white rounded-xl border border-black/5 focus:ring-2 focus:ring-[#5A5A40] outline-none"
          />
        </div>
        <div className="flex space-x-2">
          <button 
            onClick={exportToExcel}
            className="bg-white text-gray-600 px-4 py-2 rounded-xl flex items-center shadow-sm border border-black/5 hover:bg-gray-50 transition-all whitespace-nowrap"
          >
            <Download size={20} className="mr-2" /> 匯出 Excel
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
                type: '專業',
                clientConfirmed: false,
                internalConfirmed: false,
                platforms: ['IG'],
                postUrl: ''
              });
              setIsModalOpen(true);
            }}
            className="bg-[#5A5A40] text-white px-6 py-2 rounded-xl flex items-center shadow-lg hover:bg-[#4a4a35] transition-all whitespace-nowrap"
          >
            <Plus size={20} className="mr-2" /> 新增貼文
          </button>
        </div>
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
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#F5F5F0] border-b border-black/5">
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">發布社群</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">內容類型</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">發布狀態</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">發布時間</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">貼文位置</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">文案標題 / 內容</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">類型</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center">客戶確認</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center">內部檢核</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {filteredPosts.map((post) => {
                const vendor = vendors.find(v => v.id === post.vendorId);
                const isLate = post.status !== 'scheduled' && post.status !== 'published' && !isPast(addDays(parseISO(post.scheduledAt), -2));
                
                return (
                  <tr key={post.id} className="hover:bg-gray-50 transition-colors">
                    <td className="p-4">
                      <div className="flex flex-wrap gap-1">
                        {post.platforms.map(p => (
                          <span key={p} className="bg-gray-200 text-[10px] px-1.5 py-0.5 rounded font-bold">{p}</span>
                        ))}
                      </div>
                      <div className="text-xs text-gray-400 mt-1 truncate max-w-[100px]">{vendor?.name}</div>
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
                      <div className="relative group/status">
                        {getStatusBadge(post.status)}
                        <div className="absolute top-full left-0 mt-1 bg-white shadow-xl rounded-lg border border-black/5 hidden group-hover/status:block z-20">
                          {(['draft', 'scheduled', 'published'] as PostStatus[]).map(s => (
                            <button 
                              key={s}
                              onClick={() => toggleStatus(post, s)}
                              className="block w-full text-left px-4 py-2 text-xs hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg"
                            >
                              {s === 'draft' ? '草稿' : s === 'scheduled' ? '已排程' : '已發布'}
                            </button>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="text-sm font-medium">{format(parseISO(post.scheduledAt), 'MM/dd')}</div>
                      <div className="text-xs text-gray-400">{format(parseISO(post.scheduledAt), 'HH:mm')}</div>
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
                    <td className="p-4">
                      <span className="bg-[#5A5A40]/10 text-[#5A5A40] px-2 py-1 rounded text-xs font-medium">{post.type}</span>
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
                      <div className="flex space-x-2">
                        <button 
                          onClick={() => {
                            setEditingPost(post);
                            setFormData(post);
                            setIsModalOpen(true);
                          }}
                          className="p-1.5 text-blue-500 hover:bg-blue-50 rounded"
                        >
                          <FileEdit size={16} />
                        </button>
                        <button 
                          onClick={async () => {
                            if (confirm('確定刪除？')) {
                              await deleteDoc(doc(db, 'posts', post.id!));
                              toast.success('已刪除');
                            }
                          }}
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                        >
                          <MoreVertical size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

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
                      onChange={(e) => setFormData({ ...formData, vendorId: e.target.value })}
                      className="w-full p-2 bg-[#F5F5F0] rounded-xl border-none"
                    >
                      <option value="">請選擇廠商</option>
                      {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      選擇{formData.contentType === 'video' ? '影片' : '貼文'}素材 (庫存)
                    </label>
                    <select 
                      value={formData.assetId || ''}
                      onChange={(e) => {
                        const aid = e.target.value;
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
                      {assets
                        .filter(a => 
                          a.vendorId === formData.vendorId && 
                          a.type === formData.contentType &&
                          (a.status === 'available' || a.id === formData.assetId)
                        )
                        .map(a => (
                          <option key={a.id} value={a.id}>
                            [{a.category || '未分類'}] {a.title} {a.status === 'used' ? '(已使用)' : ''} {!a.approved ? '(待審核)' : ''}
                          </option>
                        ))
                      }
                    </select>
                    {assets.filter(a => a.vendorId === formData.vendorId && a.type === formData.contentType && a.status === 'available').length === 0 && (
                      <p className="text-[10px] text-red-500 mt-1 font-bold">⚠️ 此廠商目前無可用{formData.contentType === 'video' ? '影片' : '貼文'}素材，請先至資料庫上架</p>
                    )}
                  </div>
                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="block text-sm font-medium text-gray-700">預計發布時間</label>
                      <div className="flex gap-1">
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
                      required
                      value={formData.scheduledAt}
                      onChange={(e) => setFormData({ ...formData, scheduledAt: e.target.value })}
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
