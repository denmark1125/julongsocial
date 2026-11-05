import { describe, expect, it } from 'vitest';
import { NOTIFY_KINDS, resolveNotifyMode } from '../notify/kinds';

describe('通知中心規則', () => {
  it('搬家不改行為：剪輯群組照發、發布稽核照發', () => {
    expect(resolveNotifyMode('editor_review', {}, false)).toBe('live');
    expect(resolveNotifyMode('editor_reminder', {}, false)).toBe('live');
    expect(resolveNotifyMode('publish_audit', {}, false)).toBe('live');
  });

  it('搬家不改行為：舊的個人通知跟著 LINE_PERSONAL_PUSH 總開關（現在是關）', () => {
    for (const k of ['stock_alert', 'flow_digest', 'flow_event', 'shoot_sync_alert']) {
      expect(resolveNotifyMode(k, {}, false)).toBe('off');
      expect(resolveNotifyMode(k, {}, true)).toBe('live');
    }
  });

  it('畫面上改過就以畫面為準（不管總開關）', () => {
    expect(resolveNotifyMode('stock_alert', { stock_alert: { mode: 'live' } }, false)).toBe('live');
    expect(resolveNotifyMode('editor_review', { editor_review: { mode: 'off' } }, false)).toBe('off');
  });

  it('對客戶的新通知預設測試；規劃中的就算被設成正式也只到測試', () => {
    expect(resolveNotifyMode('air_notice', {}, true)).toBe('test');
    expect(resolveNotifyMode('air_notice', { air_notice: { mode: 'live' } }, true)).toBe('test');
    expect(resolveNotifyMode('monthly_billing', {}, true)).toBe('off');
  });

  it('沒登記的通知一律不發', () => {
    expect(resolveNotifyMode('nope', {}, true)).toBe('off');
  });

  it('對客戶的通知預設都不是正式（避免一上線就發給客戶）', () => {
    for (const k of NOTIFY_KINDS.filter(k => k.audience === 'client')) {
      expect(k.defaultMode === 'live').toBe(false);
    }
  });
});
