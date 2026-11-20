import { describe, expect, it } from 'vitest';
import { buildAutoPost, buildTitledPost, isBlankBoardPost, isUntouchedAutoPost, movedSchedule, retitleForAsset } from '../boardPosts';

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

describe('buildTitledPost 預計片名', () => {
  const p = buildTitledPost('全新食農桌遊體驗', vendor, day, 'u1', '2026-10-22T00:00:00Z');
  it('一般待補中貼文，標題是打的名字', () => {
    expect(p.title).toBe('全新食農桌遊體驗');
    expect(p.status).toBe('pending');
    expect(p.assetId).toBe('to_be_added');
    expect(p.scheduledAt).toBe('2026-10-24T19:30');
  });
  it('親手打的名字：取消排日時系統不能刪', () => {
    expect(p.autoTitle).toBeUndefined();
    expect(isUntouchedAutoPost(p)).toBe(false);
  });
});

describe('預計片名／系統貼文還沒寫文案：跟著片走（11-20 廣信 合掌村）', () => {
  const titled = { ...buildTitledPost('限量12位住進合掌村!', vendor, day, 'u1'), id: 'p1' };
  const auto = { ...buildAutoPost({ title: '釜山' }, vendor, day, 'u1'), id: 'p2' };
  it('預計片名、系統貼文都算空的佔位', () => {
    expect(isBlankBoardPost(titled)).toBe(true);
    expect(isBlankBoardPost(auto)).toBe(true);
  });
  it('寫了文案、掛了片、小編自己建的都不算', () => {
    expect(isBlankBoardPost({ ...titled, content: '文案' })).toBe(false);
    expect(isBlankBoardPost({ ...titled, assetId: 'a1' })).toBe(false);
    expect(isBlankBoardPost({ ...titled, status: 'draft' })).toBe(false);
    expect(isBlankBoardPost({ ...titled, createdFrom: undefined })).toBe(false);
  });
  it('拖帶團領隊上去：藍字改成帶團領隊；預計片名不補 autoTitle', () => {
    expect(retitleForAsset(titled, '帶團領隊連這件事都包到好？')).toEqual({ title: '帶團領隊連這件事都包到好？' });
  });
  it('系統貼文改名連 autoTitle 一起改（才會繼續算沒人動過）', () => {
    expect(retitleForAsset(auto, '合掌村')).toEqual({ title: '合掌村', autoTitle: '合掌村' });
  });
  it('同名或寫過文案就不改', () => {
    expect(retitleForAsset(auto, '釜山')).toBeNull();
    expect(retitleForAsset({ ...titled, content: 'x' }, '帶團')).toBeNull();
  });
});
