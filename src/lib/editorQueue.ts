import { differenceInCalendarDays, format, parseISO, startOfDay, subBusinessDays } from 'date-fns';
import { Asset } from '../types';
import { DemandItem } from './materialSupply';

/**
 * 交片後要留幾個工作天走完「業主審稿 → 修改 → 上傳雲端」。
 *
 * ⚠️ 2026-10-03 老闆：清單原本寫「10/10 要上，剩 7 天」，剪輯師照上片日剪一定來不及，
 *    事後還會說「是你寫 7 天」。所以剪輯師畫面**只顯示交片期限，不顯示上片日**。
 * 工作天＝跳過週六、日。國定假日沒有排除（date-fns 不知道台灣的假日），遇到連假要靠同事指定交片日。
 */
export const EDIT_LEAD_WORKDAYS = 7;

/** 上片日往前推 EDIT_LEAD_WORKDAYS 個工作天＝交片期限 */
export function deliveryDeadline(airDate: Date): Date {
  return subBusinessDays(startOfDay(airDate), EDIT_LEAD_WORKDAYS);
}

export type DeadlineTone = 'calm' | 'soon' | 'late';

/**
 * 交片期限的倒數文字與顏色。倒數用日曆天（「剩 3 天」＝3 天後），比工作天直觀。
 *
 * 「盡快」：毛片建檔時期限就已經過了（例如 10/06 要上、10/02 才進毛片）。
 * 這時寫「已超過 N 天」對剪輯師不公平——不是他拖，是料晚到。
 */
export function deadlineStatus(
  deadline: Date,
  createdAt: string | undefined,
  now: Date = new Date()
): { text: string; tone: DeadlineTone } {
  const left = differenceInCalendarDays(deadline, now);
  if (left < 0) {
    const created = createdAt ? parseISO(createdAt) : null;
    if (created && !Number.isNaN(created.getTime()) && differenceInCalendarDays(deadline, created) < 0) {
      return { text: '盡快', tone: 'soon' };
    }
    return { text: `已超過 ${Math.abs(left)} 天`, tone: 'late' };
  }
  if (left === 0) return { text: '今天', tone: 'soon' };
  return { text: `剩 ${left} 天`, tone: left <= 3 ? 'soon' : 'calm' };
}

/** 「10/01（四）前交片」 */
export function formatDeadline(deadline: Date): string {
  return `${format(deadline, 'MM/dd')}（${'日一二三四五六'[deadline.getDay()]}）前交片`;
}

/** 同事指定的交片日（YYYY-MM-DD）。格式不對就當沒填，不要讓一筆壞資料把整份清單弄壞 */
export function customDeadline(asset: Pick<Asset, 'editDueDate'> | undefined): Date | null {
  if (!asset?.editDueDate) return null;
  const d = parseISO(asset.editDueDate);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
}

/**
 * 剪輯師那條「現在該剪哪一支」的清單。
 *
 * ⚠️ **刻意不吃 `buildSupplyPlan()`。** 那支的配對優先序是
 * 「成片庫存 → 已交片 → 待剪毛片 → 預約拍攝」，回答的是**小編**的問題
 * （「這一格有東西可以發嗎？」）。只要有成片庫存，那一格就被判成「不用動手」。
 *
 * 2026-10-01 連錯三版都是這個原因：10/3 祥濱有成片庫存，所以那一列整個消失，
 * 但祥濱手上明明有毛片等著剪。老闆原話：「像祥濱庫存有片，就優先顯示毛片排名最前面的」。
 *
 * **剪輯師不管有沒有成片庫存，那是小編的事。** 他只管一件事：
 * 我手上的毛片，照什麼順序剪，各自對應哪一天要上。
 *
 * ⚠️ **2026-10-02 補一條，不要跟上面那條搞混：**
 * 「不准用成片把有毛片的那一列刪掉」≠「成片完全不看」。
 * 沒配到毛片的那一列，要先看看是不是**已經有交出去的成片在等排程**，
 * 有的話那天不是「沒片」，是「不缺片，缺排程」—— 而排程是小編的事，不是他的。
 *
 * 老闆原話：「因為目前成片區已經有兩個，照理來說我會安排排程，但問題是我還沒安排」。
 * 實測：自然風 1 支待剪 ＋ 2 支已交片，10/06 被寫成「沒片」，但那天根本不缺片。
 *
 * **成片只用來「標示」那一天已經有著落，絕不用來把列刪掉。** 前四版的錯都是拿它來刪。
 */
export type EditorQueueKind =
  /** 這天要上，而且有毛片可以剪 */
  | 'to_edit'
  /** 這天要上，而且已經有交出去的成片可以補 —— 等小編排程，剪輯師不用動手 */
  | 'has_stock'
  /** 這天的貼文已經掛好素材了 —— 完全結案，列出來只為了能跟社群日曆對帳 */
  | 'settled'
  /** 這天要上，這個 IP 既沒成片也沒毛片 */
  | 'no_material';

