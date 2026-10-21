import { describe, expect, it } from 'vitest';
import { isFlowFinished, isOnEditorDesk } from '../assetFlow';
import { asset } from './fixtures';

// 剪輯師工作台看不看得到一支片。2026-10-21 祥濱「潮寮里重陽九九敬老餐會」被小編排程後從剪輯師畫面消失，
// 全庫 11 支沒走完流程＋15 支做完沒請款的都這樣。規則：剪了就要付錢，排程／發布不能讓片消失。

const ME = 'E1';

describe('isOnEditorDesk', () => {
  it('業主審核中、已被小編排程（還沒上傳雲端）→ 看得到（潮寮里）', () => {
    const a = asset({ vendorId: 'xb', stage: 'finished', flowStage: 'client_review', status: 'used', usedInPostId: 'p1', editorId: ME });
    expect(isOnEditorDesk(a, ME)).toBe(true);
  });

  it('已發布但剪輯師還沒按上傳雲端 → 看得到（要上傳才能請款）', () => {
    const a = asset({ vendorId: 'xb', stage: 'finished', flowStage: 'to_upload', status: 'used', usedInPostId: 'p1' });
    expect(isOnEditorDesk(a, ME)).toBe(true);
  });

  it('已上傳＋已發布、還沒請款 → 看得到（留在已完成）', () => {
    const a = asset({ vendorId: 'xb', stage: 'finished', flowStage: 'ready', approved: true, status: 'used', usedInPostId: 'p1', cloudUploadedAt: '2026-10-10T10:00:00+08:00' });
    expect(isOnEditorDesk(a, ME)).toBe(true);
  });

  it('作廢、內部剪、派給別人、封存未上傳、舊制已結清 → 看不到（對照組照舊）', () => {
    expect(isOnEditorDesk(asset({ vendorId: 'xb', voidedAt: '2026-10-01' }), ME)).toBe(false);
    expect(isOnEditorDesk(asset({ vendorId: 'xb', internalEdit: true }), ME)).toBe(false);
    expect(isOnEditorDesk(asset({ vendorId: 'xb', editorId: 'E2' }), ME)).toBe(false);
    expect(isOnEditorDesk(asset({ vendorId: 'xb', status: 'archived' }), ME)).toBe(false);
    expect(isOnEditorDesk(asset({ vendorId: 'xb', stage: 'finished', flowStage: 'to_upload', legacySettlementStatus: 'paid' }), ME)).toBe(false);
  });
});

describe('isFlowFinished', () => {
  it('上傳雲端或可排程才算走完；業主審核中、待上傳都還沒', () => {
    expect(isFlowFinished(asset({ vendorId: 'v', stage: 'finished', flowStage: 'client_review' }))).toBe(false);
    expect(isFlowFinished(asset({ vendorId: 'v', stage: 'finished', flowStage: 'to_upload' }))).toBe(false);
    expect(isFlowFinished(asset({ vendorId: 'v', stage: 'finished', flowStage: 'client_review', cloudUploadedAt: '2026-10-10' }))).toBe(true);
    expect(isFlowFinished(asset({ vendorId: 'v', stage: 'finished', flowStage: 'ready', approved: true }))).toBe(true);
  });
});
