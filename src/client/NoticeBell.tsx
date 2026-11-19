import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Camera, CheckCircle2, Film, PenLine, Receipt, X } from 'lucide-react';
import type { ClientNotice, ClientNoticeKind } from '../lib/clientPortal';

/**
 * 通知鈴鐺（11-19）：右上角一顆鈴鐺＋紅色數字，點開是下拉清單（手機是從頂部展開的整排）。
 * 打開頁面時有新通知，底部跳一次提示（8 秒自己消失），不擋畫面。
 * 業主沒有帳號，「看過了沒」記在他自己的瀏覽器（localStorage，每個 IP 連結各一份）；換手機會再看到一次，可以接受。
 */
const ICON: Record<ClientNoticeKind, React.ReactNode> = {
  caption: <PenLine size={16} />,
  video: <Film size={16} />,
  published: <CheckCircle2 size={16} />,
  shoot: <Camera size={16} />,
  billing: <Receipt size={16} />,
};

function ago(iso: string, now: number) {
  const diff = Math.max(0, now - Date.parse(iso));
  if (diff < 60_000) return '剛剛';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小時前`;
  const d = new Date(Date.parse(iso) + 8 * 3600_000); // 台灣時間
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const readSeen = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const writeSeen = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* 私密模式存不了，就每次都當新的 */ } };

export default function NoticeBell({ notices, storageKey, onOpenPost }: {
  notices: ClientNotice[];
  storageKey: string;
  onOpenPost: (postId: string, month?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => readSeen(storageKey));
  // 打開清單時那一刻的「上次看過」：這次打開仍標出哪些是新的，關掉後才全部變舊
  const [seenAtOpen, setSeenAtOpen] = useState(seen);
  const [toast, setToast] = useState(false);
  const toastShown = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  const now = Date.now();

  const unread = useMemo(() => notices.filter(n => n.at > seen), [notices, seen]);
  const isNew = (n: ClientNotice) => n.at > seenAtOpen;

  // 打開頁面有新通知：底部提示一次
  useEffect(() => {
    if (toastShown.current || !unread.length) return;
    toastShown.current = true;
    setToast(true);
    const t = window.setTimeout(() => setToast(false), 8000);
    return () => window.clearTimeout(t);
  }, [unread.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  });

  const markAllSeen = () => {
    const latest = notices[0]?.at || new Date().toISOString();
    const v = latest > seen ? latest : seen;
    writeSeen(storageKey, v);
    setSeen(v);
  };
  const show = () => { setSeenAtOpen(seen); setOpen(true); setToast(false); markAllSeen(); };
  const close = () => { setOpen(false); setSeenAtOpen(readSeen(storageKey)); };

  const summary = (() => {
    const todo = unread.filter(n => !n.done);
    const cap = todo.filter(n => n.kind === 'caption').length;
    const vid = todo.filter(n => n.kind === 'video').length;
    const parts = [cap ? `${cap} 篇文案等您確認` : '', vid ? `${vid} 支影片等您審片` : ''].filter(Boolean);
    return parts.length ? parts.join('、') : `${unread.length} 則新通知`;
  })();

  return (
    <div ref={wrap} className="relative">
      <button type="button" aria-label={unread.length ? `通知，${unread.length} 則新的` : '通知'} onClick={() => (open ? close() : show())}
        className={`relative p-2 rounded-lg border border-[#E4E2D8] text-gray-600 hover:bg-[#F5F5F0] ${open ? 'bg-[#F5F5F0]' : ''}`}>
        <Bell size={18} />
        {unread.length > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#D9483B] text-white text-[11px] font-bold leading-[18px] text-center tabular-nums">
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[calc(100vw-1.5rem)] max-w-[380px] z-40 bg-white rounded-xl border border-[#E4E2D8] shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#EFEDE5]">
            <span className="text-[15px] font-bold">通知</span>
            <button type="button" aria-label="關閉" onClick={close} className="p-1 -m-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>
          <div className="max-h-[min(65vh,520px)] overflow-y-auto">
            {notices.length === 0 ? (
              <p className="px-4 py-10 text-center text-[14px] text-gray-400">最近 30 天沒有通知</p>
            ) : notices.map(n => {
              const clickable = !!n.postId;
              const body = (
                <>
                  <span className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${n.done ? 'bg-[#F2F1EC] text-gray-400' : 'bg-[#5A5A40]/10 text-[#5A5A40]'}`}>{ICON[n.kind]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`text-[14px] font-bold truncate ${n.done ? 'text-gray-500' : 'text-gray-900'}`}>{n.title}</span>
                      {n.done && (n.kind === 'caption' || n.kind === 'video') && <span className="shrink-0 text-[12px] text-gray-400">已處理</span>}
                    </span>
                    <span className="block text-[13px] text-gray-500 truncate">{n.detail}</span>
                    <span className="block text-[12px] text-gray-400 mt-0.5">{ago(n.at, now)}</span>
                  </span>
                  {isNew(n) && <span aria-label="新" className="shrink-0 mt-1.5 w-2 h-2 rounded-full bg-[#D9483B]" />}
                </>
              );
              const cls = `w-full flex items-start gap-3 px-4 py-3 text-left border-b border-[#F2F1EC] last:border-b-0 ${isNew(n) ? 'bg-[#5A5A40]/[0.04]' : ''}`;
              return clickable ? (
                <button key={n.id} type="button" className={`${cls} hover:bg-[#FAFAF7]`} onClick={() => { close(); onOpenPost(n.postId!, n.month); }}>{body}</button>
              ) : <div key={n.id} className={cls}>{body}</div>;
            })}
          </div>
        </div>
      )}

      {/* 打開頁面的一次性提示：底部置中、8 秒消失，點「查看」打開清單 */}
      {toast && !open && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 w-[calc(100%-2rem)] max-w-md bg-[#2F2F25] text-white rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3">
          <Bell size={18} className="shrink-0 text-[#E9E6D5]" />
          <span className="min-w-0 flex-1 text-[14px] leading-snug">{summary}</span>
          <button type="button" onClick={show} className="shrink-0 px-3 py-1.5 rounded-lg bg-white text-[#2F2F25] text-[13px] font-bold">查看</button>
          <button type="button" aria-label="關閉" onClick={() => setToast(false)} className="shrink-0 p-1 text-white/60 hover:text-white"><X size={16} /></button>
        </div>
      )}
    </div>
  );
}
