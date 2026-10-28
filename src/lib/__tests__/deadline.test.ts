import { describe, expect, it } from 'vitest';
import { customDeadline, deadlineSince, deadlineStatus, deliveryDeadline, formatDeadline } from '../editorQueue';
import { day } from './fixtures';

// 送審日＝上片日往前推 2 個日曆天（T−1 客戶審完、T−2 剪輯師送審，2026-10-28 定案；取代 10-20 的 9 天）

describe('deliveryDeadline', () => {
  it('10/30 上片 → 10/28（三）送審', () => {
    expect(deliveryDeadline(day(10, 30))).toEqual(day(10, 28));
    expect(formatDeadline(deliveryDeadline(day(10, 30)))).toBe('10/28（三）送審');
  });

  it('週末照算，不跳過：11/2（一）上片 → 10/31（六）', () => {
    expect(deliveryDeadline(day(11, 2))).toEqual(day(10, 31));
  });

  it('上片日帶時間也一樣，只看日期', () => {
    expect(deliveryDeadline(new Date(2026, 9, 30, 18, 30))).toEqual(day(10, 28));
  });
});

describe('deadlineStatus 倒數顯示規則（10-28：灰→藍→紅）', () => {
  const now = new Date(2026, 9, 5, 10, 0);

  it('還有 6 天以上：灰色', () => {
    expect(deadlineStatus(day(10, 11), undefined, now)).toEqual({ text: '還有 6 天', tone: 'later' });
  });

  it('前 5 天內：藍色，不是警告色', () => {
    expect(deadlineStatus(day(10, 10), undefined, now)).toEqual({ text: '還有 5 天', tone: 'window' });
    expect(deadlineStatus(day(10, 6), undefined, now)).toEqual({ text: '還有 1 天', tone: 'window' });
  });

  it('送審日當天：仍是藍色「今天」', () => {
    expect(deadlineStatus(day(10, 5), undefined, now)).toEqual({ text: '今天', tone: 'window' });
  });

  it('過了才紅色「已超過 N 天」', () => {
    expect(deadlineStatus(day(10, 4), '2026-09-20T09:00:00+08:00', now)).toEqual({ text: '已超過 1 天', tone: 'late' });
    expect(deadlineStatus(day(10, 2), '2026-09-20T09:00:00+08:00', now)).toEqual({ text: '已超過 3 天', tone: 'late' });
  });

  it('毛片建檔時期限就已經過了：橘色「盡快」，不怪剪輯師', () => {
    expect(deadlineStatus(day(10, 1), '2026-10-02T09:00:00+08:00', now)).toEqual({ text: '盡快', tone: 'asap' });
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

describe('deadlineSince 起算時間（2026-10-22）', () => {
  it('上片日排得晚：期限在排的時候就過了 → 盡快，不是已超過', () => {
    const since = deadlineSince({ createdAt: '2026-10-15T09:00:00+08:00', plannedAirSetAt: '2026-10-21T10:00:00+08:00' });
    expect(deadlineStatus(day(10, 16), since, new Date(2026, 9, 22, 10))).toEqual({ text: '盡快', tone: 'asap' });
  });

  it('排的時候還來得及、後來才過期 → 已超過', () => {
    const since = deadlineSince({ createdAt: '2026-10-15T09:00:00+08:00', plannedAirSetAt: '2026-10-21T10:00:00+08:00' });
    expect(deadlineStatus(day(10, 25), since, new Date(2026, 9, 27, 10))).toEqual({ text: '已超過 2 天', tone: 'late' });
  });

  it('9 天規則 10/20 上路前就過了的期限 → 盡快（例：祥濱系統補 10/24 那格，期限 10/15）', () => {
    const since = deadlineSince({ createdAt: '2026-10-02T09:00:00+08:00' });
    expect(deadlineStatus(day(10, 15), since, new Date(2026, 9, 22, 10))).toEqual({ text: '盡快', tone: 'asap' });
  });

  it('同事指定的交片日不吃寬限，只看建檔時間', () => {
    const asset = { createdAt: '2026-10-02T09:00:00+08:00', plannedAirSetAt: '2026-10-21T10:00:00+08:00', editDueDate: '2026-10-15' };
    expect(deadlineSince(asset)).toBe('2026-10-02T09:00:00+08:00');
    expect(deadlineStatus(day(10, 15), deadlineSince(asset), new Date(2026, 9, 22, 10)).tone).toBe('late');
  });
});
