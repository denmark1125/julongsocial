import React from 'react';
import { Post, PostStatus, Vendor, Asset } from '../types';
import { X, Calendar, Clock, Globe, CheckCircle2, FileText, Video, ExternalLink, User, Circle } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { clsx } from 'clsx';
import { setPostStatus, togglePostConfirmation, togglePostPlatformPublished, POST_STATUS_LABEL } from '../lib/postActions';
import { AUDIT_STATUS_ICON, describeAudit } from '../lib/publishAudit';
import { isClientApproved } from '../lib/assetFlow';
import { doc, updateDoc } from 'firebase/firestore';
import toast from 'react-hot-toast';
import { db } from '../firebase';

interface PostDetailModalProps {
  post: Post;
  vendor?: Vendor;
  asset?: Asset;
  onClose: () => void;
  // 有帶 assets/vendors 就進入可編輯模式（改發布狀態要靠 assets 檢查素材審核、靠 vendors 組 webhook）。
  // 沒帶就維持原本唯讀，其他地方引用這個 modal 不會被迫改。
  assets?: Asset[];
  vendors?: Vendor[];
  /** 有帶＝顯示「到貼文管理編輯」，按了跳去貼文管理並打開這篇（11-06） */
  onOpenInPosts?: (postId: string) => void;
}

/**
 * 「關聯素材」要打開的是**成片**，不是毛片資料夾（11-06 使用者：社群日曆點了只到素材）。
 * 優先序：剪輯師上傳到 IP 成片夾的檔 → 送客戶夾的副本 → 最新一版審片檔 → 預覽頁 → 最後才退回素材連結。
 */
