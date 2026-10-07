import { describe, expect, it } from 'vitest';
import { buildEditorQueue } from '../editorQueue';
import { compareRawEditOrder, compareUploadOrder } from '../editOrder';
import { asset, day, demand } from './fixtures';

// 同事排的剪輯順序＝配上片日的順序：第 1 支配這個 IP 最近的上片日。
const SAME_BATCH = '2026-10-01T10:00:00+08:00';

/** 每一支待剪片配到哪一天（只看有日子的列） */
const datesOf = (q: ReturnType<typeof buildEditorQueue>) =>
  Object.fromEntries(q.rows.filter(r => r.kind === 'to_edit' && r.date).map(r => [r.asset!.title, r.date]));

describe('剪輯順序', () => {
  it('同一批（同一個 createdAt）照上片時排的順序配上片日，不照資料庫回傳順序', () => {
    const demands = [demand('xy', day(10, 10)), demand('xy', day(10, 13))];
    // 故意讓 id 順序跟 batchIndex 相反：以前同一批是照 id（等於隨機）
    const second = asset({ vendorId: 'xy', id: 'a_first_by_id', title: '第二支', createdAt: SAME_BATCH, batchIndex: 1 });
    const first = asset({ vendorId: 'xy', id: 'z_last_by_id', title: '第一支', createdAt: SAME_BATCH, batchIndex: 0 });

    const q = buildEditorQueue({ demands, pendingAssets: [second, first] });

    expect(datesOf(q)).toEqual({ 第一支: day(10, 10), 第二支: day(10, 13) });
  });

  it('事後調過順序的新片插到舊片前面，拿到最近的上片日', () => {
    const demands = [demand('xy', day(10, 10)), demand('xy', day(10, 13))];
    const old = asset({ vendorId: 'xy', title: '舊片', createdAt: '2026-09-01T00:00:00+08:00', editOrder: 2 });
    const fresh = asset({ vendorId: 'xy', title: '新片', createdAt: '2026-10-05T00:00:00+08:00', editOrder: 1 });

    const q = buildEditorQueue({ demands, pendingAssets: [old, fresh] });

    expect(datesOf(q)).toEqual({ 新片: day(10, 10), 舊片: day(10, 13) });
  });

  it('調過順序的排在沒調過的前面；沒調過的照上片時間', () => {
    const untouchedOld = asset({ vendorId: 'xy', title: 'u', createdAt: '2026-08-01T00:00:00+08:00' });
    const ordered = asset({ vendorId: 'xy', title: 'o', createdAt: '2026-10-05T00:00:00+08:00', editOrder: 5 });
    const untouchedNew = asset({ vendorId: 'xy', title: 'n', createdAt: '2026-09-01T00:00:00+08:00' });

    const sorted = [untouchedNew, untouchedOld, ordered].sort(compareRawEditOrder).map(a => a.title);

    expect(sorted).toEqual(['o', 'u', 'n']);
  });

  it('急件永遠最前，就算別支被排成第 1', () => {
    const demands = [demand('xy', day(10, 10)), demand('xy', day(10, 13))];
    const ranked = asset({ vendorId: 'xy', title: '排第一', editOrder: 1 });
    const urgent = asset({ vendorId: 'xy', title: '急件', isUrgent: true, createdAt: '2026-10-06T00:00:00+08:00' });

    expect([ranked, urgent].sort(compareRawEditOrder).map(a => a.title)).toEqual(['急件', '排第一']);
    const q = buildEditorQueue({ demands, pendingAssets: [ranked, urgent] });
    expect(datesOf(q)).toEqual({ 急件: day(10, 10), 排第一: day(10, 13) });
  });

  it('成片庫存的排序不看 editOrder（片交出去之後它還留在文件上）', () => {
    const a = asset({ vendorId: 'xy', title: 'A', createdAt: '2026-09-01T00:00:00+08:00', editOrder: 9 });
    const b = asset({ vendorId: 'xy', title: 'B', createdAt: '2026-09-02T00:00:00+08:00', editOrder: 1 });

    expect([b, a].sort(compareUploadOrder).map(x => x.title)).toEqual(['A', 'B']);
  });

  it('沒人排過順序、各自不同時間建檔：跟改之前一樣照建檔時間', () => {
    const demands = [demand('xy', day(10, 10)), demand('xy', day(10, 13))];
    const older = asset({ vendorId: 'xy', title: '早', createdAt: '2026-09-01T00:00:00+08:00' });
    const newer = asset({ vendorId: 'xy', title: '晚', createdAt: '2026-09-15T00:00:00+08:00' });

    const q = buildEditorQueue({ demands, pendingAssets: [newer, older] });

    expect(datesOf(q)).toEqual({ 早: day(10, 10), 晚: day(10, 13) });
  });
});
