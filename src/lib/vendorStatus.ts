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

// 目標/欠片/提醒追蹤用：排除已終止與冷凍中
export function trackedVendors(vendors: Vendor[]): Vendor[] {
  return vendors.filter(v => getEffectiveVendorStatus(v) === 'active');
}
