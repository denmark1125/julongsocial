import { format, parseISO } from 'date-fns';
import {
  Asset,
  deriveFlowStage,
  DEFAULT_EDITOR_FEE,
  DurationTier,
  EDITOR_BILLING_CUTOVER_AT,
  EDITOR_BILLING_START_MONTH,
  EDITOR_FEE_BY_TIER,
  EditorInvoiceItem,
  Vendor,
} from '../types';

// 剪輯師請款的純計算層，前台(剪輯師請款頁)與後台(應付對帳)共用，不碰 Firestore。
// 定位跟 vendorStatus.ts 一樣：所有「誰該領多少錢」的判定只能有這一份實作。

/** 這個長度分級對應多少錢。分級價只有這一份定義。 */
export function feeForTier(tier: DurationTier): number {
  return EDITOR_FEE_BY_TIER[tier];
}

/**
 * 這支多少錢。優先序刻意是這個順序，不要在各處各自寫 ?? 900：
 *   1. editorFee —— 人工指定過（管帳調價、或已入單凍結的金額），最優先
 *   2. durationTier —— 60 秒以下 750 / 以上 950
 *   3. DEFAULT_EDITOR_FEE —— 兩者都沒有的舊素材
 *
 * ⚠️ editorFee 要排在 durationTier 前面：請款送出時會把當下算出的金額寫回 editorFee 凍結，
 * 若讓分級優先，日後調整分級價會連已送出的單子一起變動。
 */
