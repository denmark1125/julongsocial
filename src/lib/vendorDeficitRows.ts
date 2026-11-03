import { Asset, Post, ShootBooking, Vendor } from '../types';
import {
  getAvailableVideoAssets,
  getDeficitBreakdown,
  getEffectiveMonthlyTarget,
  getOwedVideoCount,
  hasVideoTrackingScope,
  isVendorTrackedInMonth,
} from './vendorStatus';

export type DeficitSeverity = 'crit' | 'warn' | 'good';

export interface DeficitRow {
  vendor: Vendor;
  target: number;
  delivered: number;
  stock: number;
  baseline: number;
  breakdown: ReturnType<typeof getDeficitBreakdown>;
  owed: number;
  /** 最近一場約好的拍攝 */
  active: ShootBooking | null;
  laterCount: number;
  overdue: boolean;
  frozenThisMonth: boolean;
  isEnded: boolean;
  sev: DeficitSeverity;
}

/**
 * 製作進度頁每個 IP 一張卡的數字（欠片、庫存、下一場拍攝、紅黃綠）。
 *
 * 2026-11 從 ShootBookings.tsx 原封不動抽出來，給會長頁共用：
 * 兩個畫面一定要同一個答案，所以不准各寫一套。
 *
 * @param today yyyy-MM-dd；currentMonth 由它的前 7 碼決定（跟原本 ShootBookings 的寫法一致）
 */
export function buildDeficitRows(
  vendors: Vendor[],
  posts: Post[],
  assets: Asset[],
  bookings: ShootBooking[],
  today: string,
): DeficitRow[] {
  const currentMonth = today.slice(0, 7);
  return vendors
    // 要不要出現在這個清單，用 hasVideoTrackingScope（本來有沒有在拍影音+合作開始了沒+沒終止/排除統計）判斷，
    // 故意不用 trackedVendors——那個會用即時 status 把「還在冷凍中、還沒解凍」的廠商整批擋掉，
    // 但冷凍中如果之前留有欠片，卡片還是要在，才能繼續管理/沖銷；這個月本身不會疊加新短缺的邏輯在 getDeficitBreakdown 內部處理
    .filter(v => hasVideoTrackingScope(v, currentMonth))
    .map(v => {
      const target = getEffectiveMonthlyTarget(v, currentMonth);
      const delivered = posts.filter(p =>
        p.vendorId === v.id && p.contentType === 'video' &&
        (p.status === 'published' || p.status === 'scheduled') &&
        (p.targetMonth ? p.targetMonth === currentMonth : (p.scheduledAt || '').slice(0, 7) === currentMonth)
      ).length;
      const stock = getAvailableVideoAssets(v.id!, assets, posts).length;
      const breakdown = getDeficitBreakdown(v, posts, assets, currentMonth);
      // 用共用的getOwedVideoCount(內部已無條件進位)，不要自己重算，避免跟Dashboard/LINE推播的欠片數字對不起來
      const owed = getOwedVideoCount(v, posts, assets, stock, currentMonth);
      const booked = bookings
        .filter(b => b.vendorId === v.id && b.status === 'booked')
        .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate) || (a.startTime || '').localeCompare(b.startTime || ''));
      const active = booked[0] || null;
      // TimeTree 匯入後同一個 IP 常同時有好幾場約好的拍攝，卡片只顯示最近一場，其他給個數量
      const laterCount = Math.max(0, booked.length - 1);
      const overdue = !!active && active.scheduledDate < today;
      // 這個廠商本來就在追蹤範圍內(hasVideoTrackingScope)，但這個月本身可能因為冷凍期/已終止而不計入新短缺——
      // 用來讓畫面清楚標示，不要讓人誤會本月的target/delivered是真的有在要求
      const frozenThisMonth = !isVendorTrackedInMonth(v, currentMonth);
      const isEnded = v.status === 'ended';
      let sev: DeficitSeverity = 'good';
      if (overdue) sev = 'crit';
      else if (owed > 0 && !active) sev = owed >= 4 ? 'crit' : 'warn';
      else if (owed > 0) sev = 'warn';
      return { vendor: v, target, delivered, stock, baseline: breakdown.baseline, breakdown, owed, active, laterCount, overdue, frozenThisMonth, isEnded, sev };
    })
    // 冷凍中/已終止且完全沒欠片的廠商不用一直顯示佔版面（沒東西要管）；還有欠片的留著提醒去清完
    .filter(row => !(row.frozenThisMonth && row.owed === 0))
    .sort((a, b) => (b.sev === 'crit' ? 2 : b.sev === 'warn' ? 1 : 0) - (a.sev === 'crit' ? 2 : a.sev === 'warn' ? 1 : 0) || b.owed - a.owed);
}
