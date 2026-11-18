import React from 'react';
import { Camera } from 'lucide-react';
import { ClientPortalData, ClientPost } from '../lib/clientPortal';
import { LINE, cellTone, hhmm, needsYou, stageOf, taipeiToday } from './shared';
import PostSections from './PostSections';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 上片行事曆（主角）。電腦：整月大格，格子裡直接寫時間＋片名＋狀態；手機：一欄只有約 50px 塞不下片名，
 * 格子放時間色塊，下面接「本月排程」清單（作法同剪輯師端 EditorSchedule）。拍攝日用藍色標在同一個月曆上。
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

  return (
    <div className="space-y-4">
      <div className={`bg-white rounded-xl border ${LINE} overflow-hidden`}>
        <div className={`grid grid-cols-7 bg-[#FAFAF7] border-b ${LINE}`}>
          {WEEK.map(w => <div key={w} className="py-2 text-center text-[13px] font-medium text-gray-500">{w}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            if (d === null) return <div key={`x${i}`} className="min-h-[64px] md:min-h-[120px] border-b border-r border-[#EFEDE5] bg-[#FAFAF7]" />;
            const isToday = key(d) === today;
            return (
              <div key={d} className="min-h-[64px] md:min-h-[120px] border-b border-r border-[#EFEDE5] p-1 md:p-2 min-w-0">
                <div className={`inline-flex items-center justify-center text-[13px] md:text-[14px] font-bold rounded-full w-6 h-6 md:w-7 md:h-7 ${isToday ? 'bg-[#5A5A40] text-white' : 'text-gray-600'}`}>{d}</div>
                <div className="mt-1 space-y-1">
                  {shootsOn(d).map((s, k) => (
                    <div key={`s${k}`} className="flex items-center justify-center md:justify-start gap-1 rounded-md bg-[#EFEEE8] text-gray-600 px-1 md:px-2 py-0.5 text-[12px] font-medium whitespace-nowrap overflow-hidden">
                      <Camera size={12} className="shrink-0" />
                      {/* 手機一欄約 48px 放不下時間，只標「拍」；時間看上面的「下次拍攝」或電腦版 */}
                      <span className="md:hidden">拍</span>
                      <span className="hidden md:inline truncate">拍攝{s.time ? ` ${s.time}` : ''}</span>
                    </div>
                  ))}
                  {postsOn(d).map(p => (
                    <button key={p.id} type="button" onClick={() => onOpen(p)} className="block w-full text-left min-w-0">
                      {/* 手機：只放時間色塊 */}
                      <span className={`md:hidden block rounded-md px-1 py-0.5 text-[12px] font-bold text-center whitespace-nowrap ${cellTone(p)}`}>{hhmm(p) || '上片'}</span>
                      {/* 電腦：時間＋片名＋狀態 */}
                      {/* 電腦：左邊一條細線（要您處理＝橄欖綠、其餘灰）＋時間＋片名＋狀態字，不再一格一張小卡 */}
                      <span className={`hidden md:block border-l-[3px] rounded-r-md px-2 py-1 transition-colors hover:bg-[#F2F1EA] ${needsYou(p) ? 'border-[#5A5A40] bg-[#5A5A40]/[0.06]' : 'border-[#CFCDC2] bg-[#FAFAF7]'}`}>
                        <span className="flex items-baseline gap-1.5 min-w-0">
                          <span className="text-[12px] text-gray-500 tabular-nums shrink-0">{hhmm(p)}</span>
                          <span className={`text-[12px] font-bold truncate ${needsYou(p) ? 'text-[#5A5A40]' : 'text-gray-500'}`}>{stageOf(p).label}</span>
                        </span>
                        <span className="block text-[14px] font-medium text-gray-900 truncate">{p.title || '（未命名）'}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 手機的清單；電腦月曆格子裡已經有完整資訊，就不重複列 */}
      <div className="md:hidden space-y-3">
        {/* 等您處理 → 接下來 → 已發布（收起來）。11-16 使用者：照日期從月初排，已發布佔滿上面，要處理的反而在最下面 */}
        <PostSections posts={data.posts} onOpen={onOpen} />
      </div>
      {sorted.length === 0 && <p className="hidden md:block text-center text-gray-400 py-4 text-[15px]">這個月還沒有排程</p>}
    </div>
  );
}