export function getAssetFee(asset: Pick<Asset, 'editorFee' | 'durationTier'>): number {
  const fee = asset.editorFee;
  if (typeof fee === 'number' && Number.isFinite(fee) && fee >= 0) return fee;
  if (asset.durationTier && asset.durationTier in EDITOR_FEE_BY_TIER) {
    return EDITOR_FEE_BY_TIER[asset.durationTier];
  }
  return DEFAULT_EDITOR_FEE;
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
export function isBeforeBillingCutover(asset: Pick<Asset, 'cloudUploadedAt'>): boolean {
  if (!asset.cloudUploadedAt) return false;
  const uploaded = Date.parse(asset.cloudUploadedAt);
  const cutover = Date.parse(EDITOR_BILLING_CUTOVER_AT);
  return Number.isFinite(uploaded) && uploaded < cutover;
}

/** 盤點時要看的素材欄位 */
export type LegacyReviewAsset = Pick<Asset,
  'cloudUploadedAt' | 'editorInvoiceId' | 'voidedAt' | 'legacySettlementStatus' |
  'stage' | 'approved' | 'flowStage' | 'status' | 'createdAt'>;

/**
 * 「從沒上傳過雲端」的舊帳。
 *
 * 內部帳號(秀姨/小馬)那批就是這種：剪輯師當年在系統外（LINE／勞報單）領錢，
 * 所以從來沒走過「上傳雲端」那一步。結果那些片會永遠掛在他的待辦裡不會動——
 * 系統沒有任何路徑可以把它們結案，除了語意不對的「封存」。
 *
 * ⚠️ 只收「還卡在剪輯師待辦」的（client_review / to_upload）。不能放寬成「所有成片」：
 *    實測那樣會撈進 288 支，其中絕大多數是 ready 的舊資料，本來就不出現在剪輯師畫面上
 *    （見 EditorAssetQueue.bucketOf 對 ready-without-upload 回傳 null），列出來只是雜訊。
 *    收斂到這條之後是 40 支，每一支都是真的需要你做決定的。
 * ⚠️ 封存的也不收：那種已經從剪輯師畫面消失了，沒有要解決的問題。
 * ⚠️ 用 createdAt 判切帳日（它沒有 cloudUploadedAt 可以判），否則今天剛上架的新片
 *    明天就會被當成舊帳跳出來。
 */
export function isLegacyNeverUploaded(asset: LegacyReviewAsset): boolean {
  if (asset.cloudUploadedAt) return false;
  if (asset.status === 'archived') return false;
  const stage = deriveFlowStage(asset);
  if (stage !== 'client_review' && stage !== 'to_upload') return false;
  const created = Date.parse(asset.createdAt || '');
  const cutover = Date.parse(EDITOR_BILLING_CUTOVER_AT);
  return Number.isFinite(created) && created < cutover;
}

/**
 * 需要人工盤點的舊帳，兩種：
 * ① 切帳日前就上傳過雲端、還沒進請款單的片。
 * ② 已經交片、但從沒上傳過雲端的片（見 isLegacyNeverUploaded）。
 * 兩種都標過 paid/unpaid 之後就不再出現。
 */
export function needsLegacyReview(asset: LegacyReviewAsset): boolean {
  if (asset.editorInvoiceId || asset.voidedAt) return false;
  if (asset.legacySettlementStatus && asset.legacySettlementStatus !== 'needs_review') return false;
  if (asset.cloudUploadedAt) return isBeforeBillingCutover(asset);
  return isLegacyNeverUploaded(asset);
}

export function isBillable(asset: Pick<Asset,
  'cloudUploadedAt' | 'editorInvoiceId' | 'voidedAt' | 'legacySettlementStatus'
>): boolean {
  // 作廢＝這支根本不該存在（多半是建重複了）。不擋在這裡的話，同一個東西的 A/B 兩支都會進請款清單。
  // ⚠️ 注意「封存」故意不擋：封存是業主暫時不用，剪輯師的工還是要算錢。兩者語意不同，別合併。
  if (asset.voidedAt) return false;
  if (asset.editorInvoiceId) return false; // 已經請過款
  const month = getBillingMonth(asset);
  if (!month || month < EDITOR_BILLING_START_MONTH) return false;
  // 切帳日前的存量片逐支盤點：只有明確確認「舊制尚未付」才轉入系統請款。
  if (isBeforeBillingCutover(asset)) return asset.legacySettlementStatus === 'unpaid';
  return true;
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
 * 這支片**現在該由誰做**。逐支指派優先，沒指派才回退到廠商的預設剪輯師。
 *
 * 這段判斷原本有三份各自獨立的實作——這裡、AssetDatabase 的 getEffectiveEditorId()、
 * ProductionFlowBoard 的 effectiveEditorId()，而且前者多一層 billableEditorId、後兩者沒有，
 * 導致「畫面上顯示的剪輯師」跟「請款算給誰」可能不同人。
 * 現在統一成這一支，其他地方一律 import，不要再各寫一份。
 *
 * ⚠️ 跟 getBillableEditorId() 是兩個不同的問題，不要混用：
 *   - 這一支＝「誰要動手剪」，會跟著逐支指派即時變動（工作台、看板、催剪輯清單用）
 *   - getBillableEditorId()＝「誰領這支的錢」，優先採用上傳當下凍結的值（請款、對帳用）
 */
export function getWorkingEditorId(
  asset: Pick<Asset, 'editorId' | 'vendorId'>,
  vendors: Vendor[]
): string | undefined {
  if (asset.editorId) return asset.editorId;
  return vendors.find(v => v.id === asset.vendorId)?.editorId;
}

/**
 * 這支片的請款歸屬。
 * billableEditorId 是上傳當下凍結的值，最準；沒有才回退到「現在該由誰做」。
 * 凍結的用意是：日後換掉廠商的預設剪輯師，不會把舊片的錢一起搬到新人身上。
 */
export function getBillableEditorId(asset: Asset, vendors: Vendor[]): string | undefined {
  if (asset.billableEditorId) return asset.billableEditorId;
  return getWorkingEditorId(asset, vendors);
}

/**
 * 這支片現在能不能改派剪輯師。
 *
 * 抽成純函式而不是把條件寫在 JSX 裡，是因為這組判斷同時要用在「按鈕出不出現」跟
 * 「真的寫入前」兩個地方（沿用交棒鏈防呆的做法），寫兩份遲早分岔；而且這樣測得到。
 */
export function canReassignEditor(
  asset: Pick<Asset, 'cloudUploadedAt' | 'editorInvoiceId' | 'voidedAt'>,
  role: string | undefined
): { ok: boolean; reason?: string; needsConfirm?: boolean } {
  // 剪輯師不能改自己的歸屬——安全規則也擋（editorId 不在 isEditorAssetUpdate 白名單）
  if (role === 'editor') return { ok: false, reason: '剪輯師不能改派' };
  if (asset.voidedAt) return { ok: false, reason: '已作廢的片不用改派' };
  // 已入單＝帳務凍結。規則層也擋（touchesEditorAssignment + assetInvoiced）
  if (asset.editorInvoiceId) return { ok: false, reason: '已納入請款單，帳務凍結' };
  // 已上傳＝剪輯費已經歸屬出去了，這時改派只會讓「誰剪的」跟「誰領錢」打架。
  // 真的要換人重剪請走作廢重建，不是改派。
  if (asset.cloudUploadedAt) return { ok: false, reason: '已上傳雲端、剪輯費已歸屬，不能改派' };
  return { ok: true, needsConfirm: true };
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
  approvedCount: number;
  approvedAmount: number;
  processingCount: number;
  processingAmount: number;
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
        approvedCount: 0, approvedAmount: 0,
        processingCount: 0, processingAmount: 0,
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
    } else if (inv.status === 'approved') {
      r.approvedCount += inv.itemCount;
      r.approvedAmount += inv.totalAmount;
    } else if (inv.status === 'payment_processing') {
      r.processingCount += inv.itemCount;
      r.processingAmount += inv.totalAmount;
    } else {
      r.submittedCount += inv.itemCount;
      r.submittedAmount += inv.totalAmount;
    }
  }

  for (const r of rows.values()) {
    r.totalCount = r.unsubmittedCount + r.submittedCount + r.approvedCount + r.processingCount + r.paidCount;
    r.totalAmount = r.unsubmittedAmount + r.submittedAmount + r.approvedAmount + r.processingAmount + r.paidAmount;
  }

  return Array.from(rows.values())
    .filter(r => r.totalCount > 0)
    .sort((a, b) => b.totalAmount - a.totalAmount);
}
