import { describe, expect, it } from 'vitest';
import { getClientApprovalTarget } from '../assetFlow';

// 2026-11-03：內部剪的片業主通過後卡在「待上傳雲端」，永遠到不了小編
describe('業主通過後去哪 getClientApprovalTarget', () => {
  it('外包、還沒上傳 → 等剪輯師上傳雲端', () => expect(getClientApprovalTarget({})).toBe('to_upload'));
  it('外包、已上傳 → 可排程', () => expect(getClientApprovalTarget({ cloudUploadedAt: '2026-11-01T00:00:00Z' })).toBe('ready'));
  it('內部剪輯、沒上傳 → 直接可排程', () => expect(getClientApprovalTarget({}, true)).toBe('ready'));
});
