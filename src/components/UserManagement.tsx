import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  updateDoc, 
  doc, 
  deleteDoc 
} from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile, UserRole } from '../types';
import { Shield, User, Trash2, Edit2, X } from 'lucide-react';
import toast from 'react-hot-toast';

export default function UserManagement({ currentUserRole }: { currentUserRole: UserRole }) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);

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

  const roleLabels: Record<UserRole, string> = {
    engineer: '工程師',
    manager: '主管',
    employee: '員工'
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <p className="text-gray-500">管理系統成員權限與帳號狀態</p>
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-[#F5F5F0] border-b border-black/5">
              <th className="p-4 text-xs font-bold text-gray-500 uppercase tracking-wider">使用者</th>
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
                <td className="p-4 text-sm text-gray-600">{user.email}</td>
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
    </div>
  );
}
