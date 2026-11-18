import { describe, expect, it } from 'vitest';
import { inClientMonth } from '../clientPortalData';

describe('inClientMonth：業主看的月份照上片日', () => {
  it('上片日在這個月就算，不管歸檔在哪個月（11-16 正式資料：好正點 11/1、11/3 歸在 10 月）', () => {
    expect(inClientMonth({ scheduledAt: '2026-11-03T20:00', targetMonth: '2026-10' }, '2026-11')).toBe(true);
    expect(inClientMonth({ scheduledAt: '2026-11-03T20:00', targetMonth: '2026-10' }, '2026-10')).toBe(false);
    expect(inClientMonth({ scheduledAt: '2026-10-31T20:00', targetMonth: '2026-11' }, '2026-10')).toBe(true);
  });
  it('還沒排上片日的照歸檔月份', () => {
    expect(inClientMonth({ scheduledAt: '', targetMonth: '2026-11' }, '2026-11')).toBe(true);
    expect(inClientMonth({ targetMonth: '2026-11' }, '2026-12')).toBe(false);
  });
});
