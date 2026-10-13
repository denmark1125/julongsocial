import { forwardRef } from 'react';
import { format, parseISO, endOfMonth } from 'date-fns';

/** 對帳單上的一列：已入單的取請款單快照，未送單的取素材現值 */
export interface StatementRow {
  key: string;
  vendorName: string;
  title: string;
  uploadedAt?: string;
  tierLabel?: string;
  amount: number;
  status: StatementStatus;
  note?: string;
}

export type StatementStatus = 'unsubmitted' | 'submitted' | 'approved' | 'payment_processing' | 'paid';

export const STATEMENT_STATUS_LABEL: Record<StatementStatus, string> = {
  unsubmitted: '未送單',
  submitted: '待核准',
  approved: '已核准',
  payment_processing: '付款中',
  paid: '已付款',
};

export interface StatementMeta {
  month: string;        // YYYY-MM
  editorName: string;
  statementNo: string;
  preparedAt: Date;
}

export interface VendorGroup<R extends StatementRow = StatementRow> {
  vendorName: string;
  rows: R[];
  subtotal: number;
}

/** 依 IP 分組（IP 依中文筆畫、組內依上傳日），每組帶小計。畫面與 PDF 共用，兩邊的分組一定一致。 */
export function groupRowsByVendor<R extends StatementRow>(rows: R[]): VendorGroup<R>[] {
  const map = new Map<string, R[]>();
  for (const r of rows) {
    const list = map.get(r.vendorName) || [];
    list.push(r);
    map.set(r.vendorName, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b, 'zh-Hant'))
    .map(([vendorName, list]) => ({
      vendorName,
      rows: [...list].sort((a, b) => (a.uploadedAt || '').localeCompare(b.uploadedAt || '')),
      subtotal: list.reduce((n, r) => n + r.amount, 0),
    }));
}

const COMPANY = '聚浪社群行銷有限公司';

// A4 @ 96dpi。版面以「頁」為單位排好再逐頁截圖，列不會被切成兩半。
const PAGE_W = 794;
const PAGE_H = 1123;
const FIRST_PAGE_LINES = 21;
const NEXT_PAGE_LINES = 28;
/** 合計＋簽核欄大約佔的行數；最後一頁放不下就另起一頁 */
const CLOSING_LINES = 8;

type Line =
  | { kind: 'ip'; vendorName: string; count: number; cont: boolean }
  | { kind: 'row'; row: StatementRow; seq: number }
  | { kind: 'sub'; vendorName: string; count: number; subtotal: number };

function toLines(groups: VendorGroup[]): Line[] {
  const lines: Line[] = [];
  let seq = 0;
  for (const g of groups) {
    lines.push({ kind: 'ip', vendorName: g.vendorName, count: g.rows.length, cont: false });
    for (const row of g.rows) lines.push({ kind: 'row', row, seq: ++seq });
    lines.push({ kind: 'sub', vendorName: g.vendorName, count: g.rows.length, subtotal: g.subtotal });
  }
  return lines;
}

/** 分頁：IP 標題不會孤零零落在頁尾；跨頁的 IP 在新頁補一行「（續）」 */
function paginate(lines: Line[]): Line[][] {
  const pages: Line[][] = [];
  let cur: Line[] = [];
  let currentIp: Line & { kind: 'ip' } | null = null;
  const cap = () => (pages.length === 0 ? FIRST_PAGE_LINES : NEXT_PAGE_LINES);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === 'ip') currentIp = l;
    const needsRoomForFirstRow = l.kind === 'ip' ? 2 : 1;
    if (cur.length + needsRoomForFirstRow > cap()) {
      pages.push(cur);
      cur = [];
      if (l.kind !== 'ip' && currentIp) cur.push({ ...currentIp, cont: true });
    }
    cur.push(l);
  }
  pages.push(cur);
  if (cur.length + CLOSING_LINES > cap()) pages.push([]);
  return pages;
}

const money = (n: number) => n.toLocaleString();

const cell = 'px-2 py-[7px] border-b border-[#E3E1D8]';

/**
 * 剪輯費對帳單（列印／PDF 用）。只負責排版，截圖與存檔在呼叫端。
 * 刻意用固定寬高與白底，不吃頁面的主題色，印出來跟螢幕上看到的一致。
 */
