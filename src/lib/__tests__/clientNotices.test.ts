import { describe, expect, it } from 'vitest';
import { buildClientNotices } from '../clientPortal';

const now = new Date('2026-11-19T04:00:00Z'); // 台灣 11/19 12:00
const opts = { now, today: '2026-11-19', flowOf: (a: any) => a.flow ?? null };

describe('客戶端通知', () => {
  it('文案送審：等您確認／修改版；確認後灰掉；已發布不列', () => {
    const posts = [
      { id: 'a', title: '釜山', scheduledAt: '2026-11-21T20:00', status: 'draft', content: 'x', captionReview: { sentAt: '2026-11-19T02:00:00Z' } },
      { id: 'b', title: '奧黛', scheduledAt: '2026-11-28T20:00', status: 'draft', content: 'x', clientConfirmed: true, captionReview: { sentAt: '2026-11-18T02:00:00Z', sendCount: 2 } },
      { id: 'c', title: '舊的', scheduledAt: '2026-11-01T20:00', status: 'draft', content: 'x', captionReview: { sentAt: '2026-09-01T02:00:00Z' } },
    ];
    const n = buildClientNotices(posts, [], [], opts);
    expect(n.map(x => x.id)).toEqual(['cap_a_2026-11-19T02:00:00Z', 'cap_b_2026-11-18T02:00:00Z']);
    expect(n[0]).toMatchObject({ kind: 'caption', title: '文案等您確認', done: false, postId: 'a', month: '2026-11' });
    expect(n[0].detail).toBe('11/21（六）《釜山》');
    expect(n[1]).toMatchObject({ title: '修改後的文案等您確認', done: true });
  });

  it('審片：掛在貼文上（直接或排上片日）才列；審過灰掉', () => {
    const posts = [{ id: 'p1', title: 'A', scheduledAt: '2026-11-22T20:00', status: 'draft' }, { id: 'p2', title: 'B', scheduledAt: '2026-11-23T20:00', status: 'draft', assetId: 'x2' }];
    const assets = [
      { id: 'x1', plannedPostId: 'p1', flow: 'client_review', reviewFiles: [{ version: 2, uploadedAt: '2026-11-19T01:00:00Z', name: 'v2' }] },
      { id: 'x2', flow: 'to_upload', reviewFiles: [{ version: 1, uploadedAt: '2026-11-18T01:00:00Z', name: 'v1' }] },
      { id: 'x3', flow: 'client_review', reviewFiles: [{ version: 1, uploadedAt: '2026-11-18T01:00:00Z', name: 'v1' }] },
    ];
    const n = buildClientNotices(posts, assets, [], opts);
    expect(n.map(x => [x.id, x.title, x.done])).toEqual([['vid_x1_2', '影片第 2 版等您審片', false], ['vid_x2_1', '影片等您審片', true]]);
  });

  it('已發布用實際發出時間；拍攝只列還沒拍的', () => {
    const posts = [{ id: 'p', title: 'C', scheduledAt: '2026-11-17T20:00', status: 'published', publishAudit: { IG: { actualAt: '2026-11-17T12:01:00Z' } } }];
    const bookings = [
      { scheduledDate: '2026-11-25', startTime: '14:00', status: 'booked', createdAt: '2026-11-18T03:00:00Z' },
      { scheduledDate: '2026-11-10', status: 'completed', createdAt: '2026-11-01T03:00:00Z' },
    ];
    const n = buildClientNotices(posts, [], bookings, opts);
    expect(n.map(x => [x.kind, x.at, x.detail])).toEqual([
      ['shoot', '2026-11-18T03:00:00Z', '11/25（三） 14:00'],
      ['published', '2026-11-17T12:01:00Z', '11/17（二）《C》'],
    ]);
  });
});
