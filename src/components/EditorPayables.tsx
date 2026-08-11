import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Asset, Editor, EditorInvoice, Vendor } from '../types';
import {
  billingMonthOptions, getAssetFee, getBillableEditorId, getBillingMonth,
  isBillable, monthLabel, summarizeByEditor,
} from '../lib/editorBilling';
import {
  Wallet, CheckCircle2, Clock, AlertCircle, Ban, ChevronDown, ChevronRight,
  FileSpreadsheet, Users as UsersIcon,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';

const money = (n: number) => `$${n.toLocaleString()}`;
const UNASSIGNED = '__unassigned__';

export default function EditorPayables() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [invoices, setInvoices] = useState<EditorInvoice[]>([]);
  const [month, setMonth] = useState<string>(format(new Date(), 'yyyy-MM'));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const unsubs = [
      onSnapshot(collection(db, 'vendors'), s =>
        setVendors(s.docs.map(d => ({ id: d.id, ...d.data() } as Vendor)))),
      onSnapshot(collection(db, 'assets'), s =>
        setAssets(s.docs.map(d => ({ id: d.id, ...d.data() } as Asset)))),
      onSnapshot(collection(db, 'editors'), s =>
        setEditors(s.docs.map(d => ({ id: d.id, ...d.data() } as Editor)))),
      onSnapshot(
        collection(db, 'editorInvoices'),
        s => setInvoices(s.docs.map(d => ({ id: d.id, ...d.data() } as EditorInvoice))),
        err => console.warn('讀取請款單失敗（規則可能尚未部署）', err)
      ),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const editorName = (editorId: string) =>
    editorId === UNASSIGNED
      ? '未指派剪輯師'
      : editors.find(e => e.id === editorId)?.name || '未知剪輯師';

  // 不排除 archived：業主不用的片我們會封存，但剪輯師該領的錢照算。
  // 「有沒有被使用」只是對帳單上的一個標註，不影響金額。
  const videoAssets = useMemo(() => assets.filter(a => a.type === 'video'), [assets]);

  /** 這支我們最後有沒有真的用：封存＝丟垃圾桶/暫存區，未使用 */
  const usageLabel = (a: Asset) => (a.status === 'archived' ? '未使用' : a.usedInPostId ? '已使用' : '未排程');

  const monthOptions = useMemo(() => billingMonthOptions(videoAssets), [videoAssets]);

  const summaries = useMemo(
    () => summarizeByEditor(month, videoAssets, vendors, editorName, invoices),
    [month, videoAssets, vendors, editors, invoices]
  );

  const totals = summaries.reduce(
    (acc, r) => ({
      unsubmitted: acc.unsubmitted + r.unsubmittedAmount,
      submitted: acc.submitted + r.submittedAmount,
      paid: acc.paid + r.paidAmount,
      all: acc.all + r.totalAmount,
    }),
    { unsubmitted: 0, submitted: 0, paid: 0, all: 0 }
  );

  const monthInvoices = invoices.filter(i => i.billingMonth === month && i.status !== 'void');

  /** 某位剪輯師這個月「還沒送單」的片 */
  const unsubmittedOf = (editorId: string) =>
    videoAssets.filter(a =>
      isBillable(a) &&
      getBillingMonth(a) === month &&
      (getBillableEditorId(a, vendors) || UNASSIGNED) === editorId
    );

  const markPaid = async (inv: EditorInvoice) => {
    setBusyId(inv.id!);
    try {
      await updateDoc(doc(db, 'editorInvoices', inv.id!), {
        status: 'paid',
        paidAt: new Date().toISOString(),
        paidByUid: auth.currentUser?.uid || '',
      });
      toast.success(`已標記 ${inv.editorName} ${monthLabel(inv.billingMonth)} 請款完成`);
    } catch (e) {
      console.error('Mark paid failed:', e);
      toast.error('操作失敗（可能是權限規則尚未部署）');
    } finally {
      setBusyId(null);
    }
  };

  const voidInvoice = async (inv: EditorInvoice) => {
    setBusyId(inv.id!);
    try {
      await updateDoc(doc(db, 'editorInvoices', inv.id!), {
        status: 'void',
        voidedAt: new Date().toISOString(),
        voidReason: '後台作廢',
      });
      // ⚠️ 作廢不會解鎖素材上的 editorInvoiceId（規則禁止清空，那是防重複請款的鎖）。
      // 那批片因此不會自動回到可請款清單，需要工程師個別處理。
      toast.success('已作廢。該批素材不會自動回到可請款清單，需要工程師處理');
    } catch (e) {
      console.error('Void failed:', e);
      toast.error('操作失敗（可能是權限規則尚未部署）');
    } finally {
      setBusyId(null);
    }
  };

  const exportExcel = async () => {
    const XLSX = await import('xlsx');
    const detail: Record<string, string | number>[] = [];

    for (const r of summaries) {
      for (const a of unsubmittedOf(r.editorId)) {
        detail.push({
          剪輯師: r.editorName,
          IP: vendors.find(v => v.id === a.vendorId)?.name || '未知 IP',
          片名: a.title,
          上傳日: a.cloudUploadedAt ? format(parseISO(a.cloudUploadedAt), 'yyyy-MM-dd') : '',
          金額: getAssetFee(a),
          狀態: '未請款（剪輯師尚未送單）',
          使用狀態: usageLabel(a),
          請款單號: '-',
        });
      }
    }
    for (const inv of monthInvoices) {
      for (const it of inv.items) {
        // 使用狀態要查當下的素材，不能用單上的快照——單是送出當下凍結的，
        // 但「我們後來到底有沒有用這支」是之後才決定的事。
        const live = assets.find(a => a.id === it.assetId);
        detail.push({
          剪輯師: inv.editorName,
          IP: it.vendorName,
          片名: it.title,
          上傳日: it.cloudUploadedAt ? format(parseISO(it.cloudUploadedAt), 'yyyy-MM-dd') : '',
          金額: it.amount,
          狀態: inv.status === 'paid' ? '已請款' : '已送出，待付款',
          使用狀態: live ? usageLabel(live) : '素材已刪除',
          請款單號: inv.id?.slice(-8).toUpperCase() || '',
        });
      }
    }

    const summaryRows = summaries.map(r => ({
      剪輯師: r.editorName,
      未送單支數: r.unsubmittedCount, 未送單金額: r.unsubmittedAmount,
      待付款支數: r.submittedCount, 待付款金額: r.submittedAmount,
      已請款支數: r.paidCount, 已請款金額: r.paidAmount,
      合計支數: r.totalCount, 合計金額: r.totalAmount,
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), '剪輯師彙總');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), '逐支明細');
    XLSX.writeFile(wb, `剪輯師對帳_${month}.xlsx`);
    toast.success('對帳清單已下載');
  };

  const stats = [
    { label: '本月應付合計', value: totals.all, icon: Wallet, color: 'text-[#5A5A40]', bg: 'bg-[#5A5A40]/10' },
    { label: '未請款（等剪輯師送單）', value: totals.unsubmitted, icon: AlertCircle, color: 'text-[#A67C52]', bg: 'bg-[#A67C52]/10' },
    { label: '已送出待付款', value: totals.submitted, icon: Clock, color: 'text-[#8B7355]', bg: 'bg-[#8B7355]/10' },
    { label: '已請款', value: totals.paid, icon: CheckCircle2, color: 'text-[#8A8A6A]', bg: 'bg-[#8A8A6A]/10' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <div key={i} className="bg-white p-4 rounded-2xl border border-black/5 shadow-sm">
            <div className={`p-2 rounded-lg w-fit mb-2 ${s.bg}`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className="text-xs text-gray-500 font-medium">{s.label}</p>
            <p className="text-lg font-bold">{money(s.value)}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-gray-400 w-10 shrink-0">月份</span>
          {monthOptions.map(m => (
            <button
              key={m}
              onClick={() => setMonth(m)}
              className={month === m
                ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
                : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
            >
              {monthLabel(m)}<span className="ml-1 opacity-60">{m.slice(0, 4)}</span>
            </button>
          ))}
        </div>
        <button
          onClick={exportExcel}
          disabled={summaries.length === 0}
          className="flex items-center gap-1.5 bg-white border border-black/10 text-[#5A5A40] px-4 py-2 rounded-xl text-xs font-bold hover:bg-black/[0.02] disabled:opacity-40"
        >
          <FileSpreadsheet size={14} /> 下載對帳清單
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-black/5">
          <h3 className="text-sm font-bold text-[#5A5A40] flex items-center gap-2">
            <UsersIcon size={14} /> {monthLabel(month)}各剪輯師應付
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-black/5 text-gray-500">
              {summaries.length}
            </span>
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            「未請款」代表片已上傳但剪輯師還沒送單，要催的是他；「已送出待付款」代表球在我們這邊。
          </p>
        </div>

        {summaries.length === 0 ? (
          <div className="p-10 text-center text-gray-400 italic text-xs">
            {monthLabel(month)}沒有任何應付款項
          </div>
        ) : (
          <div className="divide-y divide-black/5">
            {summaries.map(r => {
              const open = !!expanded[r.editorId];
              const myInvoices = monthInvoices.filter(i => i.editorId === r.editorId);
              const pending = unsubmittedOf(r.editorId);
              return (
                <div key={r.editorId}>
                  <button
                    onClick={() => setExpanded(p => ({ ...p, [r.editorId]: !open }))}
                    className="w-full text-left px-5 py-3 hover:bg-black/[0.015] flex items-center gap-3"
                  >
                    {open ? <ChevronDown size={14} className="text-gray-400 shrink-0" />
                          : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
                    <span className="font-bold text-sm text-[#5A5A40] w-32 shrink-0 truncate">{r.editorName}</span>
                    <div className="flex-1 flex items-center gap-4 flex-wrap text-[11px]">
                      {r.unsubmittedCount > 0 && (
                        <span className="text-[#A67C52] font-bold">
                          未請款 {r.unsubmittedCount} 支 {money(r.unsubmittedAmount)}
                        </span>
                      )}
                      {r.submittedCount > 0 && (
                        <span className="text-[#8B7355] font-bold">
                          待付款 {r.submittedCount} 支 {money(r.submittedAmount)}
                        </span>
                      )}
                      {r.paidCount > 0 && (
                        <span className="text-[#8A8A6A]">
                          已請款 {r.paidCount} 支 {money(r.paidAmount)}
                        </span>
                      )}
                    </div>
                    <span className="font-bold text-sm shrink-0">{money(r.totalAmount)}</span>
                  </button>

                  {open && (
                    <div className="px-5 pb-4 space-y-3 bg-black/[0.01]">
                      {myInvoices.map(inv => (
                        <div key={inv.id} className="bg-white rounded-xl border border-black/5 p-3 space-y-2">
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-bold text-[#5A5A40]">
                                單號 {inv.id?.slice(-8).toUpperCase()}
                              </span>
                              <span className="text-[11px] text-gray-400">
                                {inv.itemCount} 支 · {money(inv.totalAmount)}
                              </span>
                              {inv.status === 'paid' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[9px] font-bold border border-green-200">
                                  <CheckCircle2 size={9} /> 已請款
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[9px] font-bold border border-amber-200">
                                  <Clock size={9} /> 待付款
                                </span>
                              )}
                            </div>
                            {inv.status !== 'paid' && (
                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => markPaid(inv)}
                                  disabled={busyId === inv.id}
                                  className="flex items-center gap-1 bg-[#5A5A40] text-white px-3 py-1.5 rounded-lg text-[10px] font-bold hover:bg-[#4a4a35] disabled:opacity-40"
                                >
                                  <CheckCircle2 size={10} /> 標記已請款
                                </button>
                                <button
                                  onClick={() => voidInvoice(inv)}
                                  disabled={busyId === inv.id}
                                  className="flex items-center gap-1 bg-white border border-red-200 text-red-600 px-3 py-1.5 rounded-lg text-[10px] font-bold hover:bg-red-50 disabled:opacity-40"
                                >
                                  <Ban size={10} /> 作廢
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="space-y-0.5">
                            {inv.items.map(it => {
                              const live = assets.find(a => a.id === it.assetId);
                              const unused = live?.status === 'archived';
                              return (
                                <div key={it.assetId} className="text-[10px] text-gray-500 flex items-center gap-1.5">
                                  <span className="truncate">
                                    {it.vendorName}｜{it.title}（{money(it.amount)}）
                                  </span>
                                  {!live && (
                                    <span className="shrink-0 px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 text-[9px] font-bold">
                                      素材已刪除
                                    </span>
                                  )}
                                  {unused && (
                                    <span className="shrink-0 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[9px] font-bold">
                                      未使用
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}

                      {pending.length > 0 && (
                        <div className="bg-white rounded-xl border border-dashed border-[#A67C52]/40 p-3">
                          <p className="text-xs font-bold text-[#A67C52] mb-1.5">
                            尚未送單 {pending.length} 支（片已上傳，等他自己送出請款）
                          </p>
                          <div className="space-y-0.5">
                            {pending.map(a => (
                              <div key={a.id} className="text-[10px] text-gray-500 flex items-center gap-1.5">
                                <span className="truncate">
                                  {vendors.find(v => v.id === a.vendorId)?.name || '未知 IP'}｜{a.title}（{money(getAssetFee(a))}）
                                </span>
                                {a.status === 'archived' && (
                                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[9px] font-bold">
                                    未使用
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