export interface EditorQueueRow {
  key: string;
  /** 要上片的那一天。急件但沒配到任何一天時為 null。⚠️ 剪輯師畫面不顯示它，只顯示 deadline */
  date: Date | null;
  /** 交片期限：同事指定的交片日，沒有就是上片日往前推 7 個工作天。急件沒配到日子時為 null */
  deadline: Date | null;
  /** 期限從哪來：'custom'＝同事指定，'air'＝由上片日推算 */
  deadlineSource?: 'custom' | 'air';
  vendorId: string;
  kind: EditorQueueKind;
  asset?: Asset;
  urgent: boolean;
}

export interface EditorQueue {
  /**
   * 主清單：`to_edit` ＋ `no_material`。
   * ⚠️ **刻意不含 `has_stock`。** 全部 IP 一起算有 15 列已交片，攤平會把
   *    「第一件要動手的事」擠到第 9 列（實測）。老闆決定收進折疊區。
   */
  rows: EditorQueueRow[];
  /** 已經有成片在等排程的那些天。UI 收在折疊區，只列日期＋IP。 */
  stocked: EditorQueueRow[];
  /**
   * 貼文已經掛好素材、整件事結案的那些天。
   *
   * ⚠️ 剪輯師**不需要**這份 —— 加它純粹是為了**對帳**。
   * 2026-10-02 老闆：「我應該 10/3 有排程，但為什麼都對不上…我就是很不放心」。
   * 之前這些天被整個藏起來，於是社群日曆上有 5 筆、清單只看得到 2 筆，
   * 看起來就像系統漏算。三袋加起來要等於日曆上那一天的筆數，才對得起來。
   */
  settled: EditorQueueRow[];
  /** 毛片比上片日多出來的那些。不要藏掉，只是排在後面 */
  unassigned: Asset[];
}

/**
 * 毛片之間的順序：急件最前，其餘照建檔時間由舊到新。
 *
 * 老闆：「同事後來會排序，如果沒排序就依照上片時的順序」——
 * 同事手動排序的欄位**先不做**，等他真的要排再加。
 * 規則跟 materialSupply 的 queueOrder 一致，兩邊不要分岔。
 */
function rawOrder(a: Asset, b: Asset): number {
  if (!!a.isUrgent !== !!b.isUrgent) return a.isUrgent ? -1 : 1;
  // ⚠️ 不要用 editDueDate 決定「哪支毛片配哪一天」：指定 10/30 交片的片會插隊搶走 10/06 那格，
  //    沒指定的片反而被推到後面。交片日只影響這一列的期限，以及主清單照期限的排序。
  return (a.createdAt || '').localeCompare(b.createdAt || '');
}

/** 這一列的期限：素材有指定交片日就用它，否則由上片日推算 */
function rowDeadline(asset: Asset | undefined, airDate: Date | null): Pick<EditorQueueRow, 'deadline' | 'deadlineSource'> {
  const custom = customDeadline(asset);
  if (custom) return { deadline: custom, deadlineSource: 'custom' };
  if (airDate) return { deadline: deliveryDeadline(airDate), deadlineSource: 'air' };
  return { deadline: null };
}

/**
 * 已交片之間的順序：先交的先補最近的日子。
 * `submittedAt` 是交片時間；沒有的（舊資料）退回建檔時間，不要讓它排到最前面亂插隊。
 */
function deliveredOrder(a: Asset, b: Asset): number {
  return (a.submittedAt || a.createdAt || '').localeCompare(b.submittedAt || b.createdAt || '');
}

