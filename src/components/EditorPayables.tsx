import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, updateDoc, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Asset, Editor, EditorInvoice, Vendor } from '../types';
import {
  billingMonthOptions, getAssetFee, getBillableEditorId, getBillingMonth,
  isBillable, monthLabel, needsLegacyReview, summarizeByEditor,
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
      approved: acc.approved + r.approvedAmount,
      processing: acc.processing + r.processingAmount,
      paid: acc.paid + r.paidAmount,
      all: acc.all + r.totalAmount,
    }),
    { unsubmitted: 0, submitted: 0, approved: 0, processing: 0, paid: 0, all: 0 }
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

  const advanceInvoice = async (inv: EditorInvoice, status: 'approved' | 'payment_processing') => {
    setBusyId(inv.id!);
    const now = new Date().toISOString();
    const uid = auth.currentUser?.uid || '';
    try {
      await updateDoc(doc(db, 'editorInvoices', inv.id!), status === 'approved'
        ? { status, approvedAt: now, approvedByUid: uid }
        : { status, processingAt: now, processingByUid: uid });
      toast.success(status === 'approved' ? '請款單已核准' : '已進入付款處理');
    } catch (e) {
      console.error('Advance invoice failed:', e);
      toast.error('操作失敗（可能是權限規則尚未部署）');
    } finally {
      setBusyId(null);
    }
  };

  const voidInvoice = async (inv: EditorInvoice) => {
    setBusyId(inv.id!);
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'editorInvoices', inv.id!), {
        status: 'void',
        voidedAt: new Date().toISOString(),
        voidReason: '後台作廢',
      });
      for (const it of inv.items || []) {
        batch.update(doc(db, 'assets', it.assetId), { editorInvoiceId: '' });
      }
      await batch.commit();
      toast.success('已完整作廢，該批素材已回到可請款清單');
    } catch (e) {
      console.error('Void failed:', e);
      toast.error('操作失敗（可能是權限規則尚未部署）');
    } finally {
      setBusyId(null);
    }
  };

  const legacyReview = useMemo(
    () => videoAssets.filter(needsLegacyReview)
      .sort((a, b) => (a.cloudUploadedAt || '').localeCompare(b.cloudUploadedAt || '')),
    [videoAssets]
  );

  const settleLegacy = async (asset: Asset, status: 'paid' | 'unpaid') => {
    setBusyId(`legacy-${asset.id}`);
    try {
      const now = new Date().toISOString();
      const common = {
        legacySettlementStatus: status,
        legacyReviewedAt: now,
        legacyReviewedByUid: auth.currentUser?.uid || '',
      };
      if (status === 'paid') {
        const raw = window.prompt('舊制實際已結清金額', String(getAssetFee(asset)));
        if (raw === null) return;
        const amount = Math.round(Number(raw));
        if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
          toast.error('金額格式不正確');
          return;
        }
        const source = window.prompt('結清依據（例如：8月勞報單、LINE 對帳）', '傳統記帳') ?? '';
        await updateDoc(doc(db, 'assets', asset.id!), {
          ...common, legacySettledAt: now, legacySettledAmount: amount, legacySettlementSource: source,
        });
        toast.success('已標記舊制結清，不會再進系統請款');
      } else {
        await updateDoc(doc(db, 'assets', asset.id!), common);
        toast.success('已轉入系統請款，剪輯師現在可看見');
      }
    } catch (e) {
      console.error('Legacy review failed:', e);
      toast.error('盤點更新失敗（可能是權限規則尚未部署）');
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
          狀態: inv.status === 'paid' ? '已付款'
            : inv.status === 'payment_processing' ? '付款處理中'
            : inv.status === 'approved' ? '公司已核准'
            : '已送出，待公司核准',
          使用狀態: live ? usageLabel(live) : '素材已刪除',
          請款單號: inv.id?.slice(-8).toUpperCase() || '',
        });
      }
    }

    const summaryRows = summaries.map(r => ({
      剪輯師: r.editorName,
      未送單支數: r.unsubmittedCount, 未送單金額: r.unsubmittedAmount,
      待核准支數: r.submittedCount, 待核准金額: r.submittedAmount,
      已核准支數: r.approvedCount, 已核准金額: r.approvedAmount,
      付款中支數: r.processingCount, 付款中金額: r.processingAmount,
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
    { label: '未請款（等剪輯師送單）', value: totals.unsubmitted, icon: AlertCircle, color: 'text-[#A67C52]', bg: 'bg-[#A67C52]/10' },
    { label: '待公司核准', value: totals.submitted, icon: Clock, color: 'text-[#8B7355]', bg: 'bg-[#8B7355]/10' },
    { label: '公司已核准', value: totals.approved, icon: CheckCircle2, color: 'text-blue-700', bg: 'bg-blue-50' },
    { label: '付款處理中', value: totals.processing, icon: Wallet, color: 'text-purple-700', bg: 'bg-purple-50' },
    { label: '已請款', value: totals.paid, icon: CheckCircle2, color: 'text-[#8A8A6A]', bg: 'bg-[#8A8A6A]/10' },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
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

      {legacyReview.length > 0 && (
        <div className="bg-amber-50 rounded-2xl border border-amber-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-amber-200">
            <h3 className="text-sm font-bold text-amber-800">舊帳待盤點 · {legacyReview.length} 支</h3>
            <p className="text-[11px] text-amber-700 mt-1">切帳日前上傳的片預設不開放請款。請逐支確認舊制是否已付款。</p>
          </div>
          <div className="divide-y divide-amber-200/70 max-h-80 overflow-y-auto">
            {legacyReview.map(a => (
              <div key={a.id} className="px-5 py-3 bg-white/60 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-52">
                  <p className="text-xs font-bold text-gray-700">{vendors.find(v => v.id === a.vendorId)?.name || '未知 IP'}｜{a.title}</p>
                  <p className="text-[10px] text-gray-500">{a.cloudUploadedAt ? format(parseISO(a.cloudUploadedAt), 'yyyy-MM-dd HH:mm') : ''} 上傳 · 預設 {money(getAssetFee(a))}</p>
                </div>
                <button onClick={() => settleLegacy(a, 'paid')} disabled={busyId === `legacy-${a.id}`} className="px-3 py-1.5 rounded-lg bg-gray-700 text-white text-[10px] font-bold disabled:opacity-40">舊制已結清</button>
                <button onClick={() => settleLegacy(a, 'unpaid')} disabled={busyId === `legacy-${a.id}`} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-[10px] font-bold disabled:opacity-40">尚未付，轉系統請款</button>
              </div>
            ))}
          </div>
        </div>
      )}

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
                          待核准 {r.submittedCount} 支 {money(r.submittedAmount)}
                        </span>
                      )}
                      {r.approvedCount > 0 && <span className="text-blue-700 font-bold">已核准 {r.approvedCount} 支 {money(r.approvedAmount)}</span>}
                      {r.processingCount > 0 && <span className="text-purple-700 font-bold">付款中 {r.processingCount} 支 {money(r.processingAmount)}</span>}
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
                              ) : inv.status === 'approved' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[9px] font-bold border border-blue-200">公司已核准</span>
                              ) : inv.status === 'payment_processing' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[9px] font-bold border border-purple-200">付款處理中</span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[9px] font-bold border border-amber-200">
                                  <Clock size={9} /> 待公司核准
                                </span>
                              )}
                            </div>
                            {inv.status !== 'paid' && (
                              <div className="flex items-center gap-1.5">
                                {inv.status === 'submitted' && <button onClick={() => advanceInvoice(inv, 'approved')} disabled={busyId === inv.id} className="flex items-center gap-1 bg-blue-700 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold disabled:opacity-40">公司核准</button>}
                                {inv.status === 'approved' && <button onClick={() => advanceInvoice(inv, 'payment_processing')} disabled={busyId === inv.id} className="flex items-center gap-1 bg-purple-700 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold disabled:opacity-40">開始付款處理</button>}
                                {inv.status === 'payment_processing' && <button onClick={() => markPaid(inv)} disabled={busyId === inv.id} className="flex items-center gap-1 bg-[#5A5A40] text-white px-3 py-1.5 rounded-lg text-[10px] font-bold disabled:opacity-40"><CheckCircle2 size={10} /> 確認已付款</button>}
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
