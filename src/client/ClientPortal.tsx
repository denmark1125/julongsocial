import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftMonth, isMonthKey } from '../lib/captionReview';
import { ClientPortalData, ClientPost, clientTodoSummary } from '../lib/clientPortal';
import ClientCalendar from './ClientCalendar';
import ClientPostList from './ClientPostList';
import ClientPostDetail from './ClientPostDetail';
import StockPanel from './StockPanel';
import NoticeBell from './NoticeBell';
import Logo from '../components/Logo';
import { ACTION, LINE } from './shared';

/**
 * 客戶端（業主從 LINE 點開的 /c/<代碼>，2026-11-16）。
 * 兩個分頁：貼文管理（預設，業主最常看）、上片行事曆（含拍攝日）。點任一篇看五站進度、審片、確認／修改文案。
 * 網址：?m=YYYY-MM 指定月份、&p=<貼文id> 直接打開那一篇（LINE 卡片的按鈕會帶）。
 * 資料只向 /c/<代碼>/data 拿（伺服器白名單挑欄位，見 src/lib/clientPortal.ts），這裡不碰資料庫。
 */
const token = () => decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '');
const taipeiMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

export default function ClientPortal() {
  const params = new URLSearchParams(window.location.search);
  const [month, setMonth] = useState(isMonthKey(params.get('m')) ? params.get('m')! : taipeiMonth());
  // 業主最常看的是貼文（使用者 11-16），進來先開貼文管理；行事曆是第二個分頁
  const [tab, setTab] = useState<'calendar' | 'posts'>('posts');
  const [data, setData] = useState<ClientPortalData | null>(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(params.get('p') || '');

  const load = useCallback(async (m: string) => {
    try {
      const res = await fetch(`/c/${encodeURIComponent(token())}/data?m=${m}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || '資料暫時讀不到，請稍後再試');
      setData(json);
      setError('');
    } catch (e: any) {
      setError(e?.message || '資料暫時讀不到，請稍後再試');
    }
  }, []);

  useEffect(() => {
    setData(null);
    void load(month);
    const q = new URLSearchParams(window.location.search);
    q.set('m', month);
    window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
  }, [month, load]);

  useEffect(() => { if (data?.vendorName) document.title = `${data.vendorName}｜排程與文案`; }, [data?.vendorName]);

  // 業主常把 LINE 切出去再切回來：回到這頁時資料超過 1 分鐘就重抓，小編剛送的文案才看得到（不用自己重新整理）
  const loadedAt = useRef(0);
  useEffect(() => { if (data) loadedAt.current = Date.now(); }, [data]);
  useEffect(() => {
    const onShow = () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > 60_000) void load(month); };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [load, month]);

  // 詳情要佔一格瀏覽紀錄：手機（尤其 LINE 內建瀏覽器）按返回鍵是關掉詳情，不是整頁離開
  const urlWith = (id: string) => {
    const q = new URLSearchParams(window.location.search);
    if (id) q.set('p', id); else q.delete('p');
    return `${window.location.pathname}?${q.toString()}`;
  };
  const openPost = (id: string) => {
    if (!id) return;
    window.history.pushState({ detail: id }, '', urlWith(id));
    setOpenId(id);
  };
  const closePost = () => {
    if (window.history.state?.detail) window.history.back(); // popstate 會把 openId 清掉
    else { window.history.replaceState(null, '', urlWith('')); setOpenId(''); } // 從 LINE 卡片直接開進來的那一篇
  };
  const openStockPost = (postId: string, airDate: string) => {
    const m = airDate.slice(0, 7);
    if (isMonthKey(m) && m !== month && !data?.posts.some(p => p.id === postId)) setMonth(m);
    openPost(postId);
  };
  // 通知可能是別的月份的貼文：先換到那個月再打開
  const openNoticePost = (postId: string, m?: string) => {
    if (m && isMonthKey(m) && m !== month && !data?.posts.some(p => p.id === postId)) setMonth(m);
    openPost(postId);
  };
  useEffect(() => {
    const onPop = () => setOpenId(new URLSearchParams(window.location.search).get('p') || '');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const act = useCallback(async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`/c/${encodeURIComponent(token())}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || '送出失敗');
    await load(month);
  }, [load, month]);

  const todo = useMemo(() => clientTodoSummary(data?.posts || []), [data]);
  const open = data?.posts.find(p => p.id === openId) || null;
  const [y, m] = month.split('-').map(Number);

  if (error && !data) {
    return (
      <div className="min-h-dvh bg-[#F5F5F0] flex items-center justify-center p-8 text-center">
        <div>
          <p className="text-[20px] font-bold text-gray-700">{error}</p>
          <p className="text-[17px] text-gray-500 mt-2">有問題請直接在 LINE 群組告訴我們。</p>
        </div>
      </div>
    );
  }

  // 分頁用底線（正式網頁的分頁樣式），不用膠囊（11-18 使用者：像 App 不像正式網頁）
  const tabBtn = (id: 'calendar' | 'posts', label: string) => (
    <button type="button" onClick={() => setTab(id)}
      className={`relative px-1 pb-3 pt-1 text-[18px] whitespace-nowrap transition-colors ${tab === id ? 'font-bold text-gray-900' : 'font-medium text-gray-500 hover:text-gray-800'}`}>
      {label}
      {tab === id && <span className="absolute left-0 right-0 -bottom-px h-[3px] rounded-t bg-[#5A5A40]" />}
    </button>
  );

  const monthSwitch = (
    <div className={`inline-flex items-center border ${LINE} rounded-lg`}>
      <button type="button" aria-label="上個月" onClick={() => setMonth(shiftMonth(month, -1))} className="p-2 text-gray-600 hover:bg-[#F5F5F0] rounded-l-lg"><ChevronLeft size={18} /></button>
      <span className={`px-3 text-[17px] font-bold whitespace-nowrap tabular-nums border-x ${LINE} py-1.5`}>{y} 年 {m} 月</span>
      <button type="button" aria-label="下個月" onClick={() => setMonth(shiftMonth(month, 1))} className="p-2 text-gray-600 hover:bg-[#F5F5F0] rounded-r-lg"><ChevronRight size={18} /></button>
    </div>
  );

  return (
    <div className="min-h-dvh bg-[#F6F6F2] text-gray-900">
      {/* 頂部列：白底細線，品牌＋IP 名稱在左；右邊電腦是「月份＋鈴鐺」，手機鈴鐺固定在標題右邊、月份換到下一行
          （11-19：手機寬度不夠時鈴鐺被擠到第二行左邊，通知清單往左超出螢幕） */}
      <header className={`bg-white border-b ${LINE}`}>
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              {/* 聚浪 logo（11-19 使用者要求；跟公司後台同一個圖） */}
              <div className="flex items-center gap-1.5 text-[15px] font-medium text-gray-500 tracking-wide"><Logo className="w-6 h-6 shrink-0" showText={false} />聚浪行銷・客戶專區</div>
              <h1 className="serif text-[24px] md:text-[28px] font-bold leading-tight truncate">{data?.vendorName || '　'}</h1>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <div className="hidden md:block">{monthSwitch}</div>
              {data && <NoticeBell notices={data.notices || []} storageKey={`jl-notice-seen:${token()}`} onOpenPost={openNoticePost} />}
            </div>
          </div>
          <div className="md:hidden mt-3">{monthSwitch}</div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 pt-5 pb-[calc(2.5rem+env(safe-area-inset-bottom))] space-y-4">
        {data && todo.video + todo.caption > 0 && (
          <button type="button" onClick={() => openPost(todo.firstId)}
            className={`w-full flex items-center gap-3 text-left rounded-xl px-4 py-3 hover:bg-[#FAFAF7] ${ACTION.banner}`}>
            <span className={`shrink-0 text-[16px] font-bold whitespace-nowrap ${ACTION.bannerTag}`}>等您處理</span>
            <span className="min-w-0 flex-1 text-[17px] font-medium leading-snug">
              {[todo.caption ? `${todo.caption} 篇文案等您確認` : '', todo.video ? `${todo.video} 支影片等您審片` : ''].filter(Boolean).join('、')}
            </span>
            <span className="hidden sm:inline shrink-0 text-[16px] font-bold text-[#5A5A40] whitespace-nowrap">前往處理</span>
            <ChevronRight size={16} className="shrink-0 text-[#5A5A40]" />
          </button>
        )}

        {/* 目前庫存（11-17）：不分月份，永遠是現在；拍攝日併在這一塊 */}
        {data?.stock && (
          <StockPanel stock={data.stock} lastShoot={data.lastShoot} nextShoot={data.nextShoot} onOpenPost={openStockPost} />
        )}

        <nav className={`flex gap-7 border-b ${LINE} pt-2`}>
          {tabBtn('posts', '貼文管理')}
          {tabBtn('calendar', '上片行事曆')}
        </nav>

        {!data ? (
          <p className="text-center text-gray-400 py-16 text-[17px]">讀取中…</p>
        ) : tab === 'calendar' ? (
          <ClientCalendar data={data} onOpen={(p: ClientPost) => openPost(p.id)} />
        ) : (
          <ClientPostList posts={data.posts} onOpen={(p: ClientPost) => openPost(p.id)} />
        )}

        <p className="text-center text-[15px] text-gray-400 pt-4">有任何問題，請直接在 LINE 群組告訴我們</p>
      </main>

      {/* 換一篇、或狀態變了（剛按完確認）就重建，裡面的編輯中狀態才不會留著 */}
      {open && (
        <React.Fragment key={open.id + open.captionState + (open.video?.version || 0)}>
          <ClientPostDetail post={open} act={act} onClose={closePost} tiktokUrl={data?.tiktokUrl || ''} />
        </React.Fragment>
      )}
    </div>
  );
}
