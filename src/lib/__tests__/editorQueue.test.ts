import { describe, expect, it } from 'vitest';
import { buildEditorQueue, EditorQueue } from '../editorQueue';
import { DemandItem } from '../materialSupply';
import { asset, day, demand } from './fixtures';

// 剪輯師「現在該剪哪一支」的清單。每一條都是老闆實際打回來過的情境（見 editorQueue.ts 的註解）。

/** 守恆律：每個影片需求恰好落在 rows／stocked／settled 其中一袋，不多不少、不重複 */
function expectConservation(demands: DemandItem[], q: EditorQueue) {
  const videoIds = demands.filter(d => d.contentType === 'video').map(d => d.id).sort();
  const datedRows = q.rows.filter(r => r.date !== null); // 急件／指定交片日但沒配到日子的列不對應任何需求
  const seen = [...datedRows, ...q.stocked, ...q.settled].map(r => r.key).sort();
  expect(seen).toEqual(videoIds);
  expect(new Set(seen).size).toBe(seen.length);
}

describe('buildEditorQueue', () => {
  it('祥濱有成片庫存：最近的日子給成片，毛片排到後面，不能消失', () => {
    const demands = [demand('xb', day(10, 3)), demand('xb', day(10, 6)), demand('xb', day(10, 10))];
    const stock = asset({ vendorId: 'xb', stage: 'finished', submittedAt: '2026-09-20T00:00:00+08:00' });
    const raw = asset({ vendorId: 'xb', title: '朱府千歲' });

    const q = buildEditorQueue({ demands, pendingAssets: [raw], deliveredAssets: [stock] });

    expect(q.stocked.map(r => r.date)).toEqual([day(10, 3)]);
    const toEdit = q.rows.filter(r => r.kind === 'to_edit');
    expect(toEdit).toHaveLength(1);
    expect(toEdit[0].asset?.id).toBe(raw.id);
    expect(toEdit[0].date).toEqual(day(10, 6));
    expectConservation(demands, q);
  });

  it('自然風 10/06：1 支待剪＋2 支已交片，10/06 是「等排程」不是「沒片」', () => {
    const demands = [demand('zrf', day(10, 3)), demand('zrf', day(10, 6)), demand('zrf', day(10, 10))];
    const delivered = [
      asset({ vendorId: 'zrf', stage: 'finished', submittedAt: '2026-09-25T00:00:00+08:00' }),
      asset({ vendorId: 'zrf', stage: 'finished', submittedAt: '2026-09-26T00:00:00+08:00' }),
    ];
    const raw = asset({ vendorId: 'zrf' });

    const q = buildEditorQueue({ demands, pendingAssets: [raw], deliveredAssets: delivered });

    const oct6 = [...q.rows, ...q.stocked].find(r => r.date?.getTime() === day(10, 6).getTime());
    expect(oct6?.kind).toBe('has_stock');
    expect(q.rows.find(r => r.kind === 'no_material')).toBeUndefined();
    expect(q.rows.find(r => r.kind === 'to_edit')?.date).toEqual(day(10, 10));
    expectConservation(demands, q);
  });

  it('「沒片」不沉到最後：照期限排，比後面有片的日子早就排前面', () => {
    const demands = [demand('yb', day(10, 3)), demand('gx', day(10, 20))];
    const raw = asset({ vendorId: 'gx' });

    const q = buildEditorQueue({ demands, pendingAssets: [raw] });

    expect(q.rows.map(r => r.kind)).toEqual(['no_material', 'to_edit']);
    expectConservation(demands, q);
  });

  it('急件就算沒配到上片日，也要進主清單而且排第一', () => {
    const demands = [demand('a', day(10, 6))];
    const first = asset({ vendorId: 'a', createdAt: '2026-09-01T00:00:00+08:00' });
    const urgent = asset({ vendorId: 'b', isUrgent: true });

    const q = buildEditorQueue({ demands, pendingAssets: [first, urgent] });

    expect(q.rows[0].asset?.id).toBe(urgent.id);
    expect(q.rows[0].urgent).toBe(true);
    expect(q.rows[0].date).toBeNull();
    expect(q.unassigned).toHaveLength(0);
    expectConservation(demands, q);
  });

  it('同事指定交片日的毛片沒配到日子，也進主清單並標 custom', () => {
    const due = asset({ vendorId: 'a', editDueDate: '2026-10-08' });

    const q = buildEditorQueue({ demands: [], pendingAssets: [due] });

    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].deadlineSource).toBe('custom');
    expect(q.rows[0].deadline).toEqual(day(10, 8));
  });

  it('成片比日子多：毛片要全部留在「還沒排到上片日」，不能被 slice(負數) 吃掉', () => {
    const demands = [demand('a', day(10, 6))];
    // 毛片數要大於「成片 − 日子」的差，錯誤的 slice(-1) 才會只留下最後一支
    const delivered = [asset({ vendorId: 'a', stage: 'finished' }), asset({ vendorId: 'a', stage: 'finished' })];
    const raws = [asset({ vendorId: 'a' }), asset({ vendorId: 'a' }), asset({ vendorId: 'a' })];

    const q = buildEditorQueue({ demands, pendingAssets: raws, deliveredAssets: delivered });

    expect(q.unassigned.map(a => a.id).sort()).toEqual(raws.map(a => a.id).sort());
    expectConservation(demands, q);
  });

  it('已掛好素材的日子進 settled，圖文需求不進任何一袋', () => {
    const demands = [
      demand('a', day(10, 3), { attachedAssetId: 'x' }),
      demand('a', day(10, 4), { contentType: 'post' }),
      demand('a', day(10, 6)),
    ];

    const q = buildEditorQueue({ demands, pendingAssets: [] });

    expect(q.settled.map(r => r.date)).toEqual([day(10, 3)]);
    expect(q.rows.map(r => r.kind)).toEqual(['no_material']);
    expectConservation(demands, q);
  });

  it('毛片照急件 → 建檔時間由舊到新配日子；交片日不參與配對', () => {
    const demands = [demand('a', day(10, 6)), demand('a', day(10, 13))];
    const older = asset({ vendorId: 'a', createdAt: '2026-09-01T00:00:00+08:00', editDueDate: '2026-10-30' });
    const newer = asset({ vendorId: 'a', createdAt: '2026-09-10T00:00:00+08:00' });

    const q = buildEditorQueue({ demands, pendingAssets: [newer, older] });

    const byDate = Object.fromEntries(q.rows.map(r => [r.date!.getDate(), r.asset?.id]));
    expect(byDate[6]).toBe(older.id);
    expect(byDate[13]).toBe(newer.id);
  });

  it('守恆律：多個 IP 混合的情境', () => {
    const demands = [
      demand('a', day(10, 3)), demand('a', day(10, 6), { attachedAssetId: 'p1' }), demand('a', day(10, 10)),
      demand('b', day(10, 3)), demand('b', day(10, 7)),
      demand('c', day(10, 9)), demand('c', day(10, 9), { contentType: 'post' }),
    ];
    const q = buildEditorQueue({
      demands,
      pendingAssets: [asset({ vendorId: 'a' }), asset({ vendorId: 'b' }), asset({ vendorId: 'b' }), asset({ vendorId: 'b', isUrgent: true })],
      deliveredAssets: [asset({ vendorId: 'a', stage: 'finished' }), asset({ vendorId: 'c', stage: 'finished' })],
    });
    expectConservation(demands, q);
  });
});
