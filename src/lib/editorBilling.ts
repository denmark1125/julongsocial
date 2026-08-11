import { format, parseISO } from 'date-fns';
import {
  Asset,
  DEFAULT_EDITOR_FEE,
  EDITOR_BILLING_START_MONTH,
  EditorInvoiceItem,
  Vendor,
} from '../types';

// 剪輯師請款的純計算層，前台(剪輯師請款頁)與後台(應付對帳)共用，不碰 Firestore。
// 定位跟 vendorStatus.ts 一樣：所有「誰該領多少錢」的判定只能有這一份實作。

/** 這支多少錢。沒填過就是預設價，不要在各處各自寫 ?? 900。 */
export function getAssetFee(asset: Pick<Asset, 'editorFee'>): number {
  const fee = asset.editorFee;
  return typeof fee === 'number' && Number.isFinite(fee) && fee >= 0 ? fee : DEFAULT_EDITOR_FEE;
}

/**
 * 這支算哪個月的請款。
 *
 * ⚠️ 一定要走 date-fns 轉本地時區，**不可以** `cloudUploadedAt.slice(0,7)`。
 * cloudUploadedAt 是 `new Date().toISOString()`＝UTC，台北時間 9/1 凌晨 03:00 上傳
 * 存進去是 `2026-08-31T19:00:00Z`，字串裁切會把它算成 8 月 —— 每個月頭 8 小時上傳的片都會歸錯月。
 */
export function getBillingMonth(asset: Pick<Asset, 'cloudUploadedAt'>): string | null {
  if (!asset.cloudUploadedAt) return null;
  try {
    return format(parseISO(asset.cloudUploadedAt), 'yyyy-MM');
  } catch {
    return null;
  }
}

/**
 * 這支可不可以請款。
 *
 * 老闆定的規則：成片被完成上傳雲端＝這支可以請款。所以判定只認 cloudUploadedAt，
 * **不看業主審核進度** —— 剪輯師可以在業主還在審的時候就上傳，那也算他做完了。
 *
 * EDITOR_BILLING_START_MONTH 之前的片一律排除：那些是這套流程上線前就有 cloudUploadedAt 的存量，
 * 早就用別的方式請過款了。
 */
export function isBillable(asset: Pick<Asset, 'cloudUploadedAt' | 'editorInvoiceId'>): boolean {
  if (asset.editorInvoiceId) return false; // 已經請過款
  const month = getBillingMonth(asset);
  return !!month && month >= EDITOR_BILLING_START_MONTH;
}

/** 某位剪輯師某個月還沒請款的片 */
export function listBillable(assets: Asset[], month: string): Asset[] {
  return assets
    .filter(a => isBillable(a) && getBillingMonth(a) === month)
    .sort((a, b) => (a.cloudUploadedAt || '').localeCompare(b.cloudUploadedAt || ''));
}

/** 依 IP 分組，讓剪輯師照 IP 一組一組核對（老闆指定的呈現方式） */
export function groupByVendor(
  assets: Asset[],
  vendorName: (vendorId: string) => string
): { vendorId: string; vendorName: string; assets: Asset[] }[] {
  const groups = new Map<string, Asset[]>();
  for (const a of assets) {
    const list = groups.get(a.vendorId) ?? [];
    list.push(a);
    groups.set(a.vendorId, list);
  }
  return Array.from(groups.entries())
    .map(([vendorId, list]) => ({ vendorId, vendorName: vendorName(vendorId), assets: list }))
    .sort((x, y) => x.vendorName.localeCompare(y.vendorName, 'zh-Hant'));
}

/** 把選中的片轉成請款單明細（快照）。金額用 overrides 蓋過 asset 上的值。 */
export function buildInvoiceItems(
  assets: Asset[],
  vendors: Vendor[],
  overrides: Record<string, number> = {}
): EditorInvoiceItem[] {
  return assets.map(a => ({
    assetId: a.id!,
    vendorId: a.vendorId,
    vendorName: vendors.find(v => v.id === a.vendorId)?.name || '未知 IP',
    title: a.title || '',
    cloudUploadedAt: a.cloudUploadedAt!,
    amount: overrides[a.id!] ?? getAssetFee(a),
  }));
}

export function sumItems(items: EditorInvoiceItem[]): number {
  return items.reduce((acc, it) => acc + it.amount, 0);
}

