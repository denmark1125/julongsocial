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

describe('月片數到了就不再畫固定發片日（10-22 廣信）', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T10:00:00+08:00')); });
  afterEach(() => { vi.useRealTimers(); });
  // 固定週二、週六；10 月範圍內 10/24(六)、10/27(二)、10/31(六)
  const gx = (extra: Partial<Vendor> = {}) => vendor({
    id: 'gx', monthlyTargetVideos: 7,
    postingHabits: [{ daysOfWeek: [2, 6], time: '20:00', contentTypes: ['video'], platforms: [] }], ...extra,
  });
  const octRange = { ...range, rangeEnd: day(10, 31) };
  const post = (d: string, status: Post['status']) => ({ vendorId: 'gx', contentType: 'video', status, scheduledAt: `${d}T20:00`, targetMonth: d.slice(0, 7) } as Post);
  const fivePosts = [post('2026-10-03', 'published'), post('2026-10-06', 'published'), post('2026-10-10', 'published'), post('2026-10-17', 'published'), post('2026-10-24', 'draft')];

  it('廣信實際：10 月改 5 支、已經 5 篇（含草稿）→ 10/27、10/31 都不畫', () => {
    const v = gx({ monthlyAdjustments: [{ month: '2026-10', videoDelta: -2, reason: '', createdAt: '' }] as any });
    expect(days(listPlannedSlots({ ...octRange, vendors: [v], posts: fivePosts }))).toEqual([]);
  });

  it('月片數 7、已經 5 篇 → 只剩 2 格，早的先留', () => {
    expect(days(listPlannedSlots({ ...octRange, vendors: [gx()], posts: fivePosts }))).toEqual(['2026-10-20', '2026-10-27']);
  });

  it('月片數 6、已經 5 篇 → 只留最早一格', () => {
    expect(days(listPlannedSlots({ ...octRange, vendors: [gx({ monthlyTargetVideos: 6 })], posts: fivePosts }))).toEqual(['2026-10-20']);
  });

  it('過去沒發的發片日不佔名額：10/13 沒發，7 支、5 篇 → 未來照樣留 2 格', () => {
    const slots = listPlannedSlots({ ...octRange, rangeStart: day(10, 13), vendors: [gx()], posts: fivePosts });
    expect(days(slots).filter(d => d >= '2026-10-20')).toEqual(['2026-10-20', '2026-10-27']);
  });

  it('手動加的發片日不受限制（有人明確要加）', () => {
    const v = gx({ monthlyAdjustments: [{ month: '2026-10', videoDelta: -2, reason: '', createdAt: '' }] as any });
    const extras: ExtraSlot[] = [{ id: 'x1', vendorId: 'gx', date: '2026-10-29', time: '20:00', contentType: 'video', createdAt: '' }];
    expect(days(listPlannedSlots({ ...octRange, vendors: [v], posts: fivePosts, extras }))).toEqual(['2026-10-29']);
  });

  it('沒設月片數：照舊全畫（對照組）', () => {
    expect(days(listPlannedSlots({ ...octRange, vendors: [gx({ monthlyTargetVideos: 0 })], posts: fivePosts }))).toEqual(['2026-10-20', '2026-10-27', '2026-10-31']);
  });
});
