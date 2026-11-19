import { describe, it, expect } from 'vitest';
import { diffText, diffChanges, diffSummaryLines } from '../textDiff';

const rebuild = (parts: ReturnType<typeof diffText>, side: 'before' | 'after') =>
  parts.filter(p => p.type === 'same' || p.type === (side === 'before' ? 'del' : 'add')).map(p => p.text).join('');

describe('diffText', () => {
  it('兩邊都還原得回來', () => {
    const a = '憑手環進場就送伴手禮🎁\n價格 39,800 元\n最後一句';
    const b = '憑手環進場就送超豐富伴手禮🎁\n價格 39,900 元';
    const d = diffText(a, b);
    expect(rebuild(d, 'before')).toBe(a);
    expect(rebuild(d, 'after')).toBe(b);
  });

  it('改數字不會碎成好幾段', () => {
    expect(diffChanges('價格 39,800 元', '價格 39,900 元')).toEqual([{ del: '8', add: '9' }]);
    expect(diffChanges('價格 12,345 元', '價格 13,355 元')).toEqual([{ del: '2,34', add: '3,35' }]);
  });

  it('一樣的文字沒有改動', () => {
    expect(diffChanges('一樣', '一樣')).toEqual([]);
  });

  it('整篇重寫（很長）直接當整段換掉', () => {
    const a = '甲'.repeat(2000), b = '乙'.repeat(2000);
    expect(diffChanges(a, b)).toEqual([{ del: a, add: b }]);
  });
});

describe('diffSummaryLines', () => {
  it('改、刪、加各一句；太長截斷；超過 3 處寫還有幾處', () => {
    expect(diffSummaryLines('價格 39,800 元', '價格 39,900 元')).toEqual(['「39,800 元」改成「39,900 元」']);
    expect(diffSummaryLines('第一句。最後一句拿掉', '第一句。')).toEqual(['刪掉「最後一句拿掉」']);
    expect(diffSummaryLines('A', 'A #新標籤')).toEqual(['加上「 #新標籤」'.replace('「 ', '「')]);
    expect(diffSummaryLines('就送伴手禮', '就送超豐富伴手禮')).toEqual(['「就送伴手禮」改成「就送超豐富伴手禮」']);
    const lines = diffSummaryLines('一a二二二b三三三c四四四d五', '一X二二二Y三三三Z四四四W五');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('…還有 1 處');
  });
});
