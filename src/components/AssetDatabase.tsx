import React, { useState, useEffect } from 'react';
import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  deleteDoc,
  doc,
  updateDoc,
  where,
  getDocs
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Asset, Vendor, OperationType, FirestoreErrorInfo, AssetType, Post, Editor, ShootBooking, UserProfile } from '../types';
import { visibleVendors, trackedVendors, buildPostIndex, getDisplayAssetStatus } from '../lib/vendorStatus';
import { buildFlowUpdate } from '../lib/assetFlow';
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
  Calendar,
  X,
  ArrowLeftRight,
  ClipboardList,
  Users,
  Archive,
  Ban,
  RotateCcw
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
  // 強制刪除只開給工程師，所以這頁要知道自己是誰（比照 ShootBookings 的做法）
  const [me, setMe] = useState<UserProfile | null>(null);
  // 顯示/篩選/計數一律走「實際狀態」而不是 asset.status：貼文被刪掉的素材資料上還留著 used，
  // 直接讀 status 會讓它永遠掛著已使用的灰底、篩選也撈不到，使用者眼中那支片就等於報廢了。
  const postIndex = React.useMemo(() => buildPostIndex(posts), [posts]);
  const effStatus = (a: Pick<Asset, 'status' | 'usedInPostId'>) => getDisplayAssetStatus(a, postIndex);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  const [isTaskListOpen, setIsTaskListOpen] = useState(false);
  const [exportMode, setExportMode] = useState<'editor' | 'vendor'>('editor');
  const [selectedEditorId, setSelectedEditorId] = useState('');
  const [selectedVendorIdForExport, setSelectedVendorIdForExport] = useState('');
  const [includeRaw, setIncludeRaw] = useState(true);
  const [includeFinished, setIncludeFinished] = useState(false);
  const [taskNotes, setTaskNotes] = useState<Record<string, string>>({});
  const [isExporting, setIsExporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [vendorSearchTerm, setVendorSearchTerm] = useState('');
  const [filterVendor, setFilterVendor] = useState('all');
  const [filterStatus, setFilterStatus] = useState('available');
  const [filterStage, setFilterStage] = useState<'raw' | 'finished'>('finished');
  const [activeTab, setActiveTab] = useState<AssetType>('video');
  const [convertingAsset, setConvertingAsset] = useState<Asset | null>(null);
  const [conversionUrl, setConversionUrl] = useState('');

  const summaryRef = React.useRef<HTMLDivElement>(null);
  const taskListRef = React.useRef<HTMLDivElement>(null);

  const [newAsset, setNewAsset] = useState({
    title: '',
    url: '',
    vendorId: '',
    editorId: '',
    category: '',
    type: 'video' as AssetType,
    stage: 'raw' as 'raw' | 'finished',
    filmingDate: new Date().toISOString().split('T')[0]
  });

  const defaultCategories = ['宣傳', '教學', '生活', '活動', '訪談', '開箱', '圖文', '資訊'];

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    return onSnapshot(doc(db, 'users', uid), (snap) => {
      if (snap.exists()) setMe(snap.data() as UserProfile);
    });
  }, []);

  useEffect(() => {
    const vUnsubscribe = onSnapshot(collection(db, 'vendors'), (snapshot) => {
      setVendors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Vendor)));
    });

    const eUnsubscribe = onSnapshot(collection(db, 'editors'), (snapshot) => {
      setEditors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Editor)));
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

  // 藏鏡人上傳素材＝拍攝真的完成了；不能靠他們額外記得回「拍攝進度」頁按完成，
  // 直接在這裡自動核銷該廠商目前有效的預約，交件數跟著這批上傳累加。
  const autoResolveBooking = async (vendorId: string) => {
    const today = new Date().toISOString().split('T')[0];
    try {
      const bookedSnap = await getDocs(query(
        collection(db, 'shootBookings'),
        where('vendorId', '==', vendorId),
        where('status', '==', 'booked')
      ));
      if (!bookedSnap.empty) {
        await updateDoc(doc(db, 'shootBookings', bookedSnap.docs[0].id), {
          status: 'completed',
          deliveredCount: 1,
          resolvedAt: new Date().toISOString()
        });
        return;
      }
      const completedSnap = await getDocs(query(
        collection(db, 'shootBookings'),
        where('vendorId', '==', vendorId),
        where('status', '==', 'completed')
      ));
      const sameDay = completedSnap.docs.find(d => (d.data() as ShootBooking).resolvedAt?.startsWith(today));
      if (sameDay) {
        const cur = (sameDay.data() as ShootBooking).deliveredCount || 0;
        await updateDoc(doc(db, 'shootBookings', sameDay.id), { deliveredCount: cur + 1 });
      }
    } catch (error) {
      console.error('autoResolveBooking failed', error);
    }
  };

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
      if (newAsset.type === 'video') {
        await autoResolveBooking(newAsset.vendorId);
      }
      toast.success(newAsset.stage === 'raw' ? '原始素材已建檔' : '素材已上架');
      setNewAsset({ 
        title: '', 
        url: '', 
        vendorId: '', 
        category: '', 
        type: activeTab,
        stage: 'raw',
        filmingDate: new Date().toISOString().split('T')[0]
      });
      setIsAdding(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'assets');
    }
  };

  // 內部代為「轉為成片」（剪輯師沒登入時的後路；正常情況是剪輯師在自己後台按「轉成片」）。
  // 一律走 buildFlowUpdate，否則 stage/approved 會跟 flowStage 不一致，
  // 交棒看板就會顯示錯的「球在誰手上」。
  const handleConvert = async () => {
    if (!convertingAsset) return;
    try {
      await updateDoc(doc(db, 'assets', convertingAsset.id!), {
        ...buildFlowUpdate(convertingAsset, 'client_review', {
          byUid: auth.currentUser?.uid,
          note: '內部代為轉成片',
        }),
        url: conversionUrl || convertingAsset.url || '',
      });
      toast.success('已轉為成片，待業主審核');
      // 不推即時通知，交給每日 09:30 的彙總（見 server.ts buildFlowDigestMessage）
      setConvertingAsset(null);
      setConversionUrl('');
      setFilterStage('finished');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${convertingAsset.id}`);
    }
  };

  // 「已審核」＝業主過了且雲端也上傳好了，可以拿去排程（等同交棒鏈的 ready）。
  // 取消審核則退回「業主審核中」；要明確記錄業主意見請用製作進度看板的「要改」。
  const toggleApproval = async (asset: Asset) => {
    try {
      const to = asset.approved ? 'client_review' : 'ready';
      await updateDoc(
        doc(db, 'assets', asset.id!),
        buildFlowUpdate(asset, to, { byUid: auth.currentUser?.uid })
      );
      toast.success(asset.approved ? '已取消審核' : '已通過審核');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${asset.id}`);
    }
  };

  const toggleManualComplete = async (asset: Asset) => {
    try {
      // usedInPostId 一起清掉：不清的話會留下指向已刪貼文的懸空 id，
      // 之後又被 isAssetOrphaned 判成孤兒，狀態在兩邊來回跳
      if (asset.status === 'used') {
        await updateDoc(doc(db, 'assets', asset.id!), { status: 'available', usedInPostId: null });
        toast.success('已解鎖，重新可使用');
      } else {
        await updateDoc(doc(db, 'assets', asset.id!), { status: 'used', usedInPostId: null });
        toast.success('已標記完成');
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${asset.id}`);
    }
  };

  const toggleArchive = async (asset: Asset) => {
    try {
      const newStatus = asset.status === 'archived' ? 'available' : 'archived';
      await updateDoc(doc(db, 'assets', asset.id!), { status: newStatus });
      toast.success(newStatus === 'archived' ? '已移至封存' : '已還原素材');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${asset.id}`);
    }
  };

  // 作廢：處理「同一支片建了兩次」這種狀況。跟封存是兩回事——
  // 封存的片仍會進剪輯師的請款清單（isBillable 不看 status），所以封存**擋不住重複請款**；
  // 作廢才會從請款、庫存、排程選單、剪輯師工作台全部消失。
  const toggleVoid = async (asset: Asset) => {
    if (asset.voidedAt) {
      if (!window.confirm('要把這支素材復原嗎？復原後會重新回到庫存與請款清單。')) return;
      try {
        await updateDoc(doc(db, 'assets', asset.id!), { voidedAt: '', voidReason: '' });
        toast.success('已復原');
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `assets/${asset.id}`);
      }
      return;
    }
    if (asset.editorInvoiceId) {
      toast.error('這支已納入剪輯師請款單，不能作廢。');
      return;
    }
    const reason = window.prompt('作廢原因（例如：跟另一支重複、建錯了）', '重複建檔');
    if (reason === null) return;
    try {
      await updateDoc(doc(db, 'assets', asset.id!), {
        voidedAt: new Date().toISOString(),
        voidReason: reason.trim(),
      });
      toast.success('已作廢，不會列入請款與庫存');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `assets/${asset.id}`);
    }
  };

  const handleDelete = async (id: string) => {
    const target = assets.find(a => a.id === id);
    if (!target) return;

    // 已入請款單＝帳務凍結，任何角色都不給刪（規則也擋）
    if (target.editorInvoiceId) {
      toast.error('這支已納入剪輯師請款單，不能刪除。請改用「作廢」。');
      return;
    }

    // 貼文那頭也要顧：素材被刪掉但貼文還指著它，貼文會變成找不到關聯素材的孤兒
    // （大發已經有一則已發布的貼文是這樣壞掉的）。
    const boundPost = target.usedInPostId ? posts.find(p => p.id === target.usedInPostId) : undefined;
    if (boundPost && boundPost.status !== 'draft') {
      toast.error('這支已排程／已發布，刪掉會讓那則貼文找不到素材。請改用「作廢」。');
      return;
    }

    // 剪輯師已標記上傳雲端＝他可以據此請款，刪掉等於抹掉請款依據，規則也會擋。
    // 工程師可以強制刪除（多按一次、講清楚後果），其他人請改用作廢。
    let force = false;
    if (target.cloudUploadedAt) {
      if (me?.role !== 'engineer') {
        toast.error('剪輯師已標記上傳雲端，刪掉會抹掉他的請款依據。請改用「作廢」。');
        return;
      }
      if (!window.confirm(
        [
          '這支剪輯師已標記「上傳雲端」，可以據此請款。',
          '',
          '強制刪除會讓它從請款清單永久消失。確定要刪除嗎？',
          '（若只是想讓它不列入請款與庫存，請改用「作廢」，紀錄會留著）',
        ].join('\n')
      )) return;
      force = true;
    } else if (!window.confirm('確定要刪除此素材嗎？')) {
      return;
    }

    try {
      // 規則要求 cloudUploadedAt 為空才准刪，所以強制刪除得先解鎖。
      // 解鎖後若刪除失敗，一定要把時間戳寫回去，不能留下「已解鎖但沒刪掉」的半吊子狀態
      // ——那會讓這支片安靜地從剪輯師的請款依據裡消失。
      if (force) {
        await updateDoc(doc(db, 'assets', id), { cloudUploadedAt: '' });
      }
      try {
        await deleteDoc(doc(db, 'assets', id));
      } catch (delErr) {
        if (force) {
          await updateDoc(doc(db, 'assets', id), { cloudUploadedAt: target.cloudUploadedAt });
        }
        throw delErr;
      }
      // 掛在草稿貼文上的話，順手把貼文的關聯清掉，不然貼文會指向一個不存在的素材
      if (boundPost) {
        await updateDoc(doc(db, 'posts', boundPost.id!), { assetId: '' });
      }
      toast.success('已刪除');
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `assets/${id}`);
    }
  };

  const filteredAssets = assets.filter(a => {
    const matchesTab = a.type === activeTab;
    const matchesSearch = a.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesVendor = filterVendor === 'all' || a.vendorId === filterVendor;
    // 這條決定素材出不出現在「可使用／已使用」分頁，一定要用實際狀態——
    // 用 a.status 的話，貼文被刪掉的素材會卡在「已使用」分頁裡出不來，等於使用者永遠找不回它
    // 作廢的片只在「作廢」分頁出現，其餘分頁（含「全部」）一律不顯示，
    // 否則使用者會在可使用清單裡看到已經宣告不要的東西
    const voided = !!a.voidedAt;
    const matchesStatus = filterStatus === 'voided'
      ? voided
      : voided
        ? false
        : filterStatus === 'all'
          ? effStatus(a) !== 'archived'
          : effStatus(a) === filterStatus;
    const matchesStage = a.stage === filterStage || (!a.stage && filterStage === 'finished');
    return matchesTab && matchesSearch && matchesVendor && matchesStatus && matchesStage;
  });

  const getVendorName = (id: string) => vendors.find(v => v.id === id)?.name || '未知廠商';

  const videoInventory = assets.filter(a => a.type === 'video' && effStatus(a) === 'available' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length;
  const postInventory = assets.filter(a => a.type === 'post' && effStatus(a) === 'available' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length;

  const scheduledVideoInventory = assets.filter(a => {
    if (a.type !== 'video' || a.status !== 'used' || !a.usedInPostId) return false;
    if (a.stage !== filterStage && !(filterStage === 'finished' && !a.stage)) return false;
    const post = posts.find(p => p.id === a.usedInPostId);
    return post && (post.status === 'draft' || post.status === 'scheduled');
  }).length;

  const scheduledPostInventory = assets.filter(a => {
    if (a.type !== 'post' || a.status !== 'used' || !a.usedInPostId) return false;
    if (a.stage !== filterStage && !(filterStage === 'finished' && !a.stage)) return false;
    const post = posts.find(p => p.id === a.usedInPostId);
    return post && (post.status === 'draft' || post.status === 'scheduled');
  }).length;

  const vendorStocks = trackedVendors(vendors).map(vendor => {
    const availableVideos = assets.filter(a => a.vendorId === vendor.id && a.type === 'video' && effStatus(a) === 'available' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length;
    const availablePosts = assets.filter(a => a.vendorId === vendor.id && a.type === 'post' && effStatus(a) === 'available' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length;
    
    const scheduledVideos = assets.filter(a => {
      if (a.vendorId !== vendor.id || a.type !== 'video' || a.status !== 'used' || !a.usedInPostId) return false;
      if (a.stage !== filterStage && !(filterStage === 'finished' && !a.stage)) return false;
      const post = posts.find(p => p.id === a.usedInPostId);
      return post && (post.status === 'draft' || post.status === 'scheduled');
    }).length;

    const scheduledPosts = assets.filter(a => {
      if (a.vendorId !== vendor.id || a.type !== 'post' || a.status !== 'used' || !a.usedInPostId) return false;
      if (a.stage !== filterStage && !(filterStage === 'finished' && !a.stage)) return false;
      const post = posts.find(p => p.id === a.usedInPostId);
      return post && (post.status === 'draft' || post.status === 'scheduled');
    }).length;

    const hasVideos = vendor.cooperationItems?.includes('short_video');
    const hasPosts = vendor.cooperationItems?.includes('graphic_post');

    return {
      name: vendor.name,
      videos: availableVideos,
      posts: availablePosts,
      scheduledVideos,
      scheduledPosts,
      hasVideos,
      hasPosts
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

  const handleExportTaskJPG = async () => {
    if (!taskListRef.current) return;
    setIsExporting(true);
    try {
      const dataUrl = await toJpeg(taskListRef.current, { quality: 0.95, backgroundColor: '#F5F5F0' });
      let fileName = '';
      if (exportMode === 'editor') {
        const editorName = editors.find(e => e.id === selectedEditorId)?.name || '剪輯師';
        fileName = `${editorName}_剪輯工作紀錄表_${new Date().toLocaleDateString()}.jpg`;
      } else {
        const vendorName = vendors.find(v => v.id === selectedVendorIdForExport)?.name || '廠商';
        fileName = `${vendorName}_素材進度表_${new Date().toLocaleDateString()}.jpg`;
      }
      download(dataUrl, fileName);
      toast.success('報表已匯出');
    } catch (err) {
      console.error('Export failed', err);
      toast.error('匯出失敗');
    } finally {
      setIsExporting(false);
    }
  };

  const getEditorName = (id?: string) => editors.find(e => e.id === id)?.name || '未指定';

  const getEffectiveEditorId = (asset: Asset) => {
    if (asset.editorId) return asset.editorId;
    const vendor = vendors.find(v => v.id === asset.vendorId);
    return vendor?.editorId;
  };

  const getVendorHabits = (vendorId: string) => {
    const vendor = vendors.find(v => v.id === vendorId);
    if (!vendor || !vendor.postingHabits || vendor.postingHabits.length === 0) return '-';
    
    return vendor.postingHabits.map(habit => {
      const days = habit.daysOfWeek.map(d => ['日', '一', '二', '三', '四', '五', '六'][d]).join('、');
      return days;
    }).join(' | ');
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
            onClick={() => setIsTaskListOpen(true)}
            className="bg-white text-[#5A5A40] px-4 py-2 rounded-2xl border border-black/5 shadow-sm font-bold flex items-center space-x-2 hover:bg-gray-50 transition-colors"
          >
            <ClipboardList size={18} />
            <span>導出剪輯清單</span>
          </button>
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
              <p className="text-lg font-bold leading-none">{assets.filter(a => !a.approved && a.status !== 'archived').length} <span className="text-xs font-normal text-gray-400">件</span></p>
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
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
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

        <div className="flex space-x-1 bg-white p-1 rounded-2xl border border-black/5 w-fit shadow-sm">
          <button 
            onClick={() => {
              setFilterStage('raw');
              setFilterStatus('all');
            }}
            className={`px-6 py-2 rounded-xl text-sm font-bold transition-all ${
              filterStage === 'raw' ? 'bg-[#8B7355] text-white shadow-md' : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            原始素材 (Raw)
          </button>
          <button 
            onClick={() => {
              setFilterStage('finished');
              setFilterStatus('all');
            }}
            className={`px-6 py-2 rounded-xl text-sm font-bold transition-all ${
              filterStage === 'finished' ? 'bg-[#5A5A40] text-white shadow-md' : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            成片 (Finished)
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Left Sidebar: Vendor Stock Overview */}
        <div className="lg:w-72 flex-shrink-0 space-y-4">
          <div className="bg-white rounded-[32px] border border-black/5 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-black/5 bg-[#F5F5F0]/30 space-y-3">
              <h3 className="font-bold serif text-[#5A5A40] flex items-center">
                <Box size={18} className="mr-2" />
                廠商庫存快檢
              </h3>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                <input 
                  type="text"
                  placeholder="搜尋廠商..."
                  className="w-full pl-8 pr-3 py-1.5 bg-white rounded-xl border border-black/5 text-xs focus:ring-1 focus:ring-[#5A5A40]"
                  value={vendorSearchTerm}
                  onChange={(e) => setVendorSearchTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="p-2 max-h-[500px] overflow-y-auto no-scrollbar">
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
                  {assets.filter(a => a.type === activeTab && effStatus(a) === 'available' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length}
                </span>
              </button>
              {visibleVendors(vendors)
                .filter(v => v.name.toLowerCase().includes(vendorSearchTerm.toLowerCase()))
                .map(vendor => {
                const count = assets.filter(a => a.vendorId === vendor.id && a.type === activeTab && effStatus(a) === 'available' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length;
                const pendingCount = assets.filter(a => a.vendorId === vendor.id && a.type === activeTab && !a.approved && a.status !== 'archived' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length;
                
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
              目前共有 <span className="font-bold">{assets.filter(a => !a.approved && a.status !== 'archived' && (a.stage === filterStage || (!a.stage && filterStage === 'finished'))).length}</span> 件素材尚未通過審核，請儘速確認以利排程。
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
                {filterStage === 'finished' && (
                  <>
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
                  </>
                )}
                <button
                  onClick={() => setFilterStatus('voided')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                    filterStatus === 'voided' ? "bg-red-500 text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                  )}
                >
                  作廢
                </button>
                <button
                  onClick={() => setFilterStatus('archived')}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-bold transition-all",
                    filterStatus === 'archived' ? "bg-[#5A5A40] text-white shadow-sm" : "text-gray-500 hover:bg-gray-50"
                  )}
                >
                  回收站
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
                  setNewAsset({ 
                    ...newAsset, 
                    type: activeTab,
                    stage: filterStage 
                  });
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
              effStatus(asset) === 'used' 
                ? "opacity-50 scale-[0.96] grayscale-[0.5] hover:opacity-80" 
                : "hover:shadow-md hover:scale-[1.01]"
            )}
          >
            <div className={cn(
              "bg-[#F5F5F0] relative flex items-center justify-center overflow-hidden transition-all",
              effStatus(asset) === 'used' ? "aspect-[21/9]" : "aspect-video"
            )}>
              {asset.type === 'video' ? (
                <Video size={effStatus(asset) === 'used' ? 32 : 48} className="text-[#5A5A40] opacity-20" />
              ) : (
                <FileText size={effStatus(asset) === 'used' ? 32 : 48} className="text-[#5A5A40] opacity-20" />
              )}
              {asset.url && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <a 
                    href={asset.url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className={cn(
                      "bg-white text-[#5A5A40] rounded-full hover:scale-110 transition-transform",
                      effStatus(asset) === 'used' ? "p-2" : "p-3"
                    )}
                  >
                    <ExternalLink size={effStatus(asset) === 'used' ? 18 : 24} />
                  </a>
                </div>
              )}
              <div className="absolute top-4 left-4">
                <span className={cn(
                  "px-3 py-1 rounded-full text-[10px] font-bold text-white uppercase tracking-wider",
                  asset.stage === 'raw' ? "bg-[#8B7355]" : effStatus(asset) === 'used' ? "bg-gray-400" : "bg-[#5A5A40]"
                )}>
                  {asset.stage === 'raw' ? '原始素材' : (asset.category || '未分類')}
                </span>
              </div>
              <div className="absolute top-4 right-4">
                <span className={cn(
                  "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                  asset.stage === 'raw' ? "bg-[#8B7355]/10 text-[#8B7355] border border-[#8B7355]/20" : 
                  effStatus(asset) === 'available' ? "bg-[#8A8A6A]/10 text-[#8A8A6A] border border-[#8A8A6A]/20" : 
                  "bg-gray-100 text-gray-500 border border-gray-200"
                )}>
                  {asset.voidedAt ? '已作廢' : asset.stage === 'raw' ? '待剪輯' : effStatus(asset) === 'available' ? '可使用' : '已使用'}
                </span>
              </div>
            </div>
            <div className={cn("p-6 space-y-4", effStatus(asset) === 'used' && "py-3")}>
              <div>
                <div className="flex justify-between items-start mb-1">
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-bold text-[#5A5A40] uppercase tracking-widest">
                      {getVendorName(asset.vendorId)}
                    </p>
                    <div className="flex items-center space-x-1 text-[9px] font-bold text-gray-400">
                      <Users size={10} />
                      <span>{getEditorName(getEffectiveEditorId(asset))}</span>
                    </div>
                  </div>
                  {asset.filmingDate && (
                    <p className="text-[10px] font-medium text-gray-400">拍攝: {asset.filmingDate}</p>
                  )}
                </div>
                <h4 className={cn(
                  "font-bold leading-tight line-clamp-2",
                  effStatus(asset) === 'used' ? "text-sm text-gray-500" : "text-lg"
                )}>{asset.title}</h4>
              </div>
              <div className="flex items-center justify-between pt-4 border-t border-black/5">
                <div className="flex items-center space-x-2">
                  {asset.stage === 'raw' ? (
                    <button
                      onClick={() => setConvertingAsset(asset)}
                      className="bg-[#5A5A40] text-white px-3 py-1 rounded-lg text-[10px] font-bold hover:bg-[#4a4a35] transition-colors"
                    >
                      轉為成片
                    </button>
                  ) : (
                    <button
                      onClick={() => toggleApproval(asset)}
                      className={cn(
                        "px-3 py-1 rounded-lg text-[10px] font-bold transition-colors",
                        asset.approved ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"
                      )}
                    >
                      {asset.approved ? '已審核' : '待審核'}
                    </button>
                  )}
                  {asset.stage === 'finished' && (effStatus(asset) === 'available' || (effStatus(asset) === 'used' && !asset.usedInPostId)) && (
                    <button
                      onClick={() => toggleManualComplete(asset)}
                      title={effStatus(asset) === 'used' ? '取消完成，解鎖回可使用' : '標記完成（不排日期直接視為已使用）'}
                      className={cn(
                        "px-3 py-1 rounded-lg text-[10px] font-bold transition-colors flex items-center space-x-1",
                        effStatus(asset) === 'used' ? "bg-gray-200 text-gray-500" : "bg-[#5A5A40]/10 text-[#5A5A40]"
                      )}
                    >
                      <CheckCircle2 size={12} />
                      <span>{effStatus(asset) === 'used' ? '取消完成' : '完成'}</span>
                    </button>
                  )}
                  <span className="text-[10px] text-gray-400">{new Date(asset.createdAt).toLocaleDateString()}</span>
                  {asset.voidedAt && (
                    <span className="text-[10px] font-bold text-red-500">已作廢{asset.voidReason ? `・${asset.voidReason}` : ''}</span>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  {/* 作廢跟封存並排，但語意完全不同：封存＝暫時不用、仍可請款；作廢＝這支不該存在、不請款不算庫存 */}
                  <button
                    onClick={() => toggleVoid(asset)}
                    className={cn("transition-colors", asset.voidedAt ? "text-red-500 hover:text-green-600" : "text-gray-400 hover:text-red-500")}
                    title={asset.voidedAt ? '復原作廢' : '作廢（重複建檔／建錯，不列入請款與庫存）'}
                  >
                    <Ban size={effStatus(asset) === 'used' ? 14 : 18} />
                  </button>
                  <button 
                    onClick={() => toggleArchive(asset)}
                    className="text-gray-400 hover:text-[#5A5A40] transition-colors"
                    title={effStatus(asset) === 'archived' ? '還原素材' : '移至回收站'}
                  >
                    {effStatus(asset) === 'archived' ? <RotateCcw size={18} /> : <Archive size={18} />}
                  </button>
                  <button 
                    onClick={() => handleDelete(asset.id!)}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 size={effStatus(asset) === 'used' ? 14 : 18} />
                  </button>
                </div>
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
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-600 ml-1">素材階段</label>
                  <select 
                    className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    value={newAsset.stage}
                    onChange={(e) => setNewAsset({...newAsset, stage: e.target.value as 'raw' | 'finished'})}
                  >
                    <option value="raw">原始素材 (Raw)</option>
                    <option value="finished">成片 (Finished)</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-600 ml-1">拍攝日期</label>
                  <input 
                    type="date"
                    className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    value={newAsset.filmingDate}
                    onChange={(e) => setNewAsset({...newAsset, filmingDate: e.target.value})}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">標題 / 名稱</label>
                <input 
                  type="text"
                  required
                  className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                  placeholder="例如：2024 夏季新品拍攝素材"
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
                  onChange={(e) => {
                    const vendorId = e.target.value;
                    const vendor = vendors.find(v => v.id === vendorId);
                    setNewAsset({
                      ...newAsset, 
                      vendorId,
                      editorId: vendor?.editorId || ''
                    });
                  }}
                >
                  <option value="">選擇廠商</option>
                  {visibleVendors(vendors).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>

              {newAsset.editorId && (
                <div className="px-5 py-2 bg-[#5A5A40]/5 rounded-xl border border-[#5A5A40]/10 flex items-center justify-between">
                  <span className="text-xs font-bold text-[#5A5A40]">自動帶入剪輯師:</span>
                  <span className="text-xs font-bold text-[#5A5A40]">{getEditorName(newAsset.editorId)}</span>
                </div>
              )}

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

      {/* Convert to Finished Modal */}
      {convertingAsset && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[40px] w-full max-w-lg p-8 space-y-6 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="text-2xl font-bold serif text-[#5A5A40]">轉為成片</h3>
              <button onClick={() => setConvertingAsset(null)} className="p-2 hover:bg-gray-100 rounded-full">
                <Plus size={24} className="rotate-45" />
              </button>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-gray-500">將「{convertingAsset.title}」標記為剪輯完成，並轉入成片資料庫。</p>
              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">影片連結 (選填)</label>
                <input 
                  type="url"
                  className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                  placeholder="https://..."
                  value={conversionUrl}
                  onChange={(e) => setConversionUrl(e.target.value)}
                />
              </div>
              <div className="pt-4 flex space-x-3">
                <button 
                  onClick={() => setConvertingAsset(null)}
                  className="flex-1 py-4 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
                >
                  取消
                </button>
                <button 
                  onClick={handleConvert}
                  className="flex-1 bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-xl hover:bg-[#4a4a35] transition-all"
                >
                  確認轉換
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stock Summary Modal */}
      {isSummaryOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 md:p-4">
          <div className="bg-white rounded-[32px] md:rounded-[40px] w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col max-h-[95vh]">
            <div className="p-4 md:p-6 border-b border-black/5 flex justify-between items-center bg-white sticky top-0 z-10">
              <div className="flex items-center space-x-3">
                <div className="bg-[#5A5A40] p-2 rounded-xl text-white">
                  <BarChart3 size={20} />
                </div>
                <h3 className="text-lg md:text-xl font-bold serif text-[#5A5A40]">個別 IP 素材庫存總覽</h3>
              </div>
              <button onClick={() => setIsSummaryOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 md:p-6 bg-[#F5F5F0]/30">
              <div ref={summaryRef} className="bg-white p-3 md:p-8 rounded-[24px] md:rounded-[32px] shadow-sm border border-black/5 space-y-4 md:space-y-6">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end border-b border-black/5 pb-6 gap-4">
                  <div>
                    <h1 className="text-xl md:text-2xl font-black serif text-[#1a1a1a] mb-1">聚浪 Julong Agency</h1>
                    <p className="text-gray-500 font-bold tracking-widest uppercase text-[10px] md:text-xs">素材庫存即時報表</p>
                  </div>
                  <div className="text-left sm:text-right">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">導出日期</p>
                    <p className="text-sm md:text-base font-bold serif flex items-center sm:justify-end">
                      <Calendar size={14} className="mr-2 text-[#5A5A40]" />
                      {new Date().toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-4">
                  <div className="bg-blue-50/50 p-2.5 md:p-4 rounded-2xl md:rounded-3xl border border-blue-100 flex flex-col justify-between min-h-[70px] md:min-h-[100px] shadow-sm">
                    <div className="bg-blue-100 p-1.5 md:p-2 rounded-lg md:rounded-xl text-blue-600 w-fit">
                      <Video size={14} className="md:w-[18px] md:h-[18px]" />
                    </div>
                    <div>
                      <p className="text-[8px] md:text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-0.5">總可用影片</p>
                      <p className="text-base md:text-2xl font-black text-blue-900 leading-none">{videoInventory} <span className="text-[10px] font-normal opacity-40">隻</span></p>
                    </div>
                  </div>
                  <div className="bg-purple-50/50 p-2.5 md:p-4 rounded-2xl md:rounded-3xl border border-purple-100 flex flex-col justify-between min-h-[70px] md:min-h-[100px] shadow-sm">
                    <div className="bg-purple-100 p-1.5 md:p-2 rounded-lg md:rounded-xl text-purple-600 w-fit">
                      <FileText size={14} className="md:w-[18px] md:h-[18px]" />
                    </div>
                    <div>
                      <p className="text-[8px] md:text-[10px] font-bold text-purple-400 uppercase tracking-widest mb-0.5">總可用貼文</p>
                      <p className="text-base md:text-2xl font-black text-purple-900 leading-none">{postInventory} <span className="text-[10px] font-normal opacity-40">篇</span></p>
                    </div>
                  </div>
                  <div className="bg-orange-50/50 p-2.5 md:p-4 rounded-2xl md:rounded-3xl border border-orange-100 flex flex-col justify-between min-h-[70px] md:min-h-[100px] shadow-sm">
                    <div className="bg-orange-100 p-1.5 md:p-2 rounded-lg md:rounded-xl text-orange-600 w-fit">
                      <Clock size={14} className="md:w-[18px] md:h-[18px]" />
                    </div>
                    <div>
                      <p className="text-[8px] md:text-[10px] font-bold text-orange-400 uppercase tracking-widest mb-0.5">總排程影片</p>
                      <p className="text-base md:text-2xl font-black text-orange-900 leading-none">{scheduledVideoInventory} <span className="text-[10px] font-normal opacity-40">隻</span></p>
                    </div>
                  </div>
                  <div className="bg-amber-50/50 p-2.5 md:p-4 rounded-2xl md:rounded-3xl border border-amber-100 flex flex-col justify-between min-h-[70px] md:min-h-[100px] shadow-sm">
                    <div className="bg-amber-100 p-1.5 md:p-2 rounded-lg md:rounded-xl text-amber-600 w-fit">
                      <Clock size={14} className="md:w-[18px] md:h-[18px]" />
                    </div>
                    <div>
                      <p className="text-[8px] md:text-[10px] font-bold text-amber-400 uppercase tracking-widest mb-0.5">總排程貼文</p>
                      <p className="text-base md:text-2xl font-black text-amber-900 leading-none">{scheduledPostInventory} <span className="text-[10px] font-normal opacity-40">篇</span></p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">詳細庫存清單</p>
                  <p className="text-[9px] text-[#5A5A40] font-medium md:hidden flex items-center">
                    <ArrowLeftRight size={10} className="mr-1" /> 左右滑動查看
                  </p>
                </div>

                <div className="overflow-x-auto no-scrollbar -mx-4 px-4">
                  <div className="min-w-[550px] md:min-w-[750px] space-y-2">
                    <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[9px] md:text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b border-black/5">
                      <div className="col-span-3">廠商名稱 (IP)</div>
                      <div className="col-span-2 text-center">可用影片</div>
                      <div className="col-span-2 text-center">可用貼文</div>
                      <div className="col-span-2 text-center">排程影片</div>
                      <div className="col-span-2 text-center">排程貼文</div>
                      <div className="col-span-1 text-right">總計</div>
                    </div>
                    {vendorStocks.map((stock, idx) => (
                      <div key={idx} className="grid grid-cols-12 gap-2 items-center px-4 py-3 md:py-4 bg-[#F5F5F0]/50 rounded-2xl border border-black/5 hover:bg-[#F5F5F0] transition-colors">
                        <div className="col-span-3 font-bold text-gray-800 truncate pr-2 text-[11px] md:text-sm">{stock.name}</div>
                        <div className="col-span-2 text-center">
                          {stock.hasVideos ? (
                            <span className={cn(
                              "inline-block min-w-[20px] md:min-w-[24px] px-1.5 md:px-2 py-0.5 md:py-1 rounded-full text-[9px] md:text-[11px] font-bold",
                              stock.videos < 2 ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"
                            )}>
                              {stock.videos}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-[9px]">-</span>
                          )}
                        </div>
                        <div className="col-span-2 text-center">
                          {stock.hasPosts ? (
                            <span className="inline-block min-w-[20px] md:min-w-[24px] px-1.5 md:px-2 py-0.5 md:py-1 rounded-full bg-purple-100 text-purple-700 text-[9px] md:text-[11px] font-bold">
                              {stock.posts}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-[9px]">-</span>
                          )}
                        </div>
                        <div className="col-span-2 text-center">
                          {stock.hasVideos ? (
                            <span className="inline-block min-w-[20px] md:min-w-[24px] px-1.5 md:px-2 py-0.5 md:py-1 rounded-full bg-orange-100 text-orange-700 text-[9px] md:text-[11px] font-bold">
                              {stock.scheduledVideos}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-[9px]">-</span>
                          )}
                        </div>
                        <div className="col-span-2 text-center">
                          {stock.hasPosts ? (
                            <span className="inline-block min-w-[20px] md:min-w-[24px] px-1.5 md:px-2 py-0.5 md:py-1 rounded-full bg-amber-100 text-amber-700 text-[9px] md:text-[11px] font-bold">
                              {stock.scheduledPosts}
                            </span>
                          ) : (
                            <span className="text-gray-300 text-[9px]">-</span>
                          )}
                        </div>
                        <div className="col-span-1 text-right font-black text-gray-900 text-[11px] md:text-sm">
                          {stock.videos + stock.posts + stock.scheduledVideos + stock.scheduledPosts}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-6 border-t border-black/5 text-center">
                  <p className="text-[10px] text-gray-400 italic">此報表由 Julong 社群排程系統自動生成</p>
                </div>
              </div>
            </div>

            <div className="p-4 md:p-6 bg-white border-t border-black/5 flex space-x-3 md:space-x-4">
              <button 
                onClick={() => setIsSummaryOpen(false)}
                className="flex-1 py-3 md:py-4 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all text-sm md:text-base"
              >
                關閉
              </button>
              <button 
                onClick={handleExportJPG}
                disabled={isExporting}
                className="flex-[2] bg-[#5A5A40] text-white py-3 md:py-4 rounded-2xl font-bold shadow-xl hover:bg-[#4a4a35] transition-all flex items-center justify-center space-x-2 disabled:opacity-50 text-sm md:text-base"
              >
                {isExporting ? (
                  <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>
                ) : (
                  <>
                    <Download size={18} />
                    <span>匯出 JPG 報表</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Editor Task List Export Modal */}
      {isTaskListOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-2 md:p-4">
          <div className="bg-white rounded-[32px] md:rounded-[40px] w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col max-h-[95vh]">
            <div className="p-4 md:p-6 border-b border-gray-100 flex justify-between items-center bg-white sticky top-0 z-10">
              <div className="flex items-center space-x-3">
                <div className="bg-[#5A5A40] p-2 rounded-xl text-white shadow-lg">
                  <ClipboardList size={20} />
                </div>
                <div>
                  <h3 className="text-lg md:text-xl font-bold serif text-[#5A5A40]">導出剪輯師工作紀錄表</h3>
                  <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">僅包含待剪輯原始素材</p>
                </div>
              </div>
              <button onClick={() => setIsTaskListOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="p-4 md:p-6 bg-gray-50 border-b border-gray-100 space-y-4">
              <div className="flex bg-white p-1 rounded-2xl border border-gray-200 w-fit shadow-sm">
                <button
                  onClick={() => setExportMode('editor')}
                  className={cn(
                    "px-6 py-2 rounded-xl text-xs font-bold transition-all flex items-center space-x-2",
                    exportMode === 'editor' ? "bg-[#5A5A40] text-white shadow-md" : "text-gray-400 hover:bg-gray-50"
                  )}
                >
                  <Users size={14} />
                  <span>按剪輯師導出</span>
                </button>
                <button
                  onClick={() => setExportMode('vendor')}
                  className={cn(
                    "px-6 py-2 rounded-xl text-xs font-bold transition-all flex items-center space-x-2",
                    exportMode === 'vendor' ? "bg-[#5A5A40] text-white shadow-md" : "text-gray-400 hover:bg-gray-50"
                  )}
                >
                  <Box size={14} />
                  <span>按 IP (廠商) 導出</span>
                </button>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 items-end">
                <div className="flex-1 w-full">
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">
                    {exportMode === 'editor' ? '選擇剪輯師' : '選擇廠商 (IP)'}
                  </label>
                  {exportMode === 'editor' ? (
                    <select 
                      value={selectedEditorId}
                      onChange={(e) => setSelectedEditorId(e.target.value)}
                      className="w-full p-3 bg-white rounded-xl border border-gray-200 text-sm font-bold focus:ring-2 focus:ring-[#5A5A40]"
                    >
                      <option value="">-- 請選擇剪輯師 --</option>
                      {editors.map(ed => (
                        <option key={ed.id} value={ed.id}>{ed.name}</option>
                      ))}
                    </select>
                  ) : (
                    <select 
                      value={selectedVendorIdForExport}
                      onChange={(e) => setSelectedVendorIdForExport(e.target.value)}
                      className="w-full p-3 bg-white rounded-xl border border-gray-200 text-sm font-bold focus:ring-2 focus:ring-[#5A5A40]"
                    >
                      <option value="">-- 請選擇廠商 --</option>
                      {visibleVendors(vendors).map(v => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="flex items-center gap-4 bg-white p-3 rounded-xl border border-gray-200">
                  <label className="flex items-center space-x-2 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      checked={includeRaw}
                      onChange={(e) => setIncludeRaw(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-[#5A5A40] focus:ring-[#5A5A40]"
                    />
                    <span className="text-xs font-bold text-gray-600 group-hover:text-[#5A5A40]">原始素材 (Raw)</span>
                  </label>
                  <label className="flex items-center space-x-2 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      checked={includeFinished}
                      onChange={(e) => setIncludeFinished(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-[#5A5A40] focus:ring-[#5A5A40]"
                    />
                    <span className="text-xs font-bold text-gray-600 group-hover:text-[#5A5A40]">待發布成片</span>
                  </label>
                </div>

                <button 
                  disabled={(exportMode === 'editor' ? !selectedEditorId : !selectedVendorIdForExport) || isExporting}
                  onClick={handleExportTaskJPG}
                  className="w-full sm:w-auto bg-[#5A5A40] text-white px-8 py-3 rounded-xl font-bold shadow-lg hover:bg-[#4a4a35] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center space-x-2"
                >
                  <Download size={18} />
                  <span>{isExporting ? '生成中...' : '導出 JPG'}</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 md:p-6 bg-[#F5F5F0]/30">
              {(exportMode === 'editor' ? selectedEditorId : selectedVendorIdForExport) ? (
                <div ref={taskListRef} className="bg-white p-4 md:p-10 rounded-[24px] md:rounded-[32px] shadow-sm border border-black/5 space-y-6">
                  {/* Header Style Reference */}
                  <div className={cn(
                    "p-4 -mx-4 md:-mx-10 -mt-4 md:-mt-10 mb-8 flex justify-center items-center",
                    exportMode === 'editor' ? "bg-[#8B0000]" : "bg-[#5A5A40]"
                  )}>
                    <h2 className="text-white text-xl md:text-2xl font-black tracking-[0.2em] text-center">
                      {exportMode === 'editor' 
                        ? `聚浪 Julong Agency - ${getEditorName(selectedEditorId)} 剪輯工作紀錄表`
                        : `聚浪 Julong Agency - ${getVendorName(selectedVendorIdForExport)} 素材進度表`
                      }
                    </h2>
                  </div>

                  <div className="flex justify-between items-end border-b border-gray-100 pb-4">
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                        {exportMode === 'editor' ? '剪輯師' : '廠商名稱 (IP)'}
                      </p>
                      <p className="text-xl font-bold text-[#5A5A40] serif">
                        {exportMode === 'editor' ? getEditorName(selectedEditorId) : getVendorName(selectedVendorIdForExport)}
                      </p>
                    </div>
                    <div className="text-right space-y-1">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">導出日期</p>
                      <p className="text-sm font-bold flex items-center justify-end">
                        <Calendar size={14} className="mr-2 text-[#5A5A40]" />
                        {new Date().toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  <table className="w-full border-collapse border border-gray-300">
                    <thead>
                      <tr className="bg-[#F5F5F0]">
                        <th className="p-3 text-center text-xs font-black text-[#5A5A40] uppercase tracking-widest border border-gray-300 w-[5%]">NO.</th>
                        {exportMode === 'editor' && (
                          <th className="p-3 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest border border-gray-300 w-[15%]">IP 名稱</th>
                        )}
                        <th className={cn(
                          "p-3 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest border border-gray-300",
                          exportMode === 'editor' ? "w-[12%]" : "w-[15%]"
                        )}>
                          {exportMode === 'editor' ? '發片習慣' : '素材階段'}
                        </th>
                        <th className={cn(
                          "p-3 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest border border-gray-300",
                          exportMode === 'editor' ? "w-[38%]" : "w-[50%]"
                        )}>片名 (素材標題)</th>
                        <th className="p-3 text-left text-xs font-black text-[#5A5A40] uppercase tracking-widest border border-gray-300 w-[30%]">備註事項</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assets
                        .filter(a => {
                          const matchesTarget = exportMode === 'editor' 
                            ? getEffectiveEditorId(a) === selectedEditorId 
                            : a.vendorId === selectedVendorIdForExport;
                          
                          const isRaw = a.stage === 'raw' && effStatus(a) === 'available';
                          const isFinished = a.stage === 'finished' && effStatus(a) === 'available';
                          
                          const matchesStage = (includeRaw && isRaw) || (includeFinished && isFinished);
                          
                          return matchesTarget && matchesStage;
                        })
                        .map((asset, idx) => (
                          <tr key={asset.id} className="hover:bg-gray-50 transition-colors">
                            <td className="p-3 text-center text-sm font-bold text-gray-500 border border-gray-300">
                              {idx + 1}
                            </td>
                            {exportMode === 'editor' && (
                              <td className="p-3 text-sm font-bold text-gray-700 border border-gray-300">
                                {getVendorName(asset.vendorId)}
                              </td>
                            )}
                            <td className="p-3 text-xs font-bold border border-gray-300">
                              {exportMode === 'editor' ? (
                                <span className="text-[#8B7355]">{getVendorHabits(asset.vendorId)}</span>
                              ) : (
                                <span className={cn(
                                  "px-2 py-0.5 rounded-full",
                                  asset.stage === 'raw' ? "bg-[#8B7355]/10 text-[#8B7355]" : "bg-green-100 text-green-700"
                                )}>
                                  {asset.stage === 'raw' ? '待剪輯' : '已成片'}
                                </span>
                              )}
                            </td>
                            <td className="p-3 text-sm font-medium text-gray-600 border border-gray-300">
                              {asset.title}
                            </td>
                            <td className="p-3 border border-gray-300">
                              <input 
                                type="text"
                                placeholder={isExporting ? "" : "點擊輸入備註..."}
                                className="w-full bg-transparent border-none text-sm text-gray-500 focus:ring-0 p-0 placeholder:text-gray-300 italic"
                                value={taskNotes[asset.id!] || ''}
                                onChange={(e) => setTaskNotes({ ...taskNotes, [asset.id!]: e.target.value })}
                              />
                            </td>
                          </tr>
                        ))}
                      {assets.filter(a => {
                          const matchesTarget = exportMode === 'editor' 
                            ? getEffectiveEditorId(a) === selectedEditorId 
                            : a.vendorId === selectedVendorIdForExport;
                          const isRaw = a.stage === 'raw' && effStatus(a) === 'available';
                          const isFinished = a.stage === 'finished' && effStatus(a) === 'available';
                          const matchesStage = (includeRaw && isRaw) || (includeFinished && isFinished);
                          return matchesTarget && matchesStage;
                        }).length === 0 && (
                        <tr>
                          <td colSpan={exportMode === 'editor' ? 5 : 4} className="p-20 text-center text-gray-400 italic text-sm border border-gray-300">
                            目前無符合條件的素材
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>

                  <div className="pt-10 flex justify-between items-center opacity-30">
                    <div className="flex items-center space-x-2">
                      <div className="w-8 h-8 bg-[#5A5A40] rounded-lg"></div>
                      <span className="text-xs font-black tracking-widest">JULONG AGENCY</span>
                    </div>
                    <p className="text-[10px] font-bold">INTERNAL WORK RECORD ONLY</p>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center space-y-4 py-20">
                  <div className="bg-white p-6 rounded-full shadow-sm border border-black/5">
                    {exportMode === 'editor' ? <Users size={48} className="text-gray-200" /> : <Box size={48} className="text-gray-200" />}
                  </div>
                  <p className="text-gray-400 font-bold">
                    {exportMode === 'editor' ? '請先選擇一位剪輯師以生成清單' : '請先選擇一個廠商以生成進度表'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
