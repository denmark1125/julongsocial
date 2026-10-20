import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { format } from 'date-fns';
import { listPlannedSlots } from '../plannedSlots';
import { slotVendors } from '../vendorStatus';
import { ExtraSlot, Post, Vendor } from '../../types';
import { day } from './fixtures';

// 橘色發片日。每一條都是 2026-10-20 實際查到的情境。

const vendor = (partial: Partial<Vendor> & { id: string }): Vendor => ({
  name: partial.id, status: 'active', postingHabits: [], ...partial,
} as Vendor);

const days = (slots: { toDate: string }[]) => slots.map(s => s.toDate);
const range = { rangeStart: day(10, 20), rangeEnd: day(11, 10), moves: [], dismissed: [], posts: [] as Post[] };

describe('listPlannedSlots', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T10:00:00+08:00')); });
  afterEach(() => { vi.useRealTimers(); });

  it('康青龍基準每週五，那週多一支：加的那天也是發片日', () => {
    const kql = vendor({ id: 'kql', postingHabits: [{ daysOfWeek: [5], time: '19:00', contentTypes: ['video'], platforms: [] }] });
    const extras: ExtraSlot[] = [{ id: 'x1', vendorId: 'kql', date: '2026-10-28', time: '19:00', contentType: 'video', createdAt: '' }];

    const slots = listPlannedSlots({ ...range, vendors: [kql], extras });

    expect(days(slots)).toEqual(['2026-10-23', '2026-10-28', '2026-10-30', '2026-11-06']);
    expect(slots.find(s => s.toDate === '2026-10-28')?.extraId).toBe('x1');
  });

  it('加的那天附近已經有貼文：算已經排了，不再顯示', () => {
    const v = vendor({ id: 'v' });
    const extras: ExtraSlot[] = [{ id: 'x1', vendorId: 'v', date: '2026-10-28', time: '20:00', contentType: 'video', createdAt: '' }];
    const posts = [{ vendorId: 'v', scheduledAt: '2026-10-28T19:00' } as Post];

    expect(listPlannedSlots({ ...range, vendors: [v], extras, posts })).toEqual([]);
  });

  it('沒傳進來的廠商（例如已終止）加的格子不出現', () => {
    const extras: ExtraSlot[] = [{ id: 'x1', vendorId: 'gone', date: '2026-10-28', time: '20:00', contentType: 'video', createdAt: '' }];
    expect(listPlannedSlots({ ...range, vendors: [], extras })).toEqual([]);
  });

  it('杜永霖冷凍到 10/31、固定二六：10/31 起的格子現在就要看得到，之前的不出現', () => {
    const dyl = vendor({
      id: 'dyl', status: 'paused', pausedUntil: '2026-10-31',
      postingHabits: [{ daysOfWeek: [2, 6], time: '21:00', contentTypes: ['video'], platforms: [] }],
    });

    const vendors = slotVendors([dyl]);
    const slots = listPlannedSlots({ ...range, vendors });

    expect(vendors).toHaveLength(1);
    expect(days(slots)).toEqual(['2026-10-31', '2026-11-03', '2026-11-07', '2026-11-10']);
  });

  it('冷凍但沒填解凍日：不知道哪天恢復，不畫任何格子', () => {
    const v = vendor({ id: 'v', status: 'paused', postingHabits: [{ daysOfWeek: [2], time: '20:00', contentTypes: ['video'], platforms: [] }] });
    expect(slotVendors([v])).toEqual([]);
    expect(listPlannedSlots({ ...range, vendors: [v] })).toEqual([]);
  });

  it('沒冷凍的廠商照舊', () => {
    const v = vendor({ id: 'v', postingHabits: [{ daysOfWeek: [2], time: '20:00', contentTypes: ['video'], platforms: [] }] });
    expect(days(listPlannedSlots({ ...range, vendors: slotVendors([v]) }))).toEqual(
      [day(10, 20), day(10, 27), day(11, 3), day(11, 10)].map(d => format(d, 'yyyy-MM-dd')));
  });
});
