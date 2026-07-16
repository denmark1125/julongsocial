import { format } from 'date-fns';
import { Vendor } from '../types';

export type EffectiveVendorStatus = 'active' | 'paused' | 'ended';

// 冷凍期到期即視為 active，不需要寫回資料庫
export function getEffectiveVendorStatus(vendor: Pick<Vendor, 'status' | 'pausedUntil'>): EffectiveVendorStatus {
  if (vendor.status === 'ended') return 'ended';
  if (vendor.status === 'paused') {
    const today = format(new Date(), 'yyyy-MM-dd');
    if (vendor.pausedUntil && vendor.pausedUntil <= today) return 'active';
    return 'paused';
  }
  return 'active';
}

// 前端列表/選單用：排除已終止，冷凍中仍可見可選
export function visibleVendors(vendors: Vendor[]): Vendor[] {
  return vendors.filter(v => getEffectiveVendorStatus(v) !== 'ended');
}

// 目標/欠片/提醒追蹤用：排除已終止、冷凍中，以及手動標記「不列入統計」的廠商（如內部帳號）
export function trackedVendors(vendors: Vendor[]): Vendor[] {
  return vendors.filter(v => getEffectiveVendorStatus(v) === 'active' && !v.excludeFromStats);
}

// 針對「特定月份」判斷該廠商是否要計入目標/欠片統計：
// 只要 pauseHistory 裡任一段冷凍區間與該月有重疊，這個月就整月排除（不論當下即時 status 是否已恢復）
export function isVendorTrackedInMonth(vendor: Pick<Vendor, 'status' | 'excludeFromStats' | 'pauseHistory'>, month: string): boolean {
  if (vendor.status === 'ended') return false;
  if (vendor.excludeFromStats) return false;

  const monthStart = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const monthEnd = format(new Date(y, m, 0), 'yyyy-MM-dd'); // 該月最後一天

  const overlapsAPause = (vendor.pauseHistory || []).some(rec => {
    const from = rec.from;
    const until = rec.until || '9999-12-31'; // 尚未恢復＝視為持續到未來
    // until 是「恢復日」本身已經算active，所以要嚴格大於月初才算還在冷凍區間內
    return from <= monthEnd && until > monthStart;
  });

  return !overlapsAPause;
}

// 目標/欠片統計用（可指定月份版）：排除已終止、該月落在冷凍區間內、以及「不列入統計」的廠商
export function trackedVendorsForMonth(vendors: Vendor[], month: string): Vendor[] {
  return vendors.filter(v => isVendorTrackedInMonth(v, month));
}
