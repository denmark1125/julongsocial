import { differenceInCalendarDays } from 'date-fns';
import { auth } from '../firebase';
import {
  Asset,
  AssetFlowStage,
  FlowLogEntry,
  Post,
  FLOW_STAGE_COMPAT,
  FLOW_STALE_DAYS,
  deriveFlowStage,
} from '../types';

// 交棒鏈的唯一推進入口。剪輯師後台跟「製作進度」看板都必須走這裡，
// 兩邊各自 updateDoc 的話 stage/approved 遲早會跟 flowStage 不一致，
// 那就等於回到「查不出球在誰手上」的老問題。

// 正常的交棒路徑（UI 只會提供這些按鈕）：
//   to_edit / revising --剪輯師「交片送審」--> client_review
//   client_review --小編回填業主結果--> to_upload（通過）或 revising（要改）
//   to_upload --剪輯師「上傳雲端」--> ready
// 素材資料庫的「取消審核」是管理端的例外路徑（ready -> client_review），
// 所以這裡不做轉移白名單檢查，改由各頁面只顯示合理的按鈕來約束。
//
// ⚠️「上傳雲端」不是交棒鏈上的一棒，是一條獨立的軸（見 buildCloudUploadUpdate）。
// 實務上我們是在 LINE 上請剪輯師上傳，他上傳完就該能立刻標記，不該卡在我們有沒有空
// 回後台點「業主通過」。而且「已上傳」是請款的認定依據，必須由剪輯師自己掌握。
// 所以：業主通過與否 = 我們寫；已不已上傳 = 剪輯師寫；兩者都成立才是 ready（可排程）。

const FLOW_LOG_LIMIT = 20;

export interface AdvanceFlowOptions {
  byUid?: string;
  byName?: string;
  note?: string; // 業主退回原因
  now?: Date;
}

export function getClientApprovalTarget(asset: Pick<Asset, 'cloudUploadedAt'>): 'to_upload' | 'ready' {
  return asset.cloudUploadedAt ? 'ready' : 'to_upload';
}

/**
 * 產生推進到下一棒要寫進 Firestore 的欄位。
 * 一定會連帶寫入 FLOW_STAGE_COMPAT 對應的 stage/approved，
 * 讓 vendorStatus 的庫存/欠片計算不受 flowStage 影響（尤其 revising 必須把 stage 寫回 'raw'，
 * 否則被退回的片會像過去一樣從剪輯師的清單裡消失）。
 */
export function buildFlowUpdate(
  asset: Pick<Asset, 'stage' | 'approved' | 'flowStage' | 'revisionCount' | 'flowLog' | 'cloudUploadedAt'>,
  to: AssetFlowStage,
  opts: AdvanceFlowOptions = {}
): Record<string, unknown> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const from = deriveFlowStage(asset);
  const compat = FLOW_STAGE_COMPAT[to];

  const entry: FlowLogEntry = { from, to, at: nowIso };
  if (opts.byUid) entry.byUid = opts.byUid;
  if (opts.byName) entry.byName = opts.byName;
  if (opts.note) entry.note = opts.note;

  const update: Record<string, unknown> = {
    flowStage: to,
    flowSince: nowIso,
    stage: compat.stage,
    approved: compat.approved,
    flowLog: [...(asset.flowLog ?? []), entry].slice(-FLOW_LOG_LIMIT),
  };

  if (to === 'revising') {
    update.revisionCount = (asset.revisionCount ?? 0) + 1;
    update.revisionNote = opts.note ?? '';
  }
  if (to === 'ready') {
    // 只在還沒上傳過時補戳。剪輯師可能早在業主審核期間就上傳了，
    // 那個日期是請款月份的認定依據，絕不能被業主通過的時間蓋掉。
    if (!asset.cloudUploadedAt) update.cloudUploadedAt = nowIso;
  }
  // 剪輯師交片：沿用既有的 submittedBy/submittedAt，不另造欄位
  if (to === 'client_review' && opts.byUid) {
    update.submittedBy = opts.byUid;
    update.submittedAt = nowIso;
  }

  return update;
}

