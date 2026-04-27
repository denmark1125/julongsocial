import React, { useState, useEffect } from 'react';
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
import { Vendor, SocialAccount, OperationType, Editor } from '../types';
import { Plus, Trash2, Edit2, ExternalLink, Shield, X, Eye, EyeOff, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function VendorManagement() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditorModalOpen, setIsEditorModalOpen] = useState(false);
  const [newEditorName, setNewEditorName] = useState('');
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<Record<string, boolean>>({});
  const [visibleFormPasswords, setVisibleFormPasswords] = useState<Record<number, boolean>>({});
  const [formData, setFormData] = useState({
    name: '',
    socialAccounts: [{ platform: 'IG', username: '', password: '' }],
    postingHabits: [] as any[],
    cooperationItems: [] as string[],
    monthlyTargetPosts: 8,
    monthlyTargetVideos: 0,
    editorId: '',
    editorName: '',
    selfPublishing: false
  });

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
      const data = {
        ...formData,
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
        editorName: '',
        selfPublishing: false
      });
    } catch (error) {
      toast.error('儲存失敗');
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('確定要刪除此廠商嗎？')) {
      try {
        await deleteDoc(doc(db, 'vendors', id));
        toast.success('已刪除');
      } catch (error) {
        toast.error('刪除失敗');
      }
    }
  };

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];

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
              setFormData({ 
                name: '', 
                socialAccounts: [{ platform: 'IG', username: '', password: '' }], 
                postingHabits: [],
                cooperationItems: [],
                monthlyTargetPosts: 8,
                monthlyTargetVideos: 0,
                editorId: '',
                editorName: '',
                selfPublishing: false
              });
              setIsModalOpen(true);
            }}
            className="flex-1 sm:flex-none bg-[#5A5A40] text-white px-6 py-3 rounded-xl flex items-center justify-center shadow-lg hover:bg-[#4a4a35] transition-all"
          >
            <Plus size={20} className="mr-2" /> 建立廠商資料
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
        {vendors.map((vendor) => (
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
                      editorId: vendor.editorId || '',
                      editorName: vendor.editorName || '',
                      selfPublishing: vendor.selfPublishing || false
                    });
                    setIsModalOpen(true);
                  }}
                  className="p-2 text-blue-500 hover:bg-blue-50 rounded-lg"
                >
                  <Edit2 size={16} />
                </button>
                <button 
                  onClick={() => handleDelete(vendor.id!)}
                  className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 items-center">
                {vendor.editorName && (
                  <div className="flex items-center text-xs font-bold text-[#5A5A40] bg-[#5A5A40]/5 px-2 py-1 rounded-lg border border-[#5A5A40]/10 w-fit">
                    <span className="mr-1">剪輯師:</span>
                    <span>{vendor.editorName}</span>
                  </div>
                )}
                {vendor.selfPublishing && (
                  <div className="flex items-center text-xs font-bold text-green-600 bg-green-50 px-2 py-1 rounded-lg border border-green-100 w-fit">
                    <span>廠商自行發布</span>
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
