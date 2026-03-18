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
import { Asset, Vendor, OperationType, FirestoreErrorInfo, AssetType } from '../types';
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
  Box
} from 'lucide-react';
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
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterVendor, setFilterVendor] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [activeTab, setActiveTab] = useState<AssetType>('video');

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

    const q = query(collection(db, 'assets'), orderBy('createdAt', 'desc'));
    const aUnsubscribe = onSnapshot(q, (snapshot) => {
      setAssets(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Asset)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'assets');
    });

    return () => {
      vUnsubscribe();
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">素材資料庫</h2>
          <p className="text-sm text-gray-500">管理各廠商的影片與貼文素材素材與庫存</p>
        </div>
        <div className="flex space-x-4">
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

      <div className="flex justify-between items-center">
        <div className="flex-1 max-w-md relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input 
            type="text"
            placeholder={`搜尋${activeTab === 'video' ? '影片' : '貼文'}標題...`}
            className="w-full pl-10 pr-4 py-2 bg-white rounded-xl border border-black/5 focus:ring-2 focus:ring-[#5A5A40] shadow-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <Filter size={18} className="text-gray-400" />
            <select 
              className="bg-white rounded-xl border border-black/5 py-2 px-4 text-sm focus:ring-2 focus:ring-[#5A5A40] shadow-sm"
              value={filterVendor}
              onChange={(e) => setFilterVendor(e.target.value)}
            >
              <option value="all">所有廠商</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <select 
              className="bg-white rounded-xl border border-black/5 py-2 px-4 text-sm focus:ring-2 focus:ring-[#5A5A40] shadow-sm"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="all">所有狀態</option>
              <option value="available">可使用</option>
              <option value="used">已使用</option>
            </select>
          </div>
          <button 
            onClick={() => {
              setNewAsset({ ...newAsset, type: activeTab });
              setIsAdding(true);
            }}
            className="bg-[#5A5A40] text-white px-6 py-2 rounded-xl font-bold shadow-lg hover:bg-[#4a4a35] transition-all flex items-center space-x-2"
          >
            <Plus size={20} />
            <span>上架新{activeTab === 'video' ? '短素材' : '貼文'}</span>
          </button>
        </div>
      </div>

      {/* Asset Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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
    </div>
  );
}
