import React, { useState } from 'react';
import { Camera, ChevronDown, ChevronRight } from 'lucide-react';
import { LINE } from './shared';
import { ClientShoot, ClientStock, ClientStockBucket, ClientStockItem, clientDayLabel } from '../lib/clientPortal';

/**
 * 目前庫存（使用者 11-17：客戶想看拍了多少、哪些還是素材、哪些成片可以發）。
 * 三格支數＋上次／下次拍攝；點一格展開片名，每支標我們幫客戶排的上片日（不算「還能撐幾天」）。
 * 哪些片算庫存跟公司端拍攝進度頁同一套（vendorStatus.getAvailableVideoAssets），這裡只負責顯示。
 */
// 11-18：三格大方塊太佔位置、數字顏色各一色 → 改成一條橫向數據列，數字一律深色，展開的那格底下畫橄欖綠線
const BUCKETS: { id: ClientStockBucket; label: string }[] = [
  { id: 'raw', label: '素材待剪' },
  { id: 'review', label: '等您審片' },
  { id: 'ready', label: '成片可發布' },
];

const shootText = (s: ClientShoot | null) => (s ? `${clientDayLabel(s.date)}${s.time ? ` ${s.time}` : ''}` : '');

function airLabel(it: ClientStockItem): string {
  if (!it.airDate) return '還沒排上片日';
  const d = clientDayLabel(it.airDate.slice(0, 10));
  return `${d}${it.airDate.length >= 16 ? ` ${it.airDate.slice(11, 16)}` : ''} 上片`;
}

export default function StockPanel({ stock, lastShoot, nextShoot, onOpenPost }: {
  stock: ClientStock;
  lastShoot: ClientShoot | null;
  nextShoot: ClientShoot | null;
  /** 點有綁貼文的片：打開那篇（可能在別的月份） */
  onOpenPost: (postId: string, airDate: string) => void;
}) {
  const [open, setOpen] = useState<ClientStockBucket | ''>('');
  const items = open ? stock[open] : [];

  return (
    <section className={`bg-white rounded-xl border ${LINE}`}>
      <div className="flex flex-col md:flex-row md:items-stretch">
        <div className={`px-4 md:px-5 pt-3 md:py-3 flex md:flex-col justify-between md:justify-center gap-1 md:border-r ${LINE} md:w-[150px] shrink-0`}>
          <span className="text-[13px] font-medium text-gray-500 whitespace-nowrap">目前庫存</span>
          <span className="text-[15px] font-bold whitespace-nowrap tabular-nums">共 {stock.total} 支</span>
        </div>
        <div className="grid grid-cols-3 flex-1 min-w-0">
          {BUCKETS.map((b, i) => {
            const n = stock[b.id].length;
            const on = open === b.id;
            return (
              <button key={b.id} type="button" disabled={!n} onClick={() => setOpen(on ? '' : b.id)}
                className={`relative px-4 md:px-5 py-3 text-left transition-colors enabled:hover:bg-[#FAFAF7] ${i ? `border-l ${LINE}` : ''}`}>
                <div className="text-[13px] font-medium text-gray-500 whitespace-nowrap">{b.label}</div>
                <div className={`flex items-baseline gap-1 whitespace-nowrap ${n ? 'text-gray-900' : 'text-gray-300'}`}>
                  <span className="text-[22px] font-bold tabular-nums leading-tight">{n}</span>
                  <span className="text-[13px] font-medium">支</span>
                  {n > 0 && <ChevronDown size={14} className={`ml-0.5 text-gray-400 transition-transform ${on ? 'rotate-180' : ''}`} />}
                </div>
                {on && <span className="absolute left-0 right-0 bottom-0 h-[3px] bg-[#5A5A40]" />}
              </button>
            );
          })}
        </div>
        {(lastShoot || nextShoot) && (
          // 手機一行放不下上次＋下次：各自一段，放不下就換行，不截字
          <div className={`px-4 md:px-5 py-2.5 md:py-3 border-t md:border-t-0 md:border-l ${LINE} flex md:flex-col justify-center gap-x-4 gap-y-0.5 text-[13px] text-gray-600 shrink-0`}>
            <span className="flex items-center gap-1.5 text-gray-500 font-medium whitespace-nowrap"><Camera size={14} />拍攝</span>
            {lastShoot && <span className="whitespace-nowrap">上次 {shootText(lastShoot)}</span>}
            {nextShoot && <span className="whitespace-nowrap">下次 {shootText(nextShoot)}</span>}
          </div>
        )}
      </div>

      {open && (
        <ul className={`divide-y divide-[#EFEDE5] border-t ${LINE}`}>
          {items.map((it, i) => {
            const row = (
              <>
                {/* 手機一行放不下片名＋上片日（11-17 大發實測片名只剩 3 個字）：手機上下兩行，電腦同一行 */}
                <span className="min-w-0 flex-1 flex flex-col md:flex-row md:items-center md:gap-3">
                  <span className="min-w-0 md:flex-1 truncate text-[15px] font-medium text-gray-900">{it.title}</span>
                  <span className={`shrink-0 text-[13px] whitespace-nowrap tabular-nums ${it.airDate ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>{airLabel(it)}</span>
                </span>
                {it.postId && <ChevronRight size={16} className="shrink-0 text-gray-300" />}
              </>
            );
            return (
              <li key={`${it.title}-${i}`}>
                {it.postId
                  ? <button type="button" onClick={() => onOpenPost(it.postId, it.airDate)} className="w-full flex items-center gap-3 px-4 md:px-5 py-2.5 text-left hover:bg-[#FAFAF7]">{row}</button>
                  : <div className="flex items-center gap-3 px-4 md:px-5 py-2.5">{row}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