/**
 * 請款頁的月份選項：從有資料的最早月份排到本月，至少涵蓋本月與上個月。
 * 月底/月初交接時剪輯師常常是「9 月初才回頭送 8 月的單」，所以不能只給本月。
 */
export function billingMonthOptions(assets: Asset[], now: Date = new Date()): string[] {
  const months = new Set<string>();
  const thisMonth = format(now, 'yyyy-MM');
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  months.add(thisMonth);
  if (format(prev, 'yyyy-MM') >= EDITOR_BILLING_START_MONTH) months.add(format(prev, 'yyyy-MM'));

  for (const a of assets) {
    const m = getBillingMonth(a);
    if (m && m >= EDITOR_BILLING_START_MONTH && m <= thisMonth) months.add(m);
  }
  return Array.from(months).sort().reverse();
}

/** 2026-08 → 8月 */
export function monthLabel(month: string): string {
  const [, mm] = month.split('-');
  return `${Number(mm)}月`;
}

/**
 * 這支片的請款歸屬。
 * billableEditorId 是上傳當下凍結的值，最準；沒有才退回逐支指派、再退回廠商的預設剪輯師
 *（跟 AssetDatabase.getEffectiveEditorId 同一套 fallback）。
 */
export function getBillableEditorId(asset: Asset, vendors: Vendor[]): string | undefined {
  if (asset.billableEditorId) return asset.billableEditorId;
  if (asset.editorId) return asset.editorId;
  return vendors.find(v => v.id === asset.vendorId)?.editorId;
}

export interface EditorMonthSummary {
  editorId: string;
  editorName: string;
  /** 可請款但剪輯師還沒送單 */
  unsubmittedCount: number;
  unsubmittedAmount: number;
  /** 已送單、我們還沒付 */
  submittedCount: number;
  submittedAmount: number;
  /** 已標記請款完成 */
  paidCount: number;
  paidAmount: number;
  totalCount: number;
  totalAmount: number;
}

/**
 * 後台對帳的核心彙總。
 *
 * ⚠️ 已經有 editorInvoiceId 的素材一律從「未送單」那側排除，金額只從請款單快照取，
 * 否則同一支片會被算兩次（一次從素材、一次從單）。
 *
 * 老闆只要兩段狀態（未請款→已請款），但後台需要三段才答得出「哪些沒請款」：
 * 分不清「剪輯師忘了送單」和「我忘了付錢」的話，月底根本不知道要催誰。
 */
export function summarizeByEditor(
  month: string,
  assets: Asset[],
  vendors: Vendor[],
  editorName: (editorId: string) => string,
  invoices: { editorId: string; billingMonth: string; status: string; itemCount: number; totalAmount: number }[]
): EditorMonthSummary[] {
  const rows = new Map<string, EditorMonthSummary>();
  const row = (editorId: string): EditorMonthSummary => {
    let r = rows.get(editorId);
    if (!r) {
      r = {
        editorId, editorName: editorName(editorId),
        unsubmittedCount: 0, unsubmittedAmount: 0,
        submittedCount: 0, submittedAmount: 0,
        paidCount: 0, paidAmount: 0,
        totalCount: 0, totalAmount: 0,
      };
      rows.set(editorId, r);
    }
    return r;
  };

  for (const a of assets) {
    if (!isBillable(a) || getBillingMonth(a) !== month) continue; // isBillable 已排除有單的
    const eid = getBillableEditorId(a, vendors) || '__unassigned__';
    const r = row(eid);
    r.unsubmittedCount += 1;
    r.unsubmittedAmount += getAssetFee(a);
  }

  for (const inv of invoices) {
    if (inv.billingMonth !== month || inv.status === 'void') continue;
    const r = row(inv.editorId);
    if (inv.status === 'paid') {
      r.paidCount += inv.itemCount;
      r.paidAmount += inv.totalAmount;
    } else {
      r.submittedCount += inv.itemCount;
      r.submittedAmount += inv.totalAmount;
    }
  }

  for (const r of rows.values()) {
    r.totalCount = r.unsubmittedCount + r.submittedCount + r.paidCount;
    r.totalAmount = r.unsubmittedAmount + r.submittedAmount + r.paidAmount;
  }

  return Array.from(rows.values())
    .filter(r => r.totalCount > 0)
    .sort((a, b) => b.totalAmount - a.totalAmount);
}
