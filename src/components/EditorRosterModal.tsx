import { useEffect, useState } from 'react';
import { addDoc, collection, doc, getDocs, updateDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Editor, EditorKind, EDITOR_KIND_LABEL } from '../types';
import { assignableEditors, editorKind } from '../lib/editorRoster';
import { X, UserMinus } from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * 剪輯師管理（2026-10-21 使用者定義）：
 * - 只有兩種：外包（要請款）、內部（自己員工，不請款）。
 * - 離職不刪除：先把他手上沒做完的片、他負責的 IP 改派，再標離職、停用登入（後端 /api/editors/:id/leave）。
 * - 新增外包後，到「員工管理」幫他開登入帳號，再到 IP 卡片指定剪輯師。
 */
async function callLeave(id: string, body: Record<string, unknown>) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('認證已過期，請重新登入');
  const res = await fetch(`/api/editors/${encodeURIComponent(id)}/leave`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `伺服器回 ${res.status}`);
  return data;
}

type LineGroup = { id: string; groupName?: string; leftAt?: string | null };

type LeavePreview = { assets: { id: string; title: string; vendorName: string }[]; vendors: { id: string; name: string }[] };

/**
 * LINE 群組（2026-10-22）：每位剪輯師選一個群組，他交片送審、每 2 個上班日的審片提醒都發到那裡。
 * 選「不通知」＝關掉。群組清單是機器人所在的群組（webhook 記的 line_groups），只有主管看得到、改得到。
 */
