import { describe, expect, it } from 'vitest';
import { publishMarkUpdate } from '../publishAuditJob';

const now = new Date('2026-11-05T12:06:00Z');
const ok = (s = 'ok') => ({ status: s as any, checkedAt: '', forScheduledAt: '2026-11-05T20:00' });
const post = (over: any = {}) => ({ id: 'p', status: 'scheduled', scheduledAt: '2026-11-05T20:00', platforms: ['IG', 'FB'], internalConfirmed: true, clientConfirmed: true, ...over });
const meta = { fbPageId: 'x' };
const both = { fbPageId: 'x', tiktokBsId: 'y' };

describe('發布成功自動改已發布', () => {
  it('IG、FB 都確認 → 勾平台＋改綠色', () => {
    const u = publishMarkUpdate(post(), meta, { IG: ok(), FB: ok('time_mismatch') }, now)!;
    expect(u.status).toBe('published');
    expect(u.publishedPlatforms).toEqual(['IG', 'FB']);
    expect(u.autoPublished.missingConfirm).toBe(false);
  });

  it('IG/FB 確認了、TikTok 還沒查 → 當晚就改綠色（TikTok 不擋，週末也能變綠）', () => {
    const u = publishMarkUpdate(post({ platforms: ['IG', 'TikTok', 'FB'] }), both, { IG: ok(), FB: ok() }, now)!;
    expect(u.publishedPlatforms).toEqual(['IG', 'FB']);
    expect(u.status).toBe('published');
  });

  it('隔天 TikTok 確認 → 只補勾 TikTok', () => {
    const p = post({ status: 'published', platforms: ['IG', 'TikTok', 'FB'], publishedPlatforms: ['IG', 'FB'], publishAudit: { IG: ok(), FB: ok() } });
    expect(publishMarkUpdate(p, both, { TikTok: ok() }, now)).toEqual({ publishedPlatforms: ['IG', 'FB', 'TikTok'] });
  });

  it('只發 TikTok 的 IP（祥濱）→ TikTok 確認才改綠色', () => {
    expect(publishMarkUpdate(post({ platforms: ['TikTok'] }), { tiktokBsId: 'y' }, {}, now)).toBeNull();
    expect(publishMarkUpdate(post({ platforms: ['TikTok'] }), { tiktokBsId: 'y' }, { TikTok: ok() }, now)!.status).toBe('published');
  });

  it('YouTube 查不到不擋（廣信）', () => {
    expect(publishMarkUpdate(post({ platforms: ['IG', 'FB', 'YT'] }), meta, { IG: ok(), FB: ok() }, now)!.status).toBe('published');
  });

  it('沒勾審核照改，但標「發了但沒勾審核」', () => {
    expect(publishMarkUpdate(post({ clientConfirmed: false }), meta, { IG: ok(), FB: ok() }, now)!.autoPublished.missingConfirm).toBe(true);
  });

  it('文案對不上／發錯帳號／還沒看到 → 不算發成功', () => {
    for (const s of ['content_mismatch', 'wrong_account', 'not_seen']) {
      expect(publishMarkUpdate(post(), meta, { IG: ok(s), FB: ok() }, now)?.status).toBeUndefined();
    }
  });

  it('排程時間改過的舊結果不算', () => {
    expect(publishMarkUpdate(post(), meta, { IG: { ...ok(), forScheduledAt: '2026-11-05T19:00' }, FB: ok() }, now)?.status).toBeUndefined();
  });

  it('已經是已發布 → 不重寫', () => {
    expect(publishMarkUpdate(post({ status: 'published', publishedPlatforms: ['IG', 'FB'] }), meta, { IG: ok(), FB: ok() }, now)).toBeNull();
  });
});
