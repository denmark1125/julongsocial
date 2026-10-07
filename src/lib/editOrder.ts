import { Asset } from '../types';

type OrderFields = Pick<Asset, 'id' | 'isUrgent' | 'createdAt' | 'batchIndex' | 'editOrder'>;

/**
 * 同一批建檔的片之間：照上片／歸片時同事排的順序。
 *
 * 一批片共用同一個 createdAt（server 用同一個 now 建檔），沒有這一層的話，同一批誰先剪等於隨機。
 * 最後用 id 收尾，讓同一份資料每次重整都排出同一個順序。
 */
export function compareUploadOrder(a: OrderFields, b: OrderFields): number {
  return (a.createdAt || '').localeCompare(b.createdAt || '')
    || (a.batchIndex ?? 0) - (b.batchIndex ?? 0)
    || (a.id || '').localeCompare(b.id || '');
}

/**
 * 待剪毛片的剪輯順序（＝配上片日的順序：第 1 支配這個 IP 最近的上片日）。
 *
 * 1. 急件永遠最前
 * 2. 同事在「排剪輯順序」調過的（editOrder）照數字排，排在沒調過的前面
 * 3. 其餘照上片時的順序（老闆：「同事後來會排序，如果沒排序就依照上片時的順序」）
 *
 * ⚠️ 只能用在**待剪**的片。editOrder 在片交出去之後還留在文件上，
 *    拿去排成片庫存會改變小編排片建議用哪一支成片（理由同 materialSupply 的 queueOrder）。
 */
export function compareRawEditOrder(a: OrderFields, b: OrderFields): number {
  if (!!a.isUrgent !== !!b.isUrgent) return a.isUrgent ? -1 : 1;
  const ao = a.editOrder, bo = b.editOrder;
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if ((ao != null) !== (bo != null)) return ao != null ? -1 : 1;
  return compareUploadOrder(a, b);
}

/** 把第 index 項往前（-1）或往後（+1）移一格；超出範圍就原樣回傳 */
export function moveInList<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
