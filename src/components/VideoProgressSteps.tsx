import React from 'react';
import { format, parseISO } from 'date-fns';
import { CheckCircle2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Asset, Post, deriveFlowStage } from '../types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── 單支片進度（使用者 11-03：行事曆點下去看每支片卡在哪，比照剪輯費的圓圈流程）──
// 五站：拍攝 → 剪輯 → 業主審片 → 小編排程 → 發布。資料來源：貼文狀態＋綁定素材的 flowStage（deriveFlowStage）。
export const VIDEO_STEPS = ['拍攝', '剪輯', '業主審片', '小編排程', '發布'];

export function videoProgress(p: Post, asset: Asset | undefined, today: string, editorName: (a: Asset) => string, internal = false): { current: number; note: string } {
  const date = p.scheduledAt ? format(parseISO(p.scheduledAt), 'yyyy-MM-dd') : '';
  const when = date ? format(parseISO(date), 'M/d') : '';
  if (p.status === 'published' || (p.status === 'scheduled' && date < today)) return { current: 5, note: `${when} 已發布` };
  if (p.status === 'scheduled') return { current: 4, note: `已排程，${when} 自動發布` };
  const who = (a: Asset) => { const n = editorName(a); return n ? `（${n}）` : ''; };
  if (!asset) return { current: 0, note: '還沒有素材：等拍攝或等小編指派毛片' };
  switch (deriveFlowStage(asset)) {
    case 'to_edit': return { current: 1, note: `剪輯中${who(asset)}` };
    case 'revising': return { current: 1, note: `業主要改，剪輯師修改中${who(asset)}` };
    case 'client_review': return { current: 2, note: '剪好了，等業主審片' };
    // 內部剪輯不用上傳雲端，業主通過就是等小編（舊資料可能還停在 to_upload）
    case 'to_upload': return internal
      ? { current: 3, note: '業主已通過（內部剪輯），等小編排程發布' }
      : { current: 2, note: `業主已通過，等剪輯師上傳雲端${who(asset)}` };
    case 'ready': return { current: 3, note: '片已完成，等小編排程發布' };
  }
}

export function VideoSteps({ current }: { current: number }) {
  return (
    <div className="flex items-start">
      {VIDEO_STEPS.map((label, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <React.Fragment key={label}>
            <div className="flex flex-col items-center w-[52px] sm:w-[72px] shrink-0">
              <div className="relative">
                {now && <span className="absolute inset-0 rounded-full bg-orange-400 animate-ping opacity-40" />}
                <div className={cn('relative w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-bold border-2',
                  now ? 'bg-orange-500 border-orange-500 text-white' : done ? 'bg-[#5A5A40] border-[#5A5A40] text-white' : 'bg-white border-gray-200 text-gray-300')}>
                  {done ? <CheckCircle2 size={16} /> : i + 1}
                </div>
              </div>
              <p className={cn('mt-1.5 text-[12px] font-bold whitespace-nowrap', now ? 'text-orange-700' : done ? 'text-[#5A5A40]' : 'text-gray-400')}>{label}</p>
            </div>
            {i < VIDEO_STEPS.length - 1 && <div className={cn('flex-1 h-[3px] mt-[15px] rounded-full', i < current ? 'bg-[#5A5A40]' : 'bg-gray-200')} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

