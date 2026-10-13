import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, deleteField, doc, onSnapshot, updateDoc, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebase';
import {
  Asset, DURATION_TIER_LABEL, DurationTier, EDITOR_FEE_BY_TIER,
  Editor, EditorInvoice, Vendor,
} from '../types';
import { useLiveCollection } from '../lib/liveData';
import {
  billingMonthOptions, findFee950Issues, getAssetFee, getBillableEditorId, getBillingMonth,
  groupByVendor, isBillable, isLegacyNeverUploaded, monthLabel, needsLegacyReview,
  summarizeByEditor, WRONG_OVER60_FEE,
} from '../lib/editorBilling';
import {
  CheckCircle2, Ban,
  FileSpreadsheet, FileDown,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';
import { toJpeg } from 'html-to-image';
import { jsPDF } from 'jspdf';
import EditorStatementPdf, {
  STATEMENT_STATUS_LABEL, groupRowsByVendor, type StatementMeta, type StatementRow, type StatementStatus,
} from './EditorStatementPdf';

const money = (n: number) => `$${n.toLocaleString()}`;
const UNASSIGNED = '__unassigned__';

const STATUS_BADGE: Record<StatementStatus, string> = {
  unsubmitted: 'bg-[#A67C52]/10 text-[#8B5E34] border-[#A67C52]/30',
  submitted: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-blue-50 text-blue-700 border-blue-200',
  payment_processing: 'bg-purple-50 text-purple-700 border-purple-200',
  paid: 'bg-green-50 text-green-700 border-green-200',
};

export default function EditorPayables() {
  // 共用即時資料層：整個 session 只訂閱一次，切分頁不再重讀
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const editors = useLiveCollection<Editor>('editors');
  const [invoices, setInvoices] = useState<EditorInvoice[]>([]);
  const [month, setMonth] = useState<string>(format(new Date(), 'yyyy-MM'));

  const [busyId, setBusyId] = useState<string | null>(null);
  // 管帳調價：只有還沒納入請款單的片可以改（入單後規則層也會擋）
  const [feeAsset, setFeeAsset] = useState<Asset | null>(null);
  const [feeCustom, setFeeCustom] = useState('');

  useEffect(() => {
    // editorInvoices 只有這一頁用，留在原地（不進共用資料層）
    const unsubs = [
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

  // 剪輯費 950 → 900 一次性更正（見 findFee950Issues）。沒有受影響的單時整張卡片不出現。
  const fee950 = useMemo(() => findFee950Issues(invoices, assets), [invoices, assets]);
  const [fee950Confirm, setFee950Confirm] = useState(false);
  const fee950Total = fee950.unpaid.length + fee950.processing.length + fee950.paid.length + fee950.strayAssetIds.length;

  const fixFee950 = async () => {
    setBusyId('fee950');
    try {
      const nowIso = new Date().toISOString();
      for (const { invoice, wrongAssetIds } of fee950.unpaid) {
        // 第一批：跟「作廢」按鈕一樣，整張單作廢、片放回可請款清單
        const voidBatch = writeBatch(db);
        voidBatch.update(doc(db, 'editorInvoices', invoice.id!), {
          status: 'void',
          voidedAt: nowIso,
          voidReason: '剪輯費 950→900 更正，請重新送單',
        });
        for (const it of invoice.items || []) {
          voidBatch.update(doc(db, 'assets', it.assetId), { editorInvoiceId: '' });
        }
        await voidBatch.commit();
        // 第二批：清掉凍結的 950，讓它回到分級價。
        // ⚠️ 不能跟第一批合併：規則的 internalUnlockingInvoice 要求解鎖那一筆「只動 editorInvoiceId」，
        //    而且同一個 batch 裡規則看到的還是解鎖前的狀態（仍在請款單上 → 計費欄位凍結）。
        const feeBatch = writeBatch(db);
        for (const id of wrongAssetIds) feeBatch.update(doc(db, 'assets', id), { editorFee: deleteField() });
        await feeBatch.commit();
      }
      if (fee950.strayAssetIds.length) {
        const strayBatch = writeBatch(db);
        for (const id of fee950.strayAssetIds) strayBatch.update(doc(db, 'assets', id), { editorFee: deleteField() });
        await strayBatch.commit();
      }
      toast.success('更正完成，請通知剪輯師重新送單');
      setFee950Confirm(false);
    } catch (e) {
      console.error('Fee 950 fix failed:', e);
      toast.error('更正途中失敗，請截圖給工程師（已完成的部分不會重複處理）');
    } finally {
      setBusyId(null);
    }
  };

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
  // 兩種舊帳的處理方式不同，所以畫面上要分開：
  // 已上傳的可以「轉系統請款」（有 cloudUploadedAt 才算得出請款月份）；
  // 從沒上傳的不行——那種要嘛是舊制付過了，要嘛請剪輯師自己按上傳雲端進本月。
  const legacyUploaded = useMemo(() => legacyReview.filter(a => !!a.cloudUploadedAt), [legacyReview]);
  const legacyNeverUploaded = useMemo(() => legacyReview.filter(isLegacyNeverUploaded), [legacyReview]);
  const legacyNeverGroups = useMemo(
    () => groupByVendor(legacyNeverUploaded, id => vendors.find(v => v.id === id)?.name || '未知 IP'),
    [legacyNeverUploaded, vendors]
  );

  /**
   * 整組標記舊制已結清。秀姨一家就有 24 支，逐支點兩個 prompt 等於 48 次輸入，
   * 沒有批次的話這個功能實務上不會有人用。
   * 金額與依據問一次套用整組；仍然逐支寫入，帳上每支都有自己的結清紀錄。
   */
  const settleLegacyBatch = async (list: Asset[], vendorName: string) => {
    const raw = window.prompt(`「${vendorName}」這 ${list.length} 支，每支的舊制結清金額`, String(getAssetFee(list[0])));
    if (raw === null) return;
    const amount = Math.round(Number(raw));
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
      toast.error('金額格式不正確');
      return;
    }
    const source = window.prompt('結清依據（例如：8月勞報單、LINE 對帳）', '傳統記帳') ?? '';
    if (!window.confirm(
      `確定把「${vendorName}」的 ${list.length} 支標記為舊制已結清？
合計 ${money(amount * list.length)}。

` +
      `標記後這些片會從剪輯師的工作台消失，而且不會再進系統請款。`
    )) return;

    setBusyId(`legacy-batch-${list[0].id}`);
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      list.forEach(a => batch.update(doc(db, 'assets', a.id!), {
        legacySettlementStatus: 'paid',
        legacyReviewedAt: now,
        legacyReviewedByUid: auth.currentUser?.uid || '',
        legacySettledAt: now,
        legacySettledAmount: amount,
        legacySettlementSource: source,
      }));
      await batch.commit();
      toast.success(`已標記 ${list.length} 支舊制結清`);
    } catch (e) {
      console.error('Legacy batch settle failed:', e);
      toast.error('批次盤點失敗（可能是權限規則尚未部署）');
    } finally {
      setBusyId(null);
    }
  };

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

  /**
   * 調整一支片的剪輯費。二選一：
   *   tier  → 跟著公司定價走，清掉 editorFee，日後調分級價這支會一起變
   *   custom→ 這一支特例，直接寫死 editorFee
   * 已入單的片規則層會擋（editorInvoiceId 有值時計費欄位全部凍結），這裡先擋一次給明確訊息。
   */
  const saveFee = async (tier: DurationTier | null, custom: number | null) => {
    const asset = feeAsset;
    if (!asset || !auth.currentUser) return;
    if (asset.editorInvoiceId) {
      toast.error('這支已經納入請款單，金額不能再改');
      return;
    }
    let patch: Record<string, unknown>;
    if (tier) {
      patch = { durationTier: tier, editorFee: deleteField() };
    } else {
      if (custom === null || !Number.isFinite(custom) || custom < 0 || custom > 100000) {
        toast.error('金額要是 0 到 100000 之間的數字');
        return;
      }
      patch = { editorFee: Math.round(custom) };
    }
    setBusyId(asset.id!);
    try {
      await updateDoc(doc(db, 'assets', asset.id!), patch);
      setFeeAsset(null);
      toast.success('已更新剪輯費');
    } catch (error) {
      console.error('saveFee failed:', error);
      toast.error('更新失敗（可能是權限規則尚未部署）');
    } finally {
      setBusyId(null);
    }
  };

  /** 對帳單逐列：已入單的取請款單快照（金額已凍結），未送單的取素材現值 */
  type StatementGroup = {
    key: string;
    status: StatementStatus;
    invoice?: EditorInvoice;
    rows: (StatementRow & { asset?: Asset })[];
  };
  const statementOf = (editorId: string): StatementGroup[] => {
    const groups: StatementGroup[] = monthInvoices
      .filter(i => i.editorId === editorId)
      .sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || ''))
      .map(inv => ({
        key: inv.id!,
        status: inv.status as StatementStatus,
        invoice: inv,
        rows: (inv.items || []).map(it => {
          const live = assets.find(a => a.id === it.assetId);
          return {
            key: it.assetId,
            vendorName: it.vendorName,
            title: it.title,
            uploadedAt: it.cloudUploadedAt,
            tierLabel: live?.durationTier ? DURATION_TIER_LABEL[live.durationTier] : undefined,
            amount: it.amount,
            status: inv.status as StatementStatus,
            note: !live ? '素材已刪除' : live.status === 'archived' ? '未使用' : undefined,
          };
        }),
      }));
    const pending = unsubmittedOf(editorId)
      .sort((a, b) => (a.cloudUploadedAt || '').localeCompare(b.cloudUploadedAt || ''));
    if (pending.length > 0) {
      groups.push({
        key: 'pending',
        status: 'unsubmitted',
        rows: pending.map(a => ({
          key: a.id!,
          vendorName: vendors.find(v => v.id === a.vendorId)?.name || '未知 IP',
          title: a.title,
          uploadedAt: a.cloudUploadedAt,
          tierLabel: a.durationTier ? DURATION_TIER_LABEL[a.durationTier] : undefined,
          amount: getAssetFee(a),
          status: 'unsubmitted' as const,
          note: a.status === 'archived' ? '未使用' : undefined,
          asset: a,
        })),
      });
    }
    return groups;
  };

  // PDF：先把對帳單排成 A4 頁面（放在畫面外），逐頁截圖再組成 PDF。
  // 不用 jsPDF 直接畫字：專案沒有註冊中文字型，直接畫會是亂碼。
  const pdfRef = useRef<HTMLDivElement>(null);
  const [pdfJob, setPdfJob] = useState<{ meta: StatementMeta; rows: StatementRow[] } | null>(null);

  const exportStatementPdf = (editorId: string, name: string) => {
    const rows: StatementRow[] = statementOf(editorId)
      .flatMap(g => g.rows.map(({ asset: _asset, ...row }) => row))
      .sort((a, b) => (a.uploadedAt || '').localeCompare(b.uploadedAt || ''));
    setPdfJob({
      meta: {
        month,
        editorName: name,
        statementNo: `${month.replace('-', '')}-${editorId.slice(-4).toUpperCase()}`,
        preparedAt: new Date(),
      },
      rows,
    });
  };

  useEffect(() => {
    if (!pdfJob) return;
    let cancelled = false;
    (async () => {
      const t = toast.loading('正在產生 PDF…');
      try {
        await document.fonts.ready;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const pages: HTMLElement[] = pdfRef.current ? Array.from(pdfRef.current.querySelectorAll<HTMLElement>('[data-pdf-page]')) : [];
        if (pages.length === 0) throw new Error('沒有可輸出的頁面');
        const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
        for (let i = 0; i < pages.length; i++) {
          const url = await toJpeg(pages[i], { quality: 0.95, pixelRatio: 2, backgroundColor: '#ffffff' });
          if (i > 0) pdf.addPage();
          pdf.addImage(url, 'JPEG', 0, 0, 210, 297);
        }
        if (!cancelled) pdf.save(`剪輯費對帳單_${pdfJob.meta.editorName}_${pdfJob.meta.month}.pdf`);
        toast.success('PDF 已下載', { id: t });
      } catch (e) {
        console.error('statement pdf failed:', e);
        toast.error('PDF 產生失敗', { id: t });
      } finally {
        if (!cancelled) setPdfJob(null);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfJob]);

  const countOf = (k: 'unsubmittedCount' | 'submittedCount' | 'approvedCount' | 'processingCount' | 'paidCount') =>
    summaries.reduce((n, r) => n + r[k], 0);
  const summaryCells = [
    { label: '未送單', count: countOf('unsubmittedCount'), amount: totals.unsubmitted },
    { label: '待核准', count: countOf('submittedCount'), amount: totals.submitted },
    { label: '已核准', count: countOf('approvedCount'), amount: totals.approved },
    { label: '付款中', count: countOf('processingCount'), amount: totals.processing },
    { label: '已付款', count: countOf('paidCount'), amount: totals.paid },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-black/5 shadow-sm">
        <div className="px-5 py-4 border-b border-black/5 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-bold text-[#1a1a1a] whitespace-nowrap">剪輯費應付對帳</h2>
            <p className="text-[13px] text-gray-400 mt-0.5">以成片上傳雲端日期認列月份</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="px-3 py-2 rounded-xl border border-black/10 bg-white text-[13px] font-bold text-[#1a1a1a]"
            >
              {monthOptions.map(m => (
                <option key={m} value={m}>{m.slice(0, 4)} 年 {monthLabel(m)}</option>
              ))}
            </select>
            <button
              onClick={exportExcel}
              disabled={summaries.length === 0}
              className="flex items-center gap-1.5 bg-white border border-black/10 text-[#5A5A40] px-3 py-2 rounded-xl text-[13px] font-bold hover:bg-black/[0.02] disabled:opacity-40 whitespace-nowrap"
            >
              <FileSpreadsheet size={14} /> 匯出 Excel
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 border-black/5">
          <div className="px-5 py-4 col-span-2 sm:col-span-3 lg:col-span-1 bg-[#F5F5F0]/60">
            <p className="text-[13px] text-gray-500 whitespace-nowrap">{monthLabel(month)}應付合計</p>
            <p className="text-xl font-bold tabular-nums mt-1 whitespace-nowrap">{money(totals.all)}</p>
          </div>
          {summaryCells.map(c => (
            <div key={c.label} className="px-5 py-4 border-l border-t lg:border-t-0 border-black/5">
              <p className="text-[13px] text-gray-500 whitespace-nowrap">{c.label} · {c.count} 支</p>
              <p className={`text-base font-bold tabular-nums mt-1 whitespace-nowrap ${c.amount ? 'text-[#1a1a1a]' : 'text-gray-300'}`}>{money(c.amount)}</p>
            </div>
          ))}
        </div>
      </div>

      {fee950Total > 0 && (
        <div className="bg-rose-50 rounded-2xl border border-rose-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-rose-200">
            <h3 className="text-sm font-bold text-rose-800">剪輯費更正 · 60 秒以上應為 $900</h3>
            <p className="text-[13px] text-rose-700 mt-1">9/11 起系統把 60 秒以上的片誤算成 ${WRONG_OVER60_FEE}。以下是受影響的單，每支多算 ${WRONG_OVER60_FEE - 900}。</p>
          </div>
          <div className="divide-y divide-rose-200/70">
            {([
              ['未付款 · 會作廢，剪輯師重新送單即照 $900 計', fee950.unpaid],
              ['付款處理中 · 不會自動處理，請人工確認', fee950.processing],
              ['已付款 · 只列出來，由老闆決定是否處理差額', fee950.paid],
            ] as const).map(([label, rows]) => rows.length > 0 && (
              <div key={label} className="px-5 py-3 bg-white/60">
                <p className="text-xs font-bold text-gray-700 mb-1">{label}（{rows.length} 張）</p>
                {rows.map(({ invoice, wrongAssetIds }) => (
                  <p key={invoice.id} className="text-[13px] text-gray-600">
                    {invoice.editorName}｜{monthLabel(invoice.billingMonth)}｜總額 {money(invoice.totalAmount)}｜60 秒以上 {wrongAssetIds.length} 支，多算 {money(wrongAssetIds.length * (WRONG_OVER60_FEE - 900))}
                  </p>
                ))}
              </div>
            ))}
            {fee950.strayAssetIds.length > 0 && (
              <div className="px-5 py-3 bg-white/60">
                <p className="text-xs font-bold text-gray-700">還沒送單、但金額卡在 ${WRONG_OVER60_FEE} 的片：{fee950.strayAssetIds.length} 支（會改回 $900）</p>
              </div>
            )}
          </div>
          {(fee950.unpaid.length > 0 || fee950.strayAssetIds.length > 0) && (
            <div className="px-5 py-4 border-t border-rose-200 flex items-center gap-3 flex-wrap">
              {!fee950Confirm ? (
                <button onClick={() => setFee950Confirm(true)} className="px-4 py-2 rounded-lg bg-rose-600 text-white text-[13px] font-bold">
                  更正未付款的單
                </button>
              ) : (
                <>
                  <span className="text-[13px] text-rose-800 font-bold">確定作廢 {fee950.unpaid.length} 張未付款的單並改回 $900？</span>
                  <button onClick={fixFee950} disabled={busyId === 'fee950'} className="px-4 py-2 rounded-lg bg-rose-600 text-white text-[13px] font-bold disabled:opacity-40">
                    {busyId === 'fee950' ? '處理中…' : '確定更正'}
                  </button>
                  <button onClick={() => setFee950Confirm(false)} disabled={busyId === 'fee950'} className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-[13px] font-bold">取消</button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {legacyUploaded.length > 0 && (
        <div className="bg-amber-50 rounded-2xl border border-amber-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-amber-200">
            <h3 className="text-sm font-bold text-amber-800">舊帳待盤點 · 已上傳 {legacyUploaded.length} 支</h3>
            <p className="text-[13px] text-amber-700 mt-1">切帳日前上傳的片預設不開放請款。請逐支確認舊制是否已付款。</p>
          </div>
          <div className="divide-y divide-amber-200/70 max-h-80 overflow-y-auto">
            {legacyUploaded.map(a => (
              <div key={a.id} className="px-5 py-3 bg-white/60 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-52">
                  <p className="text-xs font-bold text-gray-700">{vendors.find(v => v.id === a.vendorId)?.name || '未知 IP'}｜{a.title}</p>
                  <p className="text-[13px] text-gray-500">{a.cloudUploadedAt ? format(parseISO(a.cloudUploadedAt), 'yyyy-MM-dd HH:mm') : ''} 上傳 · 預設 {money(getAssetFee(a))}</p>
                </div>
                <button onClick={() => settleLegacy(a, 'paid')} disabled={busyId === `legacy-${a.id}`} className="px-3 py-1.5 rounded-lg bg-gray-700 text-white text-[13px] font-bold disabled:opacity-40">舊制已結清</button>
                <button onClick={() => settleLegacy(a, 'unpaid')} disabled={busyId === `legacy-${a.id}`} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-[13px] font-bold disabled:opacity-40">尚未付，轉系統請款</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 從沒上傳過雲端的舊帳。這種片沒有 cloudUploadedAt，算不出請款月份，所以不提供
          「轉系統請款」——真的還沒付的話，請剪輯師照正常流程按上傳雲端，那就會進本月。 */}
      {legacyNeverUploaded.length > 0 && (
        <div className="bg-sky-50 rounded-2xl border border-sky-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-sky-200">
            <h3 className="text-sm font-bold text-sky-800">舊帳待盤點 · 從沒上傳雲端 {legacyNeverUploaded.length} 支</h3>
            <p className="text-[13px] text-sky-700 mt-1 leading-relaxed">
              這些片已經交片，但剪輯師從來沒按過「上傳雲端」，多半是當年在系統外（LINE／勞報單）就領過錢了。
              標記結清後會從他的工作台消失，並留下金額與依據，日後查得到。
              <span className="font-bold">若其實還沒付，不要標在這裡</span>——請剪輯師照正常流程按「上傳雲端」，那支就會進本月請款。
            </p>
          </div>
          <div className="max-h-96 overflow-y-auto divide-y divide-sky-200/70">
            {legacyNeverGroups.map(g => (
              <div key={g.vendorId} className="bg-white/60">
                <div className="px-5 py-2.5 flex items-center justify-between gap-3 flex-wrap bg-sky-100/60">
                  <span className="text-xs font-bold text-sky-900 shrink-0 whitespace-nowrap">{g.vendorName} · {g.assets.length} 支</span>
                  <button
                    onClick={() => settleLegacyBatch(g.assets, g.vendorName)}
                    disabled={busyId === `legacy-batch-${g.assets[0].id}`}
                    className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg bg-sky-700 text-white text-[13px] font-bold disabled:opacity-40"
                  >
                    整組標舊制已結清
                  </button>
                </div>
                {g.assets.map(a => (
                  <div key={a.id} className="px-5 py-2.5 flex items-center gap-3 flex-wrap border-t border-sky-100">
                    <div className="flex-1 min-w-52">
                      <p className="text-xs font-bold text-gray-700">{a.title}</p>
                      <p className="text-[13px] text-gray-500">
                        {a.createdAt ? `${format(parseISO(a.createdAt), 'yyyy-MM-dd')} 建檔` : ''} · 預設 {money(getAssetFee(a))}
                      </p>
                    </div>
                    <button
                      onClick={() => settleLegacy(a, 'paid')}
                      disabled={busyId === `legacy-${a.id}`}
                      className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-lg bg-gray-700 text-white text-[13px] font-bold disabled:opacity-40"
                    >
                      舊制已結清
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}


      {summaries.length === 0 ? (
        <div className="bg-white rounded-2xl border border-black/5 shadow-sm p-10 text-center text-gray-400 text-[13px]">
          {monthLabel(month)}沒有任何應付款項
        </div>
      ) : summaries.map(r => {
        const groups = statementOf(r.editorId);
        const count = groups.reduce((n, g) => n + g.rows.length, 0);
        let seq = 0;
        return (
          <section key={r.editorId} className="bg-white rounded-2xl border border-black/5 shadow-sm overflow-hidden">
            <header className="px-5 py-4 border-b border-black/5 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-[13px] text-gray-400">剪輯師</p>
                <h3 className="text-base font-bold text-[#1a1a1a] truncate">{r.editorName}</h3>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-[13px] text-gray-400 whitespace-nowrap">{monthLabel(month)}應付 · {count} 支</p>
                  <p className="text-lg font-bold tabular-nums whitespace-nowrap">{money(r.totalAmount)}</p>
                </div>
                <button
                  onClick={() => exportStatementPdf(r.editorId, r.editorName)}
                  disabled={!!pdfJob}
                  className="flex items-center gap-1.5 bg-[#5A5A40] text-white px-3 py-2 rounded-xl text-[13px] font-bold disabled:opacity-40 whitespace-nowrap"
                >
                  <FileDown size={14} /> 對帳單 PDF
                </button>
              </div>
            </header>

            {groups.map(g => {
              const subtotal = g.rows.reduce((n, x) => n + x.amount, 0);
              const inv = g.invoice;
              return (
                <div key={g.key} className="border-b border-black/5 last:border-b-0">
                  <div className="px-5 py-2.5 bg-[#F5F5F0]/70 flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 text-[13px] flex-wrap">
                      <span className="font-bold text-gray-700 whitespace-nowrap">
                        {inv ? `請款單 ${inv.id?.slice(-8).toUpperCase()}` : '尚未送單'}
                      </span>
                      <span className="text-gray-400 whitespace-nowrap">
                        {inv ? `${inv.submittedAt ? format(parseISO(inv.submittedAt), 'yyyy/MM/dd') : ''} 送出` : '片已上傳，等剪輯師送出請款'}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[13px] font-bold border whitespace-nowrap ${STATUS_BADGE[g.status]}`}>
                        {STATEMENT_STATUS_LABEL[g.status]}
                      </span>
                    </div>
                    {inv && inv.status !== 'paid' && (
                      <div className="flex items-center gap-1.5">
                        {inv.status === 'submitted' && <button onClick={() => advanceInvoice(inv, 'approved')} disabled={busyId === inv.id} className="bg-blue-700 text-white px-3 py-1.5 rounded-lg text-[13px] font-bold disabled:opacity-40 whitespace-nowrap">核准</button>}
                        {inv.status === 'approved' && <button onClick={() => advanceInvoice(inv, 'payment_processing')} disabled={busyId === inv.id} className="bg-purple-700 text-white px-3 py-1.5 rounded-lg text-[13px] font-bold disabled:opacity-40 whitespace-nowrap">開始付款</button>}
                        {inv.status === 'payment_processing' && <button onClick={() => markPaid(inv)} disabled={busyId === inv.id} className="flex items-center gap-1 bg-[#5A5A40] text-white px-3 py-1.5 rounded-lg text-[13px] font-bold disabled:opacity-40 whitespace-nowrap"><CheckCircle2 size={12} /> 確認已付款</button>}
                        <button onClick={() => voidInvoice(inv)} disabled={busyId === inv.id} className="flex items-center gap-1 bg-white border border-red-200 text-red-600 px-3 py-1.5 rounded-lg text-[13px] font-bold hover:bg-red-50 disabled:opacity-40 whitespace-nowrap">
                          <Ban size={12} /> 作廢
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-[13px] tabular-nums" style={{ tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: 56 }} />
                        <col />
                        <col style={{ width: 80 }} />
                        <col style={{ width: 96 }} />
                        <col style={{ width: 112 }} />
                      </colgroup>
                      <thead>
                        <tr className="text-left text-gray-400 border-b border-black/5">
                          <th className="px-5 py-2 font-medium text-center">序</th>
                          <th className="px-2 py-2 font-medium">片名</th>
                          <th className="px-2 py-2 font-medium">上傳日</th>
                          <th className="px-2 py-2 font-medium">長度</th>
                          <th className="px-5 py-2 font-medium text-right">金額</th>
                        </tr>
                      </thead>
                      {groupRowsByVendor(g.rows).map(vg => (
                        <tbody key={vg.vendorName} className="border-b border-black/5 last:border-b-0">
                          <tr>
                            <td colSpan={5} className="px-5 pt-3 pb-1.5">
                              <span className="font-bold text-[#1a1a1a] whitespace-nowrap">{vg.vendorName}</span>
                              <span className="ml-2 text-gray-400 whitespace-nowrap">{vg.rows.length} 支</span>
                            </td>
                          </tr>
                          {vg.rows.map(row => {
                            seq += 1;
                            return (
                              <tr key={row.key} className="border-t border-black/[0.04]">
                                <td className="px-5 py-2 text-center text-gray-400">{seq}</td>
                                <td className="px-2 py-2">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="truncate whitespace-nowrap text-[#1a1a1a]" title={row.title}>{row.title}</span>
                                    {row.note && (
                                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[13px] font-bold whitespace-nowrap">{row.note}</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-2 py-2 whitespace-nowrap text-gray-600">{row.uploadedAt ? format(parseISO(row.uploadedAt), 'MM/dd') : '—'}</td>
                                <td className="px-2 py-2 whitespace-nowrap text-gray-600">{row.tierLabel || '—'}</td>
                                <td className="px-5 py-2 text-right whitespace-nowrap">
                                  {row.asset ? (
                                    <button
                                      type="button"
                                      onClick={() => { setFeeCustom(''); setFeeAsset(row.asset!); }}
                                      className="font-bold text-[#5A5A40] underline decoration-dotted underline-offset-4 hover:text-[#1a1a1a]"
                                      title="調整這支的剪輯費"
                                    >
                                      {money(row.amount)}
                                    </button>
                                  ) : (
                                    <span className="font-bold">{money(row.amount)}</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          <tr className="border-t border-black/[0.06] bg-[#F5F5F0]/50">
                            <td colSpan={4} className="px-5 py-2 text-right text-gray-500 whitespace-nowrap">{vg.vendorName} 小計 {vg.rows.length} 支</td>
                            <td className="px-5 py-2 text-right font-bold whitespace-nowrap">{money(vg.subtotal)}</td>
                          </tr>
                        </tbody>
                      ))}
                      <tfoot>
                        <tr className="border-t border-black/10">
                          <td colSpan={4} className="px-5 py-2.5 text-right text-gray-600 font-bold whitespace-nowrap">
                            {inv ? '本單合計' : '未送單合計'} {g.rows.length} 支
                          </td>
                          <td className="px-5 py-2.5 text-right font-bold whitespace-nowrap">{money(subtotal)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              );
            })}

            <footer className="px-5 py-3 border-t border-black/10 flex items-center justify-between">
              <span className="text-[13px] text-gray-500 whitespace-nowrap">合計 {count} 支</span>
              <span className="text-base font-bold tabular-nums whitespace-nowrap">{money(r.totalAmount)}</span>
            </footer>
          </section>
        );
      })}

      {pdfJob && <EditorStatementPdf ref={pdfRef} meta={pdfJob.meta} rows={pdfJob.rows} />}

      {/* 管帳調價。分級與自訂金額是兩條路：選分級＝跟著公司定價走（日後調價會一起變），
          填自訂金額＝這一支特例（寫死在素材上）。已納入請款單的片不會出現在這裡。 */}
      {feeAsset && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onMouseDown={() => !busyId && setFeeAsset(null)}>
          <div className="bg-white rounded-3xl w-full max-w-md p-6 shadow-xl" onMouseDown={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold serif text-[#5A5A40]">調整剪輯費</h3>
            <p className="mt-2 text-sm text-gray-600 break-words">
              {vendors.find(v => v.id === feeAsset.vendorId)?.name || '未知 IP'}｜{feeAsset.title}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              目前 {money(getAssetFee(feeAsset))}
              {feeAsset.durationTier ? `（${DURATION_TIER_LABEL[feeAsset.durationTier]}）`
                : typeof feeAsset.editorFee === 'number' ? '（自訂金額）' : '（舊素材，沒有分級）'}
            </p>

            <p className="mt-5 text-sm font-bold text-gray-700">照長度分級</p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {(['under60', 'over60'] as DurationTier[]).map(t => (
                <button key={t} type="button" disabled={!!busyId}
                  onClick={() => saveFee(t, null)}
                  className="p-4 rounded-2xl border-2 border-black/10 hover:border-[#5A5A40] text-left transition-all disabled:opacity-40">
                  <span className="block text-base font-bold text-[#1a1a1a]">{DURATION_TIER_LABEL[t]}</span>
                  <span className="block mt-1 text-sm text-[#8B7355] font-bold">
                    NT$ {EDITOR_FEE_BY_TIER[t].toLocaleString()}
                  </span>
                </button>
              ))}
            </div>

            <p className="mt-5 text-sm font-bold text-gray-700">或指定金額（這一支特例）</p>
            <div className="mt-2 flex gap-2">
              <input
                type="number" min={0} max={100000} value={feeCustom}
                onChange={e => setFeeCustom(e.target.value)}
                placeholder="例如 800"
                className="flex-1 px-4 py-3 bg-[#F5F5F0] border-none rounded-xl focus:ring-2 focus:ring-[#5A5A40]"
              />
              <button type="button" disabled={!!busyId || feeCustom.trim() === ''}
                onClick={() => saveFee(null, Number(feeCustom))}
                className="px-5 rounded-xl bg-[#5A5A40] text-white font-bold disabled:opacity-40">
                套用
              </button>
            </div>

            <button type="button" onClick={() => setFeeAsset(null)} disabled={!!busyId}
              className="mt-5 w-full py-3 rounded-xl bg-gray-100 text-gray-700 font-bold disabled:opacity-40">
              關閉
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
