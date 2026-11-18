import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { doc, getDoc } from 'firebase/firestore';
import { Send } from 'lucide-react';
import { db } from '../firebase';
import { Post } from '../types';
import { captionDateLabel } from '../lib/captionReview';

/**
 * 送業主審文案的防呆視窗（11-18，取代瀏覽器的 window.confirm）：
 * 寫清楚送到哪個群組、哪幾篇、幾個字、是不是重送，按「確定送出」才發。
 */
export interface CaptionSendTarget { name?: string; clientLineGroupId?: string }

function Dialog({ posts, vendor, done }: { posts: Post[]; vendor: CaptionSendTarget; done: (ok: boolean) => void }) {
  // 群組名稱只有主管讀得到（line_groups 規則），讀不到就寫通稱
  const [groupName, setGroupName] = useState('');
  useEffect(() => {
    if (!vendor.clientLineGroupId) return;
    getDoc(doc(db, 'line_groups', vendor.clientLineGroupId))
      .then(s => setGroupName(String(s.data()?.groupName || '')))
      .catch(() => {});
  }, [vendor.clientLineGroupId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done]);

  const resend = posts.filter(p => p.captionReview?.sentAt);
  const one = posts.length === 1 ? posts[0] : null;
  const row = 'flex gap-3 text-[15px] leading-relaxed';
  const key = 'shrink-0 w-12 text-gray-400';

  return (
    <div className="fixed inset-0 z-[100] bg-black/45 flex items-center justify-center p-4" onClick={() => done(false)}>
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl p-6" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="text-[19px] font-bold mb-4">送給業主審文案？</h3>
        <div className="space-y-1.5">
          <div className={row}><span className={key}>IP</span><span className="font-bold">{vendor.name || '—'}</span></div>
          <div className={row}><span className={key}>送到</span><span>{groupName ? `LINE 群組「${groupName}」` : '這個 IP 綁定的客戶 LINE 群組'}</span></div>
          {one ? (
            <>
              <div className={row}><span className={key}>貼文</span><span className="min-w-0 break-words">{captionDateLabel(one.scheduledAt) ? `預計 ${captionDateLabel(one.scheduledAt)}　` : ''}「{one.title || '未命名'}」</span></div>
              <div className={row}><span className={key}>文案</span><span>共 {(one.content || '').trim().length} 字，全文放進卡片</span></div>
            </>
          ) : (
            <div className={row}><span className={key}>貼文</span>
              <span className="min-w-0">{posts.length} 篇，業主可以左右滑逐篇確認
                <ul className="mt-1 text-[14px] text-gray-600 list-disc pl-5 max-h-40 overflow-y-auto">
                  {posts.map(p => <li key={p.id} className="truncate">{captionDateLabel(p.scheduledAt)}「{p.title || '未命名'}」</li>)}
                </ul>
              </span>
            </div>
          )}
        </div>
        <div className="bg-amber-50 text-amber-800 rounded-xl px-3 py-2.5 text-[14px] leading-relaxed mt-4">
          送出後業主馬上會在群組看到。
          {resend.length > 0 && <><br />{one ? '這篇之前送過，這次卡片會標「修改版」。' : `其中 ${resend.length} 篇之前送過，卡片會標「修改版」。`}</>}
        </div>
        <div className="flex gap-3 mt-5">
          <button type="button" onClick={() => done(false)} className="flex-1 py-3 rounded-xl border border-black/10 text-[15px] font-bold text-gray-600 hover:bg-gray-50">取消</button>
          <button type="button" autoFocus onClick={() => done(true)} className="flex-1 py-3 rounded-xl bg-[#5A5A40] text-white text-[15px] font-bold hover:bg-[#4A4A34] inline-flex items-center justify-center gap-2">
            <Send size={16} /> 確定送出
          </button>
        </div>
      </div>
    </div>
  );
}

/** 開防呆視窗；按「確定送出」回 true */
export function askCaptionSend(posts: Post[], vendor: CaptionSendTarget): Promise<boolean> {
  return new Promise(resolve => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (ok: boolean) => { root.unmount(); host.remove(); resolve(ok); };
    root.render(<Dialog posts={posts} vendor={vendor} done={done} />);
  });
}
