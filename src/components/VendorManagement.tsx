import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import {
  collection,
  query,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  orderBy
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Vendor, SocialAccount, OperationType, Editor, PauseRecord } from '../types';
import { Plus, Trash2, Edit2, ExternalLink, Shield, X, Eye, EyeOff, Users, ChevronDown, ChevronUp, Settings2, Snowflake, RotateCcw, PowerOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getEffectiveVendorStatus } from '../lib/vendorStatus';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type StatusTab = 'active' | 'paused' | 'ended';

export default function VendorManagement() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditorModalOpen, setIsEditorModalOpen] = useState(false);
  const [newEditorName, setNewEditorName] = useState('');
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});
  const [visibleFormPasswords, setVisibleFormPasswords] = useState<Record<number, boolean>>({});
  const [ipProfiles, setIpProfiles] = useState<{ fb_page_id: string; ig_user_id: string | null; brand_name: string; token_status?: string }[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [statusTab, setStatusTab] = useState<StatusTab>('active');
  const [pauseModalVendor, setPauseModalVendor] = useState<Vendor | null>(null);
  const [pauseFromInput, setPauseFromInput] = useState('');
  const [pauseUntilInput, setPauseUntilInput] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    socialAccounts: [{ platform: 'IG', username: '', password: '' }],
    postingHabits: [] as any[],
    cooperationItems: [] as string[],
    monthlyTargetPosts: 8,
    monthlyTargetVideos: 0,
    excludeFromStats: false,
    pauseHistory: [] as PauseRecord[],
    editorId: '',
    editorName: '',
    selfPublishing: false,
    aiBenchmark: false,
    aiScript: false,
    aiPersona: '',
    dataFbPageId: ''
  });

  // ip-nexus 數據帳號清單（配對下拉；抓不到就留空，不影響其他功能）
  useEffect(() => {
    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        const res = await fetch('/api/studio/ipprofiles', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) setIpProfiles(await res.json());
      } catch { /* 數據庫暫時連不上也沒關係 */ }
    })();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'vendors'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const vendorList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Vendor));
      setVendors(vendorList);
    }, (error) => {
      console.error('Firestore Error:', error);
      toast.error('讀取廠商資料失敗');
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'editors'), orderBy('name'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setEditors(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Editor)));
    }, (error) => {
      console.error('Firestore Error:', error);
    });
    return () => unsubscribe();
  }, []);

  const handleAddEditor = async () => {
    if (!newEditorName.trim()) return;
    try {
      await addDoc(collection(db, 'editors'), {
        name: newEditorName.trim(),
        createdAt: new Date().toISOString()
      });
      setNewEditorName('');
      toast.success('已新增剪輯師');
    } catch (error) {
      toast.error('新增失敗');
    }
  };

  const handleDeleteEditor = async (id: string) => {
    if (!window.confirm('確定要刪除此剪輯師嗎？')) return;
    try {
      await deleteDoc(doc(db, 'editors', id));
      toast.success('已刪除');
    } catch (error) {
      toast.error('刪除失敗');
    }
  };

  const handleAddAccount = () => {
    setFormData({
      ...formData,
      socialAccounts: [...formData.socialAccounts, { platform: 'IG', username: '', password: '' }]
    });
  };

  const handleRemoveAccount = (index: number) => {
    const newAccounts = formData.socialAccounts.filter((_, i) => i !== index);
    setFormData({ ...formData, socialAccounts: newAccounts });
  };

  const handleAccountChange = (index: number, field: keyof SocialAccount, value: string) => {
    const newAccounts = [...formData.socialAccounts];
    newAccounts[index] = { ...newAccounts[index], [field]: value };
    setFormData({ ...formData, socialAccounts: newAccounts });
  };

  const handleAddHabit = () => {
    setFormData({
      ...formData,
      postingHabits: [...(formData.postingHabits || []), { daysOfWeek: [1, 3], time: '20:00', contentTypes: ['video'], platforms: ['IG', 'TikTok'] }]
    });
  };

  const handleRemoveHabit = (index: number) => {
    const newHabits = formData.postingHabits.filter((_, i) => i !== index);
    setFormData({ ...formData, postingHabits: newHabits });
  };

  const handleHabitChange = (index: number, field: string, value: any) => {
    const newHabits = [...formData.postingHabits];
    newHabits[index] = { ...newHabits[index], [field]: value };
    setFormData({ ...formData, postingHabits: newHabits });
  };

  const toggleDay = (habitIndex: number, day: number) => {
    const habit = formData.postingHabits[habitIndex];
    const newDays = habit.daysOfWeek.includes(day)
      ? habit.daysOfWeek.filter((d: number) => d !== day)
      : [...habit.daysOfWeek, day].sort();
    handleHabitChange(habitIndex, 'daysOfWeek', newDays);
  };

  const toggleContentType = (habitIndex: number, type: string) => {
    const habit = formData.postingHabits[habitIndex];
    const newTypes = habit.contentTypes.includes(type)
      ? habit.contentTypes.filter((t: string) => t !== type)
      : [...habit.contentTypes, type];
    handleHabitChange(habitIndex, 'contentTypes', newTypes);
  };

  const togglePlatform = (habitIndex: number, platform: string) => {
    const habit = formData.postingHabits[habitIndex];
    const newPlatforms = habit.platforms.includes(platform)
      ? habit.platforms.filter((p: string) => p !== platform)
      : [...habit.platforms, platform];
    handleHabitChange(habitIndex, 'platforms', newPlatforms);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;

    try {
      // 冷凍紀錄可能在這個表單裡被直接改過（例如刪掉誤加的一筆），
      // 所以即時的 status/pausedUntil 要跟著重新推算，不然刪除紀錄後畫面還是卡在冷凍中
      const statusFields: Partial<Vendor> = {};
      if (editingVendor && editingVendor.status !== 'ended') {
        const today = format(new Date(), 'yyyy-MM-dd');
        const openRecord = formData.pauseHistory.find(r => r.from <= today && (!r.until || r.until > today));
        statusFields.status = openRecord ? 'paused' : 'active';
        statusFields.pausedUntil = openRecord?.until || '';
      }

      const data = {
        ...formData,
        ...statusFields,
        createdBy: auth.currentUser.uid,
        createdAt: new Date().toISOString()
      };

      if (editingVendor) {
        await updateDoc(doc(db, 'vendors', editingVendor.id!), data);
        toast.success('廠商資料已更新');
      } else {
        await addDoc(collection(db, 'vendors'), data);
        toast.success('廠商資料已建立');
      }
      setIsModalOpen(false);
      setEditingVendor(null);
      setFormData({ 
        name: '', 
        socialAccounts: [{ platform: 'IG', username: '', password: '' }], 
        postingHabits: [],
        cooperationItems: [],
        monthlyTargetPosts: 8,
        monthlyTargetVideos: 0,
        excludeFromStats: false,
        pauseHistory: [],
        editorName: '',
        selfPublishing: false,
        aiBenchmark: false,
        aiScript: false,
        aiPersona: '',
        dataFbPageId: ''
      });
    } catch (error) {
      toast.error('儲存失敗');
    }
  };

  const handleEndCooperation = async (id: string) => {
    if (!window.confirm('確定要終止與此廠商的合作嗎？資料會保留在資料庫，但不會再出現在其他頁面的選單與追蹤中。')) return;
    try {
      await updateDoc(doc(db, 'vendors', id), { status: 'ended' });
      toast.success('已終止合作');
    } catch (error) {
      toast.error('操作失敗');
    }
  };

  const handleResume = async (id: string) => {
    try {
      const vendor = vendors.find(v => v.id === id);
      const today = format(new Date(), 'yyyy-MM-dd');
      const history = vendor?.pauseHistory || [];
      // 如果最後一筆冷凍紀錄還沒填恢復日，順手補上今天，讓歷史紀錄保持完整
      const closedHistory = history.length > 0 && !history[history.length - 1].until
        ? history.map((rec, i) => i === history.length - 1 ? { ...rec, until: today } : rec)
        : history;
      await updateDoc(doc(db, 'vendors', id), { status: 'active', pausedUntil: '', pauseHistory: closedHistory });
      toast.success('已恢復合作');
    } catch (error) {
      toast.error('操作失敗');
    }
  };

  const openPauseModal = (vendor: Vendor) => {
    setPauseModalVendor(vendor);
    const history = vendor.pauseHistory || [];
    // 目前正在冷凍中的話，一律把最後一筆紀錄當成「這次冷凍」來預填修正，
    // 不能只看 until 是否留空——已經填了預計恢復日、但還沒真的恢復，也算目前這筆
    const currentRecord = vendor.status === 'paused' && history.length > 0 ? history[history.length - 1] : null;
    setPauseFromInput(currentRecord?.from || format(new Date(), 'yyyy-MM-dd'));
    setPauseUntilInput(vendor.pausedUntil || currentRecord?.until || '');
  };

  const handleConfirmPause = async () => {
    if (!pauseModalVendor?.id) return;
    if (!pauseFromInput) {
      toast.error('請輸入冷凍起始日期');
      return;
    }
    try {
      const history = pauseModalVendor.pauseHistory || [];
      const wasAlreadyPaused = pauseModalVendor.status === 'paused';
      const newRecord: PauseRecord = { from: pauseFromInput, until: pauseUntilInput || undefined };
      // 如果本來就是冷凍中，這次視為修正同一段紀錄的日期；否則是開一段新的冷凍期（支援多次冷凍）
      const newHistory = wasAlreadyPaused && history.length > 0
        ? history.map((rec, i) => i === history.length - 1 ? newRecord : rec)
        : [...history, newRecord];

      await updateDoc(doc(db, 'vendors', pauseModalVendor.id), {
        status: 'paused',
        pausedUntil: pauseUntilInput || '',
        pauseHistory: newHistory
      });
      toast.success('已設為冷凍中');
      setPauseModalVendor(null);
      setPauseFromInput('');
      setPauseUntilInput('');
    } catch (error) {
      toast.error('操作失敗');
    }
  };

  const handleHardDelete = async (id: string) => {
    if (window.confirm('此操作將永久刪除該廠商資料，無法復原，確定要繼續嗎？')) {
      try {
        await deleteDoc(doc(db, 'vendors', id));
        toast.success('已永久刪除');
      } catch (error) {
        toast.error('刪除失敗');
      }
    }
  };

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];

  const statusTabs: { id: StatusTab; label: string }[] = [
    { id: 'active', label: '進行中' },
    { id: 'paused', label: '冷凍中' },
    { id: 'ended', label: '已終止' }
  ];
  const displayedVendors = vendors.filter(v => getEffectiveVendorStatus(v) === statusTab);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">廠商管理</h2>
          <p className="text-sm text-gray-500">管理您的 IP 帳號與客戶廠商資料</p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <button 
            onClick={() => setIsEditorModalOpen(true)}
            className="flex-1 sm:flex-none bg-white text-[#5A5A40] px-4 py-3 rounded-xl border border-[#5A5A40]/20 flex items-center justify-center shadow-sm hover:bg-gray-50 transition-all"
          >
            <Users size={20} className="mr-2" /> 剪輯師管理
          </button>
          <button 
            onClick={() => {
              setEditingVendor(null);
              setShowAdvanced(false);
              setFormData({
                name: '',
                socialAccounts: [{ platform: 'IG', username: '', password: '' }],
                postingHabits: [],
                cooperationItems: [],
                monthlyTargetPosts: 8,
                monthlyTargetVideos: 0,
                excludeFromStats: false,
                pauseHistory: [],
                editorId: '',
                editorName: '',
                selfPublishing: false,
                aiBenchmark: false,
                aiScript: false,
                aiPersona: '',
                dataFbPageId: ''
              });
              setIsModalOpen(true);
            }}
            className="flex-1 sm:flex-none bg-[#5A5A40] text-white px-6 py-3 rounded-xl flex items-center justify-center shadow-lg hover:bg-[#4a4a35] transition-all"
          >
            <Plus size={20} className="mr-2" /> 建立廠商資料
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        {statusTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setStatusTab(tab.id)}
            className={cn(
              "px-4 py-2 rounded-xl text-sm font-bold transition-all",
              statusTab === tab.id
                ? "bg-[#5A5A40] text-white shadow-sm"
                : "bg-white text-gray-500 border border-black/5 hover:bg-gray-50"
            )}
          >
            {tab.label}
            <span className="ml-1.5 text-xs font-normal opacity-70">
              {vendors.filter(v => getEffectiveVendorStatus(v) === tab.id).length}
            </span>
          </button>
        ))}
      </div>

      {displayedVendors.length === 0 && (
        <div className="text-center py-16 text-gray-400 text-sm italic">
          {statusTab === 'ended' ? '目前沒有已終止合作的廠商' : statusTab === 'paused' ? '目前沒有冷凍中的廠商' : '目前沒有進行中的廠商'}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
        {displayedVendors.map((vendor) => (
          <div key={vendor.id} className="bg-white p-6 rounded-2xl shadow-sm border border-black/5 hover:shadow-md transition-all group">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-bold serif">{vendor.name}</h3>
              <div className="flex space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={() => {
                    setEditingVendor(vendor);
                    setFormData({
                      name: vendor.name,
                      socialAccounts: vendor.socialAccounts,
                      postingHabits: vendor.postingHabits || [],
                      cooperationItems: vendor.cooperationItems || [],
                      monthlyTargetPosts: vendor.monthlyTargetPosts || 0,
                      monthlyTargetVideos: vendor.monthlyTargetVideos || 0,
                      excludeFromStats: vendor.excludeFromStats || false,
                      pauseHistory: vendor.pauseHistory || [],
                      editorId: vendor.editorId || '',
                      editorName: vendor.editorName || '',
                      selfPublishing: vendor.selfPublishing || false,
                      aiBenchmark: vendor.aiBenchmark || false,
                      aiScript: vendor.aiScript || false,
                      aiPersona: vendor.aiPersona || '',
                      dataFbPageId: vendor.dataFbPageId || ''
                    });
                    setShowAdvanced(Boolean(
                      vendor.selfPublishing || vendor.aiBenchmark || vendor.aiScript ||
                      vendor.aiPersona || vendor.dataFbPageId
                    ));
                    setIsModalOpen(true);
                  }}
                  className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg"
                >
                  <Edit2 size={16} />
                </button>
                {statusTab === 'active' && (
                  <button
                    onClick={() => openPauseModal(vendor)}
                    className="p-2 text-cyan-600 hover:bg-cyan-50 rounded-lg"
                    title="設為冷凍中"
                  >
                    <Snowflake size={16} />
                  </button>
                )}
                {statusTab === 'paused' && (
                  <>
                    <button
                      onClick={() => openPauseModal(vendor)}
                      className="p-2 text-cyan-600 hover:bg-cyan-50 rounded-lg"
                      title="修改冷凍日期"
                    >
                      <Snowflake size={16} />
                    </button>
                    <button
                      onClick={() => handleResume(vendor.id!)}
                      className="p-2 text-green-600 hover:bg-green-50 rounded-lg"
                      title="恢復合作"
                    >
                      <RotateCcw size={16} />
                    </button>
                  </>
                )}
                {statusTab !== 'ended' && (
                  <button
                    onClick={() => handleEndCooperation(vendor.id!)}
                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                    title="終止合作"
                  >
                    <PowerOff size={16} />
                  </button>
                )}
                {statusTab === 'ended' && (
                  <>
                    <button
                      onClick={() => handleResume(vendor.id!)}
                      className="p-2 text-green-600 hover:bg-green-50 rounded-lg"
                      title="恢復合作"
                    >
                      <RotateCcw size={16} />
                    </button>
                    <button
                      onClick={() => handleHardDelete(vendor.id!)}
                      className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                      title="永久刪除"
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 items-center">
                {statusTab === 'paused' && (
                  <div className="flex items-center text-xs font-bold text-cyan-700 bg-cyan-50 px-2 py-1 rounded-lg border border-cyan-100 w-fit">
                    <Snowflake size={12} className="mr-1" />
                    <span>冷凍中{vendor.pausedUntil ? `（預計 ${vendor.pausedUntil} 恢復）` : ''}</span>
                  </div>
                )}
                {statusTab === 'ended' && (
                  <div className="flex items-center text-xs font-bold text-gray-500 bg-gray-100 px-2 py-1 rounded-lg border border-gray-200 w-fit">
                    <PowerOff size={12} className="mr-1" />
                    <span>已終止合作</span>
                  </div>
                )}
                {vendor.editorName && (
                  <div className="flex items-center text-xs font-bold text-[#5A5A40] bg-[#5A5A40]/5 px-2 py-1 rounded-lg border border-[#5A5A40]/10 w-fit">
                    <span className="mr-1">剪輯師:</span>
                    <span>{vendor.editorName}</span>
                  </div>
                )}
                {vendor.excludeFromStats && (
                  <div className="flex items-center text-xs font-bold text-gray-500 bg-gray-100 px-2 py-1 rounded-lg border border-gray-200 w-fit">
                    <span>不列入統計</span>
                  </div>
                )}
                {vendor.selfPublishing && (
                  <div className="flex items-center text-xs font-bold text-green-600 bg-green-50 px-2 py-1 rounded-lg border border-green-100 w-fit">
                    <span>廠商自行發布</span>
                  </div>
                )}
                {vendor.aiBenchmark && (
                  <div className="flex items-center text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg border border-indigo-100 w-fit">
                    <span>🌂 AI 對標</span>
                  </div>
                )}
                {vendor.aiScript && (
                  <div className="flex items-center text-xs font-bold text-purple-600 bg-purple-50 px-2 py-1 rounded-lg border border-purple-100 w-fit">
                    <span>🎬 AI 腳本{vendor.aiPersona ? '' : '（缺人設）'}</span>
                  </div>
                )}
              </div>
              {vendor.cooperationItems && vendor.cooperationItems.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {vendor.cooperationItems.map(item => (
                    <span key={item} className="bg-[#5A5A40]/10 text-[#5A5A40] text-[10px] px-2 py-0.5 rounded-full font-bold border border-[#5A5A40]/20">
                      {item === 'short_video' ? '短影音' : '圖文'}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex gap-4 mb-2">
                <div className="bg-blue-50 p-2 rounded-xl flex-1 border border-blue-100">
                  <div className="text-[10px] text-blue-400 font-bold uppercase tracking-wider">圖文目標</div>
                  <div className="text-sm font-bold text-blue-700">{vendor.monthlyTargetPosts || 0} <span className="text-[10px] font-normal">/ 月</span></div>
                </div>
                <div className="bg-orange-50 p-2 rounded-xl flex-1 border border-orange-100">
                  <div className="text-[10px] text-orange-400 font-bold uppercase tracking-wider">影音目標</div>
                  <div className="text-sm font-bold text-orange-700">{vendor.monthlyTargetVideos || 0} <span className="text-[10px] font-normal">/ 月</span></div>
                </div>
              </div>

              <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">社群帳號</div>
              {vendor.socialAccounts.map((acc, idx) => {
                const passwordKey = `${vendor.id}-${idx}`;
                const isVisible = visiblePasswords[passwordKey];
                
                return (
                  <div key={idx} className="flex items-center justify-between p-3 bg-[#F5F5F0] rounded-xl text-sm">
                    <div className="flex items-center">
                      <span className="bg-[#5A5A40] text-white text-[10px] px-2 py-0.5 rounded-full mr-2 font-bold">{acc.platform}</span>
                      <span className="font-medium">{acc.username}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className="flex items-center text-gray-400">
                        <Shield size={14} className="mr-1" />
                        <span className="font-mono">{isVisible ? acc.password : '••••••'}</span>
                      </div>
                      <button 
                        onClick={() => setVisiblePasswords(prev => ({ ...prev, [passwordKey]: !isVisible }))}
                        className="text-gray-400 hover:text-[#5A5A40] transition-colors"
                      >
                        {isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                );
              })}

              {vendor.postingHabits && vendor.postingHabits.length > 0 && (
                <>
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mt-4 mb-1">發布習慣</div>
                  {vendor.postingHabits.map((habit, idx) => (
                    <div key={idx} className="p-3 bg-orange-50 rounded-xl text-xs border border-orange-100">
                      <div className="flex justify-between font-bold text-orange-800 mb-1">
                        <span>每週 {habit.daysOfWeek.map(d => weekDays[d]).join(', ')}</span>
                        <span>{habit.time}</span>
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {habit.contentTypes.map(t => (
                          <span key={t} className="bg-orange-200 text-orange-900 px-1.5 py-0.5 rounded text-[10px]">{t === 'post' ? '貼文' : '短影音'}</span>
                        ))}
                        {habit.platforms.map(p => (
                          <span key={p} className="bg-white/50 text-orange-700 px-1.5 py-0.5 rounded text-[10px] border border-orange-200">{p}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-2xl sm:rounded-3xl w-full max-w-3xl max-h-[95vh] overflow-auto shadow-2xl">
            <div className="p-5 sm:p-8">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl sm:text-2xl font-bold serif">{editingVendor ? '編輯廠商' : '建立新廠商'}</h3>
                <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full">
                  <X className="w-5 h-5 sm:w-6 sm:h-6" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6 sm:space-y-8">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">廠商名稱</label>
                  <input 
                    type="text" 
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="請輸入廠商名稱"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">負責剪輯師</label>
                  <select 
                    value={formData.editorId}
                    onChange={(e) => {
                      const selectedEditor = editors.find(ed => ed.id === e.target.value);
                      setFormData({ 
                        ...formData, 
                        editorId: e.target.value,
                        editorName: selectedEditor?.name || ''
                      });
                    }}
                    className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                  >
                    <option value="">選擇剪輯師 (外包)</option>
                    {editors.map(ed => (
                      <option key={ed.id} value={ed.id}>{ed.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="w-full flex items-center justify-between p-4 bg-[#F5F5F0] rounded-2xl hover:bg-gray-100 transition-all"
                  >
                    <span className="flex items-center text-sm font-bold text-gray-600">
                      <Settings2 size={16} className="mr-2" /> 進階設定
                      <span className="ml-2 text-xs font-normal text-gray-400">自行發布・AI 員工・人物設定</span>
                    </span>
                    {showAdvanced ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </button>

                  {showAdvanced && (
                    <div className="mt-4 space-y-4">
                      <div className="bg-green-50/50 p-4 rounded-2xl border border-green-100/50">
                        <label className="flex items-center space-x-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.selfPublishing}
                            onChange={(e) => setFormData({ ...formData, selfPublishing: e.target.checked })}
                            className="w-5 h-5 rounded border-green-300 text-green-600 focus:ring-green-500"
                          />
                          <div>
                            <span className="block text-sm font-bold text-green-800">廠商自行發布</span>
                            <span className="block text-xs text-green-600/70">勾選後，該廠商貼文可直接設為「服務次數認列」，不需強制排程日期。</span>
                          </div>
                        </label>
                      </div>

                      <div className="bg-purple-50/50 p-4 rounded-2xl border border-purple-100/50 space-y-4">
                        <p className="text-xs font-black uppercase tracking-widest text-purple-400">🤖 AI 員工設定</p>
                        <label className="flex items-center space-x-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.aiBenchmark}
                            onChange={(e) => setFormData({ ...formData, aiBenchmark: e.target.checked })}
                            className="w-5 h-5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <div>
                            <span className="block text-sm font-bold text-indigo-800">🌂 雨傘標對標研究</span>
                            <span className="block text-xs text-indigo-600/70">每天自動找這個廠商賽道的對標帳號與爆款片，推到「爆款靈感」。</span>
                          </div>
                        </label>
                        <label className="flex items-center space-x-3 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.aiScript}
                            onChange={(e) => setFormData({ ...formData, aiScript: e.target.checked })}
                            className="w-5 h-5 rounded border-purple-300 text-purple-600 focus:ring-purple-500"
                          />
                          <div>
                            <span className="block text-sm font-bold text-purple-800">🎬 AI 腳本生成</span>
                            <span className="block text-xs text-purple-600/70">依下方人物設定自動產腳本，送到「腳本審核」等核准。需先填人物設定。</span>
                          </div>
                        </label>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">📊 數據帳號配對（ip-nexus）</label>
                          <select
                            value={formData.dataFbPageId}
                            onChange={(e) => setFormData({ ...formData, dataFbPageId: e.target.value })}
                            className="w-full p-3 bg-white rounded-xl border border-purple-100 text-sm"
                          >
                            <option value="">未配對（沒有 Meta 數據也能跑，AI 只用對標＋人設）</option>
                            {ipProfiles.map(p => (
                              <option key={p.fb_page_id} value={p.fb_page_id}>
                                {p.brand_name}{p.token_status && p.token_status !== 'ok' ? '（token 異常）' : ''}
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-gray-400 mt-1">配對後 AI 會參考這家自己的成效數據（哪支片最會跑）來想題材。</p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">人物設定檔</label>
                          <textarea
                            rows={6}
                            value={formData.aiPersona}
                            onChange={(e) => setFormData({ ...formData, aiPersona: e.target.value })}
                            className="w-full p-3 bg-white rounded-xl border border-purple-100 text-sm resize-none"
                            placeholder={"AI 寫腳本的依據，寫得越像本人越好。建議包含：\n・人設：口頭禪、說話風格、角色關係（誰跟誰對戲）\n・產品事實：只能用的真數字（例：3.5倍效率、316L、終身保修）\n・紅線：絕對不能說/不能拍的事\n・可拍資源：場地、道具、出鏡的人"}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">合作項目</label>
                  <div className="flex gap-4">
                    {[
                      { id: 'short_video', label: '短影音' },
                      { id: 'graphic_post', label: '圖文' }
                    ].map(item => (
                      <label key={item.id} className="flex items-center space-x-2 cursor-pointer">
                        <input 
                          type="checkbox"
                          checked={formData.cooperationItems.includes(item.id)}
                          onChange={() => {
                            const newItems = formData.cooperationItems.includes(item.id)
                              ? formData.cooperationItems.filter(i => i !== item.id)
                              : [...formData.cooperationItems, item.id];
                            setFormData({ ...formData, cooperationItems: newItems });
                          }}
                          className="rounded border-gray-300 text-[#5A5A40] focus:ring-[#5A5A40]"
                        />
                        <span className="text-sm text-gray-700">{item.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">每月預計圖文發布數</label>
                    <input 
                      type="number" 
                      min="0"
                      value={formData.monthlyTargetPosts}
                      onChange={(e) => setFormData({ ...formData, monthlyTargetPosts: parseInt(e.target.value) || 0 })}
                      className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                      placeholder="例如: 8"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">每月預計影音發布數</label>
                    <input 
                      type="number" 
                      min="0"
                      value={formData.monthlyTargetVideos}
                      onChange={(e) => setFormData({ ...formData, monthlyTargetVideos: parseInt(e.target.value) || 0 })}
                      className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                      placeholder="例如: 4"
                    />
                  </div>
                </div>

                <div className="bg-gray-50 p-4 rounded-2xl border border-gray-200">
                  <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.excludeFromStats}
                      onChange={(e) => setFormData({ ...formData, excludeFromStats: e.target.checked })}
                      className="w-5 h-5 rounded border-gray-300 text-gray-600 focus:ring-gray-500"
                    />
                    <div>
                      <span className="block text-sm font-bold text-gray-700">不列入本月發文統計</span>
                      <span className="block text-xs text-gray-500">勾選後，此廠商不會出現在貼文管理的進度計數器、拍攝進度、庫存提醒等統計畫面（適用內部帳號等不需追蹤發文量的對象）。</span>
                    </div>
                  </label>
                </div>

                <div className="bg-cyan-50/40 p-4 rounded-2xl border border-cyan-100 space-y-3">
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="block text-sm font-bold text-cyan-800">冷凍／暫停合作紀錄</span>
                      <span className="block text-xs text-cyan-600/70">日期打錯了嗎？直接改下面現有那一列的日期欄位就好；不要點右邊的「新增一筆」——那顆按鈕是給「這段恢復合作之後，未來又要另外暫停一次」用的，跟修正現有這段的日期是兩件事，點了會多出一段沒用到的紀錄。</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFormData({
                        ...formData,
                        pauseHistory: [...formData.pauseHistory, { from: format(new Date(), 'yyyy-MM-dd'), until: undefined }]
                      })}
                      className="text-xs text-cyan-700 font-bold flex items-center hover:underline whitespace-nowrap"
                    >
                      <Plus size={14} className="mr-1" /> 新增下一段冷凍期
                    </button>
                  </div>
                  {formData.pauseHistory.length === 0 && (
                    <p className="text-xs text-gray-400 italic">尚無冷凍紀錄</p>
                  )}
                  {formData.pauseHistory.map((rec, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white p-2 rounded-xl border border-cyan-100/70">
                      <input
                        type="date"
                        value={rec.from}
                        onChange={(e) => {
                          const next = [...formData.pauseHistory];
                          next[i] = { ...next[i], from: e.target.value };
                          setFormData({ ...formData, pauseHistory: next });
                        }}
                        className="flex-1 p-2 bg-[#F5F5F0] rounded-lg border-none text-sm focus:ring-2 focus:ring-cyan-500"
                      />
                      <span className="text-gray-400 text-sm">～</span>
                      <input
                        type="date"
                        value={rec.until || ''}
                        onChange={(e) => {
                          const next = [...formData.pauseHistory];
                          next[i] = { ...next[i], until: e.target.value || undefined };
                          setFormData({ ...formData, pauseHistory: next });
                        }}
                        className="flex-1 p-2 bg-[#F5F5F0] rounded-lg border-none text-sm focus:ring-2 focus:ring-cyan-500"
                      />
                      <button
                        type="button"
                        onClick={() => setFormData({
                          ...formData,
                          pauseHistory: formData.pauseHistory.filter((_, idx) => idx !== i)
                        })}
                        className="p-2 text-red-400 hover:bg-red-50 rounded-lg"
                        title="刪除這筆紀錄"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Social Accounts Section */}
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium text-gray-700">社群帳號資料</label>
                    <button 
                      type="button"
                      onClick={handleAddAccount}
                      className="text-sm text-[#5A5A40] font-bold flex items-center hover:underline"
                    >
                      <Plus size={16} className="mr-1" /> 新增帳號
                    </button>
                  </div>

                  {formData.socialAccounts.map((acc, idx) => (
                    <div key={idx} className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-[#F5F5F0] rounded-2xl relative">
                      {formData.socialAccounts.length > 1 && (
                        <button 
                          type="button"
                          onClick={() => handleRemoveAccount(idx)}
                          className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full shadow-md"
                        >
                          <X size={12} />
                        </button>
                      )}
                      <div>
                        <select 
                          value={acc.platform}
                          onChange={(e) => handleAccountChange(idx, 'platform', e.target.value)}
                          className="w-full p-2 bg-white rounded-lg border-none text-sm"
                        >
                          <option value="IG">Instagram</option>
                          <option value="FB">Facebook</option>
                          <option value="TikTok">TikTok</option>
                          <option value="YouTube">YouTube</option>
                          <option value="LINE">LINE</option>
                        </select>
                      </div>
                      <div>
                        <input 
                          type="text" 
                          placeholder="帳號"
                          value={acc.username}
                          onChange={(e) => handleAccountChange(idx, 'username', e.target.value)}
                          className="w-full p-2 bg-white rounded-lg border-none text-sm"
                        />
                      </div>
                      <div className="relative">
                        <input 
                          type={visibleFormPasswords[idx] ? "text" : "password"} 
                          placeholder="密碼"
                          value={acc.password}
                          onChange={(e) => handleAccountChange(idx, 'password', e.target.value)}
                          className="w-full p-2 pr-8 bg-white rounded-lg border-none text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setVisibleFormPasswords(prev => ({ ...prev, [idx]: !prev[idx] }))}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#5A5A40]"
                        >
                          {visibleFormPasswords[idx] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Posting Habits Section */}
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-medium text-gray-700">發布習慣設定 (預設排程提示)</label>
                    <button 
                      type="button"
                      onClick={handleAddHabit}
                      className="text-sm text-orange-600 font-bold flex items-center hover:underline"
                    >
                      <Plus size={16} className="mr-1" /> 新增發布習慣
                    </button>
                  </div>

                  {formData.postingHabits?.map((habit, idx) => (
                    <div key={idx} className="p-6 bg-orange-50 rounded-2xl relative border border-orange-100 space-y-4">
                      <button 
                        type="button"
                        onClick={() => handleRemoveHabit(idx)}
                        className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full shadow-md"
                      >
                        <X size={12} />
                      </button>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="block text-xs font-bold text-orange-800 mb-2 uppercase tracking-wider">發布星期</label>
                          <div className="flex flex-wrap gap-2">
                            {weekDays.map((day, dIdx) => (
                              <button
                                key={day}
                                type="button"
                                onClick={() => toggleDay(idx, dIdx)}
                                className={cn(
                                  "w-8 h-8 rounded-lg text-xs font-bold transition-all",
                                  habit.daysOfWeek.includes(dIdx) ? "bg-orange-600 text-white" : "bg-white text-orange-300 border border-orange-100"
                                )}
                              >
                                {day}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-orange-800 mb-2 uppercase tracking-wider">發布時間</label>
                          <input 
                            type="time" 
                            value={habit.time}
                            onChange={(e) => handleHabitChange(idx, 'time', e.target.value)}
                            className="w-full p-2 bg-white rounded-lg border-none text-sm"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="block text-xs font-bold text-orange-800 mb-2 uppercase tracking-wider">合作內容</label>
                          <div className="flex gap-2">
                            {['post', 'video'].map(type => (
                              <button
                                key={type}
                                type="button"
                                onClick={() => toggleContentType(idx, type)}
                                className={cn(
                                  "px-3 py-1 rounded-lg text-xs font-bold transition-all",
                                  habit.contentTypes.includes(type) ? "bg-orange-600 text-white" : "bg-white text-orange-300 border border-orange-100"
                                )}
                              >
                                {type === 'post' ? '貼文' : '短影音'}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-orange-800 mb-2 uppercase tracking-wider">發布平台</label>
                          <div className="flex flex-wrap gap-2">
                            {['IG', 'FB', 'TikTok', 'YT'].map(p => (
                              <button
                                key={p}
                                type="button"
                                onClick={() => togglePlatform(idx, p)}
                                className={cn(
                                  "px-3 py-1 rounded-lg text-xs font-bold transition-all",
                                  habit.platforms.includes(p) ? "bg-orange-600 text-white" : "bg-white text-orange-300 border border-orange-100"
                                )}
                              >
                                {p}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end space-x-4 pt-4">
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
                    儲存資料
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
      {/* Pause (冷凍期) Modal */}
      {pauseModalVendor && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-cyan-50/50">
              <h3 className="text-xl font-bold serif text-cyan-700 flex items-center">
                <Snowflake size={20} className="mr-2" /> 設為冷凍中
              </h3>
              <button onClick={() => setPauseModalVendor(null)} className="p-2 hover:bg-white rounded-full transition-colors">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                <span className="font-bold">{pauseModalVendor.name}</span> 進入冷凍期，冷凍區間涵蓋到的月份，該月目標與欠片統計都會排除這家廠商，但排片選單仍可正常使用。
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">冷凍起始日期</label>
                <input
                  type="date"
                  value={pauseFromInput}
                  onChange={(e) => setPauseFromInput(e.target.value)}
                  className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-cyan-500"
                />
                <p className="text-xs text-gray-400 mt-1">可以填之前的日期回溯（例如本來就從 6/1 開始沒合作），系統會用這個日期判斷哪些月份要排除統計。</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">預計恢復日期（選填）</label>
                <input
                  type="date"
                  value={pauseUntilInput}
                  onChange={(e) => setPauseUntilInput(e.target.value)}
                  className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-cyan-500"
                />
                <p className="text-xs text-gray-400 mt-1">留空的話就是無限期冷凍，之後要手動按「恢復合作」。日期一到系統會自動視為恢復，不用再手動處理。</p>
              </div>
              {pauseModalVendor.pauseHistory && pauseModalVendor.pauseHistory.length > 0 && (
                <div className="bg-gray-50 rounded-xl p-3 space-y-1">
                  <p className="text-xs font-bold text-gray-500">歷次冷凍紀錄</p>
                  {pauseModalVendor.pauseHistory.map((rec, i) => (
                    <p key={i} className="text-xs text-gray-600">
                      {rec.from} ～ {rec.until || '（尚未恢復）'}
                    </p>
                  ))}
                </div>
              )}
              <div className="flex justify-end space-x-3 pt-2">
                <button
                  onClick={() => setPauseModalVendor(null)}
                  className="px-6 py-2 text-gray-500 font-medium"
                >
                  取消
                </button>
                <button
                  onClick={handleConfirmPause}
                  className="bg-cyan-600 text-white px-6 py-2 rounded-xl font-bold shadow-lg hover:bg-cyan-700"
                >
                  確定冷凍
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Editor Management Modal */}
      {isEditorModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-[#F5F5F0]/50">
              <h3 className="text-xl font-bold serif text-[#5A5A40]">外包剪輯師管理</h3>
              <button onClick={() => setIsEditorModalOpen(false)} className="p-2 hover:bg-white rounded-full transition-colors">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-6">
              <div className="flex gap-2">
                <input 
                  type="text"
                  placeholder="輸入剪輯師姓名"
                  value={newEditorName}
                  onChange={(e) => setNewEditorName(e.target.value)}
                  className="flex-1 p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                />
                <button 
                  onClick={handleAddEditor}
                  className="bg-[#5A5A40] text-white px-4 rounded-xl font-bold hover:bg-[#4a4a35] transition-colors"
                >
                  新增
                </button>
              </div>
              
              <div className="max-h-[300px] overflow-y-auto space-y-2 pr-2">
                {editors.map(ed => (
                  <div key={ed.id} className="flex justify-between items-center p-3 bg-[#F5F5F0] rounded-xl group">
                    <span className="font-bold text-[#5A5A40]">{ed.name}</span>
                    <button 
                      onClick={() => handleDeleteEditor(ed.id!)}
                      className="text-red-400 hover:text-red-600 p-1 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                {editors.length === 0 && (
                  <div className="text-center py-8 text-gray-400 text-sm italic">
                    尚未建立剪輯師資料
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
