import React from 'react';
import { Check } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { EditorMonthSummary, monthLabel } from '../lib/editorBilling';
import { EditorInvoice } from '../types';

/**
 * 剪輯費進度表（2026-11 使用者：「畫一個進度表讓董事知道目前卡在哪」）。
 * 四站：剪輯師送審 → 主管審核 → 董事放行 → 付款完成（董事匯款後按）。
 * 目前站＝最前面還有錢停著的那一站；它前面的站全部清空才算走過（打勾）。全部付清＝四站都打勾。
 * 主管的應付頁、董事電腦版（同一個 EditorPayables）、董事手機版共用。
 */

type Step = { key: string; label: string; short: string; who: string; amount: number; count: number; names: string[]; at?: string };

const money = (n: number) => `$${n.toLocaleString()}`;

/**
 * 每站下面標那一步發生的時間（使用者 11-03）。同月好幾張單時取最晚的那一張。
 * invoices 傳該月、已排除作廢的單。
 */
export default function BillingProgress({ month, summaries, invoices = [] }: { month: string; summaries: EditorMonthSummary[]; invoices?: EditorInvoice[] }) {
  const latest = (k: 'submittedAt' | 'approvedAt' | 'releasedAt' | 'paidAt') =>
    invoices.map(i => i[k]).filter((x): x is string => !!x).sort().pop();
  const pick = (amt: (r: EditorMonthSummary) => number, cnt: (r: EditorMonthSummary) => number) => ({
    amount: summaries.reduce((n, r) => n + amt(r), 0),
    count: summaries.reduce((n, r) => n + cnt(r), 0),
    names: summaries.filter(r => amt(r) > 0).map(r => r.editorName),
  });
  const steps: Step[] = [
    { key: 'edit', label: '剪輯師送審', short: '送審', who: '剪輯師', at: latest('submittedAt'), ...pick(r => r.unsubmittedAmount, r => r.unsubmittedCount) },
    { key: 'mgr', label: '主管審核', short: '主管', who: '主管', at: latest('approvedAt'), ...pick(r => r.submittedAmount, r => r.submittedCount) },
    { key: 'boss', label: '董事放行', short: '董事', who: '董事', at: latest('releasedAt'), ...pick(r => r.approvedAmount, r => r.approvedCount) },
    { key: 'pay', label: '付款完成', short: '付款', who: '董事', at: latest('paidAt'), ...pick(r => r.releasedAmount + r.processingAmount, r => r.releasedCount + r.processingCount) },
  ];
  const total = summaries.reduce((n, r) => n + r.totalAmount, 0);
  if (total === 0) return null;

  // 最前面還有錢停著的站（已付清那站不算「卡住」）
  const stuckIdx = steps.findIndex(s => s.amount > 0);
  const paid = pick(r => r.paidAmount, r => r.paidCount);
  const allPaid = stuckIdx === -1;

  return (
    <div className="bg-white rounded-2xl border border-black/5 shadow-sm px-5 sm:px-6 py-5">
      {/* 只放標題＋進度條（使用者 11-03：不要「目前卡在…」那種白話句） */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-bold text-[#1a1a1a] whitespace-nowrap">{monthLabel(month)}剪輯費進度</p>
        {paid.amount > 0 && <p className="text-[13px] text-gray-500 whitespace-nowrap">已付款 <b className="text-green-700 tabular-nums">{money(paid.amount)}</b> ／ {money(total)}</p>}
      </div>

      <div className="mt-5"><StepsRow steps={steps} currentIdx={stuckIdx} /></div>
    </div>
  );
}

/** 進度條本體：月份總覽（BillingProgress）與單張請款單（InvoiceProgress）共用。currentIdx = -1 ＝全部完成 */
function StepsRow({ steps, currentIdx }: { steps: Step[]; currentIdx: number }) {
  const allDone = currentIdx === -1;
  return (
    <div className="flex items-start">
      {steps.map((s, i) => {
        const done = allDone || i < currentIdx;
        const current = i === currentIdx;
        return (
          <React.Fragment key={s.key}>
            <div className="flex flex-col items-center text-center w-[52px] sm:w-[110px] shrink-0">
              <div className="relative">
                {current && <span className="absolute inset-0 rounded-full bg-orange-400 animate-ping opacity-40" />}
                <div className={`relative w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-[14px] font-bold border-2 ${
                  current ? 'bg-orange-500 border-orange-500 text-white'
                    : done ? 'bg-[#5A5A40] border-[#5A5A40] text-white'
                    : 'bg-white border-gray-200 text-gray-300'}`}>
                  {done && !current ? <Check size={18} strokeWidth={3} /> : i + 1}
                </div>
              </div>
              <p className={`mt-2 text-[12px] sm:text-[14px] font-bold whitespace-nowrap ${current ? 'text-orange-700' : done ? 'text-[#5A5A40]' : 'text-gray-400'}`}><span className="sm:hidden">{s.short}</span><span className="hidden sm:inline">{s.label}</span></p>
              {s.at && (
                <p className="mt-0.5 text-[11px] sm:text-[12px] text-gray-500 tabular-nums leading-tight">
                  <span className="sm:hidden">{format(parseISO(s.at), 'M/d')}</span>
                  <span className="hidden sm:inline">{format(parseISO(s.at), 'yyyy/M/d')}</span>
                  <span className="block">{format(parseISO(s.at), 'HH:mm')}</span>
                </p>
              )}
              {s.amount > 0 && <p className="mt-0.5 text-[11px] sm:text-[13px] tabular-nums whitespace-nowrap text-[#1a1a1a] font-bold">{money(s.amount)}</p>}
              {s.count > 0 && <p className="hidden sm:block text-[12px] text-gray-400 whitespace-nowrap">{s.count} 支</p>}
              {!s.at && s.amount === 0 && <p className="text-[11px] sm:text-[13px] text-gray-300">—</p>}
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-[3px] mt-[18px] sm:mt-[19px] rounded-full ${allDone || i < currentIdx ? 'bg-[#5A5A40]' : 'bg-gray-200'}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/**
 * 單張請款單的進度（剪輯師「我的請款」用，使用者 11-03：讓剪輯師看到自己這張單走到哪）。
 * 站名跟月份總覽一樣；目前站由單的狀態決定，每站標完成時間。
 */
export function InvoiceProgress({ inv }: { inv: EditorInvoice }) {
  const idx = inv.status === 'submitted' ? 1
    : inv.status === 'approved' ? 2
    : inv.status === 'released' || inv.status === 'payment_processing' ? 3
    : -1; // paid
  const none = { amount: 0, count: 0, names: [] as string[] };
  const steps: Step[] = [
    { key: 'edit', label: '剪輯師送審', short: '送審', who: '剪輯師', at: inv.submittedAt, ...none },
    { key: 'mgr', label: '主管審核', short: '主管', who: '主管', at: inv.approvedAt, ...none },
    { key: 'boss', label: '董事放行', short: '董事', who: '董事', at: inv.releasedAt, ...none },
    { key: 'pay', label: '付款完成', short: '付款', who: '董事', at: inv.paidAt, ...none },
  ];
  return <StepsRow steps={steps} currentIdx={idx} />;
}