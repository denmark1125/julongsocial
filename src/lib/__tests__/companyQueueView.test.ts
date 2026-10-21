import { describe, expect, it } from 'vitest';
import { buildEditorQueue } from '../editorQueue';
import { editorQueueView } from '../companyQueue';
import { asset, day, demand } from './fixtures';

// 內部與剪輯師要一致：全公司只配一次，剪輯師只是看不到別人的片（10-21 謝謝 11 格對不起來）。
describe('editorQueueView', () => {
  it('那天配到內部剪的片：剪輯師清單沒有那列，但日曆知道那天「已安排」，不是沒片', () => {
    const demands = [demand('ys', day(10, 31)), demand('ys', day(11, 3))];
    const internal = asset({ vendorId: 'ys', id: 'int', internalEdit: true, editOrder: 1 });
    const mine = asset({ vendorId: 'ys', id: 'mine', editOrder: 2 });
    const all = buildEditorQueue({ demands, pendingAssets: [internal, mine] });
    const view = editorQueueView(all, a => a.id === 'mine');

    // 跟內部同一份配對：10/31 是內部那支、11/3 才是我的
    expect(view.rows.map(r => r.asset?.id)).toEqual(['mine']);
    expect(view.rows[0].date).toEqual(day(11, 3));
    expect([...view.othersKeys]).toEqual([demands[0].id]);
    expect(view.rows.some(r => r.kind === 'no_material')).toBe(false);
  });
});