function finishedLink(a: Asset): { url: string; label: string } | null {
  const drive = (id: string) => `https://drive.google.com/file/d/${id}/view`;
  const fin = a.finishedFiles?.[a.finishedFiles.length - 1];
  if (fin?.id) return { url: drive(fin.id), label: '看成片' };
  const copy = a.clientCopies?.[a.clientCopies.length - 1];
  if (copy?.id) return { url: drive(copy.id), label: '看成片' };
  const rev = a.reviewFiles?.[a.reviewFiles.length - 1];
  if (rev?.fileId) return { url: drive(rev.fileId), label: `看成片（審片第 ${rev.version} 版）` };
  if (rev?.previewToken) return { url: `${window.location.origin}/v/${rev.previewToken}`, label: '看成片（預覽頁）' };
  // 舊片（系統內上傳成片之前）只有一個雲端連結：是單一檔案就當成片，是資料夾就照實講
  if (a.url) {
    if (/drive\.google\.com\/file\//.test(a.url)) return { url: a.url, label: '看成片' };
    return { url: a.url, label: a.stage === 'raw' ? '素材資料夾（還沒有成片）' : '雲端資料夾' };
  }
  return null;
}

const STATUS_ORDER: PostStatus[] = ['draft', 'pending', 'scheduled', 'published'];

const STATUS_STYLE: Record<PostStatus, { active: string; idle: string; text: string }> = {
  draft:     { active: 'bg-gray-600 text-white border-gray-600',       idle: 'bg-white text-gray-500 border-black/10 hover:border-gray-400',   text: 'text-gray-600' },
  pending:   { active: 'bg-orange-500 text-white border-orange-500',   idle: 'bg-white text-gray-500 border-black/10 hover:border-orange-300', text: 'text-orange-600' },
  scheduled: { active: 'bg-blue-600 text-white border-blue-600',       idle: 'bg-white text-gray-500 border-black/10 hover:border-blue-300',   text: 'text-blue-600' },
  published: { active: 'bg-green-600 text-white border-green-600',     idle: 'bg-white text-gray-500 border-black/10 hover:border-green-300',  text: 'text-green-600' },
};

export default function PostDetailModal({ post, vendor, asset, onClose, assets, vendors, onOpenInPosts }: PostDetailModalProps) {
  const editable = !!assets && !!vendors;
  // 舊版是一串三元式，未知的 status 會落到「草稿」樣式而不會爆；改用查表後要自己補回這個保護，
  // 不然萬一哪天寫進非預期的狀態值，整個 modal 會白畫面
  const statusStyle = STATUS_STYLE[post.status] || STATUS_STYLE.draft;

  return (
    <div className="readability-surface fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-[32px] w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90dvh]">
        {/* Header */}
        <div className="p-4 sm:p-6 shrink-0 gap-2 border-b border-black/5 flex justify-between items-center bg-[#F5F5F0]/30">
          <div className="flex items-center gap-3 min-w-0">
            <div className={clsx(
              "p-2 rounded-xl shrink-0",
              post.status === 'published' ? "bg-green-100 text-green-700" :
              post.status === 'scheduled' ? "bg-blue-100 text-blue-700" :
              post.status === 'pending' ? "bg-orange-100 text-orange-700" :
              "bg-gray-100 text-gray-700"
            )}>
              {post.contentType === 'video' ? <Video size={20} /> : <FileText size={20} />}
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-lg serif leading-normal line-clamp-3 break-words">{post.title}</h3>
              <p className="text-sm text-gray-500 font-medium">{vendor?.name || '未知廠商'}</p>
              {onOpenInPosts && post.id && (
                <button type="button" onClick={() => onOpenInPosts(post.id!)} className="mt-1 text-[13px] font-bold text-[#5A5A40] underline underline-offset-2">
                  到貼文管理編輯 →
                </button>
              )}
            </div>
          </div>
          <button
            aria-label="關閉貼文詳細"
            onClick={onClose}
            className="p-2 shrink-0 hover:bg-black/5 rounded-full transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6">
          {/* 發布狀態：可編輯時直接在這裡按，不用再跑回貼文管理 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5">
              <div className="flex items-center text-[13px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                <Clock size={12} className="mr-1" /> 發布狀態
              </div>
              <div className={clsx("text-base font-bold", statusStyle.text)}>
                {POST_STATUS_LABEL[post.status] || post.status}
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5">
              <div className="flex items-center text-[13px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                <Calendar size={12} className="mr-1" /> 預計時間
              </div>
              <div className="text-base font-bold">
                {(post.scheduledAt && post.scheduledAt.length > 0) ? format(parseISO(post.scheduledAt), 'yyyy/MM/dd HH:mm') : '未安排日期 / ' + (post.targetMonth || '未設定年份')}
              </div>
            </div>
          </div>

          {editable && (
            <div>
              <div className="text-[13px] font-bold text-gray-500 uppercase tracking-wider mb-2">改成</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {STATUS_ORDER.map(s => (
                  <button
                    key={s}
                    onClick={() => { if (s !== post.status) setPostStatus(post, s, { assets: assets!, vendors: vendors! }); }}
                    disabled={s === post.status}
                    className={clsx(
                      'py-2 rounded-xl border text-sm font-bold transition-all',
                      s === post.status ? clsx(STATUS_STYLE[s].active, 'cursor-default') : STATUS_STYLE[s].idle
                    )}
                  >
                    {POST_STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
              <p className="text-[13px] text-gray-500 mt-1.5">
                要改成「已發布」必須先過業主審核，且關聯素材已通過審核。
              </p>
            </div>
          )}

          {/* 發布平台：可編輯時每個平台可單獨標記已發布 */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="flex items-center text-[13px] font-bold text-gray-500 uppercase tracking-wider">
                <Globe size={12} className="mr-1" /> 發布平台
              </div>
              {editable && post.platforms.length > 0 && (
                <span className="text-[13px] text-gray-500">
                  點一下切換該平台已發布／未發布（{(post.publishedPlatforms || []).length}/{post.platforms.length}）
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {post.platforms.length === 0 && <span className="text-sm italic text-gray-500">尚未設定平台</span>}
              {post.platforms.map(platform => {
                const done = (post.publishedPlatforms || []).includes(platform);
                if (!editable) {
                  return (
                    <span key={platform} className="px-3 py-1 bg-[#5A5A40]/10 text-[#5A5A40] rounded-full text-sm font-bold">
                      {platform}
                    </span>
                  );
                }
                return (
                  <button
                    key={platform}
                    onClick={() => togglePostPlatformPublished(post, platform)}
                    className={clsx(
                      'px-3 py-1 rounded-full text-sm font-bold border flex items-center gap-1.5 transition-all',
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
            {/* 自訂封面（2026-11-05）：另外設計的封面，封面檢查就不比第一幀 */}
            {editable && post.contentType !== 'post' && (
              <label className="mt-3 flex items-center gap-2 text-[13px] text-gray-600 cursor-pointer w-fit">
                <input
                  type="checkbox"
                  checked={!!post.customCover}
                  onChange={(e) => updateDoc(doc(db, 'posts', post.id!), { customCover: e.target.checked }).catch(err => toast.error(err.message))}
                  className="rounded border-gray-300 text-[#5A5A40] focus:ring-[#5A5A40]"
                />
                這支是另外設計的封面（不檢查是不是影片第一幀）
              </label>
            )}
            {/* 發布稽核（2026-11-05）：伺服器到點後自動比對 IG/FB，見 src/lib/publishAudit.ts */}
            {post.platforms.some(pf => post.publishAudit?.[pf]?.forScheduledAt === post.scheduledAt) && (
              <div className="mt-3 space-y-1">
                {post.platforms.map(pf => {
                  const a = post.publishAudit?.[pf];
                  if (!a || a.forScheduledAt !== post.scheduledAt || a.status === 'unsupported') return null;
                  return (
                    <div key={pf} className="flex items-center gap-2 text-[13px] text-gray-600 min-w-0">
                      <span className="font-bold whitespace-nowrap">{AUDIT_STATUS_ICON[a.status]} {pf} 稽核</span>
                      <span className="min-w-0">{describeAudit(a, post.scheduledAt, id => vendors?.find(v => v.id === id)?.name || '別的 IP')}</span>
                      {a.permalink && <a href={a.permalink} target="_blank" rel="noreferrer" className="shrink-0 text-gray-400 hover:text-[#5A5A40]">看貼文</a>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Content Body */}
          <div>
            <div className="flex items-center text-[13px] font-bold text-gray-500 uppercase tracking-wider mb-2">
              <FileText size={12} className="mr-1" /> 貼文內容
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl border border-black/5 text-base text-gray-700 whitespace-pre-wrap break-words leading-relaxed">
              {post.content || <span className="italic text-gray-500">尚無內容</span>}
            </div>
          </div>

          {/* Asset Info */}
          {asset && (
            <div>
              <div className="flex items-center text-[13px] font-bold text-gray-500 uppercase tracking-wider mb-2">
                <Video size={12} className="mr-1" /> 關聯素材
              </div>
              <div className="bg-gray-50 p-4 rounded-2xl border border-black/5 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 shrink-0 bg-black/5 rounded-lg flex items-center justify-center">
                    <Video size={18} className="text-gray-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-bold line-clamp-2 break-words">{asset.title}</p>
                    <p className="text-[13px] text-gray-500">
                      ID: {asset.id?.slice(-6)}
                      {editable && <span className={isClientApproved(asset) ? 'text-green-600 ml-1.5' : 'text-orange-500 ml-1.5'}>・{asset.stage === 'raw' ? '還在剪' : isClientApproved(asset) ? '成片已審核' : '成片待業主審'}</span>}
                    </p>
                  </div>
                </div>
                {(() => {
                  const link = finishedLink(asset);
                  return link && (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={link.label}
                      className="shrink-0 flex items-center gap-1 px-3 py-2 text-[13px] font-bold text-[#5A5A40] bg-white border border-black/10 hover:bg-[#5A5A40]/10 rounded-xl transition-colors whitespace-nowrap"
                    >
                      {link.label} <ExternalLink size={14} />
                    </a>
                  );
                })()}
              </div>
            </div>
          )}

          {/* 業主審核／內部檢核：可編輯時整塊就是切換鈕 */}
          <div className="flex flex-col sm:flex-row gap-3">
            {([
              { field: 'clientConfirmed' as const, label: '業主審核', on: '已確認', off: '待確認' },
              { field: 'internalConfirmed' as const, label: '內部檢核', on: '已檢核', off: '待檢核' },
            ]).map(({ field, label, on, off }) => {
              const done = post[field];
              const cls = clsx(
                'flex-1 flex items-center justify-center p-3 rounded-2xl border text-sm font-bold gap-2',
                done ? 'bg-green-50 text-green-700 border-green-100' : 'bg-gray-50 text-gray-500 border-gray-100',
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
        <div className="p-4 sm:p-6 shrink-0 border-t border-black/5 bg-gray-50 flex flex-wrap gap-3 justify-between items-center">
          <div className="flex items-center text-[13px] text-gray-500">
            <User size={12} className="mr-1" />
            建立於 {format(parseISO(post.createdAt), 'yyyy/MM/dd')}
          </div>
          {(() => {
            // 「前往貼文」要到真正發出去的那則貼文（11-06 使用者：點了跑到雲端，跟上面看成片重複）。
            // 優先用發布稽核查到的 IG／FB 網址；手填的「貼文位置連結」是雲端資料夾的不算貼文，不顯示
            const links = (['IG', 'FB'] as const)
              .map(pf => ({ pf, url: post.publishAudit?.[pf]?.forScheduledAt === post.scheduledAt ? post.publishAudit?.[pf]?.permalink : undefined }))
              .filter((x): x is { pf: 'IG' | 'FB'; url: string } => !!x.url);
            const manual = post.postUrl && !/drive\.google\.com|docs\.google\.com/.test(post.postUrl) ? post.postUrl : undefined;
            if (!links.length && !manual) return null;
            return (
              <div className="flex flex-wrap gap-2">
                {links.map(l => (
                  <a key={l.pf} href={l.url} target="_blank" rel="noopener noreferrer"
                    className="bg-[#5A5A40] text-white px-4 py-2 rounded-xl text-[15px] font-bold flex items-center shadow-lg hover:bg-[#4a4a35] transition-all">
                    <ExternalLink size={16} className="mr-2" /> {l.pf} 貼文
                  </a>
                ))}
                {!links.length && manual && (
                  <a href={manual} target="_blank" rel="noopener noreferrer"
                    className="bg-[#5A5A40] text-white px-6 py-2 rounded-xl text-base font-bold flex items-center shadow-lg hover:bg-[#4a4a35] transition-all">
                    <ExternalLink size={16} className="mr-2" /> 前往貼文
                  </a>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
