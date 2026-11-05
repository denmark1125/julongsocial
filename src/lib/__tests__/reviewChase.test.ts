import { describe, expect, it } from 'vitest';
import { chaseMessage, chaseStage, pickChases, type ChasePost } from '../notify/reviewChase';

// 正式資料的 flowStage 會跟舊欄位 stage/approved 一起維護（見 FLOW_STAGE_COMPAT），測試資料照實際長相給
const assets: Record<string, any> = {
  approved: { flowStage: 'ready', stage: 'finished', approved: true },
  toUpload: { flowStage: 'to_upload', stage: 'finished', approved: false },
  inReview: { flowStage: 'client_review', stage: 'finished', approved: false },
  editing: { flowStage: 'to_edit', stage: 'raw', approved: false },
  revising: { flowStage: 'revising', stage: 'raw', approved: false },
};
const assetOf = (p: ChasePost) => (p.assetId ? assets[p.assetId] : null);
const post = (over: Partial<ChasePost>): ChasePost => ({ id: 'p', vendorId: 'v', scheduledAt: '2026-11-06T20:00', title: '客戶服務最貼心', assetId: 'inReview', ...over });

describe('催片', () => {
  it('業主已通過（可排程／待上傳雲端）→ 不催', () => {
    expect(chaseStage(assets.approved)).toBeNull();
    expect(chaseStage(assets.toUpload)).toBeNull();
  });

  it('還沒有片／還在剪／客戶要改／客戶還沒審 → 都要催', () => {
    expect(chaseStage(null)).toBe('還沒有片');
    expect(chaseStage(assets.editing)).toBe('還在剪，還沒送客戶審');
    expect(chaseStage(assets.revising)).toBe('客戶要改，還在改');
    expect(chaseStage(assets.inReview)).toBe('客戶還沒審');
  });

  it('上片前 30 小時 → 48 小時那一級；前 20 小時 → 24 小時那一級；前 50 小時 → 還不催', () => {
    const at = (iso: string) => pickChases([post({})], assetOf, new Date(iso));
    expect(at('2026-11-05T14:00:00+08:00')[0].tier).toBe(48);
    expect(at('2026-11-06T00:00:00+08:00')[0].tier).toBe(24);
    expect(at('2026-11-04T18:00:00+08:00')).toEqual([]);
  });

  it('同一級催過就不再催；24 小時那級還是會催', () => {
    const p = post({ reviewChase: { h48: 'x', forScheduledAt: '2026-11-06T20:00' } });
    expect(pickChases([p], assetOf, new Date('2026-11-05T14:00:00+08:00'))).toEqual([]);
    expect(pickChases([p], assetOf, new Date('2026-11-06T00:00:00+08:00'))[0].tier).toBe(24);
  });

  it('排程時間改了 → 之前的催過紀錄作廢，重新催', () => {
    const p = post({ scheduledAt: '2026-11-07T20:00', reviewChase: { h48: 'x', forScheduledAt: '2026-11-06T20:00' } });
    expect(pickChases([p], assetOf, new Date('2026-11-06T14:00:00+08:00'))[0].tier).toBe(48);
  });

  it('沒掛素材的待補貼文 → 還沒有片；圖文、已發布、已過時間 → 不催', () => {
    const now = new Date('2026-11-06T00:00:00+08:00');
    expect(pickChases([post({ assetId: 'to_be_added' })], () => null, now)[0].stage).toBe('還沒有片');
    expect(pickChases([post({ contentType: 'post' })], assetOf, now)).toEqual([]);
    expect(pickChases([post({ status: 'published' })], assetOf, now)).toEqual([]);
    expect(pickChases([post({ scheduledAt: '2026-11-05T20:00' })], assetOf, now)).toEqual([]);
  });

  it('訊息：剩不到 24 小時用緊急標題', () => {
    const items = pickChases([post({})], assetOf, new Date('2026-11-06T00:00:00+08:00'));
    expect(chaseMessage('好正點', items)).toContain('🚨 催片：好正點 剩不到 24 小時');
    expect(chaseMessage('好正點', items)).toContain('11/6 20:00「客戶服務最貼心」客戶還沒審');
  });
});

describe('片掛在排上片日（asset.plannedPostId）', () => {
  it('貼文沒掛素材，但排上片日有片指到這篇 → 照那支片的進度判斷（康青龍 11/6）', () => {
    const p = post({ assetId: 'to_be_added' });
    const viaBoard = (x: ChasePost) => (x.id === 'p' ? assets.inReview : null);
    expect(pickChases([p], viaBoard, new Date('2026-11-06T00:00:00+08:00'))[0].stage).toBe('客戶還沒審');
  });
});

describe('催片時間（不打擾下班）', () => {
  it('平日 09:30、週末 13:00', async () => {
    const { chaseTimeFor } = await import('../notify/reviewChase');
    expect(chaseTimeFor(new Date('2026-11-05T08:00:00+08:00'))).toBe('09:30'); // 週四
    expect(chaseTimeFor(new Date('2026-11-07T08:00:00+08:00'))).toBe('13:00'); // 週六
    expect(chaseTimeFor(new Date('2026-11-08T23:30:00+08:00'))).toBe('13:00'); // 週日深夜仍算週日
  });
});
