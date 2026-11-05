import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { format, parseISO, startOfMonth } from 'date-fns';
import toast from 'react-hot-toast';
import { auth, db } from '../firebase';
import { NOTIFY_MODE_LABEL, type NotifyKindDef, type NotifyMode } from '../lib/notify/kinds';

/**
 * 通知中心（2026-11-05）：每種 LINE 通知發給誰、開關、本月用了幾則、發送紀錄。
 * 規則改在伺服器（/api/admin/notify-rules/set），紀錄來自 notificationLogs（伺服器寫）。
 * 登記表在 src/lib/notify/kinds.ts。
 */

type KindRow = NotifyKindDef & { mode: NotifyMode; rule: { updatedAt?: string; updatedBy?: string } | null };
type Log = {
  id: string; kind: string; mode: NotifyMode; summary: string; at: string; units: number; intended?: string[];
  results: { type: string; label: string; ok: boolean; units: number; error?: string }[];
};

const MODES: NotifyMode[] = ['off', 'test', 'live'];
const MODE_SHORT: Record<NotifyMode, string> = { off: '關閉', test: '測試', live: '正式' };

async function api(path: string, body: any = {}) {
  const idToken = await auth.currentUser?.getIdToken();
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, ...body }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `伺服器回 ${r.status}`);
  return d;
}

export default function NotificationCenter({ quota, used }: { quota?: number | null; used?: number | null }) {
  const [kinds, setKinds] = useState<KindRow[]>([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);

  const load = async () => {
    try { setKinds((await api('/api/admin/notify-rules')).kinds); setErr(''); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  // 本月紀錄：算各種通知用了幾則＋最近的發送紀錄（一個月幾百筆，開頁讀一次）
  useEffect(() => onSnapshot(
    query(collection(db, 'notificationLogs'), where('at', '>=', startOfMonth(new Date()).toISOString()), orderBy('at', 'desc')),
    s => setLogs(s.docs.map(d => ({ id: d.id, ...d.data() } as Log))),
    () => setLogs([]),
  ), []);

  const usage = useMemo(() => {
    const m = new Map<string, { units: number; last?: string }>();
    for (const l of logs) {
      const cur = m.get(l.kind) || { units: 0 };
      cur.units += l.units || 0;
      if (!cur.last || l.at > cur.last) cur.last = l.at;
      m.set(l.kind, cur);
    }
    return m;
  }, [logs]);
  const monthUnits = logs.reduce((n, l) => n + (l.units || 0), 0);

  const setMode = async (k: KindRow, mode: NotifyMode) => {
    if (mode === k.mode) return;
    if (mode === 'live' && k.audience === 'client' && !window.confirm(`「${k.label}」切成正式後會直接發給客戶群組，確定嗎？`)) return;
    setSaving(k.id);
    try {
      await api('/api/admin/notify-rules/set', { kind: k.id, mode });
      toast.success(`${k.label}：${NOTIFY_MODE_LABEL[mode]}`);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(null);
    }
  };

  const labelOf = (id: string) => kinds.find(k => k.id === id)?.label || id;

  return (
    <div className="space-y-5">
      <p className="text-[13px] text-gray-400 px-1">
        每種通知可以分別「關閉／測試／正式」。測試＝只發給老闆，訊息前面會註明正式時要發給誰；對客戶的通知請先測試一兩週再切正式。
      </p>

      <div className="bg-white rounded-2xl border border-black/5 shadow-sm px-5 py-4 flex flex-wrap items-baseline gap-x-8 gap-y-2 text-sm">
        <span className="text-[13px] text-gray-400 whitespace-nowrap">本月 LINE 已用</span>
        <span className="font-bold whitespace-nowrap">{used ?? '—'}{quota != null ? ` / ${quota}` : ''} 則</span>
        <span className="text-[13px] text-gray-400 whitespace-nowrap">其中經過通知中心的</span>
        <span className="font-bold whitespace-nowrap">{monthUnits} 則</span>
        <span className="text-[13px] text-gray-400">（發到群組按人數扣）</span>
      </div>

      {err && <p className="text-sm text-red-500 px-1">{err}</p>}

      <div className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
        <ul className="divide-y divide-black/5">
          {kinds.map(k => {
            const u = usage.get(k.id);
            return (
              <li key={k.id} className="px-5 py-3.5 flex flex-col md:flex-row md:items-center gap-3">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[15px] font-bold whitespace-nowrap">{k.label}</span>
                    <span className={`text-[12px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap ${k.audience === 'client' ? 'bg-amber-50 text-amber-700' : 'bg-[#5A5A40]/10 text-[#5A5A40]'}`}>
                      {k.audience === 'client' ? '對客戶' : '對內'}
                    </span>
                    {k.planned && <span className="text-[12px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 font-bold whitespace-nowrap">規劃中</span>}
                  </div>
                  <p className="text-[13px] text-gray-500">發給：{k.recipientLabel}　·　{k.whenLabel}</p>
                  <p className="text-[12px] text-gray-400">
                    本月 {u?.units || 0} 則{u?.last ? `　·　上次 ${format(parseISO(u.last), 'MM/dd HH:mm')}` : ''}
                    {k.rule?.updatedBy ? `　·　${k.rule.updatedBy} 改過` : ''}
                  </p>
                </div>
                <div className="flex bg-[#F5F5F0] p-1 rounded-xl shrink-0">
                  {MODES.map(m => {
                    const disabled = saving === k.id || (k.planned && m === 'live');
                    return (
                      <button key={m} disabled={disabled} onClick={() => setMode(k, m)}
                        title={k.planned && m === 'live' ? '還在規劃中，最多只能開測試' : NOTIFY_MODE_LABEL[m]}
                        className={`px-3 py-1.5 rounded-lg text-[13px] font-bold whitespace-nowrap transition-all disabled:opacity-40 ${
                          k.mode === m ? (m === 'off' ? 'bg-white text-gray-600 shadow-sm' : m === 'test' ? 'bg-amber-500 text-white shadow-sm' : 'bg-[#5A5A40] text-white shadow-sm') : 'text-gray-400 hover:text-gray-600'}`}>
                        {MODE_SHORT[m]}
                      </button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-bold text-gray-500 px-1">本月發送紀錄</p>
        <div className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
          {logs.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-gray-400">這個月還沒有經過通知中心的發送</p>
          ) : (
            <ul className="divide-y divide-black/5">
              {logs.slice(0, 100).map(l => (
                <li key={l.id} className="px-5 py-3 text-[13px] flex flex-col sm:flex-row sm:items-baseline gap-x-3 gap-y-1">
                  <span className="tabular-nums text-gray-400 whitespace-nowrap">{format(parseISO(l.at), 'MM/dd HH:mm')}</span>
                  <span className="font-bold whitespace-nowrap">{labelOf(l.kind)}</span>
                  {l.mode === 'test' && <span className="text-[12px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-bold whitespace-nowrap">測試</span>}
                  <span className="text-gray-600 min-w-0 truncate">{l.summary}</span>
                  <span className="sm:ml-auto text-gray-400 whitespace-nowrap">
                    {l.results.map(r => `${r.ok ? '✓' : '✗'} ${r.label}`).join('、')}　{l.units} 則
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
