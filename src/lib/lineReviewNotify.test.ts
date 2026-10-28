import { describe, expect, it } from 'vitest';
import { buildPendingListMessage, isPendingQuery, listPendingReviews, type ReminderAsset } from './lineReviewNotify';

const now = new Date('2026-10-28T07:00:00Z'); // 台灣 10/28 15:00
const asset = (id: string, stage: string, extra: Partial<ReminderAsset> = {}): ReminderAsset => ({
  id, stage, title: id, vendorName: 'IP',
  reviewFiles: [{ uploadedAt: '2026-10-27T22:17:00Z', previewToken: `t_${id}`, version: 1 }],
  ...extra,
});

describe('isPendingQuery', () => {
  it('只認整句「待審」這幾種說法', () => {
    expect(isPendingQuery('待審')).toBe(true);
    expect(isPendingQuery(' 待 審 ')).toBe(true);
    expect(isPendingQuery('審片清單')).toBe(true);
    expect(isPendingQuery('祥賓有送審一隻')).toBe(false);
    expect(isPendingQuery('待審的那支好了嗎')).toBe(false);
    expect(isPendingQuery('')).toBe(false);
  });
});

describe('listPendingReviews', () => {
  it('不管滿不滿 2 個上班日，審核中、已通過未完成都列出來', () => {
    const r = listPendingReviews([
      asset('今天剛送', 'client_review'),
      asset('已通過', 'to_upload', { clientApprovedAt: '2026-10-23T02:00:00Z' }),
    ], now);
    expect(r.clientSlow.map(i => i.assetId)).toEqual(['今天剛送']);
    expect(r.clientSlow[0].days).toBe(0);
    expect(r.notCompleted.map(i => i.assetId)).toEqual(['已通過']);
    expect(r.notCompleted[0].days).toBe(5);
  });

  it('作廢、已完成、舊流程沒預覽連結、不在審核階段的都不列', () => {
    const r = listPendingReviews([
      asset('作廢', 'client_review', { voidedAt: '2026-10-28' }),
      asset('已完成', 'to_upload', { cloudUploadedAt: '2026-10-28' }),
      asset('舊流程', 'client_review', { reviewFiles: [] }),
      asset('剪輯中', 'editing'),
    ], now);
    expect(r.clientSlow).toEqual([]);
    expect(r.notCompleted).toEqual([]);
  });

  it('等最久的排前面，連結用最新版', () => {
    const r = listPendingReviews([
      asset('新', 'client_review'),
      asset('舊', 'client_review', { reviewFiles: [
        { uploadedAt: '2026-10-20T02:00:00Z', previewToken: 't', version: 1 },
        { uploadedAt: '2026-10-22T02:00:00Z', previewToken: 't', version: 2 },
      ] }),
    ], now);
    expect(r.clientSlow.map(i => i.assetId)).toEqual(['舊', '新']);
    expect(r.clientSlow[0].version).toBe(2);
  });
});

describe('buildPendingListMessage', () => {
  it('沒片回一句文字', () => {
    expect(buildPendingListMessage({ clientSlow: [], notCompleted: [] }, 'https://x')).toEqual({ type: 'text', text: '目前沒有送審中的片' });
  });

  it('超過 12 支只放 12 張卡，altText 講總數', () => {
    const items = Array.from({ length: 14 }, (_, i) => asset(`a${i}`, 'client_review'));
    const msg: any = buildPendingListMessage(listPendingReviews(items, now), 'https://x');
    expect(msg.contents.contents).toHaveLength(12);
    expect(msg.altText).toContain('送審中 14 支');
  });
});
