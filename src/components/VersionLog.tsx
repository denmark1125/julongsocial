import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  addDoc, 
  orderBy,
  serverTimestamp 
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { VersionLog } from '../types';
import { History, Plus, X, Terminal } from 'lucide-react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

export default function VersionLogView() {
  const [logs, setLogs] = useState<VersionLog[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({ version: '', content: '' });

  useEffect(() => {
    const q = query(collection(db, 'version_logs'), orderBy('date', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setLogs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as VersionLog)));
    });
    return () => unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;

    try {
      await addDoc(collection(db, 'version_logs'), {
        ...formData,
        date: new Date().toISOString(),
        createdBy: auth.currentUser.uid
      });
      toast.success('日誌已新增');
      setIsModalOpen(false);
      setFormData({ version: '', content: '' });
    } catch (error) {
      toast.error('新增失敗');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <p className="text-gray-500 font-mono text-sm">Engineer Only: System Update & Version Control</p>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-[#1a1a1a] text-white px-4 py-2 rounded-xl flex items-center shadow-lg hover:bg-black transition-all"
        >
          <Plus size={20} className="mr-2" /> 新增版本日誌
        </button>
      </div>

      <div className="space-y-4">
        {logs.map((log) => (
          <div key={log.id} className="bg-white p-6 rounded-3xl border border-black/5 shadow-sm hover:shadow-md transition-all">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-3">
                <div className="bg-black text-white px-3 py-1 rounded-full text-xs font-mono font-bold">
                  v{log.version}
                </div>
                <h4 className="font-bold serif">系統更新</h4>
              </div>
              <span className="text-xs text-gray-400 font-mono">{format(new Date(log.date), 'yyyy-MM-dd HH:mm')}</span>
            </div>
            <div className="bg-[#F5F5F0] p-4 rounded-2xl font-mono text-sm text-gray-700 whitespace-pre-wrap">
              {log.content}
            </div>
          </div>
        ))}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl">
            <div className="p-8">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-bold serif flex items-center">
                  <Terminal size={24} className="mr-2" /> 新增版本
                </h3>
                <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-gray-100 rounded-full">
                  <X size={24} />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">版本號</label>
                  <input 
                    type="text" 
                    required
                    value={formData.version}
                    onChange={(e) => setFormData({ ...formData, version: e.target.value })}
                    className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none font-mono"
                    placeholder="e.g. 1.0.2"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">更新內容</label>
                  <textarea 
                    rows={5}
                    required
                    value={formData.content}
                    onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                    className="w-full p-3 bg-[#F5F5F0] rounded-xl border-none font-mono resize-none"
                    placeholder="請輸入更新細節..."
                  />
                </div>
                <button 
                  type="submit"
                  className="w-full bg-black text-white py-3 rounded-xl font-bold shadow-lg"
                >
                  發布更新
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
