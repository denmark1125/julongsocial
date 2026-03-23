import React, { useState, useEffect } from 'react';
import { 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  deleteDoc, 
  doc,
  updateDoc
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Asset, Vendor, OperationType, FirestoreErrorInfo, AssetType, Post } from '../types';
import { 
  Video, 
  Plus, 
  Trash2, 
  ExternalLink, 
  Search,
  Filter,
  CheckCircle2,
  Clock,
  FileText,
  LayoutGrid,
  Box,
  Download,
  BarChart3,
  Calendar
} from 'lucide-react';
import { toJpeg } from 'html-to-image';
import download from 'downloadjs';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import toast from 'react-hot-toast';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  toast.error(`操作失敗: ${errInfo.error}`);
};

export default function AssetDatabase() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterVendor, setFilterVendor] = useState('all');
  const [filterStatus, setFilterStatus] = useState('available');
  const [activeTab, setActiveTab] = useState<AssetType>('video');

  const summaryRef = React.useRef<HTMLDivElement>(null);

  const [newAsset, setNewAsset] = useState({
    title: '',
    url: '',
    vendorId: '',
    category: '',
    type: 'video' as AssetType
  });

  const defaultCategories = ['宣傳', '教學', '生活', '活動', '訪談', '開箱', '圖文', '資訊'];

  useEffect(() => {
    const vUnsubscribe = onSnapshot(collection(db, 'vendors'), (snapshot) => {
      setVendors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Vendor)));
    });

    const pUnsubscribe = onSnapshot(collection(db, 'posts'), (snapshot) => {
      setPosts(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Post)));
    });

    const q = query(collection(db, 'assets'), orderBy('createdAt', 'desc'));
    const aUnsubscribe = onSnapshot(q, (snapshot) => {
      setAssets(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Asset)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'assets');
    });

    return () => {
      vUnsubscribe();
      pUnsubscribe();
      aUnsubscribe();
    };
  }, []);

  const handleAddAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAsset.title || !newAsset.vendorId) {
      toast.error('請填寫標題與廠商');
      return;
    }

    try {
      await addDoc(collection(db, 'assets'), {
        ...newAsset,
        url: newAsset.url || '',
        category: newAsset.category || '未分類',
        status: 'available',
        approved: false,
        createdAt: new Date().toISOString(),
        createdBy: auth.currentUser?.uid
      });
      toast.success('素材已上架');
      setNewAsset({ title: '', url: '', vendorId: '', category: '', type: activeTab });
      setIsAdding(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'assets');
    }
  };

  const toggleApproval = async (asset: Asset) => {
    try {
      await updateDoc(doc(db, 'assets', asset.id!), { approved: !asset.approved });
      toast.success(asset.approved ? '已取消審核' : '已通過審核');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${asset.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('確定要刪除此素材嗎？')) return;
    try {
      await deleteDoc(doc(db, 'assets', id));
      toast.success('已刪除');
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `assets/${id}`);
    }
  };

  const filteredAssets = assets.filter(a => {
    const matchesTab = a.type === activeTab;
    const matchesSearch = a.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesVendor = filterVendor === 'all' || a.vendorId === filterVendor;
    const matchesStatus = filterStatus === 'all' || a.status === filterStatus;
    return matchesTab && matchesSearch && matchesVendor && matchesStatus;
  });

  const getVendorName = (id: string) => vendors.find(v => v.id === id)?.name || '未知廠商';

  const videoInventory = assets.filter(a => a.type === 'video' && a.status === 'available').length;
  const postInventory = assets.filter(a => a.type === 'post' && a.status === 'available').length;

  const scheduledVideoInventory = assets.filter(a => {
    if (a.type !== 'video' || a.status !== 'used' || !a.usedInPostId) return false;
    const post = posts.find(p => p.id === a.usedInPostId);
    return post && (post.status === 'draft' || post.status === 'scheduled');
  }).length;

  const scheduledPostInventory = assets.filter(a => {
    if (a.type !== 'post' || a.status !== 'used' || !a.usedInPostId) return false;
    const post = posts.find(p => p.id === a.usedInPostId);
    return post && (post.status === 'draft' || post.status === 'scheduled');
  }).length;

  const vendorStocks = vendors.map(vendor => {
    const availableVideos = assets.filter(a => a.vendorId === vendor.id && a.type === 'video' && a.status === 'available').length;
    const availablePosts = assets.filter(a => a.vendorId === vendor.id && a.type === 'post' && a.status === 'available').length;
    
    const scheduledVideos = assets.filter(a => {
      if (a.vendorId !== vendor.id || a.type !== 'video' || a.status !== 'used' || !a.usedInPostId) return false;
      const post = posts.find(p => p.id === a.usedInPostId);
      return post && (post.status === 'draft' || post.status === 'scheduled');
    }).length;

    const scheduledPosts = assets.filter(a => {
      if (a.vendorId !== vendor.id || a.type !== 'post' || a.status !== 'used' || !a.usedInPostId) return false;
      const post = posts.find(p => p.id === a.usedInPostId);
      return post && (post.status === 'draft' || post.status === 'scheduled');
    }).length;

    return {
      name: vendor.name,
      videos: availableVideos,
      posts: availablePosts,
      scheduledVideos,
      scheduledPosts
    };
  }).sort((a, b) => (b.videos + b.posts + b.scheduledVideos + b.scheduledPosts) - (a.videos + a.posts + a.scheduledVideos + a.scheduledPosts));

  const handleExportJPG = async () => {
    if (!summaryRef.current) return;
    setIsExporting(true);
    try {
      const dataUrl = await toJpeg(summaryRef.current, { quality: 0.95, backgroundColor: '#F5F5F0' });
      download(dataUrl, `素材庫存報表_${new Date().toLocaleDateString()}.jpg`);
      toast.success('報表已匯出');
    } catch (err) {
      console.error('Export failed', err);
      toast.error('匯出失敗');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">素材資料庫</h2>
          <p className="text-sm text-gray-500">管理各廠商的影片與貼文素材庫存</p>
        </div>
        <div className="flex flex-wrap gap-4 w-full sm:w-auto">
          <button 
            onClick={() => setIsSummaryOpen(true)}
            className="bg-white text-[#5A5A40] px-4 py-2 rounded-2xl border border-black/5 shadow-sm font-bold flex items-center space-x-2 hover:bg-gray-50 transition-colors"
          >
            <BarChart3 size={18} />
            <span>庫存總覽</span>
          </button>
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm flex items-center space-x-3">
            <div className="bg-amber-50 p-2 rounded-lg text-amber-600">
              <Clock size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">待審核</p>
              <p className="text-lg font-bold leading-none">{assets.filter(a => !a.approved).length} <span className="text-xs font-normal text-gray-400">件</span></p>
            </div>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm flex items-center space-x-3">
            <div className="bg-blue-50 p-2 rounded-lg text-blue-600">
              <Video size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">可用影片</p>
              <p className="text-lg font-bold leading-none">{videoInventory} <span className="text-xs font-normal text-gray-400">隻</span></p>
            </div>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm flex items-center space-x-3">
            <div className="bg-purple-50 p-2 rounded-lg text-purple-600">
              <FileText size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">可用貼文</p>
              <p className="text-lg font-bold leading-none">{postInventory} <span className="text-xs font-normal text-gray-400">篇</span></p>
            </div>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm flex items-center space-x-3">
            <div className="bg-orange-50 p-2 rounded-lg text-orange-600">
              <Clock size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">已排程影片</p>
              <p className="text-lg font-bold leading-none">{scheduledVideoInventory} <span className="text-xs font-normal text-gray-400">隻</span></p>
            </div>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm flex items-center space-x-3">
            <div className="bg-amber-50 p-2 rounded-lg text-amber-600">
              <Clock size={18} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">已排程貼文</p>
              <p className="text-lg font-bold leading-none">{scheduledPostInventory} <span className="text-xs font-normal text-gray-400">篇</span></p>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 bg-white p-1 rounded-2xl border border-black/5 w-fit shadow-sm">
        <button 
          onClick={() => setActiveTab('video')}
          className={`flex items-center space-x-2 px-6 py-2 rounded-xl text-sm font-bold transition-all ${
            activeTab === 'video' ? 'bg-[#5A5A40] text-white shadow-md' : 'text-gray-500 hover:bg-gray-50'
          }`}
        >
          <Video size={16} />
          <span>短素材 (影片)</span>
        </button>
        <button 
          onClick={() => setActiveTab('post')}
          className={`flex items-center space-x-2 px-6 py-2 rounded-xl text-sm font-bold transition-all ${
            activeTab === 'post' ? 'bg-[#5A5A40] text-white shadow-md' : 'text-gray-500 hover:bg-gray-50'
          }`}
        >
          <FileText size={16} />
          <span>貼文素材</span>
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Left Sidebar: Vendor Stock Overview */}
        <div className="lg:w-72 flex-shrink-0 space-y-4">
          <div className="bg-white rounded-[32px] border border-black/5 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-black/5 bg-[#F5F5F0]/30">
              <h3 className="font-bold serif text-[#5A5A40] flex items-center">
                <Box size={18} className="mr-2" />
                廠商庫存快檢
              </h3>
            </div>
            <div className="p-2 max-h-[600px] overflow-y-auto no-scrollbar">
              <button
                onClick={() => setFilterVendor('all')}
                className={cn(
                  "w-full flex items-center justify-between p-4 rounded-2xl transition-all text-left mb-1",
                  filterVendor === 'all' ? "bg-[#5A5A40] text-white shadow-md" : "hover:bg-gray-50 text-gray-600"
                )}
              >
                <span className="font-bold text-sm">所有廠商</span>
                <span className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full font-bold",
                  filterVendor === 'all' ? "bg-white/20" : "bg-gray-100"
                )}>
                  {assets.filter(a => a.type === activeTab && a.status === 'available').length}
                </span>
              </button>
              {vendors.map(vendor => {
                const count = assets.filter(a => a.vendorId === vendor.id && a.type === activeTab && a.status === 'available').length;
                const pendingCount = assets.filter(a => a.vendorId === vendor.id && a.type === activeTab && !a.approved).length;
                
                return (
                  <button
                    key={vendor.id}
                    onClick={() => setFilterVendor(vendor.id)}
                    className={cn(
                      "w-full flex flex-col p-4 rounded-2xl transition-all text-left mb-1 group",
                      filterVendor === vendor.id ? "bg-[#5A5A40] text-white shadow-md" : "hover:bg-gray-50 text-gray-600"
                    )}
                  >
                    <div className="flex items-center justify-between w-full mb-1">
                      <span className="font-bold text-sm truncate flex-1 mr-2">{vendor.name}</span>
                      <span className={cn(
                        "text-[10px] px-2 py-0.5 rounded-full font-bold",
                        filterVendor === vendor.id ? "bg-white/20" : "bg-gray-100",
                        count === 0 && filterVendor !== vendor.id && "text-red-400"
                      )}>
                        {count}
                      </span>
                    </div>
                    {pendingCount > 0 && (
                      <span className={cn(
                        "text-[9px] font-medium opacity-70",
                        filterVendor === vendor.id ? "text-white/80" : "text-amber-600"
                      )}>
                        • {pendingCount} 件待審核
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="bg-amber-50 rounded-2xl p-4 border border-amber-100">
            <p className="text-[10px] font-bold text-amber-700 uppercase tracking-widest mb-2 flex items-center">
              <Clock size={12} className="mr-1" /> 待處理提醒
            </p>
            <p className="text-xs text-amber-800 leading-relaxed">
              目前共有 <span className="font-bold">{assets.filter(a => !a.approved).length}</span> 件素材尚未通過審核，請儘速確認以利排程。
            </p>
          </div>
        </div>

        {/* Right Content: Asset Grid */}
        <div className="flex-1 space-y-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex-1 w-full relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input 
                type="text"
                placeholder={`搜尋${activeTab === 'video' ? '影片' : '貼文'}標題...`}
                className="w-full pl-10 pr-4 py-2 bg-white rounded-xl border border-black/5 focus:ring-2 focus:ring-[#5A5A40] shadow-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 w-full md:w-auto">
              <div className="flex items-center bg-white rounded-xl border border-black/5 p-1 shadow-sm">
                <button
                  onClick={() => setFilterStatus('available')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                    filterStatus === 'available' ? "bg-[#5A5A40] text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                  )}
                >
                  可使用
                </button>
                <button
                  onClick={() => setFilterStatus('used')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                    filterStatus === 'used' ? "bg-[#5A5A40] text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                  )}
                >
                  已使用
                </button>
                <button
                  onClick={() => setFilterStatus('all')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                    filterStatus === 'all' ? "bg-[#5A5A40] text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                  )}
                >
                  全部
                </button>
              </div>
              <button 
                onClick={() => {
                  setNewAsset({ ...newAsset, type: activeTab });
                  setIsAdding(true);
                }}
                className="flex-1 md:flex-none bg-[#5A5A40] text-white px-6 py-2 rounded-xl font-bold shadow-lg hover:bg-[#4a4a35] transition-all flex items-center justify-center space-x-2 whitespace-nowrap"
              >
                <Plus size={20} />
                <span>上架素材</span>
              </button>
            </div>
          </div>

          {/* Asset Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {filteredAssets.map((asset) => (
          <div 
            key={asset.id} 
            className={cn(
              "bg-white rounded-[32px] overflow-hidden border border-black/5 shadow-sm transition-all group",
              asset.status === 'used' 
                ? "opacity-50 scale-[0.96] grayscale-[0.5] hover:opacity-80" 
                : "hover:shadow-md hover:scale-[1.01]"
            )}
          >
            <div className={cn(
              "bg-[#F5F5F0] relative flex items-center justify-center overflow-hidden transition-all",
              asset.status === 'used' ? "aspect-[21/9]" : "aspect-video"
            )}>
              {asset.type === 'video' ? (
                <Video size={asset.status === 'used' ? 32 : 48} className="text-[#5A5A40] opacity-20" />
              ) : (
                <FileText size={asset.status === 'used' ? 32 : 48} className="text-[#5A5A40] opacity-20" />
              )}
              {asset.url && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <a 
                    href={asset.url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className={cn(
                      "bg-white text-[#5A5A40] rounded-full hover:scale-110 transition-transform",
                      asset.status === 'used' ? "p-2" : "p-3"
                    )}
                  >
                    <ExternalLink size={asset.status === 'used' ? 18 : 24} />
                  </a>
                </div>
              )}
              <div className="absolute top-4 left-4">
                <span className={cn(
                  "px-3 py-1 rounded-full text-[10px] font-bold text-white uppercase tracking-wider",
                  asset.status === 'used' ? "bg-gray-400" : "bg-[#5A5A40]"
                )}>
                  {asset.category || '未分類'}
                </span>
              </div>
              <div className="absolute top-4 right-4">
                <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                  asset.status === 'available' ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'
                }`}>
                  {asset.status === 'available' ? '可使用' : '已使用'}
                </span>
              </div>
            </div>
            <div className={cn("p-6 space-y-4", asset.status === 'used' && "py-3")}>
              <div>
                <p className="text-[10px] font-bold text-[#5A5A40] uppercase tracking-widest mb-1">
                  {getVendorName(asset.vendorId)}
                </p>
                <h4 className={cn(
                  "font-bold leading-tight line-clamp-2",
                  asset.status === 'used' ? "text-sm text-gray-500" : "text-lg"
                )}>{asset.title}</h4>
              </div>
              <div className="flex items-center justify-between pt-4 border-t border-black/5">
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => toggleApproval(asset)}
                    className={cn(
                      "px-3 py-1 rounded-lg text-[10px] font-bold transition-colors",
                      asset.approved ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"
                    )}
                  >
                    {asset.approved ? '已審核' : '待審核'}
                  </button>
                  <span className="text-[10px] text-gray-400">{new Date(asset.createdAt).toLocaleDateString()}</span>
                </div>
                <button 
                  onClick={() => handleDelete(asset.id!)}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={asset.status === 'used' ? 14 : 18} />
                </button>
              </div>
            </div>
          </div>
        ))}
        {filteredAssets.length === 0 && (
          <div className="col-span-full py-20 text-center space-y-4 bg-white rounded-[40px] border border-dashed border-gray-200">
            <Box size={48} className="mx-auto text-gray-300" />
            <p className="text-gray-500">尚無{activeTab === 'video' ? '短素材' : '貼文素材'}</p>
          </div>
        )}
      </div>
    </div>
  </div>

      {/* Add Asset Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[40px] w-full max-w-lg p-8 space-y-6 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="text-2xl font-bold serif text-[#5A5A40]">上架新{activeTab === 'video' ? '短素材' : '貼文素材'}</h3>
              <button onClick={() => setIsAdding(false)} className="p-2 hover:bg-gray-100 rounded-full">
                <Plus size={24} className="rotate-45" />
              </button>
            </div>

            <form onSubmit={handleAddAsset} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">標題</label>
                <input 
                  type="text"
                  required
                  className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                  placeholder="例如：2024 夏季新品宣傳片 A"
                  value={newAsset.title}
                  onChange={(e) => setNewAsset({...newAsset, title: e.target.value})}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">所屬廠商</label>
                <select 
                  required
                  className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                  value={newAsset.vendorId}
                  onChange={(e) => setNewAsset({...newAsset, vendorId: e.target.value})}
                >
                  <option value="">選擇廠商</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">分類</label>
                <div className="relative">
                  <input 
                    type="text"
                    list="asset-categories"
                    className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="輸入或選擇類型..."
                    value={newAsset.category}
                    onChange={(e) => setNewAsset({...newAsset, category: e.target.value})}
                  />
                  <datalist id="asset-categories">
                    {defaultCategories.map(t => <option key={t} value={t} />)}
                  </datalist>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">素材連結 (雲端網址，選填)</label>
                <input 
                  type="url"
                  className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                  placeholder="https://..."
                  value={newAsset.url}
                  onChange={(e) => setNewAsset({...newAsset, url: e.target.value})}
                />
              </div>

              <div className="pt-4 flex space-x-3">
                <button 
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="flex-1 py-4 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
                >
                  取消
                </button>
                <button 
                  type="submit"
                  className="flex-1 bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-xl hover:bg-[#4a4a35] transition-all"
                >
                  確認上架
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock Summary Modal */}
      {isSummaryOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[40px] w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-8 border-b border-black/5 flex justify-between items-center bg-white sticky top-0 z-10">
              <div className="flex items-center space-x-3">
                <div className="bg-[#5A5A40] p-2 rounded-xl text-white">
                  <BarChart3 size={20} />
                </div>
                <h3 className="text-2xl font-bold serif text-[#5A5A40]">個別 IP 素材庫存總覽</h3>
              </div>
              <button onClick={() => setIsSummaryOpen(false)} className="p-2 hover:bg-gray-100 rounded-full">
                <Plus size={24} className="rotate-45" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-8 bg-[#F5F5F0]/30">
              <div ref={summaryRef} className="bg-white p-10 rounded-[32px] shadow-sm border border-black/5 space-y-8">
                <div className="flex justify-between items-end border-b border-black/5 pb-6">
                  <div>
                    <h1 className="text-3xl font-black serif text-[#1a1a1a] mb-1">聚浪 Julong Agency</h1>
                    <p className="text-gray-500 font-bold tracking-widest uppercase text-sm">素材庫存即時報表</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">導出日期</p>
                    <p className="text-lg font-bold serif flex items-center justify-end">
                      <Calendar size={16} className="mr-2 text-[#5A5A40]" />
                      {new Date().toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-blue-50/50 p-5 rounded-3xl border border-blue-100 flex flex-col justify-between h-32 shadow-sm">
                    <div className="bg-blue-100 p-2.5 rounded-xl text-blue-600 w-fit">
                      <Video size={20} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-1">總可用影片</p>
                      <p className="text-3xl font-black text-blue-900 leading-none">{videoInventory} <span className="text-xs font-normal opacity-40">隻</span></p>
                    </div>
                  </div>
                  <div className="bg-purple-50/50 p-5 rounded-3xl border border-purple-100 flex flex-col justify-between h-32 shadow-sm">
                    <div className="bg-purple-100 p-2.5 rounded-xl text-purple-600 w-fit">
                      <FileText size={20} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-purple-400 uppercase tracking-widest mb-1">總可用貼文</p>
                      <p className="text-3xl font-black text-purple-900 leading-none">{postInventory} <span className="text-xs font-normal opacity-40">篇</span></p>
                    </div>
                  </div>
                  <div className="bg-orange-50/50 p-5 rounded-3xl border border-orange-100 flex flex-col justify-between h-32 shadow-sm">
                    <div className="bg-orange-100 p-2.5 rounded-xl text-orange-600 w-fit">
                      <Clock size={20} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-orange-400 uppercase tracking-widest mb-1">總排程影片</p>
                      <p className="text-3xl font-black text-orange-900 leading-none">{scheduledVideoInventory} <span className="text-xs font-normal opacity-40">隻</span></p>
                    </div>
                  </div>
                  <div className="bg-amber-50/50 p-5 rounded-3xl border border-amber-100 flex flex-col justify-between h-32 shadow-sm">
                    <div className="bg-amber-100 p-2.5 rounded-xl text-amber-600 w-fit">
                      <Clock size={20} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-amber-400 uppercase tracking-widest mb-1">總排程貼文</p>
                      <p className="text-3xl font-black text-amber-900 leading-none">{scheduledPostInventory} <span className="text-xs font-normal opacity-40">篇</span></p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="grid grid-cols-12 px-4 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                    <div className="col-span-3">廠商名稱 (IP)</div>
                    <div className="col-span-2 text-center">可用影片</div>
                    <div className="col-span-2 text-center">可用貼文</div>
                    <div className="col-span-2 text-center">排程影片</div>
                    <div className="col-span-2 text-center">排程貼文</div>
                    <div className="col-span-1 text-right">總計</div>
                  </div>
                  {vendorStocks.map((stock, idx) => (
                    <div key={idx} className="grid grid-cols-12 items-center px-4 py-4 bg-[#F5F5F0]/50 rounded-2xl border border-black/5">
                      <div className="col-span-3 font-bold text-gray-800 truncate pr-2">{stock.name}</div>
                      <div className="col-span-2 text-center">
                        <span className={cn(
                          "px-2 py-1 rounded-full text-[11px] font-bold",
                          stock.videos < 2 ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
                        )}>
                          {stock.videos}
                        </span>
                      </div>
                      <div className="col-span-2 text-center">
                        <span className="px-2 py-1 rounded-full bg-purple-100 text-purple-700 text-[11px] font-bold">
                          {stock.posts}
                        </span>
                      </div>
                      <div className="col-span-2 text-center">
                        <span className="px-2 py-1 rounded-full bg-orange-100 text-orange-700 text-[11px] font-bold">
                          {stock.scheduledVideos}
                        </span>
                      </div>
                      <div className="col-span-2 text-center">
                        <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">
                          {stock.scheduledPosts}
                        </span>
                      </div>
                      <div className="col-span-1 text-right font-black text-gray-900 text-sm">
                        {stock.videos + stock.posts + stock.scheduledVideos + stock.scheduledPosts}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="pt-6 border-t border-black/5 text-center">
                  <p className="text-[10px] text-gray-400 italic">此報表由 Julong 社群排程系統自動生成</p>
                </div>
              </div>
            </div>

            <div className="p-8 bg-white border-t border-black/5 flex space-x-4">
              <button 
                onClick={() => setIsSummaryOpen(false)}
                className="flex-1 py-4 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
              >
                關閉
              </button>
              <button 
                onClick={handleExportJPG}
                disabled={isExporting}
                className="flex-1 bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-xl hover:bg-[#4a4a35] transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
              >
                {isExporting ? (
                  <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>
                ) : (
                  <>
                    <Download size={20} />
                    <span>匯出 JPG 報表</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