const EditorStatementPdf = forwardRef<HTMLDivElement, { meta: StatementMeta; rows: StatementRow[] }>(
  ({ meta, rows }, ref) => {
    const groups = groupRowsByVendor(rows);
    const pages = paginate(toLines(groups));
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const byStatus = (Object.keys(STATEMENT_STATUS_LABEL) as StatementStatus[])
      .map(s => ({ s, list: rows.filter(r => r.status === s) }))
      .filter(x => x.list.length > 0);
    const monthStart = parseISO(`${meta.month}-01`);

    return (
      <div ref={ref} style={{ position: 'fixed', left: -10000, top: 0 }} aria-hidden>
        {pages.map((pageLines, pi) => (
          <div
            key={pi}
            data-pdf-page
            className="bg-white text-[#1a1a1a] flex flex-col"
            style={{ width: PAGE_W, height: PAGE_H, padding: '56px 56px 40px', boxSizing: 'border-box' }}
          >
            {pi === 0 ? (
              <>
                <div className="flex items-end justify-between border-b-2 border-[#1a1a1a] pb-3">
                  <div>
                    <p className="text-[13px] tracking-[0.2em] text-gray-500">{COMPANY}</p>
                    <h1 className="text-[26px] font-bold tracking-[0.3em] mt-1">剪輯費對帳單</h1>
                  </div>
                  <p className="text-[12px] text-gray-500 whitespace-nowrap">單號 {meta.statementNo}</p>
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[13px] mt-4 mb-5">
                  <p><span className="text-gray-500 inline-block w-20">剪輯師</span>{meta.editorName}</p>
                  <p><span className="text-gray-500 inline-block w-20">製表日</span>{format(meta.preparedAt, 'yyyy/MM/dd')}</p>
                  <p><span className="text-gray-500 inline-block w-20">對帳期間</span>{format(monthStart, 'yyyy/MM/dd')} ～ {format(endOfMonth(monthStart), 'yyyy/MM/dd')}</p>
                  <p><span className="text-gray-500 inline-block w-20">計費標準</span>60 秒以下 750／60 秒以上 900</p>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between border-b border-[#1a1a1a] pb-2 mb-4 text-[12px] text-gray-500">
                <span>{COMPANY}　剪輯費對帳單（續）</span>
                <span>{meta.editorName}　{meta.statementNo}</span>
              </div>
            )}

            {pageLines.length > 0 && (
              <table className="w-full text-[12.5px] tabular-nums" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
                <colgroup>
                  <col style={{ width: 38 }} />
                  <col />
                  <col style={{ width: 70 }} />
                  <col style={{ width: 80 }} />
                  <col style={{ width: 64 }} />
                  <col style={{ width: 78 }} />
                </colgroup>
                <thead>
                  <tr className="bg-[#F2F1EC] text-left text-[12px] text-gray-600">
                    <th className={`${cell} text-center font-bold`}>序</th>
                    <th className={`${cell} font-bold`}>片名</th>
                    <th className={`${cell} font-bold`}>上傳日</th>
                    <th className={`${cell} font-bold`}>長度</th>
                    <th className={`${cell} font-bold`}>狀態</th>
                    <th className={`${cell} text-right font-bold`}>金額</th>
                  </tr>
                </thead>
                <tbody>
                  {pageLines.map((l, li) => {
                    if (l.kind === 'ip') {
                      return (
                        <tr key={`ip-${li}`}>
                          <td colSpan={6} className="px-2 pt-3 pb-1.5 border-b border-[#1a1a1a]/40 font-bold text-[13px]">
                            {l.vendorName}{l.cont ? '（續）' : ''}
                            {!l.cont && <span className="ml-2 font-normal text-gray-500 text-[12px]">{l.count} 支</span>}
                          </td>
                        </tr>
                      );
                    }
                    if (l.kind === 'sub') {
                      return (
                        <tr key={`sub-${li}`} className="bg-[#F7F6F2]">
                          <td colSpan={5} className={`${cell} text-right text-gray-600`}>{l.vendorName} 小計 {l.count} 支</td>
                          <td className={`${cell} text-right font-bold whitespace-nowrap`}>{money(l.subtotal)}</td>
                        </tr>
                      );
                    }
                    const r = l.row;
                    return (
                      <tr key={r.key}>
                        <td className={`${cell} text-center text-gray-500`}>{l.seq}</td>
                        <td className={`${cell} truncate whitespace-nowrap`}>{r.title}{r.note ? `（${r.note}）` : ''}</td>
                        <td className={`${cell} whitespace-nowrap`}>{r.uploadedAt ? format(parseISO(r.uploadedAt), 'MM/dd') : '—'}</td>
                        <td className={`${cell} whitespace-nowrap`}>{r.tierLabel || '—'}</td>
                        <td className={`${cell} whitespace-nowrap`}>{STATEMENT_STATUS_LABEL[r.status]}</td>
                        <td className={`${cell} text-right whitespace-nowrap`}>{money(r.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {pi === pages.length - 1 && (
              <div className="mt-5">
                <div className="flex items-baseline justify-between border-t-2 border-b border-[#1a1a1a] py-2.5">
                  <span className="text-[14px] font-bold">合計 {groups.length} 個 IP・{rows.length} 支</span>
                  <span className="text-[16px] font-bold tabular-nums">新台幣 {money(total)} 元</span>
                </div>
                {byStatus.length > 1 && (
                  <p className="text-[12px] text-gray-600 mt-2">
                    {byStatus.map(x => `${STATEMENT_STATUS_LABEL[x.s]} ${x.list.length} 支 ${money(x.list.reduce((s, r) => s + r.amount, 0))} 元`).join('　／　')}
                  </p>
                )}
                <p className="text-[11.5px] text-gray-500 mt-2 leading-relaxed">
                  說明：以成片上傳雲端日期認列月份；「未送單」為剪輯師尚未送出請款之片，金額以送單時為準。
                </p>
                <div className="grid grid-cols-4 gap-4 mt-10 text-[12.5px] text-center">
                  {['製表', '覆核', '核准', '剪輯師簽收'].map(l => (
                    <div key={l}>
                      <div className="h-14 border-b border-[#1a1a1a]" />
                      <p className="mt-1.5 text-gray-600">{l}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-auto pt-4 flex justify-between text-[11px] text-gray-400">
              <span>{COMPANY}</span>
              <span>第 {pi + 1} 頁／共 {pages.length} 頁</span>
            </div>
          </div>
        ))}
      </div>
    );
  }
);

export default EditorStatementPdf;
