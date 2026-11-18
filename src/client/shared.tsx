import React from 'react';
import { Check, PenLine } from 'lucide-react';
import { Asset, FLOW_STAGE_COMPAT, Post } from '../types';
import { videoProgress } from '../components/VideoProgressSteps';
import { ClientPost, clientStageLabel, clientTodo } from '../lib/clientPortal';

/**
 * 客戶端的視覺規則（11-18 第三版，使用者：顏色太雜、像 App 不像正式網頁、庫存卡太佔位置、字級層次亂）。
 * - 整頁只有一個強調色：品牌橄欖綠。要業主動手的＝橄欖綠實心；其餘狀態一律中性灰（不再用莫蘭迪多色）。
 * - 方角小圓角（面板 12px、標籤 6px）、細框、不用陰影；不用膠囊按鈕。
 * - 字級：頁名 22–26 襯線／區塊標題 16 粗／內文 15／輔助 13 灰。
 * ⚠️ 單篇詳情與手機卡片上的五站進度大圓圈不要動（使用者 11-17）。
 */
export const OLIVE = '#5A5A40';
export const LINE = 'border-[#E4E2D8]';
export const ACTION = {
  pill: 'bg-[#5A5A40] text-white',
  cell: 'bg-[#5A5A40] text-white',
  /** 要處理的卡片：橄欖細框 */
  border: 'border-[#5A5A40]/40',
  text: 'text-[#5A5A40]',
  /** 頂部「等您處理」條：白底＋左邊一條橄欖綠，不再整條深色色塊 */
  banner: 'bg-white border border-[#E4E2D8] border-l-4 border-l-[#5A5A40] text-gray-900',
  bannerTag: 'text-[#5A5A40]',
  /** 主要按鈕／次要按鈕 */
  primary: 'bg-[#5A5A40] text-white hover:bg-[#4A4A34]',
  secondary: 'bg-white text-gray-700 border border-[#D9D7CC] hover:bg-[#F5F5F0]',
};

/** 台灣今天 YYYY-MM-DD（業主一定在台灣，但手機時區可能被改過，所以不用裝置時區） */
export const taipeiToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/**
 * 這篇走到五站的哪一站＋給業主看的標籤。
 * 站別用跟公司端同一個 videoProgress()（董事行事曆、發布稽核都是它），這裡只把伺服器給的 flow 還原成它吃的形狀；
 * 文字另外用 clientStageLabel（不帶剪輯師名字與內部用語）。
 */
export function stageOf(p: ClientPost, today = taipeiToday()) {
  const stub = p.flow ? ({ flowStage: p.flow, ...FLOW_STAGE_COMPAT[p.flow] } as Asset) : undefined;
  const { current } = videoProgress(p as unknown as Post, stub, today, () => '', p.internal);
  return { current, ...clientStageLabel(p, current) };
}

/** 狀態標籤：要業主動手的＝橄欖綠實心；其餘＝灰字＋小圓點（已發布的點是橄欖綠，其他灰） */
export function StagePill({ post, size = 'md', noDetail = false }: { post: ClientPost; size?: 'sm' | 'md'; noDetail?: boolean }) {
  const s = stageOf(post);
  const fs = size === 'sm' ? 'text-[12px]' : 'text-[13px]';
  const detail = !noDetail && s.detail
    ? <span className={`text-gray-500 truncate min-w-0 ${fs}`}>{s.detail}</span> : null;
  if (s.tone === 'action') {
    return (
      <span className="inline-flex items-center gap-2 min-w-0">
        <span className={`inline-flex items-center shrink-0 rounded-md font-bold whitespace-nowrap ${ACTION.pill} ${size === 'sm' ? 'px-1.5 py-0.5 text-[12px]' : 'px-2 py-0.5 text-[13px]'}`}>{s.label}</span>
        {detail}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className={`inline-flex items-center gap-1.5 shrink-0 font-bold text-gray-700 whitespace-nowrap ${fs}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${s.tone === 'done' ? 'bg-[#5A5A40]' : 'bg-gray-400'}`} />{s.label}
      </span>
      {detail}
    </span>
  );
}

/** 只看影片這條線的狀態（文案另外一欄／一列顯示，11-18 使用者：文案審核是最重要的，要獨立明顯） */
export function filmOf(p: ClientPost, today = taipeiToday()) {
  const stub = p.flow ? ({ flowStage: p.flow, ...FLOW_STAGE_COMPAT[p.flow] } as Asset) : undefined;
  const { current } = videoProgress(p as unknown as Post, stub, today, () => '', p.internal);
  // 文案在等業主時把它當「已確認」來問影片狀態，標籤才不會又講一次文案
  return clientStageLabel({ ...p, captionState: p.captionState === 'waiting' || p.captionState === 'revising' ? 'approved' : p.captionState }, current);
}

/** 影片狀態標籤（同 StagePill 的樣式，但只講影片） */
export function FilmPill({ post, noDetail = false }: { post: ClientPost; noDetail?: boolean }) {
  const s = filmOf(post);
  if (s.tone === 'action') return <span className={`inline-flex items-center shrink-0 rounded-md px-2 py-0.5 text-[13px] font-bold whitespace-nowrap ${ACTION.pill}`}>{s.label}</span>;
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className="inline-flex items-center gap-1.5 shrink-0 text-[13px] font-bold text-gray-700 whitespace-nowrap">
        <span className={`w-1.5 h-1.5 rounded-full ${s.tone === 'done' ? 'bg-[#5A5A40]' : 'bg-gray-400'}`} />{s.label}
      </span>
      {!noDetail && s.detail && <span className="text-[13px] text-gray-500 truncate min-w-0">{s.detail}</span>}
    </span>
  );
}

/** 文案狀態：等業主確認＝橄欖綠實心大標籤（整頁最醒目）；已確認＝綠勾；準備中＝灰字 */
export function CaptionBadge({ post, size = 'md' }: { post: ClientPost; size?: 'md' | 'lg' }) {
  if (post.status === 'published') return <span className="text-[13px] text-gray-400 whitespace-nowrap">已發布</span>;
  if (post.captionState === 'waiting') {
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-md font-bold whitespace-nowrap ${ACTION.pill} ${size === 'lg' ? 'px-3 py-1.5 text-[15px]' : 'px-2.5 py-1 text-[14px]'}`}>
        <PenLine size={size === 'lg' ? 16 : 14} />等您確認
      </span>
    );
  }
  if (post.captionState === 'approved') return <span className="inline-flex items-center gap-1 text-[14px] font-bold text-[#5A5A40] whitespace-nowrap"><Check size={15} strokeWidth={3} />已確認</span>;
  if (post.captionState === 'revising') return <span className="text-[14px] text-gray-600 whitespace-nowrap">依您的意見修改中</span>;
  return <span className="text-[14px] text-gray-400 whitespace-nowrap">準備中</span>;
}

/** 手機月曆格子的時間色塊：要處理＝橄欖綠，其餘中性 */
export function cellTone(p: ClientPost): string {
  return stageOf(p).tone === 'action' ? ACTION.cell : 'bg-[#EFEEE8] text-gray-600';
}

export const needsYou = (p: ClientPost) => { const t = clientTodo(p); return t.video || t.caption; };

export const hhmm = (p: ClientPost) => (p.scheduledAt.length >= 16 ? p.scheduledAt.slice(11, 16) : '');
