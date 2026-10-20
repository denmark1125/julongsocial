import { describe, expect, it } from 'vitest';
import { findBoundPostFixes } from '../boundPosts';
import { Post } from '../../types';
import { asset } from './fixtures';

const post = (id: string, extra: Partial<Post> = {}): Post => ({
  id, vendorId: 'hz', title: `貼文 ${id}`, status: 'draft', scheduledAt: '2026-10-25T20:00',
  contentType: 'video', assetId: 'to_be_added', ...extra,
} as Post);

describe('findBoundPostFixes', () => {
  it('還在剪：小編改了日期 → 只同步上片日快照', () => {
    const raw = asset({ vendorId: 'hz', plannedPostId: 'p1', plannedAirDate: '2026-10-20' });
    expect(findBoundPostFixes([post('p1')], [raw])).toEqual([{ kind: 'sync', assetId: raw.id, date: '2026-10-25' }]);
  });

  it('日期一樣就不寫（冪等）', () => {
    const raw = asset({ vendorId: 'hz', plannedPostId: 'p1', plannedAirDate: '2026-10-25' });
    expect(findBoundPostFixes([post('p1')], [raw])).toEqual([]);
  });

  it('業主通過（待上傳／可排程／已上傳雲端）→ 自動掛上', () => {
    const ok = asset({ vendorId: 'hz', plannedPostId: 'p1', stage: 'finished', flowStage: 'to_upload' });
    const uploaded = asset({ vendorId: 'hz', plannedPostId: 'p2', stage: 'finished', flowStage: 'client_review', cloudUploadedAt: '2026-10-20T10:00:00+08:00' });
    const reviewing = asset({ vendorId: 'hz', plannedPostId: 'p3', stage: 'finished', flowStage: 'client_review', plannedAirDate: '2026-10-25' });
    const fixes = findBoundPostFixes([post('p1'), post('p2'), post('p3')], [ok, uploaded, reviewing]);
    expect(fixes).toEqual([
      { kind: 'attach', assetId: ok.id, postId: 'p1' },
      { kind: 'attach', assetId: uploaded.id, postId: 'p2' },
    ]);
  });

  it('貼文被刪／掛了別支／已發布 → 解除綁定', () => {
    const a = asset({ vendorId: 'hz', plannedPostId: 'gone' });
    const b = asset({ vendorId: 'hz', plannedPostId: 'p1' });
    const c = asset({ vendorId: 'hz', plannedPostId: 'p2' });
    const fixes = findBoundPostFixes([post('p1', { assetId: 'other' }), post('p2', { status: 'published' })], [a, b, c]);
    expect(fixes.map(f => f.kind)).toEqual(['unbind', 'unbind', 'unbind']);
  });

  it('已經掛上自己＝完成，不動', () => {
    const a = asset({ id: 'x1', vendorId: 'hz', plannedPostId: 'p1', status: 'used', usedInPostId: 'p1', stage: 'finished', flowStage: 'ready' });
    expect(findBoundPostFixes([post('p1', { assetId: 'x1' })], [a])).toEqual([]);
  });

  it('同一篇被兩支綁到：先建檔的留著，後面那支解除', () => {
    const first = asset({ vendorId: 'hz', plannedPostId: 'p1', plannedAirDate: '2026-10-25', createdAt: '2026-10-01T00:00:00+08:00' });
    const second = asset({ vendorId: 'hz', plannedPostId: 'p1', createdAt: '2026-10-02T00:00:00+08:00' });
    expect(findBoundPostFixes([post('p1')], [second, first])).toEqual([{ kind: 'unbind', assetId: second.id }]);
  });
});