export function buildEditorQueue(opts: {
  /** 未來的格子（貼文＋日曆橘色預排），由 buildHorizonDemands() 產生 */
  demands: DemandItem[];
  /** 這位剪輯師手上的待剪毛片 */
  pendingAssets: Asset[];
  /**
   * 已經剪好交出去、但還沒被排進任何貼文的片（送審中／待傳雲端／已傳的成片庫存）。
   *
   * ⚠️ 它們**補掉最近的上片日**，毛片往後排 —— 成片現在就能上，毛片還要剪。
   *    老闆 2026-10-02 拍板：「成片佔最近的，毛片往後排」。
   * ⚠️ 補掉的那一天**不是刪掉**，是標成 `has_stock` 放進 `stocked`。
   */
  deliveredAssets?: Asset[];
}): EditorQueue {
  const { demands, pendingAssets, deliveredAssets = [] } = opts;

  const rows: EditorQueueRow[] = [];
  const stocked: EditorQueueRow[] = [];
  const settled: EditorQueueRow[] = [];
  const unassigned: Asset[] = [];

  const vendorIds = Array.from(new Set<string>([
    ...demands.map(d => d.vendorId),
    ...pendingAssets.map(a => a.vendorId),
  ]));

  for (const vendorId of vendorIds) {
    // 這個 IP 接下來要上片的日子。
    // ⚠️ 已經掛好素材的貼文不算 —— 那一格有片了，不需要誰再剪一支。
    //    （這也是 deliveredAssets 不會重複計算的原因：掛上貼文的片，那一格早就不在這裡了。）
    // ⚠️ 圖文不算，剪輯師不做圖文。
    const mine = demands
      .filter(d => d.vendorId === vendorId && d.contentType === 'video')
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    // 已經掛好素材的那幾天：不進配對，但要留著讓人跟日曆對帳。
    mine.filter(d => d.attachedAssetId).forEach(d => settled.push({
      key: d.id, date: d.date, deadline: null, vendorId, kind: 'settled', urgent: false,
    }));

    const dates = mine.filter(d => !d.attachedAssetId);

    const raws = pendingAssets.filter(a => a.vendorId === vendorId).sort(rawOrder);
    const delivered = deliveredAssets.filter(a => a.vendorId === vendorId).sort(deliveredOrder);

    // 日期由近到遠依序發配：先給成片，再給毛片，都沒有就是沒片。
    dates.forEach((slot, i) => {
      const stock = delivered[i];
      if (stock) {
        stocked.push({
          key: slot.id, date: slot.date, deadline: null, vendorId,
          kind: 'has_stock', asset: stock, urgent: false,
        });
        return;
      }
      const raw = raws[i - delivered.length];
      if (raw) {
        rows.push({
          key: slot.id, date: slot.date, ...rowDeadline(raw, slot.date), vendorId,
          kind: 'to_edit', asset: raw, urgent: Boolean(raw.isUrgent),
        });
      } else {
        rows.push({
          key: slot.id, date: slot.date, ...rowDeadline(undefined, slot.date), vendorId,
          kind: 'no_material', urgent: false,
        });
      }
    });

    // 毛片比「扣掉成片之後剩下的日子」還多 → 多出來的收進折疊區。
    // ⚠️ 成片比日子多時 dates.length - delivered.length 會變負數，必須夾在 0 以上，
    //    否則 slice(負數) 會從尾端取，整批毛片被當成沒排到。
    raws.slice(Math.max(0, dates.length - delivered.length)).forEach(a => unassigned.push(a));
  }

  // 急件、或同事指定了交片日，但沒配到任何一天：一樣要進主清單。
  // 標了急件／指定了日子卻看不到，等於這個標記沒有用。
  for (let i = unassigned.length - 1; i >= 0; i--) {
    const a = unassigned[i];
    if (!a.isUrgent && !customDeadline(a)) continue;
    unassigned.splice(i, 1);
    rows.push({
      key: `${a.isUrgent ? 'urgent' : 'due'}_${a.id}`, date: null, ...rowDeadline(a, null), vendorId: a.vendorId,
      kind: 'to_edit', asset: a, urgent: Boolean(a.isUrgent),
    });
  }

  /**
   * 急件最前，其餘照日期由近到遠。
   *
   * ⚠️ **「沒片」不要沉到最後。** 試過一次，老闆的回應是「10/3 縈寶還沒片剪你也沒有上去，
   *    你原本還比較對」——那一格就算現在動不了，它仍然是最近的截止日，
   *    看得到才知道要去催料。清單照日子走，不照「能不能動手」走。
   */
  const byDate = (x: EditorQueueRow, y: EditorQueueRow) =>
    (x.date?.getTime() || 0) - (y.date?.getTime() || 0);
  stocked.sort(byDate);
  settled.sort(byDate);

  // 主清單照「交片期限」排，不照上片日排：同事指定的交片日可能比推算的早或晚。
  // 急件之間也照期限排；急件沒有期限的排在急件最前面（「現在就要」）。
  rows.sort((x, y) => {
    if (x.urgent !== y.urgent) return x.urgent ? -1 : 1;
    if (!x.deadline || !y.deadline) {
      if (!x.deadline && !y.deadline) return 0;
      return !x.deadline ? -1 : 1;
    }
    if (x.deadline.getTime() !== y.deadline.getTime()) return x.deadline.getTime() - y.deadline.getTime();
    // 同一天好幾個 IP：有片可剪的排前面，剪輯師先看到能動手的
    if ((x.kind === 'to_edit') !== (y.kind === 'to_edit')) return x.kind === 'to_edit' ? -1 : 1;
    return 0;
  });

  return { rows, stocked, settled, unassigned };
}