/**
 * 剪輯師標記「已上傳雲端」。
 *
 * 這是獨立於審核軸的一條事實線，不是交棒鏈上的一棒：
 * - 業主已經通過了（to_upload）→ 兩個條件都成立，直接進 ready（可排程）。
 * - 業主還在審（client_review）→ **只記錄上傳事實，棒次不動**。
 *   絕不能在這裡寫 approved=true —— 那等於冒用業主的通過，會讓沒審過的片
 *   直接掉進可排程庫存（vendorStatus 是用 approved 判定成片的）。
 *
 * 上傳日期 cloudUploadedAt 是請款月份的唯一認定依據，所以只寫一次、之後不覆蓋。
 */
export function buildCloudUploadUpdate(
  asset: Pick<Asset, 'stage' | 'approved' | 'flowStage' | 'revisionCount' | 'flowLog' | 'cloudUploadedAt'>,
  opts: AdvanceFlowOptions = {}
): Record<string, unknown> {
  const current = deriveFlowStage(asset);

  // 業主已通過 → 這一按就補齊最後一個條件，直接可排程
  if (current === 'to_upload') {
    return buildFlowUpdate(asset, 'ready', opts);
  }

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const entry: FlowLogEntry = {
    from: current,
    to: current, // 棒次沒動，只是補上一個事實
    at: nowIso,
    note: '已上傳雲端',
  };
  if (opts.byUid) entry.byUid = opts.byUid;
  if (opts.byName) entry.byName = opts.byName;

  return {
    cloudUploadedAt: asset.cloudUploadedAt ?? nowIso,
    flowLog: [...(asset.flowLog ?? []), entry].slice(-FLOW_LOG_LIMIT),
  };
}

/**
 * 剪輯師取消「已上傳雲端」（按錯了、或上傳到一半發現檔案不對）。
 *
 * 跟 buildCloudUploadUpdate 對稱的反向動作。之所以非有不可：cloudUploadedAt 一旦寫下去，
 * 依 firestore.rules 那支素材就**永遠刪不掉**（allow delete 要求它為空），連工程師都不行。
 * 沒有這條反向路徑，剪輯師按錯一次就得來找我們處理。
 *
 * ⚠️ 呼叫端必須自己先擋掉「已納入請款單」的片（editorInvoiceId 有值）——
 * 那是帳務凍結，不是流程問題。
 */
export function buildCloudUploadUndoUpdate(
  asset: Pick<Asset, 'stage' | 'approved' | 'flowStage' | 'revisionCount' | 'flowLog' | 'cloudUploadedAt'>,
  opts: AdvanceFlowOptions = {}
): Record<string, unknown> {
  const current = deriveFlowStage(asset);
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  // ready 的定義是「業主過了 **且** 已上傳」，少一個條件就不該再留在 ready，
  // 否則它會繼續待在可排程庫存裡，小編排下去才發現雲端根本沒檔案。
  if (current === 'ready') {
    return {
      ...buildFlowUpdate(asset, 'to_upload', { ...opts, note: '取消上傳雲端' }),
      cloudUploadedAt: '',
    };
  }

  // 還沒到 ready（業主還在審）：棒次本來就沒因為上傳而動過，這裡也只要把事實抹掉
  const entry: FlowLogEntry = {
    from: current,
    to: current,
    at: nowIso,
    note: '取消上傳雲端',
  };
  if (opts.byUid) entry.byUid = opts.byUid;
  if (opts.byName) entry.byName = opts.byName;

  return {
    cloudUploadedAt: '',
    flowLog: [...(asset.flowLog ?? []), entry].slice(-FLOW_LOG_LIMIT),
  };
}

/**
 * 撤回誤按的「交片送審／轉為成片」。只適用於尚在 client_review、且還沒有進入
 * 上傳、請款、排程的素材；呼叫端必須先做這三項檢查。
 */
export function buildSubmitUndoUpdate(
  asset: Pick<Asset, 'stage' | 'approved' | 'flowStage' | 'revisionCount' | 'flowLog' | 'cloudUploadedAt'>,
  opts: AdvanceFlowOptions = {}
): Record<string, unknown> {
  return {
    ...buildFlowUpdate(asset, 'to_edit', { ...opts, note: opts.note || '撤回誤按送審' }),
    submittedAt: '',
    submittedBy: '',
  };
}

