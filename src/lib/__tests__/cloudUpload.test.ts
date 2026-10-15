import { describe, expect, it } from 'vitest';
import type { Asset } from '../../types';
import { buildCloudUploadUpdate, buildCloudUploadUndoUpdate, buildFlowUpdate, UPLOAD_IMPLIES_APPROVAL_NOTE } from '../assetFlow';

// 2026-10-15：剪輯師按上傳＝業主通過（公司流程是審片沒問題才請剪輯師上傳）。
const now = new Date('2026-10-15T06:00:00.000Z');
const reviewing = (): Asset => ({
  vendorId: 'v', title: 't', type: 'video', status: 'available', category: '其他', createdBy: 'u', createdAt: '2026-10-01T00:00:00.000Z',
  stage: 'finished', approved: false, flowStage: 'client_review',
  submittedBy: 'editor', submittedAt: '2026-10-13T00:00:00.000Z',
  flowLog: [{ from: 'to_edit', to: 'client_review', at: '2026-10-13T00:00:00.000Z' }],
} as Asset);
const apply = (a: Asset, u: Record<string, unknown>) => ({ ...a, ...u } as Asset);

describe('上傳雲端＝業主通過', () => {
  it('業主審核中按上傳 → 直接可排程（已審核）', () => {
    const u = buildCloudUploadUpdate(reviewing(), { now, byUid: 'editor' });
    expect(u.flowStage).toBe('ready');
    expect(u.approved).toBe(true);
    expect(u.cloudUploadedAt).toBe(now.toISOString());
  });

  it('業主先通過（待上傳）再按上傳 → 可排程', () => {
    const a = apply(reviewing(), buildFlowUpdate(reviewing(), 'to_upload', { now }));
    expect(buildCloudUploadUpdate(a, { now }).flowStage).toBe('ready');
  });

  it('上傳順便通過的，撤回上傳要一起收回通過（回業主審核中），送審人時間不變', () => {
    const a = apply(reviewing(), buildCloudUploadUpdate(reviewing(), { now, byUid: 'editor' }));
    const u = buildCloudUploadUndoUpdate(a, { now, byUid: 'editor' });
    expect(u.flowStage).toBe('client_review');
    expect(u.approved).toBe(false);
    expect(u.cloudUploadedAt).toBe('');
    expect(u.submittedAt).toBeUndefined();
    expect(u.submittedBy).toBeUndefined();
  });

  it('對照組：我們先按通過、剪輯師後傳的，撤回上傳只退到待上傳（通過保留）', () => {
    const passed = apply(reviewing(), buildFlowUpdate(reviewing(), 'to_upload', { now }));
    const a = apply(passed, buildCloudUploadUpdate(passed, { now }));
    expect((a.flowLog ?? []).at(-1)?.note).not.toBe(UPLOAD_IMPLIES_APPROVAL_NOTE);
    expect(buildCloudUploadUndoUpdate(a, { now }).flowStage).toBe('to_upload');
  });

  it('主管取消審核回到業主審核中，不會把送審人改成主管', () => {
    const passed = apply(reviewing(), buildFlowUpdate(reviewing(), 'to_upload', { now }));
    const u = buildFlowUpdate(passed, 'client_review', { now, byUid: 'manager' });
    expect(u.submittedBy).toBeUndefined();
    expect(u.submittedAt).toBeUndefined();
  });

  it('對照組：真的交片送審還是會記送審人', () => {
    const raw = { ...reviewing(), stage: 'raw', flowStage: 'to_edit' } as Asset;
    expect(buildFlowUpdate(raw, 'client_review', { now, byUid: 'editor' }).submittedBy).toBe('editor');
  });
});
