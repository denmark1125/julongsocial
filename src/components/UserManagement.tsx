import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  updateDoc, 
  doc, 
  deleteDoc,
  setDoc,
  getDocs
} from 'firebase/firestore';
import { initializeApp, getApps, getApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { db } from '../firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import { UserProfile, UserRole, LineConnection, FirestoreErrorInfo, OperationType } from '../types';
import { Shield, User, Trash2, Edit2, X, Plus, Key, Mail, UserPlus, MessageCircle, Link as LinkIcon, Unlink } from 'lucide-react';
import { auth as firebaseAuth } from '../firebase';
import toast from 'react-hot-toast';
import { format, parseISO } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { PASSWORD_SUFFIX, ADMIN_USERNAME } from '../constants';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function UserManagement({ currentUserRole }: { currentUserRole: UserRole }) {
  const [activeSubTab, setActiveSubTab] = useState<'users' | 'line'>('users');
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [lineConnections, setLineConnections] = useState<LineConnection[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    email: '',
    displayName: '',
    role: 'employee' as UserRole
  });
  const [isCreating, setIsCreating] = useState(false);
  const [resettingUid, setResettingUid] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    console.log('Current Project ID:', db.app.options.projectId);
    const handleFirestoreError = (error: any, operationType: OperationType, path: string | null) => {
      const errInfo: FirestoreErrorInfo = {
        error: error instanceof Error ? error.message : String(error),
        authInfo: {
          userId: firebaseAuth.currentUser?.uid || '',
          email: firebaseAuth.currentUser?.email || '',
          emailVerified: firebaseAuth.currentUser?.emailVerified || false,
          isAnonymous: firebaseAuth.currentUser?.isAnonymous || false,
          tenantId: firebaseAuth.currentUser?.tenantId || '',
          providerInfo: firebaseAuth.currentUser?.providerData.map(provider => ({
            providerId: provider.providerId,
            displayName: provider.displayName || '',
            email: provider.email || '',
            photoUrl: provider.photoURL || ''
          })) || []
        },
        operationType,
        path
      };
      console.error(`Firestore Error (${operationType}):`, JSON.stringify(errInfo, null, 2));
      return errInfo;
    };

    const q = query(collection(db, 'users'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setUsers(snapshot.docs.map(doc => doc.data() as UserProfile));
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'users');
    });

    const lq = query(collection(db, 'line_connections'));
    const lUnsubscribe = onSnapshot(lq, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as LineConnection));
      console.log('LINE Connections data received:', data);
      setLineConnections(data);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'line_connections');
      toast.error(`無法讀取 LINE 串接資料 (${error.code || '權限錯誤'})`);
    });

    return () => {
      unsubscribe();
      lUnsubscribe();
    };
  }, []);

  const handleBindLineUser = async (connectionId: string, systemUid: string) => {
    try {
      const connection = lineConnections.find(lc => lc.id === connectionId);
      if (!connection) return;

      const lineUid = connection.id || (connection.UserId?.startsWith('U') ? connection.UserId : connection.lineUserId);

      // Update line_connections document
      await updateDoc(doc(db, 'line_connections', connectionId), { UserId: systemUid });
      
      // Update system user document
      await updateDoc(doc(db, 'users', systemUid), { lineUserId: lineUid });
      
      toast.success('綁定成功');
    } catch (error) {
      console.error('Binding error:', error);
      toast.error('綁定失敗');
    }
  };

  const handleUnbindLineUser = async (connectionId: string, systemUid: string) => {
    try {
      await updateDoc(doc(db, 'line_connections', connectionId), { UserId: '' });
      await updateDoc(doc(db, 'users', systemUid), { lineUserId: '' });
      
      toast.success('已解除綁定');
    } catch (error) {
      console.error('Unbinding error:', error);
      toast.error('解除綁定失敗');
    }
  };

  const handleUpdateRole = async (uid: string, newRole: UserRole) => {
    try {
      await updateDoc(doc(db, 'users', uid), { role: newRole });
      toast.success('權限已更新');
    } catch (error) {
      toast.error('更新失敗');
    }
  };

  const handleToggleDeficitPermission = async (uid: string, allowed: boolean) => {
    try {
      await updateDoc(doc(db, 'users', uid), { canEditDeficitBaseline: allowed });
      toast.success(allowed ? '已開放校正起始欠片權限' : '已收回校正起始欠片權限');
    } catch (error) {
      toast.error('更新失敗');
    }
  };

  const handleDeleteUser = async (uid: string) => {
    if (window.confirm('確定要刪除此使用者嗎？')) {
      try {
        await deleteDoc(doc(db, 'users', uid));
        toast.success('已刪除');
      } catch (error) {
        toast.error('刪除失敗');
      }
    }
  };

  const handleResetPassword = async (uid: string) => {
    if (!newPassword) {
      toast.error('請輸入新密碼');
      return;
    }

    setIsResetting(true);
    try {
      const auth = getAuth();
      const idToken = await auth.currentUser?.getIdToken();
      
      if (!idToken) {
        toast.error('認證失敗，請重新登入');
        return;
      }

      const controller = new AbortController();
      const signal = controller.signal;

      const response = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          targetUid: uid,
          newPassword: newPassword + PASSWORD_SUFFIX
        }),
        signal
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('Server returned non-JSON response:', text);
        throw new Error('伺服器發生錯誤，請稍後再試');
      }

      if (data.success) {
        toast.success('密碼重設成功');
        setResettingUid(null);
        setNewPassword('');
      } else {
        throw new Error(data.error || '重設失敗');
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Password reset request was aborted');
        return;
      }
      console.error('Reset password error:', error);
      toast.error(`重設失敗: ${error.message}`);
    } finally {
      setIsResetting(false);
    }
  };
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUser.username || !newUser.password || !newUser.displayName) {
      toast.error('請填寫必要欄位');
      return;
    }

    if (newUser.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
      toast.error('此帳號為系統保留，請使用其他帳號');
      return;
    }

    setIsCreating(true);
    let secondaryApp;
    try {
      // Use a secondary app instance to create user without logging out current admin
      const appName = `Secondary-${Date.now()}`;
      secondaryApp = initializeApp(firebaseConfig, appName);
      const secondaryAuth = getAuth(secondaryApp);
      
      // Use dummy domain for username login
      const loginEmail = `${newUser.username.toLowerCase()}@forest.system`;
      // Support any password length by adding a suffix internally
      const securePassword = newUser.password + PASSWORD_SUFFIX;
      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, loginEmail, securePassword);
      const uid = userCredential.user.uid;

      // Create user profile in Firestore
      await setDoc(doc(db, 'users', uid), {
        uid,
        username: newUser.username,
        email: newUser.email || '',
        displayName: newUser.displayName,
        role: newUser.role,
        createdAt: new Date().toISOString()
      });

      // Sign out from secondary app to cleanup
      await signOut(secondaryAuth);
      
      toast.success('帳號建立成功');
      setIsModalOpen(false);
      setNewUser({ username: '', password: '', email: '', displayName: '', role: 'employee' });
    } catch (error: any) {
      console.error('Create user error:', error);
      toast.error(`建立失敗: ${error.message}`);
    } finally {
      if (secondaryApp) {
        await deleteApp(secondaryApp);
      }
      setIsCreating(false);
    }
  };

  const roleLabels: Record<UserRole, string> = {
    engineer: '工程師',
    manager: '主管',
    employee: '員工'
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex bg-white p-1 rounded-2xl border border-black/5 shadow-sm">
          <button
            onClick={() => setActiveSubTab('users')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center space-x-2",
              activeSubTab === 'users' ? "bg-[#5A5A40] text-white shadow-md" : "text-gray-400 hover:bg-gray-50"
            )}
          >
            <User size={18} />
            <span>成員管理</span>
          </button>
          <button
            onClick={() => setActiveSubTab('line')}
            className={cn(
              "px-6 py-2 rounded-xl text-sm font-bold transition-all flex items-center space-x-2",
              activeSubTab === 'line' ? "bg-[#5A5A40] text-white shadow-md" : "text-gray-400 hover:bg-gray-50"
            )}
          >
            <MessageCircle size={18} />
            <span>LINE 串接管理</span>
          </button>
        </div>

        {activeSubTab === 'users' && (currentUserRole === 'engineer' || currentUserRole === 'manager') && (
          <button 
            onClick={() => setIsModalOpen(true)}
            className="bg-[#5A5A40] text-white px-6 py-2 rounded-xl font-bold shadow-lg hover:bg-[#4a4a35] transition-all flex items-center space-x-2"
          >
            <UserPlus size={20} />
            <span>新增成員帳號</span>
          </button>
        )}
      </div>

      {activeSubTab === 'users' ? (
        <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#F5F5F0] border-b border-black/5">
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">使用者</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">帳號</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">電子郵件</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">LINE 狀態</th>
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">目前權限</th>
                {currentUserRole === 'engineer' && (
                  <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">校正起始欠片</th>
                )}
                <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {users.map((user) => {
                const linkedConnection = lineConnections.find(lc => lc.lineUserId === user.lineUserId);
                return (
                  <tr key={user.uid} className="hover:bg-gray-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center">
                        <div className="w-8 h-8 bg-[#5A5A40]/10 rounded-full flex items-center justify-center text-[#5A5A40] mr-3 overflow-hidden">
                          {linkedConnection?.linePictureUrl ? (
                            <img src={linkedConnection.linePictureUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <User size={16} />
                          )}
                        </div>
                        <span className="font-medium">{user.displayName || '未設定名稱'}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-gray-600 font-mono">{user.username}</td>
                    <td className="p-4 text-sm text-gray-600">{user.email || '-'}</td>
                    <td className="p-4">
                      {user.lineUserId ? (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 border border-green-200">
                          已綁定 LINE
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-400 border border-gray-200">
                          未綁定
                        </span>
                      )}
                    </td>
                    <td className="p-4">
                      <select 
                        value={user.role}
                        onChange={(e) => handleUpdateRole(user.uid, e.target.value as UserRole)}
                        className="bg-[#F5F5F0] border-none rounded-lg text-xs font-bold px-3 py-1 outline-none focus:ring-2 focus:ring-[#5A5A40]"
                        disabled={currentUserRole !== 'engineer' && currentUserRole !== 'manager'}
                      >
                        <option value="employee">員工</option>
                        <option value="manager">主管</option>
                        <option value="engineer">工程師</option>
                      </select>
                    </td>
                    {currentUserRole === 'engineer' && (
                      <td className="p-4">
                        {user.role === 'engineer' ? (
                          <span className="text-xs text-gray-300">工程師預設可改</span>
                        ) : (
                          <label className="inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!user.canEditDeficitBaseline}
                              onChange={(e) => handleToggleDeficitPermission(user.uid, e.target.checked)}
                              className="w-4 h-4 rounded border-gray-300 text-[#5A5A40] focus:ring-[#5A5A40]"
                            />
                            <span className="ml-2 text-xs text-gray-500">{user.canEditDeficitBaseline ? '已開放' : '未開放'}</span>
                          </label>
                        )}
                      </td>
                    )}
                    <td className="p-4">
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => setResettingUid(user.uid)}
                          className="p-2 text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                          title="重設密碼"
                        >
                          <Key size={16} />
                        </button>
                        {currentUserRole === 'engineer' && (
                          <button 
                            onClick={() => handleDeleteUser(user.uid)}
                            className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                            title="刪除帳號"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
          <div className="p-6 border-b border-black/5 bg-[#F5F5F0]/50">
            <h3 className="text-lg font-bold serif text-[#5A5A40]">待綁定 LINE 使用者</h3>
            <p className="text-xs text-gray-500 mt-1">當員工加入官方 LINE 後，系統會在此顯示其資訊，請將其與系統帳號進行綁定。</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F5F5F0] border-b border-black/5">
                  <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">LINE 頭像</th>
                  <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">LINE 名稱</th>
                  <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">LINE UID</th>
                  <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">加入時間</th>
                  <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">綁定狀態</th>
                  <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5">
                {lineConnections.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-12 text-center text-gray-400 italic">
                      目前尚無 LINE 使用者資料
                    </td>
                  </tr>
                ) : (
                  lineConnections.map((connection) => {
                    // Flexible field mapping based on screenshot
                    const lineUid = connection.id || (connection.UserId?.startsWith('U') ? connection.UserId : connection.lineUserId);
                    const displayName = connection.lineDisplayName || (connection.lineUserId?.startsWith('U') ? '未知名稱' : connection.lineUserId) || '未知名稱';
                    const createdAt = connection.createdAt || (connection as any).timestamp;
                    
                    // Check if UserId is a system UID (not a LINE UID starting with U)
                    const isSystemUid = connection.UserId && !connection.UserId.startsWith('U');
                    const linkedUser = isSystemUid ? users.find(u => u.uid === connection.UserId) : null;
                    
                    return (
                      <tr key={connection.id} className="hover:bg-gray-50 transition-colors">
                        <td className="p-4">
                          <div className="w-12 h-12 rounded-2xl overflow-hidden bg-gray-100 border border-black/5 shadow-sm">
                            {connection.linePictureUrl ? (
                              <img src={connection.linePictureUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-300">
                                <User size={24} />
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="p-4 font-bold text-[#5A5A40]">{displayName}</td>
                        <td className="p-4 text-xs text-gray-400 font-mono">{lineUid}</td>
                        <td className="p-4 text-xs text-gray-500">
                          {(() => {
                            if (!createdAt) return '-';
                            try {
                              // Handle Firestore Timestamp
                              if (typeof createdAt !== 'string' && (createdAt as any)?.toDate) {
                                return format((createdAt as any).toDate(), 'yyyy/MM/dd HH:mm');
                              }
                              // Handle JS Date
                              if (createdAt instanceof Date) {
                                return format(createdAt, 'yyyy/MM/dd HH:mm');
                              }
                              // Handle String
                              if (typeof createdAt === 'string') {
                                if (createdAt.includes('年')) return createdAt;
                                return format(parseISO(createdAt), 'yyyy/MM/dd HH:mm');
                              }
                              return '-';
                            } catch (e) {
                              console.error('Date formatting error:', e);
                              return '-';
                            }
                          })()}
                        </td>
                        <td className="p-4">
                          {linkedUser ? (
                            <div className="flex items-center space-x-2">
                              <span className="bg-green-100 text-green-700 text-[10px] px-2 py-0.5 rounded-full font-bold border border-green-200">
                                已綁定：{linkedUser.displayName}
                              </span>
                            </div>
                          ) : (
                            <span className="bg-gray-100 text-gray-400 text-[10px] px-2 py-0.5 rounded-full font-bold border border-gray-200">
                              尚未綁定
                            </span>
                          )}
                        </td>
                        <td className="p-4">
                          {linkedUser ? (
                            <button 
                              onClick={() => handleUnbindLineUser(connection.id!, linkedUser.uid)}
                              className="flex items-center space-x-1 text-red-500 hover:text-red-700 text-xs font-bold transition-colors"
                            >
                              <Unlink size={14} />
                              <span>解除綁定</span>
                            </button>
                          ) : (
                            <div className="flex items-center space-x-2">
                              <select 
                                className="bg-[#F5F5F0] border-none rounded-lg text-xs font-bold px-3 py-1.5 outline-none focus:ring-2 focus:ring-[#5A5A40] min-w-[120px]"
                                onChange={(e) => {
                                  if (e.target.value) {
                                    handleBindLineUser(connection.id!, e.target.value);
                                  }
                                }}
                                defaultValue=""
                              >
                                <option value="" disabled>選擇成員...</option>
                                {users
                                  .filter(u => !u.lineUserId)
                                  .map(u => (
                                    <option key={u.uid} value={u.uid}>{u.displayName}</option>
                                  ))
                                }
                              </select>
                              <LinkIcon size={14} className="text-gray-300" />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[40px] w-full max-w-md p-8 space-y-6 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="text-2xl font-bold serif text-[#5A5A40]">新增成員帳號</h3>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full">
                <X size={24} />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">顯示名稱</label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                  <input 
                    type="text"
                    required
                    className="w-full pl-12 pr-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="例如：王小明"
                    value={newUser.displayName}
                    onChange={(e) => setNewUser({...newUser, displayName: e.target.value})}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">登入帳號</label>
                <div className="relative">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                  <input 
                    type="text"
                    required
                    className="w-full pl-12 pr-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="例如：david"
                    value={newUser.username}
                    onChange={(e) => setNewUser({...newUser, username: e.target.value})}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">設定密碼</label>
                <div className="relative">
                  <Key className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                  <input 
                    type="password"
                    required
                    className="w-full pl-12 pr-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="請輸入密碼"
                    value={newUser.password}
                    onChange={(e) => setNewUser({...newUser, password: e.target.value})}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">電子郵件 (選填)</label>
                <div className="relative">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                  <input 
                    type="email"
                    className="w-full pl-12 pr-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="user@example.com"
                    value={newUser.email}
                    onChange={(e) => setNewUser({...newUser, email: e.target.value})}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">初始權限</label>
                <select 
                  className="w-full px-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                  value={newUser.role}
                  onChange={(e) => setNewUser({...newUser, role: e.target.value as UserRole})}
                >
                  <option value="employee">員工</option>
                  <option value="manager">主管</option>
                  <option value="engineer">工程師</option>
                </select>
              </div>

              <div className="pt-4 flex space-x-3">
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 py-4 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
                >
                  取消
                </button>
                <button 
                  type="submit"
                  disabled={isCreating}
                  className="flex-1 bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-xl hover:bg-[#4a4a35] transition-all disabled:opacity-50"
                >
                  {isCreating ? '建立中...' : '確認建立'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resettingUid && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[40px] w-full max-w-md p-8 space-y-6 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="text-2xl font-bold serif text-[#5A5A40]">重設成員密碼</h3>
              <button onClick={() => { setResettingUid(null); setNewPassword(''); }} className="p-2 hover:bg-gray-100 rounded-full">
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-bold text-gray-600 ml-1">新密碼</label>
                <div className="relative">
                  <Key className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                  <input 
                    type="password"
                    required
                    className="w-full pl-12 pr-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="請輸入新密碼"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
              </div>

              <div className="pt-4 flex space-x-3">
                <button 
                  type="button"
                  onClick={() => { setResettingUid(null); setNewPassword(''); }}
                  className="flex-1 py-4 rounded-2xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
                >
                  取消
                </button>
                <button 
                  onClick={() => handleResetPassword(resettingUid)}
                  disabled={isResetting}
                  className="flex-1 bg-[#5A5A40] text-white py-4 rounded-2xl font-bold shadow-xl hover:bg-[#4a4a35] transition-all disabled:opacity-50"
                >
                  {isResetting ? '重設中...' : '確認重設'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
