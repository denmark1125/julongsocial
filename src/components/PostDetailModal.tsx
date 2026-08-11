import React from 'react';
import { Post, PostStatus, Vendor, Asset } from '../types';
import { X, Calendar, Clock, Globe, CheckCircle2, FileText, Video, ExternalLink, User, Circle } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { clsx } from 'clsx';
import { setPostStatus, togglePostConfirmation, togglePostPlatformPublished, POST_STATUS_LABEL } from '../lib/postActions';

interface PostDetailModalProps {
  post: Post;
  vendor?: Vendor;
  asset?: Asset;
  onClose: () => void;
  // 有帶 assets/vendors 就進入可編輯模式（改發布狀態要靠 assets 檢查素材審核、靠 vendors 組 webhook）。
  // 沒帶就維持原本唯讀，其他地方引用這個 modal 不會被迫改。
  assets?: Asset[];
  vendors?: Vendor[];
}

const STATUS_ORDER: PostStatus[] = ['draft', 'pending', 'scheduled', 'published'];

const STATUS_STYLE: Record<PostStatus, { active: string; idle: string; text: string }> = {
  draft:     { active: 'bg-gray-600 text-white border-gray-600',       idle: 'bg-white text-gray-500 border-black/10 hover:border-gray-400',   text: 'text-gray-600' },
  pending:   { active: 'bg-orange-500 text-white border-orange-500',   idle: 'bg-white text-gray-500 border-black/10 hover:border-orange-300', text: 'text-orange-600' },
  scheduled: { active: 'bg-blue-600 text-white border-blue-600',       idle: 'bg-white text-gray-500 border-black/10 hover:border-blue-300',   text: 'text-blue-600' },
  published: { active: 'bg-green-600 text-white border-green-600',     idle: 'bg-white text-gray-500 border-black/10 hover:border-green-300',  text: 'text-green-600' },
};

export default function PostDetailModal({ post, vendor, asset, onClose, assets, vendors }: PostDetailModalProps) {
  const editable = !!assets && !!vendors;
  // 舊版是一串三元式，未知的 status 會落到「草稿」樣式而不會爆；改用查表後要自己補回這個保護，
  // 不然萬一哪天寫進非預期的狀態值，整個 modal 會白畫面
  const statusStyle = STATUS_STYLE[post.status] || STATUS_STYLE.draft;

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
          {/* 發布狀態：可編輯時直接在這裡按，不用再跑回貼文管理 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5">
              <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                <Clock size={12} className="mr-1" /> 發布狀態
              </div>
              <div className={clsx("text-sm font-bold", statusStyle.text)}>
                {POST_STATUS_LABEL[post.status] || post.status}
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5">
              <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                <Calendar size={12} className="mr-1" /> 預計時間
              </div>
              <div className="text-sm font-bold">
                {(post.scheduledAt && post.scheduledAt.length > 0) ? format(parseISO(post.scheduledAt), 'yyyy/MM/dd HH:mm') : '未安排日期 / ' + (post.targetMonth || '未設定年份')}
              </div>
            </div>
          </div>

          {editable && (
            <div>
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">改成</div>
              <div className="grid grid-cols-4 gap-2">
                {STATUS_ORDER.map(s => (
                  <button
                    key={s}
                    onClick={() => { if (s !== post.status) setPostStatus(post, s, { assets: assets!, vendors: vendors! }); }}
                    disabled={s === post.status}
                    className={clsx(
                      'py-2 rounded-xl border text-xs font-bold transition-all',
                      s === post.status ? clsx(STATUS_STYLE[s].active, 'cursor-default') : STATUS_STYLE[s].idle
                    )}
                  >
                    {POST_STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">
                要改成「已發布」必須先過業主審核，且關聯素材已通過審核。
              </p>
            </div>
          )}

          {/* 發布平台：可編輯時每個平台可單獨標記已發布 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                <Globe size={12} className="mr-1" /> 發布平台
              </div>
              {editable && post.platforms.length > 0 && (
                <span className="text-[10px] text-gray-400">
                  點一下切換該平台已發布／未發布（{(post.publishedPlatforms || []).length}/{post.platforms.length}）
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {post.platforms.length === 0 && <span className="text-xs italic text-gray-400">尚未設定平台</span>}
              {post.platforms.map(platform => {
                const done = (post.publishedPlatforms || []).includes(platform);
                if (!editable) {
                  return (
                    <span key={platform} className="px-3 py-1 bg-[#5A5A40]/10 text-[#5A5A40] rounded-full text-xs font-bold">
                      {platform}
                    </span>
                  );
                }
                return (
                  <button
                    key={platform}
                    onClick={() => togglePostPlatformPublished(post, platform)}
                    className={clsx(
                      'px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 transition-all',
                      done
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-white text-gray-500 border-black/10 hover:border-[#5A5A40]'
                    )}
                  >
                    {done ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                    {platform}
                  </button>
                );
              })}
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
                    <p className="text-[10px] text-gray-400">
                      ID: {asset.id?.slice(-6)}
                      {editable && <span className={asset.approved ? 'text-green-600 ml-1.5' : 'text-orange-500 ml-1.5'}>・{asset.approved ? '素材已審核' : '素材未審核'}</span>}
                    </p>
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

          {/* 業主審核／內部檢核：可編輯時整塊就是切換鈕 */}
          <div className="flex gap-4">
            {([
              { field: 'clientConfirmed' as const, label: '業主審核', on: '已確認', off: '待確認' },
              { field: 'internalConfirmed' as const, label: '內部檢核', on: '已檢核', off: '待檢核' },
            ]).map(({ field, label, on, off }) => {
              const done = post[field];
              const cls = clsx(
                'flex-1 flex items-center justify-center p-3 rounded-2xl border text-xs font-bold gap-2',
                done ? 'bg-green-50 text-green-700 border-green-100' : 'bg-gray-50 text-gray-400 border-gray-100',
                editable && 'transition-all hover:border-[#5A5A40] cursor-pointer'
              );
              const inner = <>
                {done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                {label}: {done ? on : off}
              </>;
              return editable
                ? <button key={field} onClick={() => togglePostConfirmation(post, field)} className={cls}>{inner}</button>
                : <div key={field} className={cls}>{inner}</div>;
            })}
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
