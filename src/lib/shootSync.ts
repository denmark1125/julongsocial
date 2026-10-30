import type { CalendarEvent, CalendarEventCategory, ShootBooking } from '../types';

// TimeTree 行程 → shootBookings 的對應規則（純函式，server 的 /api/shoot-sync 照它寫入）。
// Worker 只送「判定為拍攝、而且是系統內 IP」的變動；這裡決定要新建、更新、合併還是不動。

export interface TimetreeShootChange {
  uuid: string;
  action: 'upsert' | 'delete';
  title?: string;
  vendorName?: string; // classify.mjs 的 SYSTEM_IPS key，必須等於 vendors.name
  startAt?: number; // TimeTree 的 start_at（毫秒）
  allDay?: boolean;
  category?: CalendarEventCategory; // 沒有＝舊版 Worker，只送系統內 IP 的拍攝
  inSystem?: boolean;
  updatedAt?: number;
}

/** 系統內 IP 的拍攝進 shootBookings（要追蹤、要通知客戶）；其他只進 calendarEvents 給行事曆看 */
export const isBookingChange = (c: TimetreeShootChange) => (c.category ?? '拍攝') === '拍攝' && c.inSystem !== false && !!c.vendorName;

// TimeTree 標題「-」後面常是拍攝人員（大發超哥拍攝-Kai、康青龍拍攝-Irene/秀姨/彭），有時是地點或內容（縈寶拍攝-晚宴）
const CREW_NAMES = new Set(['kai', 'irene', 'ju', 'david', 'peggy', 'julia', '彭', '彭彭', '儒', '馬', '名', '名育', '秀', '秀姨']);

export function parseTitleSuffix(title: string): { crew?: string; note?: string } {
  const i = title.search(/[-－]/);
  if (i < 0) return {};
  const suffix = title.slice(i + 1).trim();
  if (!suffix) return {};
  const tokens = suffix.split(/[\/、+＋,，\s]+/).filter(Boolean);
  const crew = tokens.filter(t => CREW_NAMES.has(t.toLowerCase()));
  const rest = tokens.filter(t => !CREW_NAMES.has(t.toLowerCase()));
  return {
    ...(crew.length ? { crew: crew.join('、') } : {}),
    ...(rest.length ? { note: rest.join(' ') } : {}),
  };
}

export type ShootSyncPlan =
  | { op: 'create'; data: Omit<ShootBooking, 'id'> }
  | { op: 'update'; id: string; data: Partial<ShootBooking> }
  | { op: 'none'; reason: string };

const BY = 'TimeTree';

/** 整天的行程 TimeTree 存 UTC 午夜；有時間的換成台北時間 */
export function toTaipeiDateTime(startAt: number, allDay: boolean): { date: string; time?: string } {
  const d = new Date(allDay ? startAt : startAt + 8 * 3600_000);
  const date = d.toISOString().slice(0, 10);
  return allDay ? { date } : { date, time: d.toISOString().slice(11, 16) };
}

const fmt = (date: string, time?: string) => `${date.slice(5).replace('-', '/')}${time ? ' ' + time : ''}`;

/**
 * @param bookings 全部 shootBookings（要找同 uuid 的，和同 IP 同天手動約的）
 * @param today 台北日期 YYYY-MM-DD；過去的行程不新建，免得一匯入就整排「逾期未回報」
 */
