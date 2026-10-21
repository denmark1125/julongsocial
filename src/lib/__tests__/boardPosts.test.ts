import { describe, expect, it } from 'vitest';
import { buildAutoPost, isUntouchedAutoPost, movedSchedule } from '../boardPosts';

const vendor = { id: 'v1', postingHabits: [{ daysOfWeek: [1], time: '19:30', contentTypes: ['video'], platforms: ['IG'] }], defaultPlatforms: { video: ['IG', 'TikTok'] } } as any;
const day = new Date(2026, 9, 24);

describe('buildAutoPost', () => {
  const p = buildAutoPost({ title: '熱泵 vs 電熱水器' }, vendor, day, 'u1', '2026-10-21T00:00:00Z');
  it('待補中、沒掛片、短影音', () => {
    expect(p.status).toBe('pending');
    expect(p.assetId).toBe('to_be_added');
    expect(p.contentType).toBe('video');
  });
  it('日期＋IP 習慣時間、目標月份', () => {
    expect(p.scheduledAt).toBe('2026-10-24T19:30');
    expect(p.targetMonth).toBe('2026-10');
  });
  it('平台照廠商卡', () => expect(p.platforms).toEqual(['IG', 'TikTok']));
  it('剛建好＝沒被動過', () => expect(isUntouchedAutoPost(p)).toBe(true));
});

describe('isUntouchedAutoPost', () => {
  const base = buildAutoPost({ title: 'A' }, vendor, day, 'u1');
  it('小編改標題', () => expect(isUntouchedAutoPost({ ...base, title: 'B' })).toBe(false));
  it('小編寫了文案', () => expect(isUntouchedAutoPost({ ...base, content: 'x' })).toBe(false));
  it('改成草稿', () => expect(isUntouchedAutoPost({ ...base, status: 'draft' })).toBe(false));
  it('已經掛片', () => expect(isUntouchedAutoPost({ ...base, assetId: 'a1' })).toBe(false));
  it('小編自己建的待補中（對照組）', () => expect(isUntouchedAutoPost({ ...base, createdFrom: undefined })).toBe(false));
});

describe('movedSchedule', () => {
  it('保留時分只換日子', () => expect(movedSchedule({ scheduledAt: '2026-10-24T19:30' }, new Date(2026, 10, 2)))
    .toEqual({ scheduledAt: '2026-11-02T19:30', targetMonth: '2026-11' }));
});
