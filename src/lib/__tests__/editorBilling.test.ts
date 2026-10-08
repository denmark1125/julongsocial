import { describe, expect, it } from 'vitest';
import { findFee950Issues, getAssetFee, getBillingMonth, isBillable, feeForTier } from '../editorBilling';
import { EditorInvoice } from '../../types';
import { asset } from './fixtures';

// 剪輯費：60 秒以下 750、60 秒以上 900（over60 2026-10-03 從誤寫的 950 改回；under60 2026-10-05 誤改成 700、10-08 更正回 750）
// 特殊情況由主管逐片指定金額（editorFee），優先於分級價。

describe('剪輯費', () => {
  it('分級價：750／900', () => {
    expect(feeForTier('under60')).toBe(750);
    expect(feeForTier('over60')).toBe(900);
  });

  it('主管指定的特例金額優先於分級價（例如剪輯漲價）', () => {
    expect(getAssetFee({ editorFee: 1200, durationTier: 'under60' })).toBe(1200);
  });

  it('優先序：人工指定 editorFee → 分級價 → 預設 900', () => {
    expect(getAssetFee({ editorFee: 800, durationTier: 'over60' })).toBe(800);
    expect(getAssetFee({ editorFee: 0, durationTier: 'over60' })).toBe(0);
    expect(getAssetFee({ durationTier: 'under60' })).toBe(750);
    expect(getAssetFee({})).toBe(900);
  });

  it('壞掉的 editorFee（負數、NaN）不採用', () => {
    expect(getAssetFee({ editorFee: -1, durationTier: 'under60' })).toBe(750);
    expect(getAssetFee({ editorFee: Number.NaN })).toBe(900);
  });
});

describe('請款月份', () => {
  it('用台北時間判月份：9/1 凌晨 3 點上傳算 9 月，不是 8 月', () => {
    expect(getBillingMonth({ cloudUploadedAt: '2026-08-31T19:00:00.000Z' })).toBe('2026-09');
  });

  it('沒上傳過雲端就沒有請款月份', () => {
    expect(getBillingMonth({})).toBeNull();
  });
});

describe('isBillable', () => {
  const uploaded = '2026-09-15T10:00:00+08:00';

  it('切帳日後上傳、沒入單、沒作廢 → 可以請款', () => {
    expect(isBillable({ cloudUploadedAt: uploaded })).toBe(true);
  });

  it('作廢、已入單、沒上傳 → 不能請款', () => {
    expect(isBillable({ cloudUploadedAt: uploaded, voidedAt: '2026-09-20' })).toBe(false);
    expect(isBillable({ cloudUploadedAt: uploaded, editorInvoiceId: 'inv1' })).toBe(false);
    expect(isBillable({})).toBe(false);
  });

  it('切帳日前的存量片：只有確認「舊制尚未付」才轉入', () => {
    const before = '2026-08-15T10:00:00+08:00';
    expect(isBillable({ cloudUploadedAt: before })).toBe(false);
    expect(isBillable({ cloudUploadedAt: before, legacySettlementStatus: 'unpaid' })).toBe(true);
  });
});

describe('findFee950Issues', () => {
  const invoice = (id: string, status: EditorInvoice['status'], items: { assetId: string; amount: number }[]): EditorInvoice =>
    ({ id, status, items, editorId: 'e1' } as unknown as EditorInvoice);

  it('依付款狀態分組；只認「950 且 over60」', () => {
    const a1 = asset({ id: 'a1', vendorId: 'v', durationTier: 'over60', editorFee: 950, editorInvoiceId: 'i1' });
    const a2 = asset({ id: 'a2', vendorId: 'v', durationTier: 'under60', editorFee: 950, editorInvoiceId: 'i1' });
    const a3 = asset({ id: 'a3', vendorId: 'v', durationTier: 'over60', editorFee: 950, editorInvoiceId: 'i2' });
    const stray = asset({ id: 'a4', vendorId: 'v', durationTier: 'over60', editorFee: 950 });

    const r = findFee950Issues([
      invoice('i1', 'submitted', [{ assetId: 'a1', amount: 950 }, { assetId: 'a2', amount: 950 }]),
      invoice('i2', 'paid', [{ assetId: 'a3', amount: 950 }]),
      invoice('i3', 'void', [{ assetId: 'a4', amount: 950 }]),
    ], [a1, a2, a3, stray]);

    expect(r.unpaid.map(x => x.wrongAssetIds)).toEqual([['a1']]);
    expect(r.paid.map(x => x.wrongAssetIds)).toEqual([['a3']]);
    expect(r.processing).toEqual([]);
    expect(r.strayAssetIds).toEqual(['a4']);
  });
});
