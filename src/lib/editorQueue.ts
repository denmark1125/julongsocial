import { differenceInCalendarDays, format, parseISO, startOfDay, subDays } from 'date-fns';
import { Asset } from '../types';
import { DemandItem, postDemandId } from './materialSupply';
import { compareRawEditOrder } from './editOrder';

/**
 * 交片期限＝上片日往前推這麼多個日曆天：7 天剪輯＋2 天業主審稿／修改／上傳雲端。含週末。
 *
 * ⚠️ 2026-10-20 主管定案，取代原本的「往前推 7 個工作天」。
 *    同時拿掉「沒上片日的毛片＝拍回來＋7 天」：每支片都被塞一個很近的期限，
 *    剪輯師畫面變成「全部都要剪」。現在只有排了上片日（同事拖進行事曆，或系統遞補空格）的片才有期限。
 */
export const EDIT_LEAD_DAYS = 9;

/**
 * 毛片「拍回來」的那天＝拍攝日與建檔日取較晚的。「還沒排上片日」區照這天排、印「拍回來 N 天」。
 *
 * ⚠️ 不能只看拍攝日：2026-10-06 實測極酵一支 07/31 拍、10/02 才進系統，
 *    期限被算成 08/07，整份清單第一列就是一支剪輯師兩個月前根本拿不到的片。
 */
export function shootBaseDate(asset: Pick<Asset, 'filmingDate' | 'createdAt'>): Date | null {
  const dates = [asset.filmingDate, asset.createdAt]
    .map(v => (v ? parseISO(v) : null))
    .filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  if (!dates.length) return null;
  return startOfDay(new Date(Math.max(...dates.map(d => d.getTime()))));
}

/** 上片日往前推 EDIT_LEAD_DAYS 天＝交片期限 */
export function deliveryDeadline(airDate: Date): Date {
  return subDays(startOfDay(airDate), EDIT_LEAD_DAYS);
}

/** 同事排的上片日（YYYY-MM-DD）。格式不對就當沒排 */
export function plannedAirDay(asset: Pick<Asset, 'plannedAirDate'> | undefined): Date | null {
  if (!asset?.plannedAirDate) return null;
  const d = parseISO(asset.plannedAirDate);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
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
  /** 交片期限：同事指定的交片日，沒有就是上片日往前推 EDIT_LEAD_DAYS 天。急件沒配到日子時為 null */
  deadline: Date | null;
  /**
   * 期限從哪來：'custom'＝同事指定交片日，'air'＝同事排的上片日推算，
   * 'auto'＝那天沒人排片，系統拿這個 IP 剪輯順序最前的毛片遞補，由那天推算
   */
  deadlineSource?: 'custom' | 'air' | 'auto';
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
  /**
   * 還沒排上片日：同事沒排、也沒被遞補到空格，又不是急件或指定交片日。沒有期限。
   * 拍回來最久的排前面。不要藏掉，只是不進主清單。
   */
  unassigned: Asset[];
}

/**
 * 毛片之間的順序＝配上片日的順序：急件最前，再來是同事排的剪輯順序，沒排過的照上片時的順序。
 * 規則只寫在 lib/editOrder.ts，materialSupply 的待剪池也用同一支，兩邊不要分岔。
 *
 * ⚠️ 不要用 editDueDate 決定「哪支毛片配哪一天」：指定 10/30 交片的片會插隊搶走 10/06 那格，
 *    沒指定的片反而被推到後面。交片日只影響這一列的期限，以及主清單照期限的排序。
 */
const rawOrder = compareRawEditOrder;

