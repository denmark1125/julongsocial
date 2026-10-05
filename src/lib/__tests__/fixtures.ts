import { Asset } from '../../types';
import { DemandItem } from '../materialSupply';

// 測試用的最小資料。只填被測函式真的會讀的欄位，其餘給安全的預設值。

let seq = 0;

export function asset(partial: Partial<Asset> & { vendorId: string }): Asset {
  seq += 1;
  return {
    id: partial.id ?? `asset_${seq}`,
    title: partial.title ?? `素材 ${seq}`,
    type: 'video',
    stage: 'raw',
    status: 'available',
    approved: false,
    createdAt: '2026-09-01T00:00:00+08:00',
    createdBy: 'tester',
    ...partial,
  };
}

/** 本地時間的某一天（月份從 1 開始，跟人講話的方式一樣） */
export function day(month: number, date: number, year = 2026): Date {
  return new Date(year, month - 1, date);
}

export function demand(vendorId: string, date: Date, extra: Partial<DemandItem> = {}): DemandItem {
  seq += 1;
  return { id: `demand_${seq}`, vendorId, date, contentType: 'video', ...extra };
}
