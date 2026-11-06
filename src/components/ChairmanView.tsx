import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, updateDoc, writeBatch } from 'firebase/firestore';
import { addDays, addMonths, addWeeks, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { AlertTriangle, Camera, ChevronDown, ChevronLeft, ChevronRight, CheckCircle2, Film, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { auth, db } from '../firebase';
import { useLiveCollection } from '../lib/liveData';
import { isInternalWork } from '../lib/editorRoster';
import { buildDeficitRows, DeficitRow } from '../lib/vendorDeficitRows';
import {
  getAssetFee, getBillableEditorId, getBillingMonth, isBillable, monthLabel, summarizeByEditor, defaultBillingMonth, getWorkingEditorId,
} from '../lib/editorBilling';
import { groupRowsByVendor } from './EditorStatementPdf';
import EditorPayables from './EditorPayables';
import BillingProgress from './BillingProgress';
import { VideoSteps, videoProgress } from './VideoProgressSteps';
import { Asset, DURATION_TIER_LABEL, Editor, EditorInvoice, Post, ShootBooking, Vendor, deriveFlowStage } from '../types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 會長（老闆的老闆）專用的三個頁籤（2026-11），掛在左側選單：
 *   chairmanDeficit  欠片狀況 ── 每個 IP 現在欠幾支（跟製作進度頁同一個函式算）
 *   chairmanBilling  剪輯費   ── 某月要付多少；流程＝剪輯師送審 → 主管請款單送審 → 會長款項放行 → 主管付款
 *   chairmanCalendar 發片行事曆 ── 一週一頁，每個 IP 哪天發了、沒發、已排程、拍攝
 * 除了「款項放行」以外不寫任何資料。用詞一律白話，不要系統術語。
 */

export type ChairmanSection = 'chairmanDeficit' | 'chairmanBilling' | 'chairmanCalendar';

/** 電腦（≥768px）與手機用不同畫面：剪輯費電腦版＝主管的應付頁（會長模式），手機版＝下面的精簡版 */
function useIsDesktop() {
  const q = '(min-width: 768px)';
  const [desktop, setDesktop] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setDesktop(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return desktop;
}

export default function ChairmanView({ section }: { section: ChairmanSection }) {
  const desktop = useIsDesktop();
  if (section === 'chairmanBilling' && desktop) return <EditorPayables chairman />;
  if (section === 'chairmanDeficit') return <DeficitTab />;
  if (section === 'chairmanCalendar' && desktop) return <div className="max-w-5xl mx-auto"><CalendarTab roomy /></div>;
  return (
    <div className="max-w-3xl mx-auto">
      {section === 'chairmanBilling' && <BillingTab />}
      {section === 'chairmanCalendar' && <CalendarTab />}
    </div>
  );
}

const money = (n: number) => `$${n.toLocaleString()}`;
const OLIVE = '#5A5A40';

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('bg-white rounded-2xl border border-black/5 shadow-sm', className)}>{children}</div>;
}

function Switcher({ label, onShift }: { label: string; onShift: (n: number) => void }) {
  return (
    <div className="flex items-center justify-between">
      <button onClick={() => onShift(-1)} className="w-11 h-11 rounded-full bg-white border border-black/5 flex items-center justify-center hover:bg-black/5" aria-label="上一頁"><ChevronLeft size={22} /></button>
      <span className="text-[18px] font-bold whitespace-nowrap">{label}</span>
      <button onClick={() => onShift(1)} className="w-11 h-11 rounded-full bg-white border border-black/5 flex items-center justify-center hover:bg-black/5" aria-label="下一頁"><ChevronRight size={22} /></button>
    </div>
  );
}

// ───────────────────────────── 欠片狀況 ─────────────────────────────
// 樣式比照公司「製作進度」頁的卡片（使用者 11-03：前台那個有質感），只留看的部分、拿掉所有操作。

const SEV_STYLE = {
  crit: { chip: 'bg-red-100 text-red-700 border border-red-200', bar: 'bg-red-500', label: '需處理' },
  warn: { chip: 'bg-amber-100 text-amber-700 border border-amber-200', bar: 'bg-amber-500', label: '落後' },
  good: { chip: 'bg-green-100 text-green-700 border border-green-200', bar: 'bg-green-500', label: '正常' },
} as const;

function DeficitTab() {
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const posts = useLiveCollection<Post>('posts');
  const bookings = useLiveCollection<ShootBooking>('shootBookings');
  // 跟 ShootBookings 傳一樣的 today，確保兩頁數字一致
  const today = new Date().toISOString().split('T')[0];
  const rows = useMemo(() => buildDeficitRows(vendors, posts, assets, bookings, today), [vendors, posts, assets, bookings, today]);
  const totalOwed = rows.reduce((s, r) => s + r.owed, 0);
  const owingCount = rows.filter(r => r.owed > 0).length;
  const weekEnd = format(addDays(new Date(), 7), 'yyyy-MM-dd');
  const shootsSoon = bookings.filter(b => b.status === 'booked' && b.scheduledDate >= today && b.scheduledDate <= weekEnd).length;

  if (rows.length === 0) return <Card className="py-16 text-center text-gray-400">資料載入中…</Card>;

  const pill = (icon: React.ReactNode, tone: string, label: string, value: number, unit: string) => (
    <div className="bg-white px-4 py-2.5 rounded-2xl border border-black/5 shadow-sm flex items-center gap-3">
      <div className={cn('p-2 rounded-lg', tone)}>{icon}</div>
      <div>
        <p className="text-[13px] font-bold text-gray-400 whitespace-nowrap">{label}</p>
        <p className="text-xl font-bold leading-none mt-0.5 whitespace-nowrap">{value} <span className="text-xs font-normal text-gray-400">{unit}</span></p>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-end gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">各 IP 欠片狀況</h2>
          <p className="text-sm text-gray-500">每個 IP 現在還要再拍幾支，數字跟公司「製作進度」頁同步</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          {pill(<AlertTriangle size={18} />, 'bg-red-50 text-red-600', '合計還要再拍', totalOwed, '支')}
          {pill(<Film size={18} />, 'bg-amber-50 text-amber-600', '有欠片', owingCount, `／${rows.length} 個 IP`)}
          {pill(<Camera size={18} />, 'bg-[#5A5A40]/10 text-[#5A5A40]', '未來 7 天拍攝', shootsSoon, '場')}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {rows.map(r => <React.Fragment key={r.vendor.id}><DeficitCard r={r} /></React.Fragment>)}
      </div>
    </div>
  );
}

function DeficitCard({ r }: { r: DeficitRow }) {
  const s = SEV_STYLE[r.sev];
  const pct = r.target > 0 ? Math.min(100, (r.delivered / r.target) * 100) : 0;
  return (
    <div className="bg-white rounded-[32px] border border-black/5 shadow-sm overflow-hidden">
      <div className={cn('h-1', s.bar)} />
      <div className="p-6 space-y-4">
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold flex items-center gap-1.5 truncate">
              {r.vendor.name}
              {r.frozenThisMonth && (
                <span className={cn('text-[13px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap',
                  r.isEnded ? 'text-gray-600 bg-gray-100 border-gray-200' : 'text-cyan-700 bg-cyan-50 border-cyan-100')}>
                  {r.isEnded ? '已終止' : '暫停中'}
                </span>
              )}
            </h3>
            <p className="text-[13px] text-gray-400 mt-0.5 whitespace-nowrap">手上剪好還沒發 {r.stock} 支</p>
          </div>
          <span className={cn('shrink-0 whitespace-nowrap px-3 py-1 rounded-full text-[13px] font-bold', s.chip)}>{s.label}</span>
        </div>

        <div>
          <p className="text-[13px] font-bold text-gray-400 tracking-widest whitespace-nowrap">此時此刻還要再拍</p>
          <p className={cn('text-4xl font-bold leading-none mt-1', r.owed > 0 ? 'text-[#1a1a1a]' : 'text-gray-300')}>
            {r.owed} <span className="text-sm font-normal text-gray-400">支</span>
          </p>
        </div>

        {!r.frozenThisMonth && (
          <div>
            <div className="flex justify-between text-[13px] text-gray-500 whitespace-nowrap">
              <span>本月已發</span><span className="tabular-nums font-bold text-[#1a1a1a]">{r.delivered} ／ {r.target} 支</span>
            </div>
            <div className="h-2 bg-[#F5F5F0] rounded-full mt-1.5 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: OLIVE }} />
            </div>
          </div>
        )}

        <div className={cn('rounded-xl px-3 py-2.5 text-[13px] flex items-center justify-between gap-2',
          r.overdue ? 'bg-red-50 text-red-700' : r.active ? 'bg-[#F5F5F0] text-gray-700' : r.owed > 0 ? 'bg-red-50 text-red-700' : 'bg-[#F5F5F0] text-gray-400')}>
          <span className="flex items-center gap-1.5 whitespace-nowrap font-bold">
            <Camera size={14} />
            {r.active
              ? `下次拍攝 ${format(parseISO(r.active.scheduledDate), 'M/d')}（${WEEKDAYS[parseISO(r.active.scheduledDate).getDay()]}）${r.active.startTime ? ` ${r.active.startTime}` : ''}`
              : r.owed > 0 ? '還沒約拍攝' : '目前沒有約拍攝'}
          </span>
          {r.overdue && <span className="whitespace-nowrap">日期已過，待確認</span>}
          {!r.overdue && r.laterCount > 0 && <span className="text-gray-400 whitespace-nowrap">之後還有 {r.laterCount} 場</span>}
        </div>
      </div>
    </div>
  );
}
// ───────────────────────────── 剪輯費 ─────────────────────────────

/** 給會長看的白話狀態 */
type PlainStatus = 'notYet' | 'manager' | 'you' | 'released' | 'paying' | 'paid';
const PLAIN: Record<PlainStatus, { label: string; cls: string }> = {
  notYet: { label: '剪輯師還沒請款', cls: 'bg-gray-100 text-gray-600' },
  manager: { label: '等主管送審', cls: 'bg-amber-50 text-amber-700' },
  you: { label: '等您放行', cls: 'bg-orange-100 text-orange-700' },
  released: { label: '已放行，待付款', cls: 'bg-teal-50 text-teal-700' },
  paying: { label: '已放行，待付款', cls: 'bg-teal-50 text-teal-700' },
  paid: { label: '已付清', cls: 'bg-green-50 text-green-700' },
};
const PLAIN_ORDER: PlainStatus[] = ['you', 'manager', 'notYet', 'released', 'paying', 'paid'];
const fromInvoice = (s: EditorInvoice['status']): PlainStatus =>
  s === 'submitted' ? 'manager' : s === 'approved' ? 'you' : s === 'released' ? 'released' : s === 'payment_processing' ? 'paying' : 'paid';

type PieceRow = { key: string; vendorName: string; title: string; uploadedAt?: string; tierLabel?: string; amount: number; status: 'paid'; plain: PlainStatus };

function previousMonth(): string {
  return format(addMonths(startOfMonth(new Date()), -1), 'yyyy-MM');
}

function BillingTab() {
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const editors = useLiveCollection<Editor>('editors');
  const [invoices, setInvoices] = useState<EditorInvoice[]>([]);
  const [month, setMonth] = useState(previousMonth);
  const [openEditor, setOpenEditor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => onSnapshot(
    collection(db, 'editorInvoices'),
    s => { setInvoices(s.docs.map(d => ({ id: d.id, ...d.data() } as EditorInvoice))); setInvoicesLoaded(true); },
    err => console.warn('讀取請款單失敗', err),
  ), []);

  const videoAssets = useMemo(() => assets.filter(a => a.type === 'video'), [assets]);

  // 打開時停在哪個月：跟電腦版（EditorPayables）同一套——有單等放行的最早月份優先，否則上個月沒結清就上個月，再不然本月
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const [autoMonthDone, setAutoMonthDone] = useState(false);
  useEffect(() => {
    if (autoMonthDone || !invoicesLoaded || assets.length === 0) return;
    const waiting = invoices.filter(i => i.status === 'approved').map(i => i.billingMonth).sort();
    setMonth(waiting[0] ?? defaultBillingMonth(m => summarizeByEditor(m, videoAssets, vendors, () => '', invoices, editors)
      .some(r => r.totalAmount - r.paidAmount > 0)));
    setAutoMonthDone(true);
  }, [autoMonthDone, invoicesLoaded, invoices, assets, videoAssets, vendors, editors]);
  const editorName = (id: string) => id === '__unassigned__' ? '未指派剪輯師' : editors.find(e => e.id === id)?.name || '未知剪輯師';
  const summaries = useMemo(
    () => summarizeByEditor(month, videoAssets, vendors, editorName, invoices, editors),
    [month, videoAssets, vendors, editors, invoices]
  );
  const monthInvoices = invoices.filter(i => i.billingMonth === month && i.status !== 'void');

  /** 某位剪輯師這個月的逐片明細：已請款的取請款單快照（金額已凍結），還沒請款的取素材現值。跟財務的應付頁同一套來源 */
  const piecesOf = (editorId: string): PieceRow[] => {
    const rows: PieceRow[] = [];
    for (const inv of monthInvoices.filter(i => i.editorId === editorId)) {
      for (const it of inv.items || []) {
        const live = assets.find(a => a.id === it.assetId);
        rows.push({
          key: `${inv.id}-${it.assetId}`, vendorName: it.vendorName, title: it.title, uploadedAt: it.cloudUploadedAt,
          tierLabel: live?.durationTier ? DURATION_TIER_LABEL[live.durationTier] : undefined,
          amount: it.amount, status: 'paid', plain: fromInvoice(inv.status),
        });
      }
    }
    for (const a of videoAssets) {
      if (!isBillable(a) || getBillingMonth(a) !== month || isInternalWork(a, vendors, editors)) continue;
      if ((getBillableEditorId(a, vendors) || '__unassigned__') !== editorId) continue;
      rows.push({
        key: a.id!, vendorName: vendors.find(v => v.id === a.vendorId)?.name || '未知 IP', title: a.title, uploadedAt: a.cloudUploadedAt,
        tierLabel: a.durationTier ? DURATION_TIER_LABEL[a.durationTier] : undefined,
        amount: getAssetFee(a), status: 'paid', plain: 'notYet',
      });
    }
    return rows;
  };

  const total = summaries.reduce((n, r) => n + r.totalAmount, 0);
  const totalCount = summaries.reduce((n, r) => n + r.totalCount, 0);
  const byPlain: Record<PlainStatus, number> = {
    notYet: summaries.reduce((n, r) => n + r.unsubmittedAmount, 0),
    manager: summaries.reduce((n, r) => n + r.submittedAmount, 0),
    you: summaries.reduce((n, r) => n + r.approvedAmount, 0),
    released: summaries.reduce((n, r) => n + r.releasedAmount, 0),
    paying: summaries.reduce((n, r) => n + r.processingAmount, 0),
    paid: summaries.reduce((n, r) => n + r.paidAmount, 0),
  };

  const toRelease = monthInvoices.filter(i => i.status === 'approved');
  const toReleaseTotal = toRelease.reduce((n, i) => n + i.totalAmount, 0);

  // 付款完成（董事匯款後自己按，2026-11）：一張一張按，防呆要勾「已實際匯款」
  const toPay = monthInvoices.filter(i => i.status === 'released' || i.status === 'payment_processing');
  const [payTarget, setPayTarget] = useState<EditorInvoice | null>(null);
  const [payAck, setPayAck] = useState(false);
  const markPaid = async (inv: EditorInvoice) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'editorInvoices', inv.id!), { status: 'paid', paidAt: new Date().toISOString(), paidByUid: uid });
      toast.success(`已付款完成：${inv.editorName} ${money(inv.totalAmount)}`);
      setPayTarget(null);
    } catch (e) {
      console.error('mark paid failed:', e);
      toast.error('送出失敗，請稍後再試或聯絡工程師');
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid || toRelease.length === 0) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const batch = writeBatch(db);
      for (const inv of toRelease) {
        batch.update(doc(db, 'editorInvoices', inv.id!), { status: 'released', releasedAt: now, releasedByUid: uid });
      }
      await batch.commit();
      toast.success(`已放行 ${monthLabel(month)} 剪輯費 ${money(toReleaseTotal)}`);
      setConfirming(false);
    } catch (e) {
      console.error('release failed:', e);
      toast.error('放行失敗，請稍後再試或聯絡工程師');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Switcher label={format(parseISO(`${month}-01`), 'yyyy 年 M 月')} onShift={n => { setMonth(format(addMonths(parseISO(`${month}-01`), n), 'yyyy-MM')); setOpenEditor(null); }} />

      <BillingProgress month={month} summaries={summaries} invoices={monthInvoices} />

      {toPay.length > 0 && (
        <Card className="px-5 py-5 border-2 border-green-200">
          <p className="text-[17px] font-bold">已放行，匯款後請按付款完成</p>
          <p className="text-[14px] text-gray-500 mt-0.5">按了之後剪輯師會收到已付款通知</p>
          <div className="mt-3 space-y-2">
            {toPay.map(inv => (
              <div key={inv.id} className="flex items-center gap-3 rounded-xl bg-[#F5F5F0] px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[16px] font-bold truncate">{inv.editorName}</p>
                  <p className="text-[13px] text-gray-500 whitespace-nowrap">{inv.itemCount} 支・<b className="text-[#1a1a1a] tabular-nums">{money(inv.totalAmount)}</b></p>
                </div>
                <button onClick={() => { setPayAck(false); setPayTarget(inv); }} className="px-4 py-2.5 rounded-xl bg-green-700 text-white text-[15px] font-bold whitespace-nowrap">付款完成</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {payTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center" onClick={() => !busy && setPayTarget(null)}>
          <div className="bg-white w-full rounded-t-3xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-[19px] font-bold">確認付款完成</p>
            <div className="rounded-2xl border border-black/5 divide-y divide-black/5 overflow-hidden">
              <div className="px-4 py-3 flex justify-between text-[16px]"><span className="text-gray-500">剪輯師</span><b>{payTarget.editorName}</b></div>
              <div className="px-4 py-3 flex justify-between text-[16px]"><span className="text-gray-500">月份</span><b>{monthLabel(payTarget.billingMonth)}・{payTarget.itemCount} 支</b></div>
              <div className="px-4 py-3.5 flex justify-between items-center bg-[#F5F5F0]"><span className="font-bold">匯款金額</span><span className="text-[24px] font-bold tabular-nums">{money(payTarget.totalAmount)}</span></div>
            </div>
            <label className="flex items-start gap-2.5 select-none">
              <input type="checkbox" checked={payAck} onChange={e => setPayAck(e.target.checked)} className="mt-1 w-5 h-5 accent-[#5A5A40]" />
              <span className="text-[15px]">我已經實際匯款 <b>{money(payTarget.totalAmount)}</b> 給 <b>{payTarget.editorName}</b>，金額核對無誤。送出後不能撤回。</span>
            </label>
            <button onClick={() => markPaid(payTarget)} disabled={!payAck || busy} className="w-full py-4 rounded-xl bg-green-700 text-white text-[18px] font-bold disabled:opacity-40">{busy ? '送出中…' : '付款完成'}</button>
            <button onClick={() => setPayTarget(null)} disabled={busy} className="w-full py-2 text-gray-500 font-bold">取消</button>
          </div>
        </div>
      )}

      <Card className="px-5 py-5">
        <p className="text-[16px] text-gray-500">{monthLabel(month)}剪輯費總共</p>
        <p className="text-[40px] font-bold tabular-nums leading-tight">{money(total)}</p>
        <p className="text-[15px] text-gray-500">{totalCount} 支影片・{summaries.length} 位剪輯師</p>
        {total > 0 && (
          <div className="mt-4 pt-4 border-t border-black/5 space-y-2">
            {PLAIN_ORDER.filter(k => byPlain[k] > 0).map(k => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className={cn('px-2.5 py-1 rounded-lg text-[15px] font-bold whitespace-nowrap', PLAIN[k].cls)}>{PLAIN[k].label}</span>
                <span className="text-[17px] font-bold tabular-nums whitespace-nowrap">{money(byPlain[k])}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {toRelease.length > 0 ? (
        <Card className="px-5 py-5 border-2 border-orange-200">
          <p className="text-[17px] font-bold">主管已送審，等您款項放行</p>
          <p className="text-[15px] text-gray-500 mt-0.5">放行後請匯款給剪輯師，匯完按「付款完成」</p>
          <button
            onClick={() => setConfirming(true)}
            className="mt-4 w-full py-4 rounded-xl text-white text-[18px] font-bold shadow flex items-center justify-center gap-2"
            style={{ background: OLIVE }}
          >
            <CheckCircle2 size={21} /> 款項放行 {money(toReleaseTotal)}
          </button>
        </Card>
      ) : (
        <Card className="px-5 py-4">
          {byPlain.manager > 0 ? (<>
            <p className="text-[16px] font-bold text-amber-700">剪輯師已送出請款，主管還沒送審</p>
            <p className="text-[14px] text-gray-500 mt-0.5">有 {money(byPlain.manager)} 等主管送審，請提醒主管。送審後這裡會出現「款項放行」按鈕</p>
          </>) : (<>
            <p className="text-[16px] font-bold text-gray-600">目前沒有要您放行的款項</p>
            <p className="text-[14px] text-gray-500 mt-0.5">主管送審後，這裡會出現「款項放行」按鈕</p>
          </>)}
        </Card>
      )}

      <div className="space-y-2">
        <h2 className="text-[16px] font-bold text-gray-600 px-1">每位剪輯師（點開看每一支片）</h2>
        {summaries.map(r => {
          const open = openEditor === r.editorId;
          const pieces = open ? piecesOf(r.editorId) : [];
          let seq = 0;
          return (
            <React.Fragment key={r.editorId}><Card className="overflow-hidden">
              <button onClick={() => setOpenEditor(open ? null : r.editorId)} className="w-full px-5 py-4 flex items-center gap-3 text-left">
                <div className="flex-1 min-w-0">
                  <p className="text-[18px] font-bold truncate">{r.editorName}</p>
                  <p className="text-[14px] text-gray-500 whitespace-nowrap">{r.totalCount} 支片</p>
                </div>
                <p className="text-[20px] font-bold tabular-nums whitespace-nowrap">{money(r.totalAmount)}</p>
                <ChevronDown size={20} className={cn('text-gray-400 transition-transform shrink-0', open && 'rotate-180')} />
              </button>
              {open && (
                <div className="border-t border-black/5">
                  {groupRowsByVendor(pieces).map(g => (
                    <div key={g.vendorName} className="border-b border-black/5 last:border-b-0">
                      <div className="px-5 py-2.5 bg-[#F5F5F0] flex items-center justify-between gap-3">
                        <span className="text-[16px] font-bold truncate">{g.vendorName}</span>
                        <span className="text-[14px] text-gray-600 whitespace-nowrap">{g.rows.length} 支・小計 <b className="tabular-nums">{money(g.subtotal)}</b></span>
                      </div>
                      {g.rows.map(p => {
                        seq += 1;
                        return (
                          <div key={p.key} className="px-5 py-3 flex items-start gap-3 border-t border-black/[0.04] first:border-t-0">
                            <span className="w-6 text-[13px] text-gray-400 tabular-nums pt-0.5 shrink-0">{seq}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-[15px] font-bold truncate" title={p.title}>{p.title}</p>
                              <p className="text-[13px] text-gray-500 whitespace-nowrap">
                                {p.uploadedAt ? `${format(parseISO(p.uploadedAt), 'M/d')} 交片` : '—'}{p.tierLabel ? `・${p.tierLabel}` : ''}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-[16px] font-bold tabular-nums">{money(p.amount)}</p>
                              <span className={cn('inline-block mt-0.5 px-1.5 py-0.5 rounded text-[12px] font-bold whitespace-nowrap', PLAIN[p.plain].cls)}>{PLAIN[p.plain].label}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {pieces.length === 0 && <p className="px-5 py-6 text-center text-gray-400">沒有明細</p>}
                </div>
              )}
            </Card></React.Fragment>
          );
        })}
        {summaries.length === 0 && <Card className="py-10 text-center text-gray-400">這個月沒有剪輯費</Card>}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={() => !busy && setConfirming(false)}>
          <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-[19px] font-bold whitespace-nowrap">確認放行{monthLabel(month)}剪輯費</h3>
              <button onClick={() => setConfirming(false)} disabled={busy} className="p-1.5 rounded-lg hover:bg-black/5 text-gray-400"><X size={20} /></button>
            </div>
            <div className="divide-y divide-black/5 border border-black/5 rounded-xl overflow-hidden">
              {toRelease.map(i => (
                <div key={i.id} className="px-4 py-3 flex items-center justify-between gap-3 text-[16px]">
                  <span className="truncate">{i.editorName}・{i.itemCount} 支</span>
                  <span className="tabular-nums font-bold whitespace-nowrap">{money(i.totalAmount)}</span>
                </div>
              ))}
              <div className="px-4 py-3.5 flex items-center justify-between gap-3 bg-[#F5F5F0]">
                <span className="font-bold whitespace-nowrap">合計</span>
                <span className="text-[22px] font-bold tabular-nums whitespace-nowrap">{money(toReleaseTotal)}</span>
              </div>
            </div>
            <p className="text-[15px] text-gray-500">放行後，主管就會安排付款給剪輯師。</p>
            <button onClick={release} disabled={busy} className="w-full py-4 rounded-xl text-white text-[18px] font-bold flex items-center justify-center gap-2 disabled:opacity-50" style={{ background: OLIVE }}>
              <CheckCircle2 size={21} /> {busy ? '放行中…' : '確認放行'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── 發片行事曆 ─────────────────────────────
// 一週一頁、IP 一列，格子直接寫字（使用者 11-03 選定：圖示和一格一堆標籤都看不懂）

type Word = 'done' | 'missed' | 'ready' | 'planned' | 'shoot' | 'shot';
const WORD: Record<Word, { text: string; cls: string }> = {
  done: { text: '已發', cls: 'bg-green-100 text-green-800' },
  missed: { text: '沒發', cls: 'bg-red-100 text-red-700' },
  ready: { text: '已排程', cls: 'bg-sky-100 text-sky-800' },
  planned: { text: '預定', cls: 'bg-gray-100 text-gray-500' },
  shoot: { text: '拍攝', cls: 'bg-[#5A5A40] text-white' },
  shot: { text: '已拍', cls: 'bg-[#E8E6D9] text-[#5A5A40]' },
};
const WORD_ORDER: Word[] = ['missed', 'done', 'ready', 'planned', 'shoot', 'shot'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 單支片進度的五站圓圈搬到 VideoProgressSteps.tsx（發布稽核頁也用，11-06）

function CalendarTab({ roomy = false }: { roomy?: boolean }) {
  const vendors = useLiveCollection<Vendor>('vendors');
  const posts = useLiveCollection<Post>('posts');
  const bookings = useLiveCollection<ShootBooking>('shootBookings');
  const assets = useLiveCollection<Asset>('assets');
  const editors = useLiveCollection<Editor>('editors');
  const [picked, setPicked] = useState<{ vendorId: string; date: string } | null>(null);
  const today = format(new Date(), 'yyyy-MM-dd');
  // 一次一週（使用者 11-03：三週太擠）。電腦版 roomy＝格子放大、字放大
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => format(addDays(weekStart, i), 'yyyy-MM-dd')), [weekStart]);

  // vendorId → date → 這格要寫的字（同一格同一個字只寫一次，多支片寫「已發 2」）
  const grid = useMemo(() => {
    const inWeek = new Set(days);
    const map = new Map<string, Map<string, Map<Word, number>>>();
    const add = (vendorId: string, date: string, w: Word) => {
      if (!inWeek.has(date)) return;
      if (!map.has(vendorId)) map.set(vendorId, new Map());
      const byDate = map.get(vendorId)!;
      if (!byDate.has(date)) byDate.set(date, new Map());
      const counts = byDate.get(date)!;
      counts.set(w, (counts.get(w) || 0) + 1);
    };
    for (const p of posts) {
      if (!p.scheduledAt) continue;
      const date = format(parseISO(p.scheduledAt), 'yyyy-MM-dd');
      const past = date < today;
      // 排程過的片時間到了平台就自動發出 → 過了就算已發
      if (p.status === 'published' || (p.status === 'scheduled' && past)) add(p.vendorId, date, 'done');
      else if (p.status === 'scheduled') add(p.vendorId, date, 'ready');
      else add(p.vendorId, date, past ? 'missed' : 'planned');
    }
    for (const b of bookings) {
      if (b.status === 'booked') add(b.vendorId, b.scheduledDate, 'shoot');
      else if (b.status === 'completed') add(b.vendorId, b.scheduledDate, 'shot');
    }
    return map;
  }, [posts, bookings, days, today]);

  const name = (id: string) => vendors.find(v => v.id === id)?.name || '未知IP';
  const rows = Array.from(grid.keys() as Iterable<string>).sort((a, b) => name(a).localeCompare(name(b), 'zh-Hant'));

  return (
    <div className="space-y-4">
      {roomy && (
        <div className="space-y-1">
          <h2 className="text-2xl font-bold serif text-[#5A5A40]">發片行事曆</h2>
          <p className="text-sm text-gray-500">每個 IP 這一週哪天發了、哪天沒發、哪天拍攝</p>
        </div>
      )}
      <Switcher
        label={`${format(weekStart, 'M/d')} – ${format(addDays(weekStart, 6), 'M/d')}`}
        onShift={n => setWeekStart(addWeeks(weekStart, n))}
      />

      {/* 本週摘要：先給結論，再看表 */}
      {(() => {
        const count = (w: Word) => Array.from(grid.values() as Iterable<Map<string, Map<Word, number>>>)
          .reduce((n, byDate) => n + Array.from(byDate.values() as Iterable<Map<Word, number>>).reduce((m, c) => m + (c.get(w) || 0), 0), 0);
        const items: [Word, string][] = [['done', '已發'], ['missed', '沒發'], ['ready', '已排程'], ['shoot', '拍攝']];
        return (
          <div className="grid grid-cols-4 gap-2 sm:gap-3">
            {items.map(([w, label]) => (
              <div key={w} className="bg-white rounded-2xl border border-black/5 shadow-sm px-3 sm:px-4 py-3 text-center sm:text-left">
                <p className="text-[13px] text-gray-400 font-bold whitespace-nowrap">本週{label}</p>
                <p className={cn('text-2xl font-bold tabular-nums leading-tight', w === 'missed' && count(w) > 0 ? 'text-red-600' : 'text-[#1a1a1a]')}>{count(w)}</p>
              </div>
            ))}
          </div>
        );
      })()}

      <div className="bg-white rounded-[28px] border border-black/5 shadow-sm overflow-hidden">
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr>
              <th className={roomy ? 'w-[140px]' : 'w-[72px]'} />
              {days.map(d => {
                const isToday = d === today;
                return (
                  <th key={d} className={cn('font-normal', roomy ? 'py-4' : 'py-2.5')}>
                    <span className={cn('block', roomy ? 'text-[13px]' : 'text-[12px]', isToday ? 'text-[#5A5A40] font-bold' : 'text-gray-400')}>{isToday ? '今天' : `週${WEEKDAYS[parseISO(d).getDay()]}`}</span>
                    <span className={cn('mx-auto mt-1 flex items-center justify-center rounded-full font-bold tabular-nums',
                      roomy ? 'h-9 px-3 text-[16px]' : 'h-8 px-1.5 text-[13px]',
                      isToday ? 'bg-[#5A5A40] text-white' : 'text-[#1a1a1a]')}>{format(parseISO(d), 'M/d')}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((vid, idx) => (
              <tr key={vid} className={cn(idx % 2 === 1 && 'bg-[#F5F5F0]/40')}>
                <td className={cn('pr-1 font-bold truncate', roomy ? 'pl-6 py-3.5 text-[16px]' : 'pl-3 py-3 text-[13px]')}>{name(vid)}</td>
                {days.map(d => {
                  const counts = grid.get(vid)?.get(d);
                  const words = counts ? WORD_ORDER.filter(w => counts.has(w)) : [];
                  return (
                    <td key={d} className={cn('text-center align-middle', roomy ? 'px-1.5 py-2' : 'px-0.5 py-1.5', d === today && 'bg-[#5A5A40]/[0.05]')}>
                      <button
                        type="button"
                        disabled={words.length === 0}
                        onClick={() => setPicked({ vendorId: vid, date: d })}
                        className={cn('w-full flex flex-col gap-1 items-center rounded-xl py-1 transition', words.length > 0 && 'hover:bg-black/[0.04] cursor-pointer', picked?.vendorId === vid && picked.date === d && 'ring-2 ring-[#5A5A40]/40')}
                      >
                        {words.map(w => (
                          <span key={w} className={cn('inline-block rounded-full font-bold whitespace-nowrap',
                            roomy ? 'px-3 py-1 text-[14px]' : 'px-1.5 py-0.5 text-[12px]', WORD[w].cls)}>
                            {WORD[w].text}{counts!.get(w)! > 1 ? ` ${counts!.get(w)}` : ''}
                          </span>
                        ))}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="py-12 text-center text-gray-400">這一週沒有發片或拍攝</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {picked && (() => {
        const dayPosts = posts
          .filter(p => p.vendorId === picked.vendorId && p.scheduledAt && format(parseISO(p.scheduledAt), 'yyyy-MM-dd') === picked.date)
          .sort((a, b) => (a.scheduledAt || '').localeCompare(b.scheduledAt || ''));
        const dayShoots = bookings.filter(b => b.vendorId === picked.vendorId && b.scheduledDate === picked.date && (b.status === 'booked' || b.status === 'completed'));
        const editorOf = (a: Asset) => {
          const id = getWorkingEditorId(a, vendors);
          return (id && editors.find(e => e.id === id)?.name) || '剪輯師';
        };
        return (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={() => setPicked(null)}>
            <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[19px] font-bold">{name(picked.vendorId)}</p>
                  <p className="text-[14px] text-gray-500">{format(parseISO(picked.date), 'M/d')}（{WEEKDAYS[parseISO(picked.date).getDay()]}）</p>
                </div>
                <button onClick={() => setPicked(null)} className="p-1.5 rounded-lg hover:bg-black/5 text-gray-400"><X size={20} /></button>
              </div>
              {dayShoots.map(b => (
                <div key={b.id} className="rounded-2xl bg-[#F5F5F0] px-4 py-3 flex items-center gap-2 text-[15px]">
                  <Camera size={16} className="text-[#5A5A40]" />
                  <b>{b.status === 'completed' ? '已拍攝' : '拍攝'}</b>
                  <span className="text-gray-500">{[b.startTime, b.location, b.crew].filter(Boolean).join('・')}</span>
                </div>
              ))}
              {dayPosts.map(p => {
                // 片跟貼文有兩種綁法：貼文掛了素材（assetId），或毛片預先綁了這篇貼文（asset.plannedPostId，還在剪的時候就是這種）
                const asset = (p.assetId && p.assetId !== 'to_be_added' ? assets.find(a => a.id === p.assetId) : undefined)
                  || assets.find(a => a.plannedPostId === p.id && !a.voidedAt);
                const prog = videoProgress(p, asset, today, editorOf, !!asset && isInternalWork(asset, vendors, editors));
                return (
                  <div key={p.id} className="rounded-2xl border border-black/5 px-4 py-4 space-y-3">
                    <div>
                      <p className="text-[16px] font-bold truncate">{asset?.title || p.title || '（未命名）'}</p>
                      <p className={cn('text-[14px] mt-0.5 font-bold', prog.current >= 4 ? 'text-green-700' : 'text-orange-700')}>{prog.note}</p>
                    </div>
                    <VideoSteps current={prog.current} />
                  </div>
                );
              })}
              {dayPosts.length === 0 && dayShoots.length === 0 && <p className="text-gray-400 text-center py-6">這天沒有安排</p>}
            </div>
          </div>
        );
      })()}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-[14px] text-gray-500">
        {([['done', '已經發出去'], ['missed', '日子到了還沒發'], ['ready', '片已排定，會自動發'], ['planned', '排了日子，片還在做'], ['shoot', '約好的拍攝日']] as [Word, string][]).map(([w, d]) => (
          <span key={w} className="whitespace-nowrap flex items-center gap-1.5">
            <span className={cn('px-1.5 py-0.5 rounded text-[13px] font-bold', WORD[w].cls)}>{WORD[w].text}</span>{d}
          </span>
        ))}
      </div>
    </div>
  );
}
