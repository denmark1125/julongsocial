import { describe, expect, it } from 'vitest';
import { isAuditSkipped, withoutSkipped } from '../publishAudit';
import { auditCounts, buildAuditRows } from '../publishAuditRows';

// 11-18 廣信：FB 發在孝文個人帳號，系統查不到 → 不稽核、不計問題
describe('個人帳號平台不稽核', () => {
  it('helpers', () => {
    expect(isAuditSkipped(['FB'], 'FB')).toBe(true);
    expect(isAuditSkipped(['FB'], 'IG')).toBe(false);
    expect(isAuditSkipped(undefined, 'FB')).toBe(false);
    expect(withoutSkipped({ platforms: ['IG', 'FB', 'TikTok'] }, ['FB']).platforms).toEqual(['IG', 'TikTok']);
  });
  it('稽核列：FB 灰掉寫個人帳號，舊的「沒看到」不算問題', () => {
    const post: any = { id: 'p1', vendorId: 'v1', scheduledAt: '2026-11-17T20:00', platforms: ['IG', 'FB'],
      publishAudit: { FB: { status: 'not_seen', checkedAt: 'x', forScheduledAt: '2026-11-17T20:00' }, IG: { status: 'ok', checkedAt: 'x', forScheduledAt: '2026-11-17T20:00' } } };
    const vmap = new Map<string, any>([['v1', { id: 'v1', metaFbPageId: '1', auditSkipPlatforms: ['FB'] }]]);
    const [row] = buildAuditRows([post], vmap);
    const fb = row.cells.find(c => c.pf === 'FB')!;
    expect(fb.personal).toBe(true);
    expect(fb.status).toBe('unsupported');
    expect(auditCounts([row])).toEqual({ problem: 0, ok: 1, pending: 0 });
  });
});
