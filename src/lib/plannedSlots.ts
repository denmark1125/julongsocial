import { addDays, format, getDay, isSameDay, parseISO, startOfDay } from 'date-fns';
import { DismissedHabit, PlannedSlotMove, PostingHabit, Post, Vendor } from '../types';

// 預排時段（社群日曆上的橘色卡）的唯一計算入口。
//
// 「這一天有哪些預排」這個問題原本在兩個地方各算一份：社群日曆自己算一份、
// 貼文管理的「建議發布時間」又算一份。兩份都只讀 vendor.postingHabits，所以
// 把預排拖到別天之後，貼文管理仍然會建議原本那天——同一件事講兩種答案。
// 抽到這裡共用，兩邊看到的預排一定一致。

/** 日曆上實際看得到的一格預排。date 是「現在該出現在哪一天」，fromDate 是它的身分。 */
export interface PlannedSlot {
  vendorId: string;
  vendorName: string;
  habit: PostingHabit;
  time: string;      // HH:mm
  date: Date;        // 含時間，可直接丟進貼文的 scheduledAt
  fromDate: string;  // YYYY-MM-DD 原本該出現的那天（＝這個時段的身分證）
  toDate: string;    // YYYY-MM-DD 目前落在哪一天
  moveId?: string;   // 有值代表它被挪過，再拖一次是改這筆而不是新增
  isMoved: boolean;
}

export interface PlannedSlotOptions {
  /** 已經篩選過的廠商（日曆傳 trackedVendors，貼文表單傳選到的那一家） */
  vendors: Vendor[];
  moves: PlannedSlotMove[];
  dismissed: DismissedHabit[];
  posts: Post[];
  rangeStart: Date;
  rangeEnd: Date;
  /** 只要這種內容形式的時段（貼文表單用；日曆不篩） */
  contentType?: string;
  /**
   * 幾天內已經有該廠商的貼文就算「這個預排已經被滿足」，不再顯示。
   * 日曆沿用 1（前後一天內有發就不用再提醒）；貼文表單沿用 0（只有同一天才算被佔走）。
   * 兩邊本來就不同，刻意保留原行為，不要為了統一而偷改任何一邊的顯示結果。
   */
  fulfilledWindowDays?: number;
}

/** 一個時段被挪去哪。回傳 null 代表沒被挪過。 */
function findMove(moves: PlannedSlotMove[], vendorId: string, habitTime: string, fromDate: string) {
  return moves.find(m => m.vendorId === vendorId && m.habitTime === habitTime && m.fromDate === fromDate) || null;
}

/**
 * ⚠️ 用 fromDate 比對而不是顯示日期：被挪走的預排如果按下 X，記的仍是原本那一天，
 * 這樣舊資料（還沒有搬移功能時寫的 dismissedHabits）也完全對得上，不需要 migration。
 */
function isDismissed(dismissed: DismissedHabit[], vendorId: string, habitTime: string, fromDate: string) {
  return dismissed.some(d => d.vendorId === vendorId && d.habitTime === habitTime && d.date === fromDate);
}

function isFulfilled(posts: Post[], vendorId: string, date: Date, windowDays: number) {
  return posts.some(p => {
    if (p.vendorId !== vendorId || !p.scheduledAt) return false;
    const scheduled = parseISO(p.scheduledAt);
    for (let offset = -windowDays; offset <= windowDays; offset++) {
      if (isSameDay(scheduled, addDays(date, offset))) return true;
    }
    return false;
  });
}

/**
 * 列出區間內看得到的預排。
 *
 * ⚠️ 掃描範圍要比顯示範圍寬：預排可以從上個月底被拖進這個月一號，
 *    只掃顯示區間的話那張卡會整個消失（而且不會有任何錯誤訊息）。
 */
export function listPlannedSlots(opts: PlannedSlotOptions): PlannedSlot[] {
  const {
    vendors, moves, dismissed, posts, rangeStart, rangeEnd,
    contentType, fulfilledWindowDays = 1,
  } = opts;

  const SCAN_PAD_DAYS = 31; // 單次調整不該跨超過一個月；掃描範圍前後各放寬一個月綽綽有餘
  const scanStart = startOfDay(addDays(rangeStart, -SCAN_PAD_DAYS));
  const scanEnd = startOfDay(addDays(rangeEnd, SCAN_PAD_DAYS));
  const visibleStart = startOfDay(rangeStart);
  const visibleEnd = startOfDay(rangeEnd);

  const slots: PlannedSlot[] = [];

  for (let day = scanStart; day <= scanEnd; day = addDays(day, 1)) {
    const dayOfWeek = getDay(day);
    const fromDate = format(day, 'yyyy-MM-dd');

    for (const vendor of vendors) {
      for (const habit of vendor.postingHabits || []) {
        if (!habit.daysOfWeek.includes(dayOfWeek)) continue;
        if (contentType && habit.contentTypes && !habit.contentTypes.includes(contentType)) continue;
        if (isDismissed(dismissed, vendor.id!, habit.time, fromDate)) continue;

        const move = findMove(moves, vendor.id!, habit.time, fromDate);
        const toDate = move?.toDate || fromDate;
        const landedOn = startOfDay(parseISO(toDate));
        if (landedOn < visibleStart || landedOn > visibleEnd) continue;

        const [hours, minutes] = habit.time.split(':').map(Number);
        const date = new Date(landedOn);
        date.setHours(hours || 0, minutes || 0, 0, 0);

        if (isFulfilled(posts, vendor.id!, date, fulfilledWindowDays)) continue;

        slots.push({
          vendorId: vendor.id!,
          vendorName: vendor.name,
          habit,
          time: habit.time,
          date,
          fromDate,
          toDate,
          moveId: move?.id,
          isMoved: !!move,
        });
      }
    }
  }

  return slots.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** 某一天要顯示的預排。日曆每一格呼叫一次，不要每格都重跑 listPlannedSlots。 */
export function groupSlotsByDay(slots: PlannedSlot[]): Map<string, PlannedSlot[]> {
  const map = new Map<string, PlannedSlot[]>();
  for (const slot of slots) {
    const key = slot.toDate;
    const list = map.get(key);
    if (list) list.push(slot);
    else map.set(key, [slot]);
  }
  return map;
}