export default function EditorRosterModal({ editors, onClose, canManage = false }: { editors: Editor[]; onClose: () => void; canManage?: boolean }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EditorKind>('external');
  const [leaving, setLeaving] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<LeavePreview | null>(null);
  const [toId, setToId] = useState('');
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<LineGroup[]>([]);

  useEffect(() => {
    if (!canManage) return;
    getDocs(collection(db, 'line_groups'))
      .then(snap => setGroups(snap.docs.map(d => ({ id: d.id, ...d.data() } as LineGroup)).filter(g => !g.leftAt)))
      .catch(() => setGroups([]));
  }, [canManage]);

  const add = async () => {
    if (!name.trim()) return;
    try {
      await addDoc(collection(db, 'editors'), { name: name.trim(), kind, createdAt: new Date().toISOString() });
      setName('');
      toast.success(kind === 'external' ? '已新增外包剪輯師。要讓他用系統，請到「員工管理」開登入帳號' : '已新增內部剪輯師');
    } catch {
      toast.error('新增失敗');
    }
  };

  const changeKind = async (e: Editor, next: EditorKind) => {
    if (editorKind(e) === next) return;
    const msg = next === 'internal'
      ? `把 ${e.name} 改成「內部」？\n\n改了之後他剪的片不會再進請款（已送出的請款單不受影響）。`
      : `把 ${e.name} 改成「外包」？\n\n改了之後他上傳雲端的片會進請款。`;
    if (!window.confirm(msg)) return;
    try {
      await updateDoc(doc(db, 'editors', e.id!), { kind: next });
      toast.success('已更新');
    } catch {
      toast.error('更新失敗');
    }
  };

  const openLeave = async (e: Editor) => {
    setLeaving(e); setPreview(null); setToId('');
    try {
      setPreview(await callLeave(e.id!, { dryRun: true }));
    } catch (err: any) {
      toast.error(err.message || '讀取失敗');
      setLeaving(null);
    }
  };

  const confirmLeave = async () => {
    if (!leaving) return;
    setBusy(true);
    try {
      const r = await callLeave(leaving.id!, { toEditorId: toId });
      toast.success(`${leaving.name} 已設為離職，改派 ${r.movedAssets} 支片、${r.movedVendors} 個 IP`);
      setLeaving(null);
    } catch (err: any) {
      toast.error(err.message || '設定離職失敗');
    } finally {
      setBusy(false);
    }
  };

  const active = assignableEditors(editors);
  const left = editors.filter(e => e.leftAt).sort((a, b) => (b.leftAt || '').localeCompare(a.leftAt || ''));
  const targets = assignableEditors(editors.filter(e => e.id !== leaving?.id));

  // 群組改到「LINE 串接管理」統一設定（2026-10-30），這裡只顯示目前綁哪個，免得兩個地方各改各的
  const groupRow = (e: Editor) => {
    const current = e.lineGroupId || '';
    const name = groups.find(g => g.id === current)?.groupName;
    return (
      <div className="flex items-center gap-2 mt-2 text-[13px] text-gray-500">
        <span className="shrink-0 font-bold whitespace-nowrap">LINE 群組</span>
        <span className="truncate">{current ? (name || '（機器人已不在這群）') : '不通知'}</span>
        <span className="shrink-0 text-gray-400 whitespace-nowrap">・到「LINE 串接管理」修改</span>
      </div>
    );
  };

  const row = (e: Editor) => (
    <div key={e.id} className="p-3 bg-[#F5F5F0] rounded-xl">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-bold text-[#5A5A40] truncate">{e.name}</span>
        {e.linkedUserUid && !e.leftAt && (
          <span className="shrink-0 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[13px] font-bold border border-green-200 whitespace-nowrap">有登入</span>
        )}
      </div>
      {e.leftAt ? (
        <span className="shrink-0 text-[13px] text-gray-400 whitespace-nowrap">{e.leftAt.slice(0, 10)} 離職</span>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={editorKind(e)}
            onChange={ev => changeKind(e, ev.target.value as EditorKind)}
            className="text-sm font-bold bg-white rounded-lg border border-black/10 px-2 py-1"
          >
            <option value="external">外包</option>
            <option value="internal">內部</option>
          </select>
          <button
            type="button"
            onClick={() => openLeave(e)}
            className="flex items-center gap-1 text-sm font-bold text-gray-500 hover:text-red-600 px-2 py-1 rounded-lg hover:bg-white whitespace-nowrap"
          >
            <UserMinus size={14} /> 離職
          </button>
        </div>
      )}
    </div>
    {canManage && !e.leftAt && groupRow(e)}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onMouseDown={() => !busy && onClose()}>
      <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onMouseDown={e => e.stopPropagation()}>
        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-[#F5F5F0]/50">
          <h3 className="text-xl font-bold serif text-[#5A5A40]">剪輯師管理</h3>
          <button onClick={onClose} className="p-2 hover:bg-white rounded-full transition-colors"><X size={20} /></button>
        </div>

        {leaving ? (
          <div className="p-6 space-y-4 overflow-y-auto">
            <h4 className="text-lg font-bold text-[#5A5A40]">{leaving.name} 離職</h4>
            {!preview ? (
              <p className="text-gray-500">讀取他手上的片…</p>
            ) : (
              <>
                <div className="text-[15px] text-gray-700 space-y-1">
                  <p>還沒完成的片：<b>{preview.assets.length}</b> 支</p>
                  <p>他是預設剪輯師的 IP：<b>{preview.vendors.length ? preview.vendors.map(v => v.name).join('、') : '沒有'}</b></p>
                  <p className="text-sm text-gray-500">已上傳雲端、已請款的片不動，紀錄照樣顯示他的名字。{leaving.linkedUserUid ? '他的登入帳號會停用。' : ''}</p>
                </div>
                {preview.assets.length > 0 && (
                  <ul className="max-h-40 overflow-y-auto text-sm text-gray-600 bg-[#F5F5F0] rounded-xl p-3 space-y-1">
                    {preview.assets.map(a => <li key={a.id} className="truncate">{a.vendorName}｜{a.title}</li>)}
                  </ul>
                )}
                <label className="block">
                  <span className="text-sm font-bold text-gray-700">這些片和 IP 改給</span>
                  <select value={toId} onChange={e => setToId(e.target.value)} className="mt-1 w-full p-3 bg-[#F5F5F0] rounded-xl border-none">
                    <option value="">內部剪輯（先不指定是誰）</option>
                    {targets.external.length > 0 && <optgroup label="外包">{targets.external.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</optgroup>}
                    {targets.internal.length > 0 && <optgroup label="內部">{targets.internal.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</optgroup>}
                  </select>
                </label>
                <div className="flex gap-3 pt-2">
                  <button type="button" onClick={() => setLeaving(null)} disabled={busy} className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-700 font-bold disabled:opacity-40">取消</button>
                  <button type="button" onClick={confirmLeave} disabled={busy} className="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold disabled:opacity-40">
                    {busy ? '處理中…' : '確定離職'}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="p-6 space-y-5 overflow-y-auto">
            <div className="flex gap-2">
              <input
                type="text" placeholder="輸入剪輯師姓名" value={name} onChange={e => setName(e.target.value)}
                className="flex-1 min-w-0 p-3 bg-[#F5F5F0] rounded-xl border-none focus:ring-2 focus:ring-[#5A5A40]"
              />
              <select value={kind} onChange={e => setKind(e.target.value as EditorKind)} className="p-3 bg-[#F5F5F0] rounded-xl border-none font-bold">
                <option value="external">{EDITOR_KIND_LABEL.external}</option>
                <option value="internal">{EDITOR_KIND_LABEL.internal}</option>
              </select>
              <button onClick={add} className="bg-[#5A5A40] text-white px-4 rounded-xl font-bold hover:bg-[#4a4a35] whitespace-nowrap">新增</button>
            </div>
            <p className="text-sm text-gray-500 -mt-2">外包要請款；內部是自己的員工，不請款。</p>
            {canManage && (
              <p className="text-sm text-gray-500 -mt-3">LINE 群組：剪輯師交片送審、審片提醒會發到選的群組；選「不通知」就關掉。群組要先把聚浪機器人邀進去、在群裡講一句話才會出現在選單。</p>
            )}

            {(['external', 'internal'] as const).map(k => (
              <section key={k} className="space-y-2">
                <h4 className="text-sm font-bold text-gray-500">{EDITOR_KIND_LABEL[k]}（{active[k].length}）</h4>
                {active[k].length ? active[k].map(row) : <p className="text-sm text-gray-400">沒有</p>}
              </section>
            ))}
            {left.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-bold text-gray-400">已離職</h4>
                {left.map(row)}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