/** 這一列的期限：素材有指定交片日就用它，否則由上片日推算；沒有上片日就沒有期限 */
function rowDeadline(
  asset: Asset | undefined, airDate: Date | null, source: 'air' | 'auto'
): Pick<EditorQueueRow, 'deadline' | 'deadlineSource'> {
  const custom = customDeadline(asset);
  if (custom) return { deadline: custom, deadlineSource: 'custom' };
  if (airDate) return { deadline: deliveryDeadline(airDate), deadlineSource: source };
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

    const open = mine.filter(d => !d.attachedAssetId);

    const raws = pendingAssets.filter(a => a.vendorId === vendorId).sort(rawOrder);
    const delivered = deliveredAssets.filter(a => a.vendorId === vendorId).sort(deliveredOrder);

    // 1. 已經排好的毛片先佔格：
    //    a. 綁了小編貼文（plannedPostId）→ 日子以那篇貼文為準，小編改日期這裡自動跟著變。
    //       那篇已經掛了別支片 → 當作沒綁（片退回下面的遞補／未排）。
    //    b. 沒綁，但同事排了上片日（plannedAirDate）→ 照他排的日子；那天剛好有格子就佔掉。
    //       綁定的貼文不在視窗內（太遠，或剛被刪、還沒被 useBoundPostSync 清掉）也退回這條，用快照。
    //    ⚠️ 已經過了的日子也照樣顯示（期限會是「已超過」）—— 那是同事該改日期的訊號，不要自動清掉。
    //    ⚠️ 那天不在這個 IP 的發片日上（同事拖到別天）也照樣成列，只是不對應任何格子。
    const claimed = new Set<string>();
    const free: Asset[] = [];
    // 綁了貼文的先處理：不然只排了日子的片會先用日期把那篇貼文的格子佔走
    const boundFirst = [...raws].sort((x, y) => Number(!x.plannedPostId) - Number(!y.plannedPostId));
    boundFirst.forEach(raw => {
      const post = raw.plannedPostId ? mine.find(d => d.id === postDemandId(raw.plannedPostId!)) : undefined;
      if (post && post.attachedAssetId && post.attachedAssetId !== raw.id) { free.push(raw); return; }
      if (post && !claimed.has(post.id)) {
        claimed.add(post.id);
        const air = startOfDay(post.date);
        rows.push({
          key: post.id, date: air, ...rowDeadline(raw, air, 'air'), vendorId,
          kind: 'to_edit', asset: raw, urgent: Boolean(raw.isUrgent),
        });
        return;
      }
      const air = plannedAirDay(raw);
      if (!air) { free.push(raw); return; }
      const slot = open.find(d => !claimed.has(d.id) && startOfDay(d.date).getTime() === air.getTime());
      if (slot) claimed.add(slot.id);
      rows.push({
        key: slot ? slot.id : `planned_${raw.id}`, date: air, ...rowDeadline(raw, air, 'air'), vendorId,
        kind: 'to_edit', asset: raw, urgent: Boolean(raw.isUrgent),
      });
    });

    free.sort(rawOrder); // 上面先處理綁定的片打亂了順序，遞補要照剪輯順序

    // 2. 剩下沒人排的發片日由近到遠遞補：先給成片，再給沒排日子的毛片（剪輯順序第 1 支先），都沒有就是沒片。
    //    老闆 2026-10-20：「這週六縈寶要上片但是沒排片，會優先放上片排序一的片」。
    const empty = open.filter(d => !claimed.has(d.id));
    empty.forEach((slot, i) => {
      const stock = delivered[i];
      if (stock) {
        stocked.push({
          key: slot.id, date: slot.date, deadline: null, vendorId,
          kind: 'has_stock', asset: stock, urgent: false,
        });
        return;
      }
      const raw = free[i - delivered.length];
      if (raw) {
        rows.push({
          key: slot.id, date: slot.date, ...rowDeadline(raw, slot.date, 'auto'), vendorId,
          kind: 'to_edit', asset: raw, urgent: Boolean(raw.isUrgent),
        });
      } else {
        rows.push({
          key: slot.id, date: slot.date, ...rowDeadline(undefined, slot.date, 'auto'), vendorId,
          kind: 'no_material', urgent: false,
        });
      }
    });

    // 沒排日子的毛片比「扣掉成片之後剩下的空格」還多 → 多出來的收進「還沒排上片日」。
    // ⚠️ 成片比空格多時 empty.length - delivered.length 會變負數，必須夾在 0 以上，
    //    否則 slice(負數) 會從尾端取，整批毛片被當成沒排到。
    free.slice(Math.max(0, empty.length - delivered.length)).forEach(a => unassigned.push(a));
  }

  // 沒排上片日，但急件或同事指定了交片日：一樣要進主清單。標了卻看不到，等於這個標記沒有用。
  for (let i = unassigned.length - 1; i >= 0; i--) {
    const a = unassigned[i];
    if (!a.isUrgent && !customDeadline(a)) continue;
    unassigned.splice(i, 1);
    rows.push({
      key: `${a.isUrgent ? 'urgent' : 'due'}_${a.id}`, date: null, ...rowDeadline(a, null, 'auto'), vendorId: a.vendorId,
      kind: 'to_edit', asset: a, urgent: Boolean(a.isUrgent),
    });
  }
  // 還沒排上片日：拍回來最久的排前面
  unassigned.sort((x, y) => (shootBaseDate(x)?.getTime() ?? 0) - (shootBaseDate(y)?.getTime() ?? 0));

  /**
   * 急件最前，其餘照日期由近到遠。
   *
   * ⚠️ 2026-10-06 改：「沒片」排在有片可剪的列後面，彼此照上片日排。
   *    原因：沒片那一列畫面上顯示的是上片日（見 QueueRow），卻照看不到的交片期限排序，
   *    10/16 的康青龍跑到 10/08 的片前面，老闆：「照理來說不是應該往下排？」
   *    （10/02 老闆曾說沒片不要沉底 —— 這次是老闆本人看過新畫面後改的決定。仍在主清單、不收合。）
   */
  const byDate = (x: EditorQueueRow, y: EditorQueueRow) =>
    (x.date?.getTime() || 0) - (y.date?.getTime() || 0);
  stocked.sort(byDate);
  settled.sort(byDate);

  // 主清單照「交片期限」排，不照上片日排：同事指定的交片日可能比推算的早或晚。
  // 急件之間也照期限排；急件沒有期限的排在急件最前面（「現在就要」）。
  rows.sort((x, y) => {
    if (x.urgent !== y.urgent) return x.urgent ? -1 : 1;
    // 沒片的排在有片可剪的後面，彼此照畫面上顯示的上片日排
    if ((x.kind === 'no_material') !== (y.kind === 'no_material')) return x.kind === 'no_material' ? 1 : -1;
    if (x.kind === 'no_material') return byDate(x, y);
    if (!x.deadline || !y.deadline) {
      if (!x.deadline && !y.deadline) return 0;
      return !x.deadline ? -1 : 1;
    }
    if (x.deadline.getTime() !== y.deadline.getTime()) return x.deadline.getTime() - y.deadline.getTime();
    // 同一天好幾個 IP：有片可剪的排前面，剪輯師先看到能動手的
    if ((x.kind === 'to_edit') !== (y.kind === 'to_edit')) return x.kind === 'to_edit' ? -1 : 1;
    return 0;
  });

  // 同一個 IP 的待剪列，畫面上的先後一律照同事排的剪輯順序（剪輯師卡片上的「順序 N」）。
  // 上面照期限排完之後，同一家的片可能倒過來：急件之間照期限、同事指定交片日也會插隊，
  // 結果「順序 2」排在「順序 1」上面（2026-10-07 極酵文創兩支急件）。
  // 做法：各 IP 保留它原本佔的那幾個位置，只在那幾個位置之間照順序重新放 ——
  // 跨 IP 的交錯不變，急件也仍在最上面（急件在順序裡本來就排最前，佔的也正好是最上面那幾格）。
  // ⚠️ 同事親手排了上片日的列（'air'）不參與：日子是人定的，換位置會讓期限跟那支片對不上。
  const slotsByVendor = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (r.kind === 'to_edit' && r.asset && r.deadlineSource !== 'air') slotsByVendor.set(r.vendorId, [...(slotsByVendor.get(r.vendorId) || []), i]);
  });
  const reordered = [...rows];
  slotsByVendor.forEach(slots => {
    const ordered = slots.map(i => rows[i]).sort((x, y) => rawOrder(x.asset!, y.asset!));
    slots.forEach((slot, k) => { reordered[slot] = ordered[k]; });
  });

  return { rows: reordered, stocked, settled, unassigned };
}
