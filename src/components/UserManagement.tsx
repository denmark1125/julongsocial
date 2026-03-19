import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  updateDoc, 
  doc, 
  deleteDoc,
  setDoc
} from 'firebase/firestore';
import { initializeApp, getApps, getApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { db } from '../firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import { UserProfile, UserRole } from '../types';
import { Shield, User, Trash2, Edit2, X, Plus, Key, Mail, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';

export default function UserManagement({ currentUserRole }: { currentUserRole: UserRole }) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    email: '',
    displayName: '',
    role: 'employee' as UserRole
  });
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setUsers(snapshot.docs.map(doc => doc.data() as UserProfile));
    });
    return () => unsubscribe();
  }, []);

  const handleUpdateRole = async (uid: string, newRole: UserRole) => {
    try {
      await updateDoc(doc(db, 'users', uid), { role: newRole });
      toast.success('權限已更新');
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

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUser.username || !newUser.password || !newUser.displayName) {
      toast.error('請填寫必要欄位');
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
      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, loginEmail, newUser.password);
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
      <div className="flex justify-between items-center">
        <p className="text-gray-500">管理系統成員權限與帳號狀態</p>
        {(currentUserRole === 'engineer' || currentUserRole === 'manager') && (
          <button 
            onClick={() => setIsModalOpen(true)}
            className="bg-[#5A5A40] text-white px-6 py-2 rounded-xl font-bold shadow-lg hover:bg-[#4a4a35] transition-all flex items-center space-x-2"
          >
            <UserPlus size={20} />
            <span>新增成員帳號</span>
          </button>
        )}
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-[#F5F5F0] border-b border-black/5">
              <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">使用者</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">帳號</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">電子郵件</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">目前權限</th>
              <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5">
            {users.map((user) => (
              <tr key={user.uid} className="hover:bg-gray-50 transition-colors">
                <td className="p-4">
                  <div className="flex items-center">
                    <div className="w-8 h-8 bg-[#5A5A40]/10 rounded-full flex items-center justify-center text-[#5A5A40] mr-3">
                      <User size={16} />
                    </div>
                    <span className="font-medium">{user.displayName || '未設定名稱'}</span>
                  </div>
                </td>
                <td className="p-4 text-sm text-gray-600 font-mono">{user.username}</td>
                <td className="p-4 text-sm text-gray-600">{user.email || '-'}</td>
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
                <td className="p-4">
                  {currentUserRole === 'engineer' && (
                    <button 
                      onClick={() => handleDeleteUser(user.uid)}
                      className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
                    minLength={4}
                    className="w-full pl-12 pr-5 py-3 bg-[#F5F5F0] rounded-2xl border-none focus:ring-2 focus:ring-[#5A5A40]"
                    placeholder="至少 4 位數"
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
    </div>
  );
}
