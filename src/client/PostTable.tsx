import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Check } from 'lucide-react';
import { VIDEO_STEPS } from '../components/VideoProgressSteps';
import { ClientPost, clientDayLabel } from '../lib/clientPortal';
import { ACTION, CaptionBadge, FilmPill, LINE, hhmm, needsYou, stageOf, taipeiToday } from './shared';

/**
 * 電腦版貼文表格（11-18 使用者：卡片排成兩欄像手機版、不正式，也看不出實際時間先後）。
 * 一篇一列、整月照上片時間由早到晚，中間畫「今天」分隔線；要業主處理的列在原位標橄欖綠，不另外搬到最上面
 * （頂部「等您處理」橫條負責提醒）。已發布的在今天以前、預設收起來。手機版維持卡片（PostSections）。
 */
const COLS = 'grid grid-cols-[116px_52px_80px_minmax(0,1fr)_212px_204px_124px_16px] items-center gap-x-4';
const dateOf = (p: ClientPost) => p.scheduledAt.slice(0, 10);
const asc = (a: ClientPost, b: ClientPost) => (a.scheduledAt || '9').localeCompare(b.scheduledAt || '9');

/**
 * 五站縮成一條路線：圓點之間連線，走過的線是橄欖綠、目前那一站橘色實心＋橘字站名（同卡片上的五站進度）。
 * ⚠️ 11-18 曾把目前那站改成橄欖綠框想減少顏色，使用者：「原來醒目的路線指示是好的，現在看不出來進度」→ 橘色保留。
 */
function MiniSteps({ current }: { current: number }) {
  const finished = current >= VIDEO_STEPS.length;
  const label = finished ? '已發布' : VIDEO_STEPS[current];
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="flex items-center shrink-0">
        {VIDEO_STEPS.map((s, i) => (
          <React.Fragment key={s}>
            {i > 0 && <span className={`w-2.5 h-[2px] ${i <= current ? 'bg-[#5A5A40]' : 'bg-gray-200'}`} />}
            <span title={s}
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[12px] font-bold border-2 ${
                i === current ? 'bg-orange-500 border-orange-500 text-white'
                  : i < current ? 'bg-[#5A5A40] border-[#5A5A40] text-white' : 'bg-white border-gray-200 text-gray-300'}`}>
              {i < current ? <Check size={11} strokeWidth={3} /> : i + 1}
            </span>
          </React.Fragment>
        ))}
      </div>
      <span className={`text-[15px] font-bold whitespace-nowrap ${finished ? 'text-[#5A5A40]' : 'text-orange-700'}`}>{label}</span>
    </div>
  );
}

function Row({ post, onOpen }: { post: ClientPost; onOpen: (p: ClientPost) => void }) {
  const s = stageOf(post);
  const you = needsYou(post);
  return (
    <button type="button" onClick={() => onOpen(post)}
      className={`${COLS} w-full text-left px-5 py-3 border-t border-[#EFEDE5] transition-colors hover:bg-[#FAFAF7] relative ${you ? 'bg-[#5A5A40]/[0.04]' : ''}`}>
      {you && <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-[#5A5A40]" />}
      <span className="text-[17px] font-medium text-gray-900 tabular-nums whitespace-nowrap">{clientDayLabel(dateOf(post)) || '未定'}</span>
      <span className="text-[17px] tabular-nums text-gray-600 whitespace-nowrap">{hhmm(post) || '—'}</span>
      <span className="text-[15px] text-gray-500 truncate">{post.platforms.join('／') || '—'}</span>
      <span className="text-[17px] font-bold text-gray-900 truncate">{post.title || '（未命名）'}</span>
      <MiniSteps current={s.current} />
      {/* 影片狀態一欄、文案一欄（11-18 使用者：文案審核最重要，要獨立、明顯）；都單行，每列等高 */}
      <span className="min-w-0 truncate"><FilmPill post={post} /></span>
      <span><CaptionBadge post={post} /></span>
      <ChevronRight size={18} className="text-gray-300" />
    </button>
  );
}

export default function PostTable({ posts, onOpen, mode = 'timeline' }: {
  posts: ClientPost[];
  onOpen: (p: ClientPost) => void;
  /** timeline＝全部（今天分隔線＋已發布收合）；flat＝篩選後照給的順序直接列 */
  mode?: 'timeline' | 'flat';
}) {
  const [showDone, setShowDone] = useState(false);
  const today = taipeiToday();
  const sorted = [...posts].sort(asc);
  const done = sorted.filter(p => p.status === 'published');
  const rest = sorted.filter(p => p.status !== 'published');
  const dated = rest.filter(p => dateOf(p));
  const past = dated.filter(p => dateOf(p) < today);
  const future = dated.filter(p => dateOf(p) >= today);
  const undated = rest.filter(p => !dateOf(p));
  // 今天不在這個月就不畫分隔線（看上個月／下個月）
  const months = new Set(sorted.map(p => dateOf(p).slice(0, 7)).filter(Boolean));
  const showToday = months.has(today.slice(0, 7)) || (past.length > 0 && future.length > 0);
  const onlyDone = !rest.length;

  const header = (
    <div className={`${COLS} px-5 py-2.5 bg-[#FAFAF7] text-[15px] font-medium text-gray-500`}>
      <span>上片日期</span><span>時間</span><span>平台</span><span>標題</span><span>進度</span><span>影片</span><span>文案</span><span />
    </div>
  );
  const rows = (items: ClientPost[]) => items.map(p => <React.Fragment key={p.id}><Row post={p} onOpen={onOpen} /></React.Fragment>);

  return (
    <div className={`bg-white rounded-xl border ${LINE} overflow-hidden`}>
      {header}
      {mode === 'flat' ? rows(posts) : (
        <>
          {done.length > 0 && !onlyDone && (
            <button type="button" onClick={() => setShowDone(v => !v)}
              className="w-full flex items-center gap-2 px-5 py-2.5 border-t border-[#EFEDE5] text-[16px] text-gray-500 hover:bg-[#FAFAF7]">
              <ChevronDown size={16} className={showDone ? 'rotate-180 transition-transform' : 'transition-transform'} />
              <span className="font-bold">已發布 {done.length} 篇</span>
              <span className="text-gray-400">{showDone ? '收起' : '展開'}</span>
            </button>
          )}
          {(showDone || onlyDone) && rows(done)}
          {rows(past)}
          {showToday && (
            <div className="flex items-center gap-3 px-5 py-1.5 border-t border-[#EFEDE5]">
              <span className={`text-[15px] font-bold whitespace-nowrap ${ACTION.text}`}>今天 {clientDayLabel(today)}</span>
              <span className="flex-1 h-[2px] bg-[#5A5A40]/40 rounded-full" />
            </div>
          )}
          {rows(future)}
          {rows(undated)}
        </>
      )}
    </div>
  );
}
