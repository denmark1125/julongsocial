/**
 * 某個 IP「上次拍攝」是哪一天（LINE 庫存警示卡片的「上次拍攝」用）。
 *
 * ⚠️ 不能只看「已結案的拍攝預約」：預約系統很少人用，2026-11-18 大發 9、10 月拍了四場，
 *    系統只有 7/24 那筆結案預約 → 卡片寫「上次拍攝 07/24」，看起來像四個月沒拍。
 * 所以取下面兩個來源裡最晚、且不晚於今天的那天：
 *   ① 拍攝預約：沒取消、日子已經過了（TimeTree 同步進來的 booked 也算，過了就是拍了）
 *   ② 素材的拍攝日：實際拍回來的片
 */
export function lastShootDate(
  vendorId: string,
  bookings: { vendorId?: string; status?: string; scheduledDate?: string }[],
  assets: { vendorId?: string; filmingDate?: string }[],
  today: string, // YYYY-MM-DD（台灣日期）
): string | null {
  const dates: string[] = [];
  for (const b of bookings) {
    if (b.vendorId !== vendorId || b.status === "cancelled") continue;
    const d = String(b.scheduledDate || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today) dates.push(d);
  }
  for (const a of assets) {
    if (a.vendorId !== vendorId) continue;
    const d = String(a.filmingDate || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today) dates.push(d);
  }
  if (!dates.length) return null;
  return dates.sort().at(-1)!;
}
