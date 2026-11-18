import React, { useEffect, useState } from 'react';
import { ExternalLink, PenLine, X } from 'lucide-react';
import { VideoSteps } from '../components/VideoProgressSteps';
import { CAPTION_MAX_LEN } from '../lib/captionReview';
import { ClientPost, clientDayLabel } from '../lib/clientPortal';
import { ACTION, StagePill, hhmm, stageOf } from './shared';

/**
 * 單篇詳情：五站進度、審片、文案。業主能做的三件事都在這裡——
 * 審片通過、文案 OK、改文案（存檔即視為確認；改之前的版本伺服器會留底並通知小編）。
 * 影片要修改不在這裡填，請業主回 LINE 群組講（使用者 11-16 這一版不做意見欄）。
 */
export default function ClientPostDetail({ post, act, onClose, tiktokUrl = '' }: {
  post: ClientPost;
  /** 這個 IP 的 TikTok 帳號首頁（TikTok 拿不到單篇網址，11-18 改連首頁） */
  tiktokUrl?: string;
  /** 送出動作；成功後上層會重新抓資料 */
  act: (path: string, body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.caption);
  const [videoBroken, setVideoBroken] = useState(false);

  // 開著詳情時背景不要跟著捲（iPhone 上手指在面板外滑會捲到後面的清單）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  const s = stageOf(post);
  // TikTok 一律連帳號首頁，不放單篇（小編手貼的單篇網址常失效，業主點不開會一直問）
  const showTikTok = post.status === 'published' && post.platforms.includes('TikTok') && !!tiktokUrl;
  const postLinks = post.links.filter(l => l.pf !== 'TikTok');
  const day = clientDayLabel(post.scheduledAt.slice(0, 10)) || '上片日未定';

  const run = async (name: string, path: string, body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(name);
    try {
      await act(path, body);
      setEditing(false);
    } catch (e: any) {
      window.alert(`${e?.message || '送出失敗'}，請再試一次或在 LINE 群組告訴我們`);
    } finally {
      setBusy('');
    }
  };

  const sectionTitle = 'text-[13px] font-bold text-gray-500 mb-2 tracking-wide';
  const btn = 'flex-1 py-3 rounded-lg text-[16px] font-bold whitespace-nowrap disabled:opacity-50 transition-colors';

  const captionWaiting = post.captionState === 'waiting' && post.status !== 'published';
  // 文案在等業主時排第一、加框（11-18 使用者：文案審核是最重要的，要明顯）
  const captionSection = (
          <section className={captionWaiting ? 'rounded-xl border-2 border-[#5A5A40] bg-[#5A5A40]/[0.03] p-4 -mx-1' : ''}>
            {captionWaiting ? (
              <div className="mb-3">
                <div className="flex items-center gap-2 text-[17px] font-bold text-[#5A5A40]"><PenLine size={18} />文案等您確認</div>
                <p className="text-[14px] text-gray-600 mt-1">沒問題請按「文案 OK」；要改可以按「我要修改」直接改字，存檔就算確認。</p>
              </div>
            ) : <div className={sectionTitle}>文案</div>}
            {post.captionState === 'preparing' ? (
              <p className="text-[15px] text-gray-400 bg-[#F7F7F3] border border-[#ECEAE1] rounded-lg p-4">文案準備中，寫好會傳給您確認。</p>
            ) : !post.caption.trim() ? (
              // 已發布但系統裡沒記文案（11-16 正式資料 CWORKS 一篇），不要秀一個空白框
              <p className="text-[15px] text-gray-400 bg-[#F7F7F3] border border-[#ECEAE1] rounded-lg p-4">這篇沒有記錄文案。</p>
            ) : editing ? (
              <>
                <textarea value={draft} onChange={e => setDraft(e.target.value)} maxLength={CAPTION_MAX_LEN} rows={12}
                  className="w-full rounded-lg border-2 border-[#5A5A40] p-4 text-[16px] leading-relaxed" />
                <div className="text-right text-[13px] text-gray-400">{draft.length}／{CAPTION_MAX_LEN}</div>
                <div className="flex gap-3 mt-2">
                  <button type="button" disabled={!!busy || !draft.trim()} className={`${btn} ${ACTION.primary}`}
                    onClick={() => run('edit', '/edit', { postId: post.id, content: draft.trim() })}>
                    {busy === 'edit' ? '儲存中…' : '儲存並確認'}
                  </button>
                  <button type="button" disabled={!!busy} className={`${btn} ${ACTION.secondary}`} onClick={() => { setDraft(post.caption); setEditing(false); }}>取消</button>
                </div>
              </>
            ) : (
              <>
                <div className="text-[16px] leading-relaxed whitespace-pre-wrap break-words bg-[#F7F7F3] border border-[#ECEAE1] rounded-lg p-4">{post.caption}</div>
                {post.captionState === 'waiting' && (
                  <div className="flex gap-3 mt-3">
                    <button type="button" disabled={!!busy} className={`${btn} ${ACTION.primary}`}
                      onClick={() => run('ok', '/approve', { postId: post.id }, '確定這篇文案沒問題嗎？')}>
                      {busy === 'ok' ? '送出中…' : '文案 OK'}
                    </button>
                    <button type="button" disabled={!!busy} className={`${btn} ${ACTION.secondary}`} onClick={() => setEditing(true)}>我要修改</button>
                  </div>
                )}
                {post.captionState === 'approved' && (
                  <div className="flex items-center gap-3 mt-3">
                    <span className="text-[14px] font-bold text-[#5A5A40] whitespace-nowrap">{post.editedAfterApproval ? '✓ 您已確認・之後我們有微調文字' : '✓ 您已確認'}</span>
                    <button type="button" className="text-[14px] font-bold text-gray-500 underline underline-offset-2 whitespace-nowrap" onClick={() => setEditing(true)}>還想再改</button>
                  </div>
                )}
              </>
            )}
          </section>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center md:p-6" onClick={onClose}>
      <div className="bg-white w-full md:max-w-xl rounded-t-2xl md:rounded-2xl max-h-[92dvh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-[#E4E2D8]">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] text-gray-500 whitespace-nowrap">{day} {hhmm(post)}{post.platforms.length ? `・${post.platforms.join('／')}` : ''}</div>
              <h2 className="text-[20px] font-bold leading-snug mt-1 break-words">{post.title || '（未命名）'}</h2>
            </div>
            <button type="button" onClick={onClose} aria-label="關閉" className="shrink-0 p-2 -m-1 rounded-full text-gray-400 hover:bg-black/5"><X size={22} /></button>
          </div>
          <div className="mt-4"><VideoSteps current={s.current} /></div>
          <div className="mt-3"><StagePill post={post} /></div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          {captionWaiting && captionSection}
          {post.video && (
            <section>
              <div className={sectionTitle}>影片{post.video.version > 1 ? `（第 ${post.video.version} 版）` : ''}</div>
              <div className="rounded-lg overflow-hidden bg-black mx-auto aspect-[9/16] max-h-[46vh]">
                {post.video.kind === 'r2'
                  // 播放網址 6 小時後失效（R2 簽名）：頁面開著放太久再按播放會失敗，請業主重新整理
                  ? (videoBroken
                    ? <div className="w-full h-full flex items-center justify-center p-6 text-center text-white/80 text-[15px]">影片暫時播不出來，請重新整理這一頁再試一次</div>
                    : <video controls playsInline preload="metadata" src={post.video.url} onError={() => setVideoBroken(true)} className="w-full h-full object-contain bg-black" />)
                  : <iframe src={post.video.url} allow="autoplay; fullscreen" allowFullScreen className="w-full h-full border-0" title="影片預覽" />}
              </div>
              <div className="flex gap-3 mt-3">
                <button type="button" disabled={!!busy} className={`${btn} ${ACTION.primary}`}
                  onClick={() => run('video', '/video-approve', { assetId: post.video!.assetId }, '確定這支影片審核通過嗎？')}>
                  {busy === 'video' ? '送出中…' : '影片審核通過'}
                </button>
              </div>
              <p className="text-[14px] text-gray-500 mt-2">影片要修改的地方，請直接在 LINE 群組告訴我們。</p>
            </section>
          )}

          {/* 等業主審片、但系統裡沒有審片檔：舊流程是剪輯師直接把片丟到 LINE 群組（11-16 正式資料大發超哥 3 支）。
              不能叫業主看一個不存在的播放器，也不能讓他沒看片就按通過 */}
          {!post.video && post.flow === 'client_review' && post.status !== 'published' && (
            <section>
              <div className={sectionTitle}>影片</div>
              <p className="text-[15px] text-gray-600 bg-[#F7F7F3] border border-[#ECEAE1] rounded-lg p-4">這支影片已在 LINE 群組傳給您，看完請直接在群組回覆我們。</p>
            </section>
          )}

          {!captionWaiting && captionSection}

          {(postLinks.length > 0 || showTikTok) && (
            <section>
              <div className={sectionTitle}>已發布</div>
              <div className="flex flex-wrap gap-2">
                {postLinks.map(l => (
                  <a key={l.pf} href={l.url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#5A5A40] text-white text-[15px] font-bold whitespace-nowrap hover:bg-[#4A4A34]">
                    <ExternalLink size={16} /> 看 {l.pf} 貼文
                  </a>
                ))}
                {showTikTok && (
                  <a href={tiktokUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-[#5A5A40] text-white text-[15px] font-bold whitespace-nowrap hover:bg-[#4A4A34]">
                    <ExternalLink size={16} /> 到 TikTok 帳號看
                  </a>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
