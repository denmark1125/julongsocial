import React, { useEffect, useState } from 'react';
import { Camera, ChevronRight } from 'lucide-react';
import { ClientPortalData, ClientPost, clientDayLabel } from '../lib/clientPortal';
import { LINE, StagePill, hhmm, needsYou, stageOf, taipeiToday } from './shared';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 上片行事曆。電腦：整月大格，格子裡直接寫時間＋片名＋狀態。
 * 手機（11-19 使用者：格子裡的時間色塊根本看不出內容）：一欄只有約 50px，改成「格子只標記、點一天看那天」——
 * 格子放日期＋小圓點（橄欖綠＝要您處理、灰＝其他、淡灰＝已發布）＋拍攝小相機；月曆下面列「選到的那一天」的貼文與拍攝，字級照正常大小。
 * 預設選今天（今天不在這個月就選這個月第一個有排程的日子）。
 */
export default function ClientCalendar({ data, onOpen }: { data: ClientPortalData; onOpen: (p: ClientPost) => void }) {
  const [y, m] = data.month.split('-').map(Number);
  const today = taipeiToday();
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const key = (d: number) => `${data.month}-${String(d).padStart(2, '0')}`;
  const sorted = [...data.posts].sort((a, b) => (a.scheduledAt || '9').localeCompare(b.scheduledAt || '9'));
  const postsOn = (d: number) => sorted.filter(p => p.scheduledAt.slice(0, 10) === key(d));
  const shootsOn = (d: number) => data.shoots.filter(s => s.date === key(d));
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);

  // 手機選到的那一天
  const pickDefault = () => {
    if (today.slice(0, 7) === data.month) return Number(today.slice(8, 10));
    const days = [...sorted.map(p => p.scheduledAt.slice(0, 10)), ...data.shoots.map(x => x.date)]
      .filter(d => d.slice(0, 7) === data.month).sort();
    return days.length ? Number(days[0].slice(8, 10)) : 1;
  };
  const [sel, setSel] = useState(pickDefault);
  useEffect(() => { setSel(pickDefault()); }, [data.month]); // eslint-disable-line react-hooks/exhaustive-deps
  const selPosts = postsOn(sel);
  const selShoots = shootsOn(sel);

  return (
    <div className="space-y-4">
      <div className={`bg-white rounded-xl border ${LINE} overflow-hidden`}>
        <div className={`grid grid-cols-7 bg-[#FAFAF7] border-b ${LINE}`}>
          {WEEK.map(w => <div key={w} className="py-2 text-center text-[15px] font-medium text-gray-500">{w}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            if (d === null) return <div key={`x${i}`} className="min-h-[56px] md:min-h-[120px] border-b border-r border-[#EFEDE5] bg-[#FAFAF7]" />;
            const isToday = key(d) === today;
            const ps = postsOn(d);
            const ss = shootsOn(d);
            const isSel = d === sel;
            return (
              <div key={d} className="min-h-[56px] md:min-h-[120px] border-b border-r border-[#EFEDE5] min-w-0">
                {/* 手機：整格是一顆按鈕，點了下面列這一天 */}
                <button type="button" onClick={() => setSel(d)} aria-label={`${m} 月 ${d} 日，${ps.length} 篇貼文${ss.length ? '，有拍攝' : ''}`}
                  className={`md:hidden w-full h-full min-h-[56px] flex flex-col items-center pt-1.5 gap-1 transition-colors ${isSel ? 'bg-[#5A5A40]/10' : 'active:bg-[#F2F1EA]'}`}>
                  <span className={`inline-flex items-center justify-center text-[16px] font-bold rounded-full w-7 h-7 ${isToday ? 'bg-[#5A5A40] text-white' : isSel ? 'text-[#5A5A40]' : 'text-gray-700'}`}>{d}</span>
                  <span className="flex items-center gap-[3px] h-3">
                    {ss.length > 0 && <Camera size={11} className="text-gray-500" />}
                    {ps.slice(0, 3).map(p => (
                      <span key={p.id} className={`w-[6px] h-[6px] rounded-full ${needsYou(p) ? 'bg-[#5A5A40]' : p.status === 'published' ? 'bg-[#C9C7BB]' : 'bg-gray-400'}`} />
                    ))}
                    {ps.length > 3 && <span className="text-[11px] leading-none text-gray-500">+</span>}
                  </span>
                </button>
                {/* 電腦：格子裡直接寫（左邊細線：要您處理＝橄欖綠、其餘灰） */}
                <div className="hidden md:block p-2">
                  <div className={`inline-flex items-center justify-center text-[16px] font-bold rounded-full w-7 h-7 ${isToday ? 'bg-[#5A5A40] text-white' : 'text-gray-600'}`}>{d}</div>
                  <div className="mt-1 space-y-1">
                    {ss.map((x, k) => (
                      <div key={`s${k}`} className="flex items-center gap-1 rounded-md bg-[#EFEEE8] text-gray-600 px-2 py-0.5 text-[14px] font-medium whitespace-nowrap overflow-hidden">
                        <Camera size={12} className="shrink-0" /><span className="truncate">拍攝{x.time ? ` ${x.time}` : ''}</span>
                      </div>
                    ))}
                    {ps.map(p => (
                      <button key={p.id} type="button" onClick={() => onOpen(p)} className="block w-full text-left min-w-0">
                        <span className={`block border-l-[3px] rounded-r-md px-2 py-1 transition-colors hover:bg-[#F2F1EA] ${needsYou(p) ? 'border-[#5A5A40] bg-[#5A5A40]/[0.06]' : 'border-[#CFCDC2] bg-[#FAFAF7]'}`}>
                          <span className="flex items-baseline gap-1.5 min-w-0">
                            <span className="text-[14px] text-gray-500 tabular-nums shrink-0">{hhmm(p)}</span>
                            <span className={`text-[14px] font-bold truncate ${needsYou(p) ? 'text-[#5A5A40]' : 'text-gray-500'}`}>{stageOf(p).label}</span>
                          </span>
                          <span className="block text-[16px] font-medium text-gray-900 truncate">{p.title || '（未命名）'}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 手機：選到的那一天（電腦月曆格子裡已經有完整資訊，不重複列） */}
      <div className={`md:hidden bg-white rounded-xl border ${LINE} overflow-hidden`}>
        <div className="px-4 py-3 border-b border-[#EFEDE5] flex items-baseline gap-2">
          <span className="text-[18px] font-bold">{clientDayLabel(key(sel))}</span>
          {key(sel) === today && <span className="text-[15px] font-bold text-[#5A5A40]">今天</span>}
          <span className="text-[15px] text-gray-400 ml-auto">{selPosts.length ? `${selPosts.length} 篇貼文` : ''}</span>
        </div>
        {selShoots.map((x, k) => (
          <div key={`s${k}`} className="flex items-center gap-3 px-4 py-3 border-b border-[#F2F1EC] text-[17px] text-gray-700">
            <span className="w-12 shrink-0 tabular-nums text-gray-500">{x.time || '整天'}</span>
            <Camera size={16} className="shrink-0 text-gray-500" />
            <span className="font-medium">{key(sel) < today || (key(sel) === today && x.done) ? '拍攝（已完成）' : '拍攝'}</span>
          </div>
        ))}
        {selPosts.map(p => (
          <button key={p.id} type="button" onClick={() => onOpen(p)}
            className={`w-full flex items-center gap-3 px-4 py-3 border-b border-[#F2F1EC] last:border-b-0 text-left active:bg-[#FAFAF7] ${needsYou(p) ? 'bg-[#5A5A40]/[0.04]' : ''}`}>
            <span className="w-12 shrink-0 tabular-nums text-[17px] text-gray-500">{hhmm(p) || '—'}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[17px] font-bold text-gray-900 truncate">{p.title || '（未命名）'}</span>
              <span className="block mt-1"><StagePill post={p} size="sm" /></span>
            </span>
            <ChevronRight size={18} className="shrink-0 text-gray-300" />
          </button>
        ))}
        {!selPosts.length && !selShoots.length && <p className="px-4 py-6 text-center text-[16px] text-gray-400">這天沒有排程</p>}
      </div>
      {sorted.length === 0 && <p className="hidden md:block text-center text-gray-400 py-4 text-[17px]">這個月還沒有排程</p>}
    </div>
  );
}
