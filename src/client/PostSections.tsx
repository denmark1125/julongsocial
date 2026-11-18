import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ClientPost, clientSections } from '../lib/clientPortal';
import PostRow from './PostRow';
import { ACTION } from './shared';

/**
 * 依「要不要業主動手」分段的貼文清單（使用者 11-16）：等您處理 → 接下來 → 已發布（預設收起來）。
 * 行事曆下方的手機清單與「貼文管理」共用，兩邊順序一定一樣。
 * 只剩已發布（例如看上個月）時，已發布直接攤開，不讓人面對一個空畫面。
 */
export default function PostSections({ posts, onOpen, showCaption = false, twoCols = false }: {
  posts: ClientPost[];
  onOpen: (p: ClientPost) => void;
  showCaption?: boolean;
  twoCols?: boolean;
}) {
  const { todo, upcoming, done } = clientSections(posts);
  const onlyDone = !todo.length && !upcoming.length;
  const [showDone, setShowDone] = useState(false);
  // grid-cols-1＝minmax(0,1fr)：不寫的話長片名（單行截斷）會把格子撐寬，手機整頁可以左右滑（11-16 大發實測）
  const grid = twoCols ? 'grid grid-cols-1 gap-3 md:grid-cols-2' : 'grid grid-cols-1 gap-3';
  const list = (items: ClientPost[]) => (
    <div className={grid}>
      {items.map(p => <React.Fragment key={p.id}><PostRow post={p} onOpen={onOpen} showCaption={showCaption} /></React.Fragment>)}
    </div>
  );
  const title = (text: string, n: number, cls = 'text-gray-600') => (
    <h2 className={`text-[15px] font-bold px-1 whitespace-nowrap ${cls}`}>{text}<span className="ml-1.5 font-normal text-gray-400">{n}</span></h2>
  );

  if (!posts.length) return <p className="text-center text-gray-400 py-10 text-[15px]">這個月還沒有排程</p>;

  return (
    <div className="space-y-5">
      {todo.length > 0 && <section className="space-y-3">{title('等您處理', todo.length, ACTION.text)}{list(todo)}</section>}
      {upcoming.length > 0 && <section className="space-y-3">{title('接下來', upcoming.length)}{list(upcoming)}</section>}
      {done.length > 0 && (
        <section className="space-y-3">
          {onlyDone ? title('已發布', done.length) : (
            <button type="button" onClick={() => setShowDone(v => !v)}
              className="w-full flex items-center justify-between bg-white rounded-xl border border-[#E4E2D8] px-4 py-3 text-[15px] font-bold text-gray-600">
              <span className="whitespace-nowrap">已發布<span className="ml-1.5 font-normal text-gray-400">{done.length}</span></span>
              <span className="flex items-center gap-1 text-[14px] font-normal text-gray-400 whitespace-nowrap">
                {showDone ? '收起' : '展開'}<ChevronDown size={18} className={showDone ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </span>
            </button>
          )}
          {(onlyDone || showDone) && list(done)}
        </section>
      )}
    </div>
  );
}
