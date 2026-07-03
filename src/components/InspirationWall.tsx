import React, { useState, useEffect, useCallback } from 'react';
import { auth } from '../firebase';
import { Flame, Star, X, ExternalLink, Loader2, RefreshCw, Lightbulb } from 'lucide-react';
import toast from 'react-hot-toast';

interface Inspiration {
  id: string; found_date: string; platform: string | null;
  author: string | null; title: string; url: string | null;
  stats: Record<string, number> | null;
  why_hot: string | null; suggestion: string | null;
  ip_id: string | null; status: string; created_at: string;
}

const PLATFORM_BADGE: Record<string, string> = {
  instagram: 'bg-pink-100 text-pink-600',
  tiktok: 'bg-black text-white',
  youtube: 'bg-red-100 text-red-600',
};

const fmt = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}萬` : n.toLocaleString();

async function api(path: string, options: RequestInit = {}) {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function InspirationWall() {
  const [items, setItems] = useState<Inspiration[]>([]);
  const [loading, setLoading] = useState(true);
  const [starOnly, setStarOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api(`/api/studio/inspirations${starOnly ? '?status=starred' : ''}`));
    } catch (e: any) {
      toast.error(`載入失敗：${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [starOnly]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (item: Inspiration, status: string) => {
    try {
      await api(`/api/studio/inspirations/${item.id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      if (status === 'dismissed') toast('已收走', { icon: '🗑️' });
      if (status === 'starred') toast.success('已加星');
      load();
    } catch (e: any) { toast.error(e.message); }
  };

  // 依日期分組
  const byDate = items.reduce<Record<string, Inspiration[]>>((acc, it) => {
    (acc[it.found_date] = acc[it.found_date] || []).push(it);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-gray-500 text-sm">🌂 雨傘標每天巡邏對標帳號，把驗證過真的在爆的片放上來</p>
        <div className="flex gap-3">
          <button onClick={() => setStarOnly(!starOnly)}
            className={`px-4 py-2 rounded-xl text-sm font-bold border transition-all flex items-center gap-2 ${
              starOnly ? 'bg-amber-400 border-amber-400 text-white' : 'bg-white border-black/10 hover:bg-gray-50'}`}>
            <Star size={16} /> 只看加星
          </button>
          <button onClick={load} className="p-2 bg-white rounded-xl border border-black/10 hover:bg-gray-50"><RefreshCw size={16} /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20 text-gray-400"><Loader2 className="animate-spin" size={32} /></div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-3xl border border-black/5 p-16 text-center text-gray-400">
          <Flame size={40} className="mx-auto mb-4 opacity-30" />
          <p className="font-bold">還沒有靈感入庫</p>
          <p className="text-xs mt-2">雨傘標每天早上巡邏後會自動把爆款片推上來</p>
        </div>
      ) : (
        (Object.entries(byDate) as [string, Inspiration[]][]).map(([date, list]) => (
          <div key={date}>
            <p className="text-xs font-black uppercase tracking-widest text-gray-400 mb-3">{date}</p>
            <div className="grid md:grid-cols-2 gap-4">
              {list.map(it => (
                <div key={it.id} className={`bg-white rounded-3xl border shadow-sm hover:shadow-md transition-all p-6 ${
                  it.status === 'starred' ? 'border-amber-300' : 'border-black/5'}`}>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      {it.platform && (
                        <span className={`px-2 py-1 rounded-full text-[10px] font-black uppercase ${PLATFORM_BADGE[it.platform] || 'bg-gray-100 text-gray-500'}`}>
                          {it.platform}
                        </span>
                      )}
                      {it.author && <span className="text-xs text-gray-400 font-mono truncate">@{it.author.replace(/^@/, '')}</span>}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => setStatus(it, it.status === 'starred' ? 'new' : 'starred')} title="加星"
                        className={`p-2 rounded-lg transition-all ${it.status === 'starred' ? 'text-amber-500 bg-amber-50' : 'text-gray-300 hover:text-amber-500 hover:bg-amber-50'}`}>
                        <Star size={16} fill={it.status === 'starred' ? 'currentColor' : 'none'} />
                      </button>
                      <button onClick={() => setStatus(it, 'dismissed')} title="收走"
                        className="p-2 rounded-lg text-gray-300 hover:text-red-400 hover:bg-red-50 transition-all">
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                  <h4 className="font-bold serif mb-2 leading-snug">{it.title}</h4>
                  {it.stats && (
                    <div className="flex gap-4 text-xs text-gray-400 font-mono mb-3">
                      {it.stats.views != null && <span>▶ {fmt(it.stats.views)}</span>}
                      {it.stats.likes != null && <span>♥ {fmt(it.stats.likes)}</span>}
                      {it.stats.comments != null && <span>💬 {fmt(it.stats.comments)}</span>}
                    </div>
                  )}
                  {it.why_hot && (
                    <div className="bg-[#F5F5F0] p-3 rounded-xl mb-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">🔥 為什麼紅</p>
                      <p className="text-sm leading-relaxed">{it.why_hot}</p>
                    </div>
                  )}
                  {it.suggestion && (
                    <div className="bg-blue-50 p-3 rounded-xl mb-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-blue-400 mb-1 flex items-center gap-1"><Lightbulb size={10} /> 可以怎麼用</p>
                      <p className="text-sm leading-relaxed">{it.suggestion}</p>
                    </div>
                  )}
                  {it.url && (
                    <a href={it.url} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-bold text-gray-400 hover:text-black transition-all mt-1">
                      <ExternalLink size={12} /> 看原片
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
