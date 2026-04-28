import React from 'react';
import { Post, Vendor, Asset } from '../types';
import { X, Calendar, Clock, Globe, CheckCircle2, FileText, Video, ExternalLink, User } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { clsx } from 'clsx';

interface PostDetailModalProps {
  post: Post;
  vendor?: Vendor;
  asset?: Asset;
  onClose: () => void;
}

export default function PostDetailModal({ post, vendor, asset, onClose }: PostDetailModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-[32px] w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-6 border-b border-black/5 flex justify-between items-center bg-[#F5F5F0]/30">
          <div className="flex items-center space-x-3">
            <div className={clsx(
              "p-2 rounded-xl",
              post.status === 'published' ? "bg-green-100 text-green-700" : 
              post.status === 'scheduled' ? "bg-blue-100 text-blue-700" : 
              post.status === 'pending' ? "bg-orange-100 text-orange-700" :
              "bg-gray-100 text-gray-700"
            )}>
              {post.contentType === 'video' ? <Video size={20} /> : <FileText size={20} />}
            </div>
            <div>
              <h3 className="font-bold text-lg serif leading-tight">{post.title}</h3>
              <p className="text-xs text-gray-500 font-medium">{vendor?.name || '未知廠商'}</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-black/5 rounded-full transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Status & Time Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5">
              <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                <Clock size={12} className="mr-1" /> 發布狀態
              </div>
              <div className={clsx(
                "text-sm font-bold",
                post.status === 'published' ? "text-green-600" : 
                post.status === 'scheduled' ? "text-blue-600" : 
                post.status === 'pending' ? "text-orange-600" :
                "text-gray-600"
              )}>
                {post.status === 'published' ? '已發布' : post.status === 'scheduled' ? '已排程' : post.status === 'pending' ? '待補中' : '草稿'}
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5">
              <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                <Calendar size={12} className="mr-1" /> 預計時間
              </div>
              <div className="text-sm font-bold">
                {post.scheduledAt ? format(parseISO(post.scheduledAt), 'yyyy/MM/dd HH:mm') : '未安排時間'}
              </div>
            </div>
          </div>

          {/* Platforms */}
          <div>
            <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
              <Globe size={12} className="mr-1" /> 發布平台
            </div>
            <div className="flex flex-wrap gap-2">
              {post.platforms.map(platform => (
                <span key={platform} className="px-3 py-1 bg-[#5A5A40]/10 text-[#5A5A40] rounded-full text-xs font-bold">
                  {platform}
                </span>
              ))}
            </div>
          </div>

          {/* Content Body */}
          <div>
            <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
              <FileText size={12} className="mr-1" /> 貼文內容
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5 text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
              {post.content || <span className="italic text-gray-400">尚無內容</span>}
            </div>
          </div>

          {/* Asset Info */}
          {asset && (
            <div>
              <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                <Video size={12} className="mr-1" /> 關聯素材
              </div>
              <div className="bg-gray-50 p-4 rounded-2xl border border-black/5 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-black/5 rounded-lg flex items-center justify-center">
                    <Video size={18} className="text-gray-400" />
                  </div>
                  <div>
                    <p className="text-sm font-bold truncate max-w-[200px]">{asset.title}</p>
                    <p className="text-[10px] text-gray-400">ID: {asset.id?.slice(-6)}</p>
                  </div>
                </div>
                {asset.url && (
                  <a 
                    href={asset.url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="p-2 text-[#5A5A40] hover:bg-[#5A5A40]/10 rounded-xl transition-colors"
                  >
                    <ExternalLink size={18} />
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Confirmation Status */}
          <div className="flex gap-4">
            <div className={clsx(
              "flex-1 flex items-center justify-center p-3 rounded-2xl border text-xs font-bold gap-2",
              post.clientConfirmed ? "bg-green-50 text-green-700 border-green-100" : "bg-gray-50 text-gray-400 border-gray-100"
            )}>
              <CheckCircle2 size={16} />
              業主審核: {post.clientConfirmed ? '已確認' : '待確認'}
            </div>
            <div className={clsx(
              "flex-1 flex items-center justify-center p-3 rounded-2xl border text-xs font-bold gap-2",
              post.internalConfirmed ? "bg-green-50 text-green-700 border-green-100" : "bg-gray-50 text-gray-400 border-gray-100"
            )}>
              <CheckCircle2 size={16} />
              內部檢核: {post.internalConfirmed ? '已檢核' : '待檢核'}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-black/5 bg-gray-50 flex justify-between items-center">
          <div className="flex items-center text-[10px] text-gray-400">
            <User size={12} className="mr-1" />
            建立於 {format(parseISO(post.createdAt), 'yyyy/MM/dd')}
          </div>
          {post.postUrl && (
            <a 
              href={post.postUrl} 
              target="_blank" 
              rel="noopener noreferrer"
              className="bg-[#5A5A40] text-white px-6 py-2 rounded-xl text-sm font-bold flex items-center shadow-lg hover:bg-[#4a4a35] transition-all"
            >
              <ExternalLink size={16} className="mr-2" /> 前往貼文
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
