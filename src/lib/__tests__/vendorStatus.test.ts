import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getAvailableVideoAssets,
  getDeficitBreakdown,
  getDeliveredVideosInMonth,
  getOwedVideoCount,
  getVideoStockAlert,
  isAssetFree,
  isAssetSelectable,
  buildPostIndex,
} from '../vendorStatus';
import { Post, Vendor } from '../../types';
import { asset } from './fixtures';

// 欠片與庫存：週報「還要再拍 N 支」、LINE 庫存警示、儀表板都吃這一份算式。
// 這裡把數字鎖住，之後整理狀態欄位（PR 4）時任何一個數字變了都會被抓到。

const post = (p: Partial<Post> & { id: string; vendorId: string }): Post =>
  ({ title: 't', status: 'published', contentType: 'video', ...p } as Post);

const vendor = (v: Partial<Vendor>): Vendor =>
  ({ id: 'v1', name: '測試 IP', status: 'active', monthlyTargetVideos: 8, createdBy: 'x', ...v } as Vendor);

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 12, 0)); // 2026-10-15 中午
});
afterAll(() => vi.useRealTimers());

describe('已交支數', () => {
  it('已發布＋已排程的影音貼文算，草稿和圖文不算；有 targetMonth 以它為準', () => {
    const posts = [
      post({ id: 'p1', vendorId: 'v1', status: 'published', scheduledAt: '2026-08-05T12:00:00+08:00' }),
      post({ id: 'p2', vendorId: 'v1', status: 'scheduled', scheduledAt: '2026-08-20T12:00:00+08:00' }),
      post({ id: 'p3', vendorId: 'v1', status: 'draft', scheduledAt: '2026-08-21T12:00:00+08:00' }),
      post({ id: 'p4', vendorId: 'v1', contentType: 'post', scheduledAt: '2026-08-22T12:00:00+08:00' }),
      post({ id: 'p5', vendorId: 'v1', scheduledAt: '2026-09-02T12:00:00+08:00', targetMonth: '2026-08' }),
      post({ id: 'p6', vendorId: 'v2', scheduledAt: '2026-08-05T12:00:00+08:00' }),
    ];
    expect(getDeliveredVideosInMonth('v1', posts, [], '2026-08')).toBe(3);
  });

  it('手動標記完成的素材依認列月份算；掛在貼文上的不重複算', () => {
    const assets = [
      asset({ vendorId: 'v1', status: 'used', recognizedMonth: '2026-08' }),
      asset({ vendorId: 'v1', status: 'used', recognizedMonth: '2026-08', usedInPostId: 'p1' }),
      asset({ vendorId: 'v1', status: 'used', recognizedMonth: '2026-08', voidedAt: '2026-08-30' }),
    ];
    expect(getDeliveredVideosInMonth('v1', [], assets, '2026-08')).toBe(1);
  });
});

describe('欠片（getDeficitBreakdown／getOwedVideoCount）', () => {
  it('從手動回填的最後一個月往後連續累加，再扣掉庫存', () => {
    const v = vendor({ deficitEntries: [{ month: '2026-07', owed: 2 }] as Vendor['deficitEntries'] });
    const posts = [
      ...[1, 2, 3, 4, 5].map(i => post({ id: `a${i}`, vendorId: 'v1', scheduledAt: `2026-08-0${i}T12:00:00+08:00` })),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => post({ id: `s${i}`, vendorId: 'v1', scheduledAt: `2026-09-0${i}T12:00:00+08:00` })),
    ];
    const b = getDeficitBreakdown(v, posts, [], '2026-09', new Date(2026, 9, 15));
    expect(b.baseline).toBe(2);
    expect(b.monthlyShortfalls.map(m => [m.month, m.target, m.delivered, m.delta])).toEqual([
      ['2026-08', 8, 5, 3],
      ['2026-09', 8, 9, -1],
    ]);
    expect(b.totalShortfall).toBe(4);
    expect(getOwedVideoCount(v, posts, [], 1, '2026-09')).toBe(3);
    expect(getOwedVideoCount(v, posts, [], 10, '2026-09')).toBe(0);
  });

  it('冷凍中的月份不產生新目標，但補交照樣沖銷', () => {
    const v = vendor({
      deficitEntries: [{ month: '2026-07', owed: 4 }] as Vendor['deficitEntries'],
      pauseHistory: [{ from: '2026-08-01', until: '2026-09-01' }] as Vendor['pauseHistory'],
    });
    const posts = [post({ id: 'p', vendorId: 'v1', scheduledAt: '2026-08-10T12:00:00+08:00' })];
    const aug = getDeficitBreakdown(v, posts, [], '2026-08', new Date(2026, 9, 15)).monthlyShortfalls[0];
    expect(aug).toMatchObject({ month: '2026-08', target: 0, delivered: 1, delta: -1, untracked: true });
  });

  it('進行中的當月照週節奏按比例算，不是整月目標', () => {
    const v = vendor({ deficitEntries: [{ month: '2026-09', owed: 0 }] as Vendor['deficitEntries'], weeklyPattern: [2, 2, 2, 2] });
    const b = getDeficitBreakdown(v, [], [], '2026-10', new Date(2026, 9, 15));
    const oct = b.monthlyShortfalls[0];
    expect(oct.month).toBe('2026-10');
    expect(oct.expectedByNow).toBeCloseTo(4 + 2 * (1 / 7), 5);
  });
});

describe('庫存', () => {
  const posts = [
    post({ id: 'draft', vendorId: 'v1', status: 'draft' }),
    post({ id: 'sched', vendorId: 'v1', status: 'scheduled' }),
  ];
  const index = buildPostIndex(posts);

  it('isAssetFree：可用、掛草稿、孤兒算庫存；掛已排程、作廢不算', () => {
    expect(isAssetFree({ status: 'available' }, index)).toBe(true);
    expect(isAssetFree({ status: 'used', usedInPostId: 'draft' }, index)).toBe(true);
    expect(isAssetFree({ status: 'used', usedInPostId: 'deleted' }, index)).toBe(true);
    expect(isAssetFree({ status: 'used', usedInPostId: 'sched' }, index)).toBe(false);
    expect(isAssetFree({ status: 'available', voidedAt: 'x' }, index)).toBe(false);
  });

  it('isAssetSelectable：掛在草稿上的已被佔走，不能再挑（跟庫存答案相反）', () => {
    expect(isAssetSelectable({ status: 'used', usedInPostId: 'draft' }, index)).toBe(false);
    expect(isAssetSelectable({ status: 'used', usedInPostId: 'deleted' }, index)).toBe(true);
  });

  it('成片／毛片庫存：沒有 stage 的舊資料算成片', () => {
    const assets = [
      asset({ vendorId: 'v1', stage: 'finished' }),
      asset({ vendorId: 'v1', stage: undefined as unknown as 'raw' }),
      asset({ vendorId: 'v1', stage: 'raw' }),
      asset({ vendorId: 'v1', stage: 'raw', status: 'used', usedInPostId: 'sched' }),
      asset({ vendorId: 'v2', stage: 'raw' }),
    ];
    const mine = getAvailableVideoAssets('v1', assets, posts);
    const alert = getVideoStockAlert(vendor({ weeklyPattern: [2, 2, 2, 2] }), mine, 0, new Date(2026, 9, 15));
    expect([alert.finishedStock, alert.rawStock]).toEqual([2, 1]);
  });

  it('欠片 > 0 一律要拍片', () => {
    expect(getVideoStockAlert(vendor({}), [], 1, new Date(2026, 9, 15)).severity).toBe('shoot');
  });
});
