import { describe, expect, it } from 'vitest';
import { findSkippedAssets, rawCheckIssue, rawCheckSummary, summarizeFolder } from '../rawCheck';
import { Vendor } from '../../types';
import { asset, day } from './fixtures';

const NOW = new Date('2026-10-20T10:00:00+08:00');

describe('素材自動檢查', () => {
  it('3 支影片＋1 張照片：算影片數與總長', () => {
    const check = summarizeFolder([
      { mimeType: 'video/quicktime', durationSec: 120 },
      { mimeType: 'video/mp4', durationSec: 100 },
      { mimeType: 'video/mp4', durationSec: 32 },
      { mimeType: 'image/jpeg' },
    ], NOW);
    expect(check).toMatchObject({ videoCount: 3, fileCount: 4, totalSec: 252 });
    expect(rawCheckIssue(check)).toBeNull();
    expect(rawCheckSummary(check)).toBe('素材 3 支影片・共 4 分 12 秒');
  });

  it('只有照片 → 資料夾裡沒有影片檔；空的 → 資料夾是空的', () => {
    expect(rawCheckIssue(summarizeFolder([{ mimeType: 'image/jpeg' }], NOW))).toBe('資料夾裡沒有影片檔');
    expect(rawCheckIssue(summarizeFolder([], NOW))).toBe('資料夾是空的');
  });

  it('總長太短算異常；有一支還在處理（沒有長度）就不判斷長度', () => {
    expect(rawCheckIssue(summarizeFolder([{ mimeType: 'video/mp4', durationSec: 12 }], NOW))).toBe('素材只有 12 秒');
    const processing = summarizeFolder([{ mimeType: 'video/mp4', durationSec: 12 }, { mimeType: 'video/mp4' }], NOW);
    expect(processing.totalSec).toBeUndefined();
    expect(rawCheckIssue(processing)).toBeNull();
    expect(rawCheckSummary(processing)).toBe('素材 2 支影片');
  });

  it('認領的資料夾系統看不到（null）：不是異常，也不顯示摘要', () => {
    const check = summarizeFolder(null, NOW);
    expect(check.unreadable).toBe(true);
    expect(rawCheckIssue(check)).toBeNull();
    expect(rawCheckSummary(check)).toBeNull();
  });
});

describe('疑似跳過', () => {
  const vendors = [{ id: 'v', name: 'IP', editorId: 'E1' } as Vendor];
  // 待剪片 a：10/24 上片、10/15 交片
  const air = new Map([['a', day(10, 24)], ['c', day(10, 24)]]);
  const dl = new Map([['a', day(10, 15)], ['c', day(10, 15)]]);
  const sent = (id: string, plannedAirDate: string, submittedAt = '2026-10-19T15:00:00+08:00') =>
    asset({ vendorId: 'v', id, stage: 'finished', flowStage: 'client_review', submittedAt, plannedAirDate });

  it('期限過了、剪輯師之後先交了比它晚上片的片 → 疑似跳過', () => {
    const a = asset({ vendorId: 'v', id: 'a' });
    const later = sent('b', '2026-10-28');
    expect([...findSkippedAssets([a], air, dl, [a, later], vendors, [], NOW)]).toEqual(['a']);
  });

  it('謝謝 10/20 交了小株番茄（10/20 上，比這支早）：不是跳過，是照先後剪', () => {
    const a = asset({ vendorId: 'v', id: 'a' });
    const earlier = sent('b', '2026-10-20', '2026-10-20T10:12:00+08:00');
    expect(findSkippedAssets([a], air, dl, [a, earlier], vendors, [], NOW).size).toBe(0);
  });

  it('期限還沒到、或晚上片的片是期限之前交的 → 不算', () => {
    const a = asset({ vendorId: 'v', id: 'a' });
    const before = sent('b', '2026-10-28', '2026-10-14T15:00:00+08:00');
    expect(findSkippedAssets([a], air, new Map([['a', day(10, 25)]]), [a, sent('d', '2026-10-28')], vendors, [], NOW).size).toBe(0);
    expect(findSkippedAssets([a], air, dl, [a, before], vendors, [], NOW).size).toBe(0);
  });

  it('交出去的片上片日看掛上的貼文', () => {
    const a = asset({ vendorId: 'v', id: 'a' });
    const b = asset({ vendorId: 'v', id: 'b', stage: 'finished', flowStage: 'to_upload', submittedAt: '2026-10-19T15:00:00+08:00', usedInPostId: 'p1' });
    const posts = [{ id: 'p1', scheduledAt: '2026-10-30T20:00' }];
    expect([...findSkippedAssets([a], air, dl, [a, b], vendors, posts, NOW)]).toEqual(['a']);
  });

  it('剪輯師已回報問題（還沒處理）不算；處理完了又被跳過就算', () => {
    const later = sent('b', '2026-10-28');
    const reported = asset({ vendorId: 'v', id: 'a', editorReport: { reason: 'missing', at: '2026-10-16T10:00:00+08:00' } });
    const resolved = asset({ vendorId: 'v', id: 'c', editorReport: { reason: 'missing', at: '2026-10-16T10:00:00+08:00', resolvedAt: '2026-10-17T10:00:00+08:00' } });
    expect([...findSkippedAssets([reported, resolved], air, dl, [reported, resolved, later], vendors, [], NOW)]).toEqual(['c']);
  });

  it('撤回到待剪的片身上的舊交片時間不算', () => {
    const a = asset({ vendorId: 'v', id: 'a' });
    const withdrawn = asset({ vendorId: 'v', id: 'b', submittedAt: '2026-10-19T15:00:00+08:00', plannedAirDate: '2026-10-28' });
    expect(findSkippedAssets([a, withdrawn], air, dl, [a, withdrawn], vendors, [], NOW).size).toBe(0);
  });
});

describe('assetRawIssue', () => {
  it('沒附任何素材連結的舊片不算異常（使用者 10-20：不用補）', async () => {
    const { assetRawIssue } = await import('../rawCheck');
    expect(assetRawIssue({ url: '', driveFolderId: undefined })).toBeNull();
    expect(assetRawIssue({ url: 'https://drive.google.com/drive/folders/abc' })).toBeNull();
    expect(assetRawIssue({ driveFolderId: 'abc', rawCheck: { videoCount: 0, fileCount: 0, checkedAt: '' } })).toBe('資料夾是空的');
  });
});
