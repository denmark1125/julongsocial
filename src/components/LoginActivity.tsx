import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { format, formatDistanceToNow, parseISO, subDays } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import { ChevronDown, LogIn, Monitor, Smartphone, RefreshCw } from 'lucide-react';
import { auth, db } from '../firebase';
import { UserProfile } from '../types';

/**
 * 工程師專用：每個帳號的登入次數與時間（2026-11-04）。
 * 次數來自 loginLogs（這個功能上線後才開始記）；「Firebase 最後登入」來自 Auth 本身，上線前的也看得到。
 */

type Log = { id: string; uid: string; username: string; displayName: string; role: string; kind: 'login' | 'open'; device: string; at: string };
type AuthInfo = { uid: string; lastSignInTime?: string; lastRefreshTime?: string; creationTime?: string; disabled?: boolean };

const ROLE_LABEL: Record<string, string> = { engineer: '工程師', manager: '主管', employee: '員工', editor: '剪輯師', chairman: '董事' };
const RANGES = [7, 30, 90] as const;

const fmt = (iso?: string) => (iso ? format(parseISO(iso), 'yyyy/MM/dd HH:mm') : '—');
const ago = (iso?: string) => (iso ? formatDistanceToNow(parseISO(iso), { addSuffix: true, locale: zhTW }) : '');

