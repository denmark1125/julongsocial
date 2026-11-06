/**
 * 排上片日「插隊」（2026-11-06 使用者）：
 * 11/1 A、11/2 B、11/3 C，臨時要把 D 插在 11/2 → D 排 11/2，B 連同它的貼文往後到下一個發片日，
 * 那天原本的 C 再往後……一路推到有空位為止。以前要把 B、C 一支一支解鎖丟回去重排。
 *
 * 只算「誰搬到哪天」，不碰資料庫；畫面確認後再一次寫入（AirDateBoard.insertAt）。
 *
 * 規則：
 *  - 片跟它綁的貼文一起搬（文案跟著片走，不會配錯）
 *  - 小編已經在後台排好／已發布的貼文（movable=false）不動，那天直接跳過，往下一個發片日找
 *  - 有小編貼文在等片、但還沒綁片的日子也跳過（不要把兩篇擠在同一天）
 *  - 找不到下一個發片日（沒設固定發片日的 IP）：往後一週同一天
 */

export interface InsertItem {
  id: string;
  /** 目前排在哪天 yyyy-MM-dd */
  day: string;
  /** false＝貼文已經在後台排好或發了，不能搬 */
  movable: boolean;
}

export interface InsertMove { id: string; from: string; to: string }

export type InsertPlan =
  | { ok: true; moves: InsertMove[] }
  | { ok: false; reason: string };

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param day       要插在哪天
 * @param items     這個 IP 已經排了日子的片（不含要插進來的那支）
 * @param slotDays  這個 IP 的發片日（固定發片日＋挪過的＋手動加的），yyyy-MM-dd
 * @param blockedDays 不能搬進去的日子（有小編貼文在等片但沒綁片）
 */
export function planInsert(day: string, items: InsertItem[], slotDays: string[], blockedDays: Set<string> = new Set()): InsertPlan {
  const byDay = new Map<string, InsertItem[]>();
  for (const it of items) byDay.set(it.day, [...(byDay.get(it.day) || []), it]);

  const onDay = byDay.get(day) || [];
  if (onDay.some(it => !it.movable)) return { ok: false, reason: '這天的貼文已經在後台排好或發布了，不能插在這天' };

  // 候選日子：發片日＋已經有排片的日子，排序去重
  const candidates = [...new Set([...slotDays, ...items.map(i => i.day)])].filter(d => d > day).sort();
  const isFree = (d: string) => !blockedDays.has(d) && !(byDay.get(d) || []).some(it => !it.movable);

  const moves: InsertMove[] = [];
  let carry = onDay;
  let cur = day;
  // 保險：最多推 60 步，不可能真的推這麼多
  for (let guard = 0; carry.length && guard < 60; guard++) {
    const next = candidates.find(d => d > cur && isFree(d)) ?? addDays(cur, 7);
    for (const it of carry) moves.push({ id: it.id, from: it.day, to: next });
    carry = (byDay.get(next) || []).filter(it => it.movable);
    cur = next;
  }
  return { ok: true, moves };
}
