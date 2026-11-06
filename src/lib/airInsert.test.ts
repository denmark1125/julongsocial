import { describe, expect, it } from 'vitest';
import { planInsert } from './airInsert';

const it_ = (id: string, day: string, movable = true) => ({ id, day, movable });

describe('planInsert 排上片日插隊', () => {
  it('使用者的例子：11/1 A、11/2 B、11/3 C，D 插 11/2 → B 到 11/3、C 到下一個發片日', () => {
    const plan = planInsert('2026-11-02', [it_('A', '2026-11-01'), it_('B', '2026-11-02'), it_('C', '2026-11-03')],
      ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05']);
    expect(plan).toEqual({ ok: true, moves: [
      { id: 'B', from: '2026-11-02', to: '2026-11-03' },
      { id: 'C', from: '2026-11-03', to: '2026-11-05' },
    ] });
  });

  it('後面有空的發片日就停：只搬需要搬的', () => {
    const plan = planInsert('2026-11-02', [it_('B', '2026-11-02'), it_('C', '2026-11-10')],
      ['2026-11-02', '2026-11-04', '2026-11-10']);
    expect(plan.ok && plan.moves).toEqual([{ id: 'B', from: '2026-11-02', to: '2026-11-04' }]);
  });

  it('插在空的日子：什麼都不用搬', () => {
    const plan = planInsert('2026-11-02', [it_('C', '2026-11-03')], ['2026-11-02', '2026-11-03']);
    expect(plan).toEqual({ ok: true, moves: [] });
  });

  it('已經在後台排好的貼文不動，跳過那天', () => {
    const plan = planInsert('2026-11-02', [it_('B', '2026-11-02'), it_('C', '2026-11-03', false), it_('E', '2026-11-05')],
      ['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-07']);
    expect(plan.ok && plan.moves).toEqual([
      { id: 'B', from: '2026-11-02', to: '2026-11-05' },
      { id: 'E', from: '2026-11-05', to: '2026-11-07' },
    ]);
  });

  it('那天本身的貼文已排好：不能插', () => {
    const plan = planInsert('2026-11-02', [it_('B', '2026-11-02', false)], ['2026-11-02', '2026-11-03']);
    expect(plan.ok).toBe(false);
  });

  it('有小編貼文在等片的日子跳過', () => {
    const plan = planInsert('2026-11-02', [it_('B', '2026-11-02')], ['2026-11-02', '2026-11-03', '2026-11-04'], new Set(['2026-11-03']));
    expect(plan.ok && plan.moves).toEqual([{ id: 'B', from: '2026-11-02', to: '2026-11-04' }]);
  });

  it('沒設發片日的 IP：最後一支往後一週', () => {
    const plan = planInsert('2026-11-02', [it_('B', '2026-11-02')], []);
    expect(plan.ok && plan.moves).toEqual([{ id: 'B', from: '2026-11-02', to: '2026-11-09' }]);
  });

  it('同一天兩支一起往後', () => {
    const plan = planInsert('2026-11-02', [it_('B', '2026-11-02'), it_('B2', '2026-11-02')], ['2026-11-02', '2026-11-04']);
    expect(plan.ok && plan.moves.map(m => `${m.id}>${m.to}`)).toEqual(['B>2026-11-04', 'B2>2026-11-04']);
  });
});
