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
  if (p.status === 'scheduled') return { current: 4, note: `已排程・預定 ${when} 發布` };
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


/**
 * 五站進度的「一句話」改成「狀態標籤＋淡色說明」（11-06 使用者：「已排程・預定 11/6 發布」橘色粗體一整句
 * 很醜、跟圓圈顏色打架、也不好讀）。標籤講現在是哪個狀態（顏色跟著狀態走），後面灰字只補時間或原因。
 */
type Tone = 'done' | 'scheduled' | 'waiting' | 'working' | 'idle' | 'problem';
const TONE_CLASS: Record<Tone, { pill: string; dot: string }> = {
  done: { pill: 'bg-emerald-50 text-emerald-700 ring-emerald-100', dot: 'bg-emerald-500' },
  scheduled: { pill: 'bg-sky-50 text-sky-700 ring-sky-100', dot: 'bg-sky-500' },
  waiting: { pill: 'bg-amber-50 text-amber-800 ring-amber-100', dot: 'bg-amber-500' },
  working: { pill: 'bg-orange-50 text-orange-700 ring-orange-100', dot: 'bg-orange-500' },
  idle: { pill: 'bg-gray-50 text-gray-600 ring-gray-200', dot: 'bg-gray-400' },
  problem: { pill: 'bg-rose-50 text-rose-700 ring-rose-100', dot: 'bg-rose-500' },
};

export function progressStatus(current: number, note: string, scheduledAt?: string, today = format(new Date(), 'yyyy-MM-dd')): { tone: Tone; label: string; detail: string } {
  const when = scheduledAt
    ? `${scheduledAt.slice(0, 10) === today ? '今天' : format(parseISO(scheduledAt), 'M/d')} ${scheduledAt.slice(11, 16)}`
    : '';
  if (current >= 5) return { tone: 'done', label: '已發布', detail: note.includes('確認') ? '各平台已確認' : '' };
  if (current === 4) return { tone: 'scheduled', label: '已排程', detail: note.includes('後台已排好') ? `後台已排好・${when} 發布` : `${when} 發布` };
  if (current === 3) {
    const why = note.includes('・') ? note.split('・').pop()! : note.includes('等小編') ? '' : note;
    return { tone: 'waiting', label: '待小編排程', detail: why.replace(/^成片與文案皆已確認$/, '成片與文案都好了') };
  }
  if (current === 2) return { tone: 'working', label: note.includes('上傳') ? '待上傳雲端' : '待業主審片', detail: '' };
  if (current === 1) return { tone: 'working', label: note.includes('修改') ? '業主要改・修改中' : '剪輯中', detail: (note.match(/（(.+)）/) || [])[1] || '' };
  return { tone: 'idle', label: '等素材', detail: '' };
}

export function StatusPill({ tone, label, detail, size = 'md' }: { tone: Tone; label: string; detail?: string; size?: 'sm' | 'md' }) {
  const t = TONE_CLASS[tone];
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className={cn('inline-flex items-center gap-1.5 shrink-0 rounded-lg font-bold ring-1 ring-inset whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[12px]' : 'px-2.5 py-1 text-[13px]', t.pill)}>
        <span className={cn('w-1.5 h-1.5 rounded-full', t.dot)} />{label}
      </span>
      {detail && <span className={cn('text-gray-500 truncate min-w-0', size === 'sm' ? 'text-[12px]' : 'text-[13px]')}>{detail}</span>}
    </span>
  );
}