export default function LoginActivity() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [logs, setLogs] = useState<Log[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [authInfo, setAuthInfo] = useState<Record<string, AuthInfo>>({});
  const [authErr, setAuthErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => onSnapshot(collection(db, 'users'), s => setUsers(s.docs.map(d => ({ ...(d.data() as UserProfile), uid: d.id })))), []);

  useEffect(() => {
    const since = subDays(new Date(), days).toISOString();
    return onSnapshot(
      query(collection(db, 'loginLogs'), where('at', '>=', since), orderBy('at', 'desc')),
      s => setLogs(s.docs.map(d => ({ id: d.id, ...d.data() } as Log))),
      e => console.warn('讀取登入紀錄失敗', e),
    );
  }, [days]);

  const loadAuth = async () => {
    setAuthErr('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const r = await fetch('/api/admin/auth-activity', { headers: { Authorization: `Bearer ${idToken}` } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '讀取失敗');
      setAuthInfo(Object.fromEntries((j.users as AuthInfo[]).map(u => [u.uid, u])));
    } catch (e: any) {
      setAuthErr(e?.message || '讀取失敗');
    }
  };
  useEffect(() => { loadAuth(); }, []);

  const rows = useMemo(() => {
    return users.map(u => {
      const mine = logs.filter(l => l.uid === u.uid);
      const logins = mine.filter(l => l.kind === 'login');
      const lastLog = mine[0]?.at;
      const a = authInfo[u.uid];
      const lastLogin = [logins[0]?.at, a?.lastSignInTime].filter(Boolean).sort().pop();
      const lastActive = [lastLog, a?.lastRefreshTime].filter(Boolean).sort().pop();
      return { u, mine, loginCount: logins.length, openCount: mine.length - logins.length, lastLogin, lastActive, disabled: a?.disabled };
    }).sort((x, y) => (y.lastActive || '').localeCompare(x.lastActive || ''));
  }, [users, logs, authInfo]);

  const totalLogin = logs.filter(l => l.kind === 'login').length;
  const activeAccounts = rows.filter(r => r.mine.length > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">登入紀錄</h2>
          <p className="text-sm text-gray-500">每個帳號登入幾次、什麼時候登入、最近一次使用。只有工程師看得到。</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-white p-1 rounded-xl border border-black/5 shadow-sm">
            {RANGES.map(d => (
              <button key={d} onClick={() => setDays(d)} className={`px-3 py-1.5 rounded-lg text-[13px] font-bold whitespace-nowrap ${days === d ? 'bg-[#5A5A40] text-white' : 'text-gray-500 hover:text-[#1a1a1a]'}`}>近 {d} 天</button>
            ))}
          </div>
          <button onClick={loadAuth} className="p-2.5 rounded-xl bg-white border border-black/5 shadow-sm text-gray-500 hover:text-[#5A5A40]" title="重新讀取最後登入時間"><RefreshCw size={16} /></button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          ['近 ' + days + ' 天登入次數', totalLogin, '次'],
          ['近 ' + days + ' 天有使用的帳號', activeAccounts, `／${users.length} 個`],
          ['近 ' + days + ' 天開啟系統', logs.length - totalLogin, '次'],
        ].map(([l, v, u]) => (
          <div key={l as string} className="bg-white rounded-2xl border border-black/5 shadow-sm px-5 py-4">
            <p className="text-[13px] font-bold text-gray-400 whitespace-nowrap">{l}</p>
            <p className="text-2xl font-bold tabular-nums mt-0.5 whitespace-nowrap">{v} <span className="text-xs font-normal text-gray-400">{u}</span></p>
          </div>
        ))}
      </div>

      {authErr && <p className="text-[13px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">「最後登入」欄讀不到（{authErr}），次數不受影響。</p>}

      <div className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="bg-[#F5F5F0] text-[13px] text-gray-500">
                <th className="px-5 py-3 font-bold">帳號</th>
                <th className="px-3 py-3 font-bold whitespace-nowrap">身分</th>
                <th className="px-3 py-3 font-bold whitespace-nowrap text-right">登入次數</th>
                <th className="px-3 py-3 font-bold whitespace-nowrap text-right">開啟系統</th>
                <th className="px-3 py-3 font-bold whitespace-nowrap">最後登入</th>
                <th className="px-3 py-3 font-bold whitespace-nowrap">最近使用</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {rows.map(r => {
                const isOpen = open === r.u.uid;
                return (
                  <React.Fragment key={r.u.uid}>
                    <tr className="hover:bg-black/[0.02] cursor-pointer" onClick={() => setOpen(isOpen ? null : r.u.uid)}>
                      <td className="px-5 py-3.5">
                        <p className="text-[15px] font-bold whitespace-nowrap">{r.u.displayName || '未設定名稱'}{r.disabled && <span className="ml-2 text-[12px] text-gray-400 font-normal">已停用</span>}</p>
                        <p className="text-[12px] text-gray-400 font-mono">{r.u.username}</p>
                      </td>
                      <td className="px-3 py-3.5 text-[13px] text-gray-600 whitespace-nowrap">{ROLE_LABEL[r.u.role] || r.u.role}</td>
                      <td className="px-3 py-3.5 text-right text-[17px] font-bold tabular-nums">{r.loginCount || <span className="text-gray-300">0</span>}</td>
                      <td className="px-3 py-3.5 text-right text-[15px] tabular-nums text-gray-600">{r.openCount || <span className="text-gray-300">0</span>}</td>
                      <td className="px-3 py-3.5 whitespace-nowrap">
                        <p className="text-[14px] tabular-nums">{fmt(r.lastLogin)}</p>
                        <p className="text-[12px] text-gray-400">{ago(r.lastLogin)}</p>
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap">
                        <p className="text-[14px] tabular-nums">{fmt(r.lastActive)}</p>
                        <p className="text-[12px] text-gray-400">{ago(r.lastActive)}</p>
                      </td>
                      <td className="pr-4"><ChevronDown size={18} className={`text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} /></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} className="bg-[#F5F5F0]/60 px-5 py-3">
                          {r.mine.length === 0 ? (
                            <p className="text-[13px] text-gray-400 py-2">近 {days} 天沒有紀錄（這個功能上線後才開始記）</p>
                          ) : (
                            <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto">
                              {r.mine.slice(0, 60).map(l => (
                                <span key={l.id} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[13px] whitespace-nowrap ${l.kind === 'login' ? 'bg-[#5A5A40] text-white' : 'bg-white border border-black/5 text-gray-600'}`}>
                                  {l.kind === 'login' ? <LogIn size={12} /> : l.device === '手機' ? <Smartphone size={12} /> : <Monitor size={12} />}
                                  {format(parseISO(l.at), 'MM/dd HH:mm')}
                                  <span className={l.kind === 'login' ? 'text-white/70' : 'text-gray-400'}>{l.kind === 'login' ? '登入' : '開啟'}・{l.device}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[13px] text-gray-400 px-1 leading-relaxed">
        登入＝輸入帳號密碼登入；開啟系統＝已經是登入狀態直接打開（同一個分頁重新整理不重複算）。次數從這個功能上線後開始累積；「最後登入」包含上線前 Firebase 記下的時間。
      </p>
    </div>
  );
}