export function planShootSync(
  change: TimetreeShootChange,
  vendorId: string | null,
  bookings: ShootBooking[],
  today: string,
  nowIso: string,
): ShootSyncPlan {
  const linked = bookings.find(b => b.timetreeUuid === change.uuid);
  const log = (b: ShootBooking | undefined, note: string) => [...(b?.changeLog || []), { at: nowIso, by: BY, note }];

  if (change.action === 'delete') {
    if (!linked) return { op: 'none', reason: '沒有對應的預約' };
    if (linked.status !== 'booked') return { op: 'none', reason: `預約已${linked.status}` };
    return {
      op: 'update', id: linked.id!,
      data: { status: 'cancelled', reason: 'other', resolvedAt: nowIso, changeLog: log(linked, 'TimeTree 刪除了這筆行程') },
    };
  }

  if (!vendorId) return { op: 'none', reason: '不是系統內的 IP' };
  if (change.startAt == null) return { op: 'none', reason: '缺少日期' };
  const { date, time } = toTaipeiDateTime(change.startAt, !!change.allDay);
  const title = change.title || '';

  if (linked) {
    if (linked.status !== 'booked') return { op: 'none', reason: `預約已${linked.status}` };
    const same = linked.scheduledDate === date && (linked.startTime || '') === (time || '')
      && linked.vendorId === vendorId && (linked.title || '') === title;
    if (same) return { op: 'none', reason: '沒有變動' };
    const notes: string[] = [];
    if (linked.scheduledDate !== date || (linked.startTime || '') !== (time || '')) {
      notes.push(`改期 ${fmt(linked.scheduledDate, linked.startTime)} → ${fmt(date, time)}`);
    }
    if (linked.vendorId !== vendorId) notes.push('改了 IP');
    if ((linked.title || '') !== title) notes.push(`標題改成「${title}」`);
    const data: Partial<ShootBooking> = { scheduledDate: date, vendorId, title, changeLog: log(linked, notes.join('、')) };
    if (time) data.startTime = time;
    // 人員／備註是從舊標題帶出來、沒被人手改過，才跟著新標題更新
    const before = parseTitleSuffix(linked.title || '');
    const after = parseTitleSuffix(title);
    if ((linked.crew || undefined) === before.crew && after.crew !== before.crew) data.crew = after.crew || '';
    if ((linked.note || undefined) === before.note && after.note !== before.note) data.note = after.note || '';
    return { op: 'update', id: linked.id!, data };
  }

  // 同一場拍攝有人先在系統手動約了：接上 TimeTree，不要變兩筆
  const manual = bookings.find(b => b.vendorId === vendorId && b.status === 'booked' && !b.timetreeUuid && b.scheduledDate === date);
  if (manual) {
    const data: Partial<ShootBooking> = { timetreeUuid: change.uuid, title, changeLog: log(manual, '和 TimeTree 行程合併') };
    if (time && !manual.startTime) data.startTime = time;
    const parsed = parseTitleSuffix(title);
    if (parsed.crew && !manual.crew) data.crew = parsed.crew;
    if (parsed.note && !manual.note) data.note = parsed.note;
    return { op: 'update', id: manual.id!, data };
  }

  if (date < today) return { op: 'none', reason: '過去的行程不匯入' };
  const data: Omit<ShootBooking, 'id'> = {
    vendorId, scheduledDate: date, status: 'booked', source: 'timetree', timetreeUuid: change.uuid, title,
    bookedByUid: 'timetree', bookedByName: BY, createdAt: nowIso,
  };
  if (time) data.startTime = time;
  Object.assign(data, parseTitleSuffix(title));
  return { op: 'create', data };
}

/** 上傳素材自動核銷時要挑哪一筆：最早一筆已到期的；都還沒到就挑最早的（沿用舊行為） */
export function pickBookingToResolve<T extends Pick<ShootBooking, 'scheduledDate'>>(booked: T[], today: string): T | null {
  const sorted = [...booked].sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  return sorted.find(b => b.scheduledDate <= today) || sorted[0] || null;
}

/** calendarEvents 的寫入內容；拍攝要進 shootBookings 的不放這裡，免得行事曆同一場出現兩次 */
export function toCalendarEvent(change: TimetreeShootChange): Omit<CalendarEvent, 'id'> | null {
  if (change.action !== 'upsert' || isBookingChange(change) || change.startAt == null || !change.category) return null;
  const { date, time } = toTaipeiDateTime(change.startAt, !!change.allDay);
  const ev: Omit<CalendarEvent, 'id'> = { title: change.title || '', category: change.category, date, allDay: !!change.allDay, updatedAt: change.updatedAt || 0 };
  if (time) ev.startTime = time;
  if (change.vendorName) ev.ip = change.vendorName;
  return ev;
}
