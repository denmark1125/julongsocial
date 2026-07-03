import React, { useState, useEffect, useCallback } from 'react';
import { auth } from '../firebase';
import {
  Clapperboard, Check, X, Pencil, Plus, MessageSquareQuote,
  ChevronDown, ChevronUp, Loader2, RefreshCw, LayoutGrid, ListFilter,
  Video, FileEdit, Send, Archive, Trophy, Sparkles
} from 'lucide-react';
import toast from 'react-hot-toast';

interface StudioIp { id: string; name: string; }
interface ScriptScene { time: string; visual: string; audio: string; }
interface ScriptOrigin {
  primary: 'own_data' | 'benchmark' | 'creative';
  icon: string; label: string; feedback_applied?: boolean;
}
interface ScriptDetail {
  hook?: string;        // 0-3s 黃金鉤子
  strategy?: string;    // 導演行銷策略與心理學邏輯
  pacing?: string;      // 節奏、BGM、字卡建議
  scenes?: ScriptScene[]; // 逐格導演分鏡
  cta?: string;         // 完播話術
  hashtags?: string[];
  format?: string;      // video=影音腳本 / post=貼文
  warnings?: string[];  // 事實查核：拍前要跟業主確認的主張
  origin?: ScriptOrigin; // 出處：這支怎麼來的
}
interface Script {
  id: string; ip_id: string; no: number | null;
  topic: string; content: string; hook: string | null; props_location: string | null;
  status: string; source: string; batch: string | null; created_at: string;
  detail: ScriptDetail | null;
}
interface IpOverview {
  ip_id: string; name: string; pending: number; approved: number; rejected: number;
  filmed: number; published: number; archived: number; total: number; latest_created_at: string | null;
}
interface BenchmarkAccount {
  id: string; ip_id: string; handle: string; niche: string | null;
  status: 'candidate' | 'verified' | 'dead' | 'promoted';
  followers: number | null; avg_likes: number | null; source: string | null;
  found_date: string; verified_at: string | null;
}

const REJECT_TAGS: { tag: string; label: string }[] = [
  { tag: 'cant_film',    label: '不能拍' },
  { tag: 'not_persona',  label: '不像這個人' },
  { tag: 'fake_numbers', label: '數字不實/太廣告' },
  { tag: 'too_flat',     label: '太平淡不會爆' },
  { tag: 'topic_repeat', label: '主題重複' },
  { tag: 'wrong_format', label: '格式錯' },
];

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending:   { label: '待審',   cls: 'bg-amber-100 text-amber-700' },
  approved:  { label: '已核准', cls: 'bg-green-100 text-green-700' },
  rejected:  { label: '已駁回', cls: 'bg-red-100 text-red-600' },
  filmed:    { label: '已拍攝', cls: 'bg-blue-100 text-blue-700' },
  published: { label: '已發布', cls: 'bg-black text-white' },
  archived:  { label: '封存',   cls: 'bg-gray-100 text-gray-500' },
};

// 生命週期直線：待審 → 已核准 → 已拍攝 → 已發布 → 封存（駁回是另一條岔路，不在這條線上）
const NEXT_STATUS: Record<string, { status: string; label: string; icon: any }> = {
  approved: { status: 'filmed',    label: '標記已拍攝', icon: Video },
  filmed:   { status: 'published', label: '標記已發布', icon: Send },
  published:{ status: 'archived',  label: '封存',       icon: Archive },
};

const ORIGIN_ICON: Record<string, any> = { own_data: Trophy, benchmark: ListFilter, creative: Sparkles };

