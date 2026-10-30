import React, { useEffect, useMemo, useState } from 'react';
import { collection, deleteField, doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { CheckCircle2, AlertTriangle, RefreshCw, Send, Users, Scissors, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { auth, db } from '../firebase';
import { useLiveCollection } from '../lib/liveData';
import { assignableEditors } from '../lib/editorRoster';
import { Editor, UserRole, Vendor } from '../types';
import UserManagement from './UserManagement';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// LINE 串接管理（2026-10-30）：跟 LINE 有關的設定統一在這一頁，只有主管／工程師。
// - 客戶群組：每個 IP 綁一個群組（vendors.clientLineGroupId），之後拍攝提醒發這裡；目前只綁定、不發通知
// - 剪輯群組：從剪輯師管理搬過來（editors.lineGroupId），送審通知／審片提醒照舊發
// - 同事個人通知：從員工管理搬過來（line_connections ↔ users.lineUserId）
// 群組清單＝機器人所在的群組，由 /api/webhook/line 在被邀請或群組有人講話時記下（line_groups）。

type LineGroup = { id: string; groupName?: string; leftAt?: string | null; lastSeenAt?: string };
type Status = {
  configured: boolean; botName?: string | null; basicId?: string | null; webhookUrl?: string | null;
  webhookActive?: boolean; webhookPointsHere?: boolean; quotaType?: string | null; quota?: number | null; used?: number | null; personalPush?: boolean;
};
type Tab = 'clients' | 'editors' | 'people';

const select = 'w-full min-w-0 text-sm bg-[#F5F5F0] rounded-lg border-none px-3 py-2 truncate focus:ring-2 focus:ring-[#5A5A40]';

export default function LineIntegration({ currentUserRole }: { currentUserRole: UserRole }) {
  const vendors = useLiveCollection<Vendor>('vendors');
  const editors = useLiveCollection<Editor>('editors');
  const [groups, setGroups] = useState<LineGroup[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('clients');

  useEffect(() => onSnapshot(
    collection(db, 'line_groups'),
    snap => setGroups(snap.docs.map(d => ({ id: d.id, ...d.data() } as LineGroup)).filter(g => !g.leftAt)),
    () => setGroups([]),
  ), []);

  const loadStatus = async () => {
    setStatusError('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/admin/line-status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `伺服器回 ${res.status}`);
      setStatus(data);
    } catch (e: any) {
      setStatusError(e.message || '讀取失敗');
    }
  };
  useEffect(() => { loadStatus(); }, []);

  const groupName = (id?: string) => groups.find(g => g.id === id)?.groupName || id || '';
  const ipVendors = useMemo(
    () => vendors.filter(v => v.status !== 'ended').sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
    [vendors],
  );
  const { external, internal } = assignableEditors(editors);
  const activeEditors = [...external, ...internal];

  // 每個群組被誰用了：一個群組綁兩個 IP 不擋（同一個老闆兩個品牌常共用群組），但要看得出來
  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    const add = (gid: string | undefined, who: string) => { if (gid) m.set(gid, [...(m.get(gid) || []), who]); };
    vendors.forEach(v => add(v.clientLineGroupId, v.name));
    editors.filter(e => !e.leftAt).forEach(e => add(e.lineGroupId, `剪輯師 ${e.name}`));
    return m;
  }, [vendors, editors]);
  const unbound = groups.filter(g => !usedBy.has(g.id));
  const isLive = (gid?: string) => !!gid && groups.some(g => g.id === gid);

  const bindVendor = async (v: Vendor, gid: string) => {
    try {
      await updateDoc(doc(db, 'vendors', v.id!), { clientLineGroupId: gid || deleteField() });
      toast.success(gid ? `${v.name} 綁定「${groupName(gid)}」` : `已解除 ${v.name} 的群組`);
    } catch {
      toast.error('更新失敗');
    }
  };

  const bindEditor = async (e: Editor, gid: string) => {
    try {
      await updateDoc(doc(db, 'editors', e.id!), { lineGroupId: gid || deleteField() });
      toast.success(gid ? `${e.name} 的送審通知會發到「${groupName(gid)}」` : `已關閉 ${e.name} 的群組通知`);
    } catch {
      toast.error('更新失敗');
    }
  };

  // 跟原本剪輯師管理的「發測試」同一支端點：往群組發兩則【測試】（送審通知＋審片提醒）
  const sendEditorTest = async (gid: string) => {
    if (!window.confirm('往這個群組發兩則【測試】訊息（送審通知＋審片提醒）？群組裡的人都看得到，也會用掉 LINE 則數。')) return;
    setTesting(gid);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/admin/test-review-notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, groupId: gid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `伺服器回 ${res.status}`);
      toast.success('已發出測試訊息');
    } catch (err: any) {
      toast.error(err.message || '發送失敗');
    } finally {
      setTesting(null);
    }
  };

  const groupSelect = (current: string | undefined, onChange: (gid: string) => void) => (
    <select value={current || ''} onChange={e => onChange(e.target.value)} className={select}>
      <option value="">選擇群組…</option>
      {current && !isLive(current) && <option value={current}>（機器人已不在這群）</option>}
      {groups.map(g => <option key={g.id} value={g.id}>{g.groupName || g.id}</option>)}
    </select>
  );

  // 一個 IP／剪輯師一張小卡：名稱＋狀態在上、選群組在下，排成格子，不再整條螢幕寬
  const bindCard = (key: string, name: string, current: string | undefined, onChange: (gid: string) => void,
    emptyLabel: string, self: string, extra?: React.ReactNode) => {
    const others = (current && usedBy.get(current)?.filter(w => w !== self)) || [];
    return (
      <div key={key} className="bg-white rounded-2xl border border-black/5 shadow-sm p-4 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold truncate">{name}</span>
          <span className={cn('shrink-0 px-2 py-0.5 rounded-full text-[12px] font-bold whitespace-nowrap',
            isLive(current) ? 'bg-green-100 text-green-700' : current ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-400')}>
            {isLive(current) ? '已綁定' : current ? '群組失效' : emptyLabel}
          </span>
        </div>
        {groupSelect(current, onChange)}
        {(others.length > 0 || extra) && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-amber-600 truncate">{others.length ? `也綁了 ${others.join('、')}` : ''}</span>
            {extra}
          </div>
        )}
      </div>
    );
  };

  const boundClients = ipVendors.filter(v => isLive(v.clientLineGroupId)).length;
  const boundEditors = activeEditors.filter(e => isLive(e.lineGroupId)).length;
  const overQuota = status?.quota != null && status.used != null && status.used >= status.quota;
  const tabs: { id: Tab; label: string; icon: typeof Users; count?: string }[] = [
    { id: 'clients', label: '客戶群組', icon: Users, count: `${boundClients}/${ipVendors.length}` },
    { id: 'editors', label: '剪輯群組', icon: Scissors, count: `${boundEditors}/${activeEditors.length}` },
    { id: 'people', label: '同事個人通知', icon: User },
  ];

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-500">客戶群組、剪輯群組、同事個人通知，都在這裡綁定</p>

      {/* 帳號狀態：一條橫的就好，不佔一整張大卡 */}
      <div className="bg-white rounded-2xl border border-black/5 shadow-sm px-5 py-4 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
        {statusError && <span className="text-red-500">{statusError}</span>}
        {!status && !statusError && <span className="text-gray-400">讀取 LINE 帳號狀態…</span>}
        {status && !status.configured && <span className="text-red-500">系統還沒設定 LINE 金鑰</span>}
        {status?.configured && (
          <>
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[13px] text-gray-400 whitespace-nowrap">官方帳號</span>
              <span className="font-bold truncate">{status.botName || '—'}</span>
              <span className="text-[13px] text-gray-400 whitespace-nowrap">{status.basicId || ''}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] text-gray-400 whitespace-nowrap">接收群組訊息</span>
              {status.webhookActive && status.webhookPointsHere
                ? <span className="font-bold text-green-700 flex items-center gap-1 whitespace-nowrap"><CheckCircle2 size={14} />正常</span>
                : <span className="font-bold text-red-600 flex items-center gap-1 whitespace-nowrap"><AlertTriangle size={14} />{status.webhookActive ? '沒有接到 ERP' : '沒有開啟'}</span>}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] text-gray-400 whitespace-nowrap">本月已用</span>
              <span className={cn('font-bold whitespace-nowrap', overQuota && 'text-red-600')}>
                {status.used ?? '—'}{status.quotaType === 'limited' && status.quota != null ? ` / ${status.quota}` : ''} 則
              </span>
              {overQuota && <span className="text-[13px] text-red-600 whitespace-nowrap">用完了，通知發不出去</span>}
            </div>
          </>
        )}
        <button onClick={loadStatus} className="ml-auto p-2 rounded-lg hover:bg-gray-100 text-gray-400" title="重新整理"><RefreshCw size={16} /></button>
      </div>

      {unbound.length > 0 && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-5 py-3 text-sm flex flex-wrap items-center gap-2">
          <span className="font-bold text-red-600 whitespace-nowrap">還沒綁定的群組</span>
          {unbound.map(g => (
            <span key={g.id} className="px-2.5 py-0.5 rounded-full bg-white text-red-600 border border-red-100 text-[13px] font-bold whitespace-nowrap">{g.groupName || g.id}</span>
          ))}
        </div>
      )}

      <div className="flex bg-white p-1 rounded-2xl border border-black/5 shadow-sm w-fit max-w-full overflow-x-auto">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={cn('px-5 py-2 rounded-xl text-sm font-bold transition-all flex items-center gap-2 whitespace-nowrap',
                tab === t.id ? 'bg-[#5A5A40] text-white shadow-md' : 'text-gray-400 hover:bg-gray-50')}>
              <Icon size={16} />{t.label}
              {t.count && <span className={cn('text-[12px] font-normal', tab === t.id ? 'text-white/70' : 'text-gray-300')}>{t.count}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'clients' && (
        <div className="space-y-3">
          <p className="text-[13px] text-gray-400 px-1">之後拍攝提醒會發到這裡；目前只綁定，不會發任何訊息。剛加入機器人的群組，要有人在群組講一句話才會出現在選單</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {ipVendors.map(v => bindCard(v.id!, v.name, v.clientLineGroupId, gid => bindVendor(v, gid), '還沒綁', v.name))}
          </div>
        </div>
      )}

      {tab === 'editors' && (
        <div className="space-y-3">
          <p className="text-[13px] text-gray-400 px-1">剪輯師交片送審、每 2 個上班日的審片提醒會發到這裡</p>
          {activeEditors.length === 0 && <p className="text-sm text-gray-400 px-1">目前沒有剪輯師</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {activeEditors.map(e => {
              const gid = e.lineGroupId;
              return bindCard(e.id!, e.name, gid, g => bindEditor(e, g), '不通知', `剪輯師 ${e.name}`, isLive(gid) ? (
                <button onClick={() => sendEditorTest(gid!)} disabled={testing === gid}
                  className="shrink-0 flex items-center gap-1 text-[13px] font-bold text-gray-500 hover:text-[#5A5A40] whitespace-nowrap disabled:opacity-40">
                  <Send size={12} />{testing === gid ? '發送中…' : '發測試'}
                </button>
              ) : undefined);
            })}
          </div>
        </div>
      )}

      {tab === 'people' && (
        <div className="space-y-3">
          {status?.configured && !status.personalPush && (
            <p className="text-[13px] text-amber-700 bg-amber-50 border border-amber-100 rounded-2xl px-4 py-2.5">
              個人通知目前<b>全部關閉</b>（庫存警示、製作進度、同步失敗警報都不發私訊），省 LINE 則數；綁定照樣可以先做好，之後打開就會生效
            </p>
          )}
          <UserManagement currentUserRole={currentUserRole} mode="lineOnly" />
        </div>
      )}
    </div>
  );
}