/**
 * 交棒完成後發即時 LINE 通知。
 *
 * ⚠️ 2026-08-12 起沒有任何地方呼叫這支——老闆回報「LINE 好吵」，即時推播改成
 * 每日 09:30 的彙總（server.ts 的 buildFlowDigestMessage）。函式跟 /api/notify/flow-event
 * 端點都留著，是為了將來要恢復即時通知時不用重寫。
 * 通知失敗絕不能讓交棒本身失敗——狀態已經寫進 Firestore 了，所以這裡只記 log 不擋流程。
 * 內容由伺服器自己讀 Firestore 組出來，這裡只送 assetId + 事件種類。
 */
export async function notifyFlowEvent(assetId: string, kind: 'submitted' | 'uploaded'): Promise<void> {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const idToken = await user.getIdToken();
    await fetch('/api/notify/flow-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, assetId, kind }),
    });
  } catch (e) {
    console.warn('flow event notify failed (狀態已更新，僅通知未送出)', e);
  }
}

/** 卡在目前這一棒幾天。沒有 flowSince 的舊資料退回用 submittedAt / createdAt 估。 */
export function getFlowDaysStuck(
  asset: Pick<Asset, 'flowSince' | 'submittedAt' | 'createdAt'>,
  now: Date = new Date()
): number {
  const ref = asset.flowSince || asset.submittedAt || asset.createdAt;
  if (!ref) return 0;
  const parsed = new Date(ref);
  if (Number.isNaN(parsed.getTime())) return 0;
  return Math.max(0, differenceInCalendarDays(now, parsed));
}

/** 這一棒是不是卡太久了（看板轉紅、LINE 催件的判斷依據） */
export function isFlowStale(
  asset: Pick<Asset, 'stage' | 'approved' | 'flowStage' | 'flowSince' | 'submittedAt' | 'createdAt'>,
  now: Date = new Date()
): boolean {
  const stage = deriveFlowStage(asset);
  return getFlowDaysStuck(asset, now) >= FLOW_STALE_DAYS[stage];
}

export interface FlowDueInfo {
  scheduledAt: string;
  daysUntil: number;
  /** 發布日已到/已過，但這支還沒走到可排程 */
  overdue: boolean;
  /** 三天內就要上了 */
  imminent: boolean;
}

/**
 * 這支素材掛在哪張貼文上、那張貼文哪天要發。
 * 這是「快到發布日卻還沒片」能提早發現的依據——
 * 過去要等小編排程時才會發現，那時候已經來不及了。
 */
export function getFlowDueInfo(
  asset: Pick<Asset, 'id' | 'usedInPostId' | 'stage' | 'approved' | 'flowStage'>,
  posts: Pick<Post, 'id' | 'scheduledAt' | 'status'>[],
  now: Date = new Date()
): FlowDueInfo | null {
  if (!asset.usedInPostId) return null;
  const post = posts.find(p => p.id === asset.usedInPostId);
  if (!post?.scheduledAt) return null;
  const due = new Date(post.scheduledAt);
  if (Number.isNaN(due.getTime())) return null;

  const daysUntil = differenceInCalendarDays(due, now);
  const settled = deriveFlowStage(asset) === 'ready';
  return {
    scheduledAt: post.scheduledAt,
    daysUntil,
    overdue: !settled && daysUntil < 0,
    imminent: !settled && daysUntil >= 0 && daysUntil <= 3,
  };
}

/**
 * 看板欄內排序：急件 → 逾期/即將到期 → 卡最久 → 發布日最近。
 * 不再用全域 manualPriorityRank 決定順序（拖一筆會覆寫整份清單、且永不清除，
 * 反而讓新進的急件永遠排在舊清單後面）。
 */
export function sortFlowColumn(
  assets: Asset[],
  posts: Pick<Post, 'id' | 'scheduledAt' | 'status'>[],
  now: Date = new Date()
): Asset[] {
  const weight = (a: Asset): number => {
    const due = getFlowDueInfo(a, posts, now);
    let w = 0;
    if (a.isUrgent) w += 10000;
    if (due?.overdue) w += 5000;
    else if (due?.imminent) w += 2000;
    if (isFlowStale(a, now)) w += 1000;
    return w + Math.min(getFlowDaysStuck(a, now), 90);
  };
  return [...assets].sort((x, y) => weight(y) - weight(x));
}
