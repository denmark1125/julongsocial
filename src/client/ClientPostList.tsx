import React, { useState } from 'react';
import { ClientPost } from '../lib/clientPortal';
import { needsYou } from './shared';
import PostRow from './PostRow';
import PostSections from './PostSections';
import PostTable from './PostTable';

type Filter = 'all' | 'todo' | 'done';

/** 貼文管理（業主版）：當月每篇一列，可以只看「等您處理」的 */
export default function ClientPostList({ posts, onOpen }: { posts: ClientPost[]; onOpen: (p: ClientPost) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const sorted = [...posts].sort((a, b) => (a.scheduledAt || '9').localeCompare(b.scheduledAt || '9'));
  const todo = sorted.filter(needsYou);
  const done = sorted.filter(p => p.status === 'published').reverse();
  const shown = filter === 'todo' ? todo : filter === 'done' ? done : sorted;
  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: `全部 ${sorted.length}` },
    { id: 'todo', label: `等您處理 ${todo.length}` },
    { id: 'done', label: `已發布 ${done.length}` },
  ];
  return (
    <div className="space-y-3">
      {/* 篩選：一組相連的分段按鈕（11-18：膠囊一顆顆像 App） */}
      <div className="flex">
        <div className="inline-flex rounded-lg border border-[#D9D7CC] bg-white overflow-hidden">
          {chips.map((c, i) => (
            <button key={c.id} type="button" onClick={() => setFilter(c.id)}
              className={`px-3.5 py-1.5 text-[14px] whitespace-nowrap transition-colors ${i ? 'border-l border-[#D9D7CC]' : ''} ${filter === c.id ? 'bg-[#5A5A40] text-white font-bold' : 'text-gray-600 font-medium hover:bg-[#F5F5F0]'}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 && filter !== 'all' ? (
        <p className="text-center text-gray-400 py-10 text-[15px]">
          {filter === 'todo' ? '目前沒有需要您處理的事' : '這個月還沒有發布的貼文'}
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-center text-gray-400 py-10 text-[15px]">這個月還沒有排程</p>
      ) : (
        <>
          {/* 電腦版：表格照時間排（11-18）；手機版：維持卡片 */}
          <div className="hidden md:block">
            <PostTable posts={shown} onOpen={onOpen} mode={filter === 'all' ? 'timeline' : 'flat'} />
          </div>
          <div className="md:hidden">
            {filter === 'all' ? <PostSections posts={sorted} onOpen={onOpen} showCaption /> : (
              <div className="grid grid-cols-1 gap-3">
                {shown.map(p => <React.Fragment key={p.id}><PostRow post={p} onOpen={onOpen} showCaption /></React.Fragment>)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
