import { useEffect, useMemo, useState } from 'react';
import {
  collection, doc, onSnapshot, query, where, writeBatch,
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import {
  Asset, DEFAULT_EDITOR_FEE, EditorInvoice, UserProfile, Vendor,
} from '../types';
import {
  billingMonthOptions, buildInvoiceItems, getAssetFee, getBillingMonth,
  groupByVendor, listBillable, monthLabel, sumItems,
} from '../lib/editorBilling';
import {
  Receipt, Send, CheckCircle2, FileText, Ban, Wallet, CalendarDays, ShieldCheck,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';

const money = (n: number) => `$${n.toLocaleString()}`;

function StatusBadge({ status }: { status: EditorInvoice['status'] }) {
  if (status === 'paid') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[10px] font-bold border border-green-200">
        <CheckCircle2 size={10} /> 已請款
      </span>
    );
  }
  if (status === 'void') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-50 text-gray-400 text-[10px] font-bold border border-black/5">
        <Ban size={10} /> 已作廢
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-200">
      <Send size={10} /> 已送出，待付款
    </span>
  );
}

export default function EditorInvoicePage({ userProfile }: { userProfile: UserProfile | null }) {
  const vendorIds = userProfile?.assignedVendorIds || [];
  const vendorIdsKey = [...vendorIds].sort().join(',');
  const myEditorId = userProfile?.linkedEditorId;

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [invoices, setInvoices] = useState<EditorInvoice[]>([]);
  const [month, setMonth] = useState<string>(format(new Date(), 'yyyy-MM'));
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [fees, setFees] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  // 送出後金額就凍結、而且是錢的事，所以中間一定要有一道「停下來看清楚」的關卡
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [doneInfo, setDoneInfo] = useState<{ month: string; count: number; total: number } | null>(null);

  useEffect(() => {
    if (vendorIds.length === 0) { setVendors([]); setAssets([]); return; }
    const unsubs = vendorIds.flatMap(vid => [
      onSnapshot(doc(db, 'vendors', vid), snap => {
        setVendors(prev => {
          const others = prev.filter(v => v.id !== vid);
          return snap.exists() ? [...others, { id: snap.id, ...snap.data() } as Vendor] : others;
        });
      }),
      onSnapshot(query(collection(db, 'assets'), where('vendorId', '==', vid)), snap => {
        setAssets(prev => {
          const others = prev.filter(a => a.vendorId !== vid);
          return [...others, ...snap.docs.map(d => ({ id: d.id, ...d.data() } as Asset))];
        });
      }),
    ]);
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  // ⚠️ 這個 where 不能省。Firestore 規則是逐文件評估的，剪輯師只讀得到 editorId 是自己的單，
  // 沒有把查詢範圍先收斂到自己身上的話，整個查詢會直接 permission-denied（不是回空陣列）。
  useEffect(() => {
    if (!myEditorId) { setInvoices([]); return; }
    const unsub = onSnapshot(
      query(collection(db, 'editorInvoices'), where('editorId', '==', myEditorId)),
      snap => setInvoices(snap.docs.map(d => ({ id: d.id, ...d.data() } as EditorInvoice))),
      err => console.warn('讀取請款單失敗（規則可能尚未部署）', err)
    );
    return () => unsub();
  }, [myEditorId]);

  const vendorName = (vendorId: string) => vendors.find(v => v.id === vendorId)?.name || '未知 IP';

  // 只算掛在我名下的片：素材可逐支覆寫剪輯師，別人的片不該進我的請款單。
  // ⚠️ 刻意**不排除 archived**：業主不用那支片時我們會封存，但剪輯師已經剪完也上傳了，
  //    錢照算。用不用是我們的事，不是他的事。
  const myAssets = useMemo(
    () => assets.filter(a =>
      a.type === 'video' &&
      (!myEditorId || !a.billableEditorId || a.billableEditorId === myEditorId) &&
      (!myEditorId || !a.editorId || a.editorId === myEditorId)
    ),
    [assets, myEditorId]
  );

  const monthOptions = useMemo(() => billingMonthOptions(myAssets), [myAssets]);
  const billable = useMemo(() => listBillable(myAssets, month), [myAssets, month]);
  const groups = useMemo(() => groupByVendor(billable, vendorName), [billable, vendors]);

  const feeOf = (a: Asset) => fees[a.id!] ?? getAssetFee(a);
  const chosen = billable.filter(a => selected[a.id!]);
  const chosenTotal = chosen.reduce((acc, a) => acc + feeOf(a), 0);
  const billableTotal = billable.reduce((acc, a) => acc + feeOf(a), 0);

  const monthInvoices = invoices
    .filter(i => i.billingMonth === month && i.status !== 'void')
    .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));

  const setFee = (assetId: string, raw: string) => {
    // parseInt('') → NaN 會讓 Firestore 規則的 is int 判定失敗，噴出看不懂的 permission-denied
    const n = Number(raw);
    setFees(prev => ({ ...prev, [assetId]: Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_EDITOR_FEE }));
  };

  const toggleAll = (list: Asset[], on: boolean) => {
    setSelected(prev => {
      const next = { ...prev };
      for (const a of list) next[a.id!] = on;
      return next;
    });
  };

  const submit = async () => {
    if (!auth.currentUser || !myEditorId) { toast.error('這個帳號還沒對應到剪輯師，請聯繫管理員'); return; }
    if (chosen.length === 0) { toast.error('請先勾選要請款的片'); return; }

    setSubmitting(true);
    try {
      const overrides: Record<string, number> = {};
      for (const a of chosen) overrides[a.id!] = feeOf(a);
      const items = buildInvoiceItems(chosen, vendors, overrides);
      const nowIso = new Date().toISOString();

      const batch = writeBatch(db);
      const invoiceRef = doc(collection(db, 'editorInvoices'));
      const payload: EditorInvoice = {
        editorId: myEditorId,
        editorName: userProfile?.displayName || userProfile?.username || '',
        submittedByUid: auth.currentUser.uid,
        billingMonth: month,
        items,
        itemCount: items.length,
        totalAmount: sumItems(items),
        status: 'submitted',
        submittedAt: nowIso,
        createdAt: nowIso,
      };
      batch.set(invoiceRef, payload);

      // 同一批把金額寫回素材：這樣後台對帳時「單上的金額」跟「素材上的金額」永遠一致，
      // 對不上就代表有人動過手腳。editorInvoiceId 是防重複請款的鎖，規則只允許 unset→set。
      for (const a of chosen) {
        batch.update(doc(db, 'assets', a.id!), {
          editorFee: overrides[a.id!],
          editorInvoiceId: invoiceRef.id,
        });
      }

      await batch.commit();
      setSelected({});
      setConfirmOpen(false);
      setAck(false);
      // 用完成視窗取代 toast：對帳是一個月一次的儀式性動作，一閃而過的提示不足以讓人放心
      setDoneInfo({ month, count: items.length, total: payload.totalAmount });
    } catch (error) {
      console.error('Submit invoice failed:', error);
      toast.error('送出失敗。若持續發生請聯繫管理員（可能是權限規則尚未部署）');
    } finally {
      setSubmitting(false);
    }
  };

  if (vendorIds.length === 0) {
    return (
      <div className="bg-white rounded-3xl shadow-sm border border-black/5 p-12 flex flex-col items-center justify-center text-center space-y-4">
        <div className="w-16 h-16 bg-[#5A5A40]/10 rounded-2xl flex items-center justify-center text-[#5A5A40]">
          <Receipt size={28} />
        </div>
        <div>
          <h3 className="text-lg font-bold serif text-[#5A5A40]">我的請款</h3>
          <p className="text-xs text-amber-600 bg-amber-50 px-4 py-2 rounded-xl mt-3">
            目前尚未被指派任何廠商，請聯繫管理員設定。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold serif text-[#5A5A40] flex items-center gap-2">
            <Receipt size={20} /> 我的請款
          </h2>
          <p className="text-xs text-gray-400 mt-1">
            按過「上傳雲端」的片就會出現在這裡。核對金額後勾選送出，我們收到就會請你填勞報單。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="bg-white px-4 py-2 rounded-2xl border border-black/5 shadow-sm">
            <p className="text-[10px] font-bold text-gray-400">本月可請款</p>
            <p className="text-lg font-bold leading-none text-[#5A5A40]">
              {billable.length} <span className="text-xs font-normal text-gray-400">支</span>
            </p>
          </div>
          <div className="bg-white px-4 py-2 rounded-2xl border border-[#5A5A40]/20 shadow-sm">
            <p className="text-[10px] font-bold text-gray-400">金額合計</p>
            <p className="text-lg font-bold leading-none text-[#5A5A40]">{money(billableTotal)}</p>
          </div>
        </div>
      </div>

      {/* 月份切換：月初回頭送上個月的單是常態，不能只給本月 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-bold text-gray-400 w-10 shrink-0">月份</span>
        {monthOptions.map(m => (
          <button
            key={m}
            onClick={() => { setMonth(m); setSelected({}); }}
            className={month === m
              ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
              : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
          >
            {monthLabel(m)}
            <span className="ml-1 opacity-60">{m.slice(0, 4)}</span>
          </button>
        ))}
      </div>

      {/* 可請款清單，依 IP 分組 */}
      <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-black/5 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-[#5A5A40] flex items-center gap-2">
              <CalendarDays size={14} /> {monthLabel(month)}可請款清單
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-black/5 text-gray-500">
                {billable.length}
              </span>
            </h3>
            <p className="text-[11px] text-gray-400 mt-0.5">
              預設每支 {money(DEFAULT_EDITOR_FEE)}，未滿 60 秒的請改成 750。
              送出後金額就凍結，請務必重新確認；若有問題請聯絡對接 PM。
            </p>
          </div>
          {billable.length > 0 && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => toggleAll(billable, true)}
                className="px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]"
              >
                全選
              </button>
              <button
                onClick={() => toggleAll(billable, false)}
                className="px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]"
              >
                清除
              </button>
            </div>
          )}
        </div>

        {billable.length === 0 ? (
          <div className="p-10 text-center text-gray-400 italic text-xs">
            {monthLabel(month)}沒有可請款的片。按過「上傳雲端」的片才會出現在這裡。
          </div>
        ) : (
          <div className="divide-y divide-black/5">
            {groups.map(g => (
              <div key={g.vendorId}>
                <div className="px-5 py-2 bg-black/[0.015] flex items-center justify-between">
                  <span className="text-[11px] font-bold text-[#5A5A40]">{g.vendorName}</span>
                  <span className="text-[10px] text-gray-400">
                    {g.assets.length} 支 · {money(g.assets.reduce((acc, a) => acc + feeOf(a), 0))}
                  </span>
                </div>
                {g.assets.map(a => (
                  <label
                    key={a.id}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-black/[0.015] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={!!selected[a.id!]}
                      onChange={e => setSelected(prev => ({ ...prev, [a.id!]: e.target.checked }))}
                      className="w-4 h-4 accent-[#5A5A40] shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-600 truncate">{a.title}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {a.cloudUploadedAt ? `${format(parseISO(a.cloudUploadedAt), 'MM/dd')} 上傳雲端` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[11px] text-gray-400">$</span>
                      <input
                        type="number"
                        min={0}
                        step={50}
                        value={feeOf(a)}
                        onChange={e => setFee(a.id!, e.target.value)}
                        onClick={e => e.preventDefault()}
                        className="w-20 px-2 py-1 rounded-lg border border-black/10 text-sm text-right font-bold text-[#5A5A40] focus:outline-none focus:border-[#5A5A40]"
                      />
                    </div>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}

        {billable.length > 0 && (
          <div className="px-5 py-3 border-t border-black/5 bg-white flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-gray-500">
              已勾選 <span className="font-bold text-[#5A5A40]">{chosen.length}</span> 支 ·
              合計 <span className="font-bold text-[#5A5A40]">{money(chosenTotal)}</span>
            </p>
            <button
              onClick={() => { setAck(false); setConfirmOpen(true); }}
              disabled={chosen.length === 0}
              className="flex items-center gap-1.5 bg-[#5A5A40] text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm hover:bg-[#4a4a35] transition-all disabled:opacity-40"
            >
              <Send size={14} />
              送出請款
            </button>
          </div>
        )}
      </div>

      {/* 已送出的單：讓剪輯師自己查得到「這個月我請了沒、請了多少」 */}
      <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-black/5">
          <h3 className="text-sm font-bold text-[#5A5A40] flex items-center gap-2">
            <FileText size={14} /> {monthLabel(month)}已送出的請款單
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-black/5 text-gray-500">
              {monthInvoices.length}
            </span>
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">送出後金額不能再改，如果有錯請聯繫我們。</p>
        </div>
        {monthInvoices.length === 0 ? (
          <div className="p-10 text-center text-gray-400 italic text-xs">
            {monthLabel(month)}還沒送出任何請款單
          </div>
        ) : (
          <div className="divide-y divide-black/5">
            {monthInvoices.map(inv => (
              <div key={inv.id} className="px-5 py-3 space-y-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-[#5A5A40] flex items-center gap-1.5">
                      <Wallet size={14} /> {money(inv.totalAmount)}
                    </span>
                    <span className="text-[11px] text-gray-400">{inv.itemCount} 支</span>
                    <StatusBadge status={inv.status} />
                  </div>
                  <span className="text-[10px] text-gray-400">
                    {inv.submittedAt ? `${format(parseISO(inv.submittedAt), 'MM/dd HH:mm')} 送出` : ''}
                  </span>
                </div>
                <div className="text-[10px] text-gray-400 leading-relaxed">
                  {inv.items.map(it => `${it.vendorName}｜${it.title}（${money(it.amount)}）`).join('　')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 送出前的防呆：把整份金額攤開再確認一次。錢的事不能只靠一顆按鈕。 */}
      {confirmOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
            <div className="px-6 pt-5 pb-4 border-b border-black/5">
              <h3 className="text-lg font-bold serif text-[#5A5A40] flex items-center gap-2">
                <ShieldCheck size={18} /> 確認 {monthLabel(month)} 請款金額
              </h3>
              <p className="text-[11px] text-gray-400 mt-1">
                送出後金額就凍結，無法自行修改。請逐項核對，若有問題請先聯絡對接 PM。
              </p>
            </div>

            <div className="px-6 py-3 overflow-y-auto flex-1">
              <div className="divide-y divide-black/5">
                {chosen.map(a => (
                  <div key={a.id} className="py-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold text-[#5A5A40]">{vendorName(a.vendorId)}</p>
                      <p className="text-xs text-gray-600 truncate">{a.title}</p>
                      <p className="text-[10px] text-gray-400">
                        {a.cloudUploadedAt ? `${format(parseISO(a.cloudUploadedAt), 'MM/dd')} 上傳雲端` : ''}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-[#5A5A40] shrink-0">{money(feeOf(a))}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-black/5 bg-black/[0.015] space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">{monthLabel(month)}請款合計（{chosen.length} 支）</span>
                <span className="text-2xl font-bold text-[#5A5A40]">{money(chosenTotal)}</span>
              </div>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={e => setAck(e.target.checked)}
                  className="w-4 h-4 accent-[#5A5A40] mt-0.5 shrink-0"
                />
                <span className="text-xs text-gray-600 leading-relaxed">
                  我已重新確認以上支數與金額無誤，了解送出後即凍結、不能自行修改。
                </span>
              </label>

              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => { setConfirmOpen(false); setAck(false); }}
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-white border border-black/10 text-gray-500 hover:text-[#5A5A40] disabled:opacity-40"
                >
                  再檢查一次
                </button>
                <button
                  onClick={submit}
                  disabled={!ack || submitting}
                  className="flex items-center gap-1.5 bg-[#5A5A40] text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm hover:bg-[#4a4a35] transition-all disabled:opacity-40"
                >
                  <Send size={14} />
                  {submitting ? '送出中...' : '確認送出'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 完成視窗：對帳是一個月一次的事，要讓剪輯師明確知道「這個月結束了」 */}
      {doneInfo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="px-6 py-8 flex flex-col items-center text-center space-y-3">
              <div className="w-16 h-16 bg-green-50 rounded-2xl flex items-center justify-center text-green-600">
                <CheckCircle2 size={30} />
              </div>
              <h3 className="text-lg font-bold serif text-[#5A5A40]">
                已完成 {monthLabel(doneInfo.month)} 對帳流程
              </h3>
              <p className="text-sm text-gray-600">
                已送出 <span className="font-bold text-[#5A5A40]">{doneInfo.count}</span> 支，
                合計 <span className="font-bold text-[#5A5A40]">{money(doneInfo.total)}</span>
              </p>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                我們收到後會請你填寫勞報單。<br />
                金額已凍結，如需更正請聯絡對接 PM。
              </p>
            </div>
            <div className="px-6 pb-5">
              <button
                onClick={() => setDoneInfo(null)}
                className="w-full bg-[#5A5A40] text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-sm hover:bg-[#4a4a35] transition-all"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
