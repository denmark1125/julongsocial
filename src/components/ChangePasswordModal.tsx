import React, { useState } from 'react';
import { X, Lock, Eye, EyeOff } from 'lucide-react';
import { auth } from '../firebase';
import { updatePassword, EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import toast from 'react-hot-toast';

interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  userEmail: string;
}

export default function ChangePasswordModal({ isOpen, onClose, userEmail }: ChangePasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('新密碼與確認密碼不符');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('新密碼長度至少需 6 位數');
      return;
    }

    setLoading(true);
    try {
      const user = auth.currentUser;
      if (!user || !user.email) throw new Error('使用者未登入');

      // Re-authenticate user first
      const credential = EmailAuthProvider.credential(user.email, currentPassword);
      await reauthenticateWithCredential(user, credential);

      // Update password
      await updatePassword(user, newPassword);
      
      toast.success('密碼修改成功');
      onClose();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error: any) {
      console.error('Change password failed:', error);
      if (error.code === 'auth/wrong-password') {
        toast.error('目前密碼錯誤');
      } else {
        toast.error(`修改失敗：${error.message}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="p-6 border-b border-black/5 flex justify-between items-center bg-[#F5F5F0]/50">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-[#5A5A40] rounded-xl">
              <Lock size={20} className="text-white" />
            </div>
            <h3 className="font-bold text-lg text-[#5A5A40]">修改登入密碼</h3>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-full transition-colors">
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">目前密碼</label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-4 py-3 bg-[#F5F5F0] border-none rounded-xl focus:ring-2 focus:ring-[#5A5A40] transition-all"
                placeholder="請輸入目前使用的密碼"
                required
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#5A5A40]"
              >
                {showCurrent ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">新密碼</label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-4 py-3 bg-[#F5F5F0] border-none rounded-xl focus:ring-2 focus:ring-[#5A5A40] transition-all"
                placeholder="請輸入新密碼 (至少 4 位)"
                required
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#5A5A40]"
              >
                {showNew ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">確認新密碼</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-3 bg-[#F5F5F0] border-none rounded-xl focus:ring-2 focus:ring-[#5A5A40] transition-all"
              placeholder="請再次輸入新密碼"
              required
            />
          </div>

          <div className="pt-4 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 border border-gray-200 text-gray-600 rounded-xl font-bold hover:bg-gray-50 transition-all"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-3 bg-[#5A5A40] text-white rounded-xl font-bold hover:bg-[#4A4A30] shadow-lg shadow-[#5A5A40]/20 transition-all disabled:opacity-50"
            >
              {loading ? '處理中...' : '確認修改'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
