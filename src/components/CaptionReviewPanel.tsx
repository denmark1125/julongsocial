import React, { useState } from 'react';
import { CheckSquare, Send, Square, Trash2 } from 'lucide-react';
import { Post } from '../types';
import type { CaptionSendTarget } from './CaptionSendConfirm';
import { CAPTION_STATUS_LABEL, CaptionStatus, canSendCaption, captionStatus } from '../lib/captionReview';
import { addManualFeedback, applyFeedbackAsCaption, removeFeedback, sendCaptionReview } from '../lib/captionReviewClient';

/** 狀態標籤的顏色。跟文案頁業主看到的顏色同一套：橘＝等業主、綠＝確認、紅＝業主要改 */
export const CAPTION_STATUS_STYLE: Record<CaptionStatus, string> = {
  published: 'bg-gray-100 text-gray-500',
  empty: 'bg-gray-100 text-gray-500',
  unsent: 'bg-gray-100 text-gray-600',
  sent: 'bg-amber-50 text-amber-700',
  change_requested: 'bg-rose-50 text-rose-700',
  approved: 'bg-emerald-50 text-emerald-700',
  client_edited: 'bg-emerald-50 text-emerald-700',
  changed_after: 'bg-amber-50 text-amber-700',
};

export function CaptionStatusChip({ post, className = '' }: { post: Post; className?: string }) {
  const s = captionStatus(post);
  return <span className={`inline-block px-2 py-0.5 rounded-lg text-[12px] font-bold whitespace-nowrap ${CAPTION_STATUS_STYLE[s]} ${className}`}>{CAPTION_STATUS_LABEL[s]}</span>;
}

/**
 * 貼文管理表格「客戶確認」那一格（11-18 使用者：飛機放外層，一眼看出哪篇還沒送）。
 * 勾選框照舊可以手動勾（業主在群組口頭說 OK 的）；底下依狀態放飛機／等業主／誰確認。
 */
