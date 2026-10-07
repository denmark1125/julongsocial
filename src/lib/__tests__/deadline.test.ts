import { describe, expect, it } from 'vitest';
import { customDeadline, deadlineStatus, deliveryDeadline, formatDeadline } from '../editorQueue';
import { day } from './fixtures';

// 交片期限＝上片日往前推 7 個工作天（docs/進度紀錄.md 2026-10-03 第三節第 2 點）

describe('deliveryDeadline', () => {
  it('10/10 上片 → 10/01（四）前交片', () => {
    expect(deliveryDeadline(day(10, 10))).toEqual(day(10, 1));
    expect(formatDeadline(deliveryDeadline(day(10, 10)))).toBe('10/01（四）前交片');
  });

  it('跳過週六日：10/13（二）上片 → 10/02（五）', () => {
    expect(deliveryDeadline(day(10, 13))).toEqual(day(10, 2));
  });

  it('上片日帶時間也一樣，只看日期', () => {
    expect(deliveryDeadline(new Date(2026, 9, 13, 18, 30))).toEqual(day(10, 2));
  });
});

describe('deadlineStatus 倒數顯示規則', () => {
  const now = new Date(2026, 9, 5, 10, 0);

  it('還有 4 天以上：灰色「剩 N 天」', () => {
    expect(deadlineStatus(day(10, 9), undefined, now)).toEqual({ text: '剩 4 天', tone: 'calm' });
  });

  it('剩 1～3 天：橘色', () => {
    expect(deadlineStatus(day(10, 8), undefined, now)).toEqual({ text: '剩 3 天', tone: 'soon' });
    expect(deadlineStatus(day(10, 6), undefined, now)).toEqual({ text: '剩 1 天', tone: 'soon' });
  });

  it('期限就是今天：橘色「今天」', () => {
    expect(deadlineStatus(day(10, 5), undefined, now)).toEqual({ text: '今天', tone: 'soon' });
  });

  it('已超過期限：紅色「已超過 N 天」', () => {
    expect(deadlineStatus(day(10, 2), '2026-09-20T09:00:00+08:00', now)).toEqual({ text: '已超過 3 天', tone: 'late' });
  });

  it('毛片建檔時期限就已經過了：橘色「盡快」，不怪剪輯師', () => {
    expect(deadlineStatus(day(10, 1), '2026-10-02T09:00:00+08:00', now)).toEqual({ text: '盡快', tone: 'soon' });
  });
});

describe('customDeadline 同事指定交片日', () => {
  it('有效日期就採用', () => {
    expect(customDeadline({ editDueDate: '2026-10-08' })).toEqual(day(10, 8));
  });

  it('沒填或格式壞掉就當沒填，不讓整份清單壞掉', () => {
    expect(customDeadline({})).toBeNull();
    expect(customDeadline({ editDueDate: '下週一' })).toBeNull();
    expect(customDeadline(undefined)).toBeNull();
  });
});
