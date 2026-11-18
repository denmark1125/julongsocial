import React from 'react';
import { ChevronRight } from 'lucide-react';
import { VideoSteps } from '../components/VideoProgressSteps';
import { ClientPost, clientDayLabel } from '../lib/clientPortal';
import { ACTION, CaptionBadge, FilmPill, hhmm, needsYou, stageOf } from './shared';

/** 一篇貼文一列：上片日、片名、五站進度、狀態。行事曆（手機）與貼文管理共用 */
export default function PostRow({ post, onOpen, showCaption = false }: { post: ClientPost; onOpen: (p: ClientPost) => void; showCaption?: boolean }) {
  const s = stageOf(post);
  const day = clientDayLabel(post.scheduledAt.slice(0, 10)) || '上片日未定';
  return (
    <button type="button" onClick={() => onOpen(post)}
      className={`block w-full text-left bg-white rounded-xl border p-4 transition-colors hover:border-[#5A5A40] ${needsYou(post) ? `${ACTION.border} border-l-4 border-l-[#5A5A40]` : 'border-[#E4E2D8]'}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[14px] font-medium text-gray-600 tabular-nums whitespace-nowrap">{day} {hhmm(post)}</span>
        {post.platforms.length > 0 && <span className="text-[13px] text-gray-400 whitespace-nowrap">{post.platforms.join('／')}</span>}
        <ChevronRight size={18} className="ml-auto shrink-0 text-gray-300" />
      </div>
      <div className="mt-1 text-[16px] font-bold text-gray-900 truncate">{post.title || '（未命名）'}</div>
      <div className="mt-3"><VideoSteps current={s.current} /></div>
      {/* 影片、文案各一列（11-18 使用者：文案審核最重要，要獨立、明顯）。已發布的只留一個「已發布」 */}
      {post.status === 'published' ? (
        <div className="mt-3"><FilmPill post={post} /></div>
      ) : (
        <div className="mt-3 grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-[13px]">
          <span className="text-gray-500 font-medium">影片</span><span className="min-w-0"><FilmPill post={post} /></span>
          <span className="text-gray-500 font-medium">文案</span><span><CaptionBadge post={post} /></span>
        </div>
      )}
    </button>
  );
}