export function CaptionConfirmCell({ post, vendor, onToggle, send }: {
  post: Post; vendor: CaptionSendTarget; onToggle: () => void;
  send: (posts: Post[], vendor: CaptionSendTarget) => void;
}) {
  const s = captionStatus(post);
  const cr = post.captionReview || {};
  const plane = (label: string, enabled = true, hint = '') => (
    <button type="button" disabled={!enabled} title={hint || undefined} onClick={() => send([post], vendor)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-bold bg-[#5A5A40] text-white hover:bg-[#4A4A34] disabled:opacity-35 disabled:cursor-not-allowed whitespace-nowrap">
      <Send size={13} /> {label}
    </button>
  );
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button aria-label="切換業主審核" onClick={onToggle}>
        {post.clientConfirmed ? <CheckSquare className="text-green-500" size={20} /> : <Square className="text-gray-300" size={20} />}
      </button>
      {s === 'published' ? null
        : post.clientConfirmed && s !== 'changed_after' ? (
          cr.approvedAt ? <span className="text-[12px] text-green-700 whitespace-nowrap">{cr.approvedByName || '業主'} {mmdd(cr.approvedAt)} 確認</span> : null
        ) : s === 'sent' ? (
          <>
            <CaptionStatusChip post={post} />
            {cr.sentAt && <span className="text-[12px] text-gray-400 whitespace-nowrap">{mmdd(cr.sentAt)} 送出</span>}
          </>
        ) : s === 'empty' ? (
          <>{plane('送業主審', false, '先寫文案才能送')}<span className="text-[12px] text-gray-400 whitespace-nowrap">先寫文案才能送</span></>
        ) : (
          <>
            {(s === 'change_requested' || s === 'changed_after') && <CaptionStatusChip post={post} />}
            {plane(cr.sentAt ? '再送一次' : '送業主審')}
          </>
        )}
    </div>
  );
}

const mmdd = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 貼文上的「業主審文案」區塊（2026-11-16）：狀態、送審、業主意見、修改紀錄。
 * 放在貼文詳情與貼文編輯視窗裡。規格見 src/lib/captionReview.ts。
 *
 * - `unsaved`：編輯視窗裡文案還沒存檔 → 不能送審（送出去的是資料庫裡那一版，會跟畫面上不一樣）。
 * - `onApplyText`：有帶＝「用這段取代文案」只把文字放進編輯視窗的輸入框，由使用者自己按儲存；
 *   沒帶＝直接改資料庫。
 */
export default function CaptionReviewPanel({ post, vendorName, unsaved = false, onApplyText }: {
  post: Post;
  vendorName: string;
  unsaved?: boolean;
  onApplyText?: (text: string) => void;
}) {
  const [note, setNote] = useState('');
  const cr = post.captionReview || {};
  const status = captionStatus(post);
  const sendable = canSendCaption(post) && !unsaved;
  const feedback = cr.feedback || [];
  const history = cr.history || [];

  return (
    <div className="rounded-2xl border border-black/5 bg-gray-50 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold text-gray-500 whitespace-nowrap">業主審文案</span>
        <CaptionStatusChip post={post} />
        {cr.sentAt && <span className="text-[12px] text-gray-400 whitespace-nowrap">送審 {mmdd(cr.sentAt)}{(cr.sendCount || 1) > 1 ? `・第 ${cr.sendCount} 次` : ''}</span>}
        {post.clientConfirmed && cr.approvedAt && <span className="text-[12px] text-gray-400 whitespace-nowrap">{cr.approvedByName || '業主'} {mmdd(cr.approvedAt)} 確認</span>}
      </div>

      {status === 'changed_after' && <p className="text-[13px] text-amber-700">業主確認之後文案有再改過。小改不用重送；改了意思請再送一次。</p>}
      {unsaved && <p className="text-[13px] text-gray-500">文案有改動，請先按儲存再送審。</p>}

      {post.status !== 'published' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!sendable} onClick={() => void sendCaptionReview([post], vendorName)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[14px] font-bold bg-[#5A5A40] text-white disabled:opacity-40 whitespace-nowrap">
            <Send size={14} /> {cr.sentAt ? '再送一次給業主' : '送業主審文案'}
          </button>
        </div>
      )}

      {feedback.length > 0 && (
        <div className="space-y-2">
          <div className="text-[13px] font-bold text-rose-700">業主意見</div>
          {feedback.map((f, i) => (
            <div key={`${f.at}-${i}`} className="bg-white rounded-xl border border-black/5 p-3">
              <div className="text-[12px] text-gray-400">{f.byName}・{mmdd(f.at)}</div>
              <div className="text-[14px] whitespace-pre-wrap break-words mt-1">{f.text}</div>
              {post.status !== 'published' && (
                <div className="flex flex-wrap gap-3 mt-2">
                  <button type="button" className="text-[13px] font-bold text-[#5A5A40] underline underline-offset-2 whitespace-nowrap"
                    onClick={() => {
                      if (!window.confirm('用業主這段文字取代整篇文案嗎？（原本的文案會留在修改紀錄）')) return;
                      if (onApplyText) onApplyText(f.text); else void applyFeedbackAsCaption(post, f.text);
                    }}>
                    用這段取代文案
                  </button>
                  <button type="button" className="inline-flex items-center gap-1 text-[13px] text-gray-400 whitespace-nowrap"
                    onClick={() => { if (window.confirm('刪除這則意見？')) void removeFeedback(post, f); }}>
                    <Trash2 size={12} /> 刪除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {post.status !== 'published' && (
        <div className="flex gap-2">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="業主在群組直接講的意見，可以貼在這裡留紀錄"
            className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-white border border-black/10 text-[14px]" />
          <button type="button" disabled={!note.trim()} onClick={() => { void addManualFeedback(post, note); setNote(''); }}
            className="px-3 py-2 rounded-xl text-[14px] font-bold bg-white border border-black/10 text-gray-600 disabled:opacity-40 whitespace-nowrap">
            貼上
          </button>
        </div>
      )}

      {history.length > 0 && (
        <details>
          <summary className="text-[13px] font-bold text-gray-500 cursor-pointer">修改紀錄（{history.length}）</summary>
          <div className="space-y-2 mt-2">
            {[...history].reverse().map((h, i) => (
              <div key={`${h.at}-${i}`} className="bg-white rounded-xl border border-black/5 p-3">
                <div className="text-[12px] text-gray-400">{h.by === 'client' ? '業主改字' : `${h.byName || '小編'}套用業主意見`}・{mmdd(h.at)}・改之前是：</div>
                <div className="text-[13px] text-gray-600 whitespace-pre-wrap break-words mt-1">{h.before || '（空白）'}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
