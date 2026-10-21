import { addDays } from 'date-fns';
import { Asset, DismissedHabit, ExtraSlot, PlannedSlotMove, Post, Vendor, deriveFlowStage } from '../types';
import { isClosedOutsideSystem } from './assetFlow';
import { buildEditorQueue, EditorQueue } from './editorQueue';
import { buildHorizonDemands, DemandItem, SUPPLY_HORIZON_DAYS } from './materialSupply';
import { listPlannedSlots } from './plannedSlots';
import { buildPostIndex, isAssetSelectable, slotVendors, stockVisibleVendors } from './vendorStatus';

/**
 * 全公司（所有 IP）的剪輯排程，內部畫面共用：排上片日拖拉板、製作進度的「需要處理」。
 * 跟剪輯師畫面同一套配對（buildEditorQueue），同一個視窗（SUPPLY_HORIZON_DAYS），
 * 兩邊才會遞補到同一支、算出同一個交片期限。
 */

/** 還在等人剪的片 */
export const isPendingEdit = (a: Asset) =>
  a.type === 'video' && !a.voidedAt && a.status !== 'archived' && !isClosedOutsideSystem(a) &&
  (deriveFlowStage(a) === 'to_edit' || deriveFlowStage(a) === 'revising');

export interface CompanyQueue {
  /** 看得到的 IP（含冷凍中，冷凍凍的是發片不是剪片） */
  visible: Vendor[];
  pending: Asset[];
  /** 剪好交出去、還沒掛上貼文的片 */
  delivered: Asset[];
  demands: DemandItem[];
  queue: EditorQueue;
}

export function buildCompanyQueue(opts: {
  vendors: Vendor[];
  assets: Asset[];
  posts: Post[];
  moves: PlannedSlotMove[];
  dismissed: DismissedHabit[];
  extras: ExtraSlot[];
  now?: Date;
}): CompanyQueue {
  const { vendors, assets, posts, moves, dismissed, extras, now = new Date() } = opts;
  const visible = stockVisibleVendors(vendors);
  const visibleIds = new Set(visible.map(v => v.id));
  const pending = assets.filter(a => isPendingEdit(a) && visibleIds.has(a.vendorId));
  const postIndex = buildPostIndex(posts);
  /*
   * 剪好交出去、還沒掛上貼文的片（它們先補最近的空格）。送審中、待上傳、可排程都算。
   * ⚠️ 「還沒掛上」一律走 isAssetSelectable，不要自己寫 !usedInPostId：掛的貼文被刪掉的片
   *    （孤兒）其實還沒用掉。也不要列舉階段漏掉「可排程」—— 10-20 稽核時杜永霖一支可排程的片就這樣消失。
   */
  const delivered = assets.filter(a => {
    if (a.type !== 'video' || a.status === 'archived' || isClosedOutsideSystem(a) || !visibleIds.has(a.vendorId)) return false;
    const stage = deriveFlowStage(a);
    if (stage === 'to_edit' || stage === 'revising') return false;
    return isAssetSelectable(a, postIndex);
  });

  const slots = listPlannedSlots({
    vendors: slotVendors(vendors), moves, dismissed, extras, posts,
    rangeStart: now, rangeEnd: addDays(now, SUPPLY_HORIZON_DAYS), fulfilledWindowDays: 1,
  });
  const demands = buildHorizonDemands({ posts, slots, now }).filter(d => d.contentType === 'video');
  const queue = buildEditorQueue({ demands, pendingAssets: pending, deliveredAssets: delivered });
  return { visible, pending, delivered, demands, queue };
}

/** 每支待剪片的上片日與交片期限（有排到日子的才有） */
export function datesOf(queue: EditorQueue): { airDates: Map<string, Date>; deadlines: Map<string, Date> } {
  const airDates = new Map<string, Date>(), deadlines = new Map<string, Date>();
  queue.rows.forEach(r => {
    if (r.kind !== 'to_edit' || !r.asset) return;
    if (r.date) airDates.set(r.asset.id!, r.date);
    if (r.deadline) deadlines.set(r.asset.id!, r.deadline);
  });
  return { airDates, deadlines };
}

/**
 * 剪輯師看到的版本：**同一份全公司配對**，只是把不是他的待剪片藏起來。
 *
 * ⚠️ 不要拿「只有他的片」重新配一次：那樣同一天內部（排上片日、製作進度）說「待剪：老闆的一天」（內部剪），
 *    剪輯師那邊卻說「沒片」或補上另一支 —— 10-21 盤查時謝謝的畫面有 11 格跟內部對不起來（使用者：內部跟剪輯要一致）。
 * 別人的待剪列：從清單拿掉（不是他的工作），但那一天不是「沒片」，日曆照樣算有安排。
 */
export function editorQueueView(queue: EditorQueue, isMine: (a: Asset) => boolean): EditorQueue & { othersKeys: Set<string> } {
  const othersKeys = new Set<string>();
  const rows = queue.rows.filter(r => {
    if (r.kind !== 'to_edit' || !r.asset || isMine(r.asset)) return true;
    othersKeys.add(r.key);
    return false;
  });
  return { ...queue, rows, unassigned: queue.unassigned.filter(isMine), othersKeys };
}