async function api(path: string, options: RequestInit = {}) {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function ScriptBoard() {
  const [ips, setIps] = useState<StudioIp[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [overview, setOverview] = useState<IpOverview[]>([]);
  const [view, setView] = useState<'list' | 'overview' | 'benchmarks'>('list');
  const [benchmarks, setBenchmarks] = useState<BenchmarkAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [ipFilter, setIpFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [expanded, setExpanded] = useState<string | null>(null);

  // 駁回 modal
  const [rejecting, setRejecting] = useState<Script | null>(null);
  const [rejectTag, setRejectTag] = useState('');
  const [rejectNote, setRejectNote] = useState('');

  // 改稿 modal
  const [editing, setEditing] = useState<Script | null>(null);
  const [editForm, setEditForm] = useState({ topic: '', content: '', hook: '', props_location: '' });

  // 手寫貼上 modal
  const [pasting, setPasting] = useState(false);
  const [pasteForm, setPasteForm] = useState({ ip_id: '', no: '', topic: '', content: '', hook: '', props_location: '' });

  // 業主回饋 modal
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackForm, setFeedbackForm] = useState({ ip_id: '', said: '', kind: 'topic' });

const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (ipFilter) params.set('ip_id', ipFilter);
      if (statusFilter) params.set('status', statusFilter);
      const benchParams = new URLSearchParams();
      if (ipFilter) benchParams.set('ip_id', ipFilter);
      const [ipData, scriptData, overviewData, benchData] = await Promise.all([
        api('/api/studio/ips'),
        api(`/api/studio/scripts?${params.toString()}`),
        api('/api/studio/scripts/overview'),
        api(`/api/studio/benchmarks?${benchParams.toString()}`),
      ]);
      setIps(ipData);
      setScripts(scriptData);
      // 急迫度排序：待審庫存少的（快沒東西可審/快沒腳本可拍）排最前面，適合多 IP 同時盯進度
      setOverview([...overviewData].sort((a, b) => a.pending - b.pending));
      setBenchmarks(benchData);
    } catch (e: any) {
      toast.error(`載入失敗：${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [ipFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const ipName = (id: string) => ips.find(i => i.id === id)?.name || id;

  const advance = async (s: Script) => {
    const next = NEXT_STATUS[s.status];
    if (!next) return;
    try {
      await api(`/api/studio/scripts/${s.id}/advance`, { method: 'POST', body: JSON.stringify({ status: next.status }) });
      toast.success(`已標記「${STATUS_META[next.status].label}」`);
      load();
    } catch (e: any) { toast.error(e.message); }
  };

  const approve = async (s: Script) => {
    try {
      await api(`/api/studio/scripts/${s.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
      toast.success('已核准');
      load();
    } catch (e: any) { toast.error(e.message); }
  };

  const submitReject = async () => {
    if (!rejecting || !rejectTag) { toast.error('請選一個駁回原因'); return; }
    try {
      await api(`/api/studio/scripts/${rejecting.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action: 'reject', tag: rejectTag, note: rejectNote || undefined }),
      });
      toast.success('已駁回，原因已記錄');
      setRejecting(null); setRejectTag(''); setRejectNote('');
      load();
    } catch (e: any) { toast.error(e.message); }
  };

  const openEdit = (s: Script) => {
    setEditing(s);
    setEditForm({ topic: s.topic, content: s.content, hook: s.hook || '', props_location: s.props_location || '' });
  };

  const submitEdit = async () => {
    if (!editing) return;
    try {
      await api(`/api/studio/scripts/${editing.id}`, { method: 'PUT', body: JSON.stringify(editForm) });
      toast.success('改稿已儲存（差異已記錄，AI 會學）');
      setEditing(null);
      load();
    } catch (e: any) { toast.error(e.message); }
  };

  const submitPaste = async () => {
    if (!pasteForm.ip_id || !pasteForm.topic || !pasteForm.content) {
      toast.error('IP、主題、內容為必填'); return;
    }
    try {
      await api('/api/studio/scripts', {
        method: 'POST',
        body: JSON.stringify({ ...pasteForm, no: pasteForm.no ? parseInt(pasteForm.no) : undefined }),
      });
      toast.success('手寫腳本已入庫');
      setPasting(false);
      setPasteForm({ ip_id: '', no: '', topic: '', content: '', hook: '', props_location: '' });
      load();
    } catch (e: any) { toast.error(e.message); }
  };

  const submitFeedback = async () => {
    if (!feedbackForm.ip_id || !feedbackForm.said) { toast.error('請選 IP 並填業主說了什麼'); return; }
    try {
      await api('/api/studio/client-feedback', { method: 'POST', body: JSON.stringify(feedbackForm) });
      toast.success('業主回饋已登記');
      setFeedbackOpen(false);
      setFeedbackForm({ ip_id: '', said: '', kind: 'topic' });
    } catch (e: any) { toast.error(e.message); }
  };

  const inputCls = 'w-full p-3 bg-[#F5F5F0] rounded-xl border-none';

  return (
    <div className="space-y-6">
      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex bg-white rounded-xl border border-black/10 overflow-hidden text-sm">
            <button onClick={() => setView('list')}
              className={`px-4 py-3 font-bold transition-all flex items-center gap-2 ${view === 'list' ? 'bg-black text-white' : 'hover:bg-gray-50'}`}>
              <ListFilter size={14} /> 清單
            </button>
            <button onClick={() => setView('overview')}
              className={`px-4 py-3 font-bold transition-all flex items-center gap-2 ${view === 'overview' ? 'bg-black text-white' : 'hover:bg-gray-50'}`}>
              <LayoutGrid size={14} /> 帳號總攬
            </button>
            <button onClick={() => setView('benchmarks')}
              className={`px-4 py-3 font-bold transition-all flex items-center gap-2 ${view === 'benchmarks' ? 'bg-black text-white' : 'hover:bg-gray-50'}`}>
              <Trophy size={14} /> 對標名單
            </button>
          </div>
          {(view === 'list' || view === 'benchmarks') && (
            <>
              <select value={ipFilter} onChange={e => setIpFilter(e.target.value)} className="p-3 bg-white rounded-xl border border-black/10 text-sm">
                <option value="">全部 IP</option>
                {ips.map(ip => <option key={ip.id} value={ip.id}>{ip.name}</option>)}
              </select>
              {view === 'list' && (
                <div className="flex bg-white rounded-xl border border-black/10 overflow-hidden text-sm">
                  {['pending', 'approved', 'filmed', 'published', 'rejected', 'archived', ''].map(s => (
                    <button key={s || 'all'} onClick={() => setStatusFilter(s)}
                      className={`px-3 py-3 font-bold transition-all whitespace-nowrap ${statusFilter === s ? 'bg-black text-white' : 'hover:bg-gray-50'}`}>
                      {s ? STATUS_META[s].label : '全部'}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <button onClick={load} className="p-3 bg-white rounded-xl border border-black/10 hover:bg-gray-50" title="重新整理">
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setFeedbackOpen(true)}
            className="bg-white border border-black/10 px-4 py-2 rounded-xl flex items-center text-sm font-bold hover:bg-gray-50 transition-all">
            <MessageSquareQuote size={18} className="mr-2" /> 業主說
          </button>
          <button onClick={() => setPasting(true)}
            className="bg-[#1a1a1a] text-white px-4 py-2 rounded-xl flex items-center shadow-lg hover:bg-black transition-all text-sm font-bold">
            <Plus size={18} className="mr-2" /> 手寫貼上
          </button>
        </div>
      </div>

      {/* 對標名單：雨傘標每天自動找的候選/已驗證帳號 */}
      {view === 'benchmarks' && (
        loading ? (
          <div className="flex justify-center py-20 text-gray-400"><Loader2 className="animate-spin" size={32} /></div>
        ) : benchmarks.length === 0 ? (
          <div className="bg-white rounded-3xl border border-black/5 p-16 text-center text-gray-400">
            <Trophy size={40} className="mx-auto mb-4 opacity-30" />
            <p className="font-bold">這個 IP 還沒有對標名單</p>
            <p className="text-xs mt-2">雨傘標每天 10:00 自動搜尋並補進來，誠信鐵則：只列真實搜尋結果，找不到就是沒有</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-gray-400">🟡 候選＝雨傘標搜尋找到但還沒驗證是否為活帳號（常見原因：IG 暫時限流）；🟢 已驗證＝確認活著並抓到真實粉絲/互動數據</p>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {benchmarks.map(b => (
                <div key={b.id} className="bg-white rounded-3xl border border-black/5 shadow-sm p-5">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h4 className="font-bold serif truncate">@{b.handle}</h4>
                    <span className={`shrink-0 px-2 py-1 rounded-full text-[10px] font-bold ${
                      b.status === 'verified' ? 'bg-green-100 text-green-700' :
                      b.status === 'dead' ? 'bg-gray-100 text-gray-400' :
                      b.status === 'promoted' ? 'bg-indigo-100 text-indigo-600' :
                      'bg-amber-100 text-amber-700'}`}>
                      {b.status === 'verified' ? '🟢 已驗證' : b.status === 'dead' ? '⚫ 已失效' :
                       b.status === 'promoted' ? '⭐ 種子池' : '🟡 候選'}
                    </span>
                  </div>
                  {b.niche && <p className="text-xs text-gray-400 mb-2">賽道：{b.niche}</p>}
                  {b.status === 'verified' && (
                    <p className="text-sm text-gray-600 mb-2">
                      粉絲 {b.followers?.toLocaleString() ?? '?'}
                      {b.avg_likes != null && ` ｜ 平均讚 ${b.avg_likes.toLocaleString()}`}
                    </p>
                  )}
                  {b.source && <p className="text-xs text-gray-400 truncate" title={b.source}>{b.source}</p>}
                  <p className="text-[10px] text-gray-300 mt-2">發現於 {b.found_date}</p>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {/* 帳號總攬：依「待審庫存」急迫度排序，庫存少的排最前面 */}
      {view === 'overview' && (
        loading ? (
          <div className="flex justify-center py-20 text-gray-400"><Loader2 className="animate-spin" size={32} /></div>
        ) : overview.length === 0 ? (
          <div className="bg-white rounded-3xl border border-black/5 p-16 text-center text-gray-400">
            <LayoutGrid size={40} className="mx-auto mb-4 opacity-30" />
            <p className="font-bold">還沒有任何 IP 的腳本紀錄</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {overview.map(o => (
              <div key={o.ip_id}
                onClick={() => { setIpFilter(o.ip_id); setStatusFilter(''); setView('list'); }}
                className={`bg-white rounded-3xl border p-6 cursor-pointer hover:shadow-md transition-all ${
                  o.pending === 0 && o.total > 0 ? 'border-red-200' : 'border-black/5'}`}>
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-bold serif text-lg">{o.name}</h4>
                  {o.pending === 0 && o.total > 0 && (
                    <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-red-100 text-red-600">🔥 庫存見底</span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {(['pending', 'approved', 'filmed'] as const).map(st => (
                    <div key={st} className={`rounded-xl py-3 ${STATUS_META[st].cls}`}>
                      <div className="text-2xl font-black">{o[st]}</div>
                      <div className="text-[10px] font-bold">{STATUS_META[st].label}</div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-3">
                  已發布 {o.published}／封存 {o.archived}／駁回 {o.rejected}
                  {o.latest_created_at && ` · 最新產出 ${new Date(o.latest_created_at).toLocaleDateString('zh-TW')}`}
                </p>
              </div>
            ))}
          </div>
        )
      )}

      {/* 腳本卡片列表 */}
      {view === 'list' && (loading ? (
        <div className="flex justify-center py-20 text-gray-400"><Loader2 className="animate-spin" size={32} /></div>
      ) : scripts.length === 0 ? (
        <div className="bg-white rounded-3xl border border-black/5 p-16 text-center text-gray-400">
          <Clapperboard size={40} className="mx-auto mb-4 opacity-30" />
          <p className="font-bold">這個篩選條件下沒有腳本</p>
          <p className="text-xs mt-2">AI 生成的腳本會自動出現在「待審」；也可以按「手寫貼上」入庫自己寫的腳本</p>
        </div>
      ) : (
        <div className="space-y-4">
          {scripts.map(s => {
            const meta = STATUS_META[s.status] || STATUS_META.pending;
            const isOpen = expanded === s.id;
            return (
              <div key={s.id} className="bg-white rounded-3xl border border-black/5 shadow-sm hover:shadow-md transition-all">
                <div className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded(isOpen ? null : s.id)}>
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${meta.cls}`}>{meta.label}</span>
                        <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-gray-100 text-gray-500">
                          {s.detail?.format === 'post' ? '📝 貼文' : '🎬 影音'}
                        </span>
                        {s.detail?.origin && (
                          <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-600" title="這支腳本的靈感出處">
                            {s.detail.origin.icon} {s.detail.origin.label}
                            {s.detail.origin.feedback_applied ? '＋回饋進化' : ''}
                          </span>
                        )}
                        <span className="text-xs text-gray-400 font-mono">{ipName(s.ip_id)}{s.no != null ? ` · #${s.no}` : ''}</span>
                        {(s.detail?.warnings?.length ?? 0) > 0 && (
                          <span className="px-2 py-1 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700">
                            ⚠️ {s.detail!.warnings!.length} 項待跟業主確認
                          </span>
                        )}
                      </div>
                      <h4 className="font-bold serif text-lg truncate">{s.topic}</h4>
                      {s.hook && <p className="text-sm text-gray-500 mt-1 truncate">💥 {s.hook}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {s.status === 'pending' && (
                        <>
                          <button onClick={() => approve(s)} title="核准"
                            className="p-3 rounded-xl bg-green-50 text-green-600 hover:bg-green-600 hover:text-white transition-all">
                            <Check size={18} />
                          </button>
                          <button onClick={() => openEdit(s)} title="就地改稿"
                            className="p-3 rounded-xl bg-amber-50 text-amber-600 hover:bg-amber-500 hover:text-white transition-all">
                            <Pencil size={18} />
                          </button>
                          <button onClick={() => { setRejecting(s); setRejectTag(''); setRejectNote(''); }} title="駁回"
                            className="p-3 rounded-xl bg-red-50 text-red-500 hover:bg-red-500 hover:text-white transition-all">
                            <X size={18} />
                          </button>
                        </>
                      )}
                      {NEXT_STATUS[s.status] && (() => {
                        const next = NEXT_STATUS[s.status];
                        const Icon = next.icon;
                        return (
                          <button onClick={() => advance(s)} title={next.label}
                            className="px-3 py-3 rounded-xl bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white transition-all flex items-center gap-1 text-xs font-bold">
                            <Icon size={16} /> {next.label}
                          </button>
                        );
                      })()}
                      {s.status !== 'pending' && (
                        <button onClick={() => openEdit(s)} title="改稿"
                          className="p-3 rounded-xl bg-gray-50 text-gray-500 hover:bg-gray-200 transition-all">
                          <Pencil size={18} />
                        </button>
                      )}
                      <button onClick={() => setExpanded(isOpen ? null : s.id)} className="p-3 rounded-xl hover:bg-gray-50 text-gray-400">
                        {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="mt-4 space-y-4">
                      {/* 事實查核警示：拍/發之前要跟業主確認的主張 */}
                      {(s.detail?.warnings?.length ?? 0) > 0 && (
                        <div className="bg-amber-50 border border-amber-200 p-4 rounded-2xl">
                          <p className="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-2">
                            ⚠️ 事實查核：以下說法在人物設定裡沒有依據，拍/發之前要跟業主確認
                          </p>
                          <ul className="space-y-1">
                            {s.detail!.warnings!.map((w, i) => (
                              <li key={i} className="text-sm text-amber-800">・{w}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {/* 黃金 Hook */}
                      {(s.detail?.hook || s.hook) && (
                        <div className="bg-black text-white p-5 rounded-2xl">
                          <p className="text-[10px] font-black uppercase tracking-widest text-amber-400 mb-2">爆款黃金 Hook（0-3s）</p>
                          <p className="serif text-lg leading-relaxed">“{s.detail?.hook || s.hook}”</p>
                        </div>
                      )}
                      {/* 策略邏輯 + 節奏建議 */}
                      {(s.detail?.strategy || s.detail?.pacing) && (
                        <div className="grid md:grid-cols-2 gap-3">
                          {s.detail?.strategy && (
                            <div className="bg-[#F5F5F0] p-4 rounded-2xl">
                              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">導演行銷策略與心理學邏輯</p>
                              <p className="text-sm leading-relaxed">{s.detail.strategy}</p>
                            </div>
                          )}
                          {s.detail?.pacing && (
                            <div className="bg-[#F5F5F0] p-4 rounded-2xl">
                              <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">節奏、BGM 與字卡建議</p>
                              <p className="text-sm leading-relaxed">💡 {s.detail.pacing}</p>
                            </div>
                          )}
                        </div>
                      )}
                      {/* 逐格分鏡表 */}
                      {s.detail?.scenes && s.detail.scenes.length > 0 ? (
                        <div className="border border-black/5 rounded-2xl overflow-hidden">
                          <div className="grid grid-cols-12 bg-black text-white text-[10px] font-black uppercase tracking-widest px-4 py-3">
                            <div className="col-span-2">鏡頭時間</div>
                            <div className="col-span-5">畫面視覺與字幕壓字</div>
                            <div className="col-span-5">口播語音與音效</div>
                          </div>
                          {s.detail.scenes.map((sc, i) => (
                            <div key={i} className={`grid grid-cols-12 px-4 py-3 text-sm gap-2 ${i % 2 ? 'bg-[#FAFAF7]' : 'bg-white'}`}>
                              <div className="col-span-2 font-mono font-bold">{sc.time}</div>
                              <div className="col-span-5 leading-relaxed">{sc.visual}</div>
                              <div className="col-span-5 leading-relaxed text-gray-600">{sc.audio}</div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="bg-[#F5F5F0] p-4 rounded-2xl text-sm whitespace-pre-wrap leading-relaxed">{s.content}</div>
                      )}
                      {/* CTA + Hashtags */}
                      {s.detail?.cta && (
                        <div className="bg-green-50 p-4 rounded-2xl">
                          <p className="text-[10px] font-black uppercase tracking-widest text-green-600 mb-1">收尾 CTA 完播話術</p>
                          <p className="text-sm">{s.detail.cta}</p>
                        </div>
                      )}
                      {s.detail?.hashtags && s.detail.hashtags.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {s.detail.hashtags.map(h => (
                            <span key={h} className="px-3 py-1 bg-[#F5F5F0] rounded-full text-xs font-bold text-gray-600">
                              #{h.replace(/^#/, '')}
                            </span>
                          ))}
                        </div>
                      )}
                      {s.props_location && (
                        <p className="text-xs text-gray-500">🎬 道具／地點：{s.props_location}</p>
                      )}
                      {/* 複製完整腳本 */}
                      <button onClick={() => {
                        const d = s.detail;
                        const scenes = d?.scenes?.map(sc => `[${sc.time}]\n畫面：${sc.visual}\n口播：${sc.audio}`).join('\n\n') || s.content;
                        const text = `【🎬 ${ipName(s.ip_id)}｜${s.topic}】\n\n[🔥 黃金Hook]: ${d?.hook || s.hook || ''}\n${d?.pacing ? `\n[🎧 節奏音效]: ${d.pacing}\n` : ''}\n${scenes}\n\n[🎯 CTA]: ${d?.cta || ''}\n${d?.hashtags?.length ? `\n[🏷️] ${d.hashtags.map(h => '#' + h.replace(/^#/, '')).join(' ')}` : ''}${s.props_location ? `\n[🎬 道具/地點]: ${s.props_location}` : ''}`;
                        navigator.clipboard.writeText(text);
                        toast.success('完整腳本已複製');
                      }} className="text-xs font-bold text-gray-400 hover:text-black transition-all">
                        📋 複製完整腳本
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {/* 駁回 modal：6 標籤一鍵 */}
      {rejecting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl p-8">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-2xl font-bold serif">駁回原因</h3>
              <button onClick={() => setRejecting(null)} className="p-2 hover:bg-gray-100 rounded-full"><X size={24} /></button>
            </div>
            <p className="text-sm text-gray-400 mb-6 truncate">「{rejecting.topic}」</p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {REJECT_TAGS.map(t => (
                <button key={t.tag} onClick={() => setRejectTag(t.tag)}
                  className={`p-4 rounded-2xl text-sm font-bold border transition-all ${
                    rejectTag === t.tag ? 'bg-red-500 text-white border-red-500' : 'bg-[#F5F5F0] border-transparent hover:border-red-200'}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <textarea rows={2} value={rejectNote} onChange={e => setRejectNote(e.target.value)}
              className={inputCls + ' resize-none text-sm'} placeholder="備註（選填）" />
            <button onClick={submitReject}
              className="w-full bg-red-500 text-white py-3 rounded-xl font-bold shadow-lg mt-4 hover:bg-red-600 transition-all">
              確認駁回
            </button>
          </div>
        </div>
      )}

      {/* 改稿 modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl p-8 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-bold serif">就地改稿</h3>
              <button onClick={() => setEditing(null)} className="p-2 hover:bg-gray-100 rounded-full"><X size={24} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">主題</label>
                <input value={editForm.topic} onChange={e => setEditForm({ ...editForm, topic: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">內容（完整台詞）</label>
                <textarea rows={10} value={editForm.content} onChange={e => setEditForm({ ...editForm, content: e.target.value })}
                  className={inputCls + ' resize-none text-sm leading-relaxed'} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">爆點</label>
                  <input value={editForm.hook} onChange={e => setEditForm({ ...editForm, hook: e.target.value })} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">道具／地點</label>
                  <input value={editForm.props_location} onChange={e => setEditForm({ ...editForm, props_location: e.target.value })} className={inputCls} />
                </div>
              </div>
              <p className="text-xs text-gray-400">💡 你改的每一個字都會被記錄成差異，AI 下一批會照著學。</p>
              <button onClick={submitEdit} className="w-full bg-black text-white py-3 rounded-xl font-bold shadow-lg">儲存改稿</button>
            </div>
          </div>
        </div>
      )}

      {/* 手寫貼上 modal */}
      {pasting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl p-8 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-2xl font-bold serif">手寫腳本入庫</h3>
              <button onClick={() => setPasting(false)} className="p-2 hover:bg-gray-100 rounded-full"><X size={24} /></button>
            </div>
            <p className="text-xs text-gray-400 mb-6">人寫的腳本是 AI 的黃金教材——發布驗證後會進 golden set。</p>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">IP *</label>
                  <select value={pasteForm.ip_id} onChange={e => setPasteForm({ ...pasteForm, ip_id: e.target.value })} className={inputCls}>
                    <option value="">選擇 IP</option>
                    {ips.map(ip => <option key={ip.id} value={ip.id}>{ip.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">編號</label>
                  <input type="number" value={pasteForm.no} onChange={e => setPasteForm({ ...pasteForm, no: e.target.value })} className={inputCls} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">主題 *</label>
                <input value={pasteForm.topic} onChange={e => setPasteForm({ ...pasteForm, topic: e.target.value })} className={inputCls} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">內容（完整台詞）*</label>
                <textarea rows={8} value={pasteForm.content} onChange={e => setPasteForm({ ...pasteForm, content: e.target.value })}
                  className={inputCls + ' resize-none text-sm leading-relaxed'} placeholder="直接把整段台詞貼進來" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">爆點</label>
                  <input value={pasteForm.hook} onChange={e => setPasteForm({ ...pasteForm, hook: e.target.value })} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">道具／地點</label>
                  <input value={pasteForm.props_location} onChange={e => setPasteForm({ ...pasteForm, props_location: e.target.value })} className={inputCls} />
                </div>
              </div>
              <button onClick={submitPaste} className="w-full bg-black text-white py-3 rounded-xl font-bold shadow-lg">入庫</button>
            </div>
          </div>
        </div>
      )}

      {/* 業主回饋 modal */}
      {feedbackOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl p-8">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-2xl font-bold serif">業主說了什麼</h3>
              <button onClick={() => setFeedbackOpen(false)} className="p-2 hover:bg-gray-100 rounded-full"><X size={24} /></button>
            </div>
            <p className="text-xs text-gray-400 mb-6">開完會 30 秒登記，AI 會把它變成紅線或題材方向。</p>
            <div className="space-y-4">
              <select value={feedbackForm.ip_id} onChange={e => setFeedbackForm({ ...feedbackForm, ip_id: e.target.value })} className={inputCls}>
                <option value="">選擇 IP</option>
                {ips.map(ip => <option key={ip.id} value={ip.id}>{ip.name}</option>)}
              </select>
              <textarea rows={4} value={feedbackForm.said} onChange={e => setFeedbackForm({ ...feedbackForm, said: e.target.value })}
                className={inputCls + ' resize-none text-sm'} placeholder="例：業主說不要再拍店長正面、想多做節慶檔期…" />
              <div className="flex gap-2">
                {[['redline', '🚫 紅線'], ['topic', '💡 題材'], ['praise', '👍 讚美'], ['other', '其他']].map(([k, label]) => (
                  <button key={k} onClick={() => setFeedbackForm({ ...feedbackForm, kind: k })}
                    className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                      feedbackForm.kind === k ? 'bg-black text-white' : 'bg-[#F5F5F0] hover:bg-gray-200'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <button onClick={submitFeedback} className="w-full bg-black text-white py-3 rounded-xl font-bold shadow-lg">登記</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
