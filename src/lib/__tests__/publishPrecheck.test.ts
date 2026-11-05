import { describe, expect, it } from 'vitest';
import { precheckAll, precheckOne, unmatchedCards, type VendorCalendar } from '../publishPrecheck';

// 11-05 實測：又生 20:00 已在 Business Suite 排好 FB＋IG；好正點 20:00 還沒排
const cal: Record<string, VendorCalendar> = {
  yasun: { ok: true, cards: [
    { date: '2026-11-05', time: '11:39', platform: 'FB', status: '現存' },
    { date: '2026-11-05', time: '20:00', platform: 'FB' },
    { date: '2026-11-05', time: '20:00', platform: 'IG' },
  ] },
  hozen: { ok: true, cards: [] },
  tea: { ok: false, error: 'Meta 登入過期' },
};
const post = (vendorId: string, scheduledAt: string, platforms = ['IG', 'TikTok', 'FB']) => ({ id: vendorId, vendorId, scheduledAt, platforms });

describe('precheck', () => {
  it('又生 20:00 FB/IG 都排好了 → 已排好；TikTok 不在 Meta 範圍不列', () => {
    const rows = precheckAll([post('yasun', '2026-11-05T20:00')], cal);
    expect(rows.map(r => `${r.platform}:${r.result.status}`)).toEqual(['IG:scheduled', 'FB:scheduled']);
  });

  it('好正點 Meta 上還沒排 → 還沒排', () => {
    expect(precheckOne(post('hozen', '2026-11-05T20:00'), 'IG', cal.hozen).status).toBe('not_scheduled');
  });

  it('Meta 排 20:00、系統寫 19:00 → 時間不同', () => {
    const r = precheckOne(post('yasun', '2026-11-05T19:00'), 'FB', cal.yasun);
    expect(r.status).toBe('time_diff');
    expect(r.metaTime).toBe('20:00');
  });

  it('機器人讀不到這家（登入過期）→ 讀不到，不能當成還沒排', () => {
    expect(precheckOne(post('tea', '2026-11-05T19:00'), 'IG', cal.tea).status).toBe('unreadable');
  });

  it('同一家同一天兩支、Meta 只排一支 → 第二支算還沒排（卡片不重複配、早上已發的那則不算）', () => {
    const rows = precheckAll([post('yasun', '2026-11-05T20:00', ['FB']), post('yasun-2', '2026-11-05T20:10', ['FB'])].map(p => ({ ...p, vendorId: 'yasun' })), cal);
    expect(rows.map(r => r.result.status)).toEqual(['scheduled', 'not_scheduled']);
  });
});

describe('Meta 有排、系統沒有', () => {
  it('CWORKS 11/5 Meta 20:00 排了 IG，系統當天沒排程 → 列出來；早上已發的不算', () => {
    const c: Record<string, VendorCalendar> = { cworks: { ok: true, cards: [
      { date: '2026-11-05', time: '11:05', platform: 'IG', status: '現存' },
      { date: '2026-11-05', time: '20:00', platform: 'IG' },
    ] } };
    const x = unmatchedCards([], c, '2026-11-05', '17:30');
    expect(x.map(e => `${e.vendorId} ${e.card.time} ${e.card.platform}`)).toEqual(['cworks 20:00 IG']);
  });

  it('又生 20:00 有對應排程 → 不列', () => {
    expect(unmatchedCards([post('yasun', '2026-11-05T20:00')].map(p => ({ ...p, vendorId: 'yasun' })), { yasun: cal.yasun }, '2026-11-05', '17:30')).toEqual([]);
  });
});
