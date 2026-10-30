import { describe, expect, it } from 'vitest';
import { pickBookingToResolve, planShootSync, toTaipeiDateTime } from '../shootSync';
import type { ShootBooking } from '../../types';

const NOW = '2026-10-29T12:00:00.000Z';
const TODAY = '2026-10-29';
// 2026-11-04 14:00 台北＝06:00Z
const nov4at14 = Date.parse('2026-11-04T06:00:00Z');
const up = (over = {}) => ({ uuid: 'u1', action: 'upsert' as const, title: '大發拍攝-Kai', vendorName: '大發超哥', startAt: nov4at14, allDay: false, ...over });
const bk = (over: Partial<ShootBooking>): ShootBooking => ({
  id: 'b1', vendorId: 'v1', scheduledDate: '2026-11-04', status: 'booked', bookedByUid: 'x', bookedByName: '小編', createdAt: NOW, ...over,
});

describe('toTaipeiDateTime', () => {
  it('有時間：換台北時間', () => expect(toTaipeiDateTime(nov4at14, false)).toEqual({ date: '2026-11-04', time: '14:00' }));
  it('台北凌晨跨日', () => expect(toTaipeiDateTime(Date.parse('2026-11-03T17:30:00Z'), false)).toEqual({ date: '2026-11-04', time: '01:30' }));
  it('整天：UTC 午夜當日期、沒時間', () => expect(toTaipeiDateTime(Date.parse('2026-11-04T00:00:00Z'), true)).toEqual({ date: '2026-11-04' }));
});

describe('planShootSync 新增', () => {
  it('沒有任何預約 → 新建 TimeTree 來源', () => {
    const p = planShootSync(up(), 'v1', [], TODAY, NOW);
    expect(p.op).toBe('create');
    if (p.op !== 'create') return;
    expect(p.data).toMatchObject({ vendorId: 'v1', scheduledDate: '2026-11-04', startTime: '14:00', source: 'timetree', timetreeUuid: 'u1', status: 'booked', bookedByName: 'TimeTree' });
  });
  it('整天行程不寫 startTime（Firestore 不能有 undefined）', () => {
    const p = planShootSync(up({ allDay: true, startAt: Date.parse('2026-11-04T00:00:00Z') }), 'v1', [], TODAY, NOW);
    expect(p.op === 'create' && 'startTime' in p.data).toBe(false);
  });
  it('不是系統內 IP → 不動', () => expect(planShootSync(up(), null, [], TODAY, NOW).op).toBe('none'));
  it('過去的行程不新建', () => expect(planShootSync(up({ startAt: Date.parse('2026-10-01T06:00:00Z') }), 'v1', [], TODAY, NOW).op).toBe('none'));
  it('同 IP 同天已手動約 → 合併，不變兩筆', () => {
    const p = planShootSync(up(), 'v1', [bk({ id: 'm1' })], TODAY, NOW);
    expect(p).toMatchObject({ op: 'update', id: 'm1', data: { timetreeUuid: 'u1', startTime: '14:00' } });
  });
  it('手動約的是別天 → 另建（對照組）', () => expect(planShootSync(up(), 'v1', [bk({ scheduledDate: '2026-11-05' })], TODAY, NOW).op).toBe('create'));
  it('手動約的已填時間 → 合併時不覆蓋', () => {
    const p = planShootSync(up(), 'v1', [bk({ id: 'm1', startTime: '10:00' })], TODAY, NOW);
    expect(p.op === 'update' && 'startTime' in p.data).toBe(false);
  });
});

describe('planShootSync 修改／重送', () => {
  const linked = bk({ timetreeUuid: 'u1', startTime: '14:00', title: '大發拍攝-Kai', source: 'timetree' });
  it('同一個變動重送 → 不動（不重複寫、不重複通知）', () => expect(planShootSync(up(), 'v1', [linked], TODAY, NOW).op).toBe('none'));
  it('改時間 → 更新並留改期紀錄', () => {
    const p = planShootSync(up({ startAt: Date.parse('2026-11-05T02:00:00Z') }), 'v1', [linked], TODAY, NOW);
    expect(p).toMatchObject({ op: 'update', id: 'b1', data: { scheduledDate: '2026-11-05', startTime: '10:00' } });
    expect(p.op === 'update' && p.data.changeLog?.at(-1)?.note).toBe('改期 11/04 14:00 → 11/05 10:00');
  });
  it('已完成的不再改', () => expect(planShootSync(up({ title: '改' }), 'v1', [{ ...linked, status: 'completed' }], TODAY, NOW).op).toBe('none'));
});

describe('planShootSync 刪除', () => {
  it('進行中 → 取消、原因其他', () => {
    const p = planShootSync({ uuid: 'u1', action: 'delete' }, null, [bk({ timetreeUuid: 'u1' })], TODAY, NOW);
    expect(p).toMatchObject({ op: 'update', data: { status: 'cancelled', reason: 'other', resolvedAt: NOW } });
  });
  it('已完成的不取消', () => expect(planShootSync({ uuid: 'u1', action: 'delete' }, null, [bk({ timetreeUuid: 'u1', status: 'completed' })], TODAY, NOW).op).toBe('none'));
  it('沒對應 → 不動', () => expect(planShootSync({ uuid: 'zz', action: 'delete' }, null, [bk({})], TODAY, NOW).op).toBe('none'));
});

describe('pickBookingToResolve', () => {
  it('挑已到期最早的，不是未來那筆', () => {
    expect(pickBookingToResolve([{ scheduledDate: '2026-11-20' }, { scheduledDate: '2026-10-28' }], TODAY)?.scheduledDate).toBe('2026-10-28');
  });
  it('都還沒到 → 最早的（舊行為）', () => {
    expect(pickBookingToResolve([{ scheduledDate: '2026-11-20' }, { scheduledDate: '2026-11-03' }], TODAY)?.scheduledDate).toBe('2026-11-03');
  });
  it('沒有 → null', () => expect(pickBookingToResolve([], TODAY)).toBeNull());
});

import { parseTitleSuffix, toCalendarEvent, isBookingChange } from '../shootSync';

describe('parseTitleSuffix（同事寫在「-」後面的東西）', () => {
  it('人名 → 人員', () => expect(parseTitleSuffix('大發超哥拍攝-Kai')).toEqual({ crew: 'Kai' }));
  it('多個人名', () => expect(parseTitleSuffix('康青龍拍攝-Irene/秀姨/彭')).toEqual({ crew: 'Irene、秀姨、彭' }));
  it('內容 → 備註', () => expect(parseTitleSuffix('縈寶拍攝-晚宴')).toEqual({ note: '晚宴' }));
  it('人名＋內容混寫', () => expect(parseTitleSuffix('祥濱拍攝-議員500桌 Kai')).toEqual({ crew: 'Kai', note: '議員500桌' }));
  it('沒有「-」', () => expect(parseTitleSuffix('自然風拍攝')).toEqual({}));
  it('新建預約帶入人員', () => {
    const p = planShootSync(up({ title: '大發超哥拍攝-Kai' }), 'v1', [], TODAY, NOW);
    expect(p.op === 'create' && p.data.crew).toBe('Kai');
  });
  it('標題改人名 → 人員跟著改', () => {
    const b = bk({ timetreeUuid: 'u1', startTime: '14:00', title: '大發拍攝-Kai', crew: 'Kai' });
    const p = planShootSync(up({ title: '大發拍攝-Irene' }), 'v1', [b], TODAY, NOW);
    expect(p.op === 'update' && p.data.crew).toBe('Irene');
  });
  it('人員被手動改過 → 不覆蓋', () => {
    const b = bk({ timetreeUuid: 'u1', startTime: '14:00', title: '大發拍攝-Kai', crew: 'Kai、阿明' });
    const p = planShootSync(up({ title: '大發拍攝-Irene' }), 'v1', [b], TODAY, NOW);
    expect(p.op === 'update' && 'crew' in p.data).toBe(false);
  });
});

describe('toCalendarEvent', () => {
  it('諮詢 → 進行事曆', () => {
    expect(toCalendarEvent({ uuid: 'c1', action: 'upsert', title: '學員諮詢', category: '諮詢', startAt: nov4at14, allDay: false, updatedAt: 5 }))
      .toEqual({ title: '學員諮詢', category: '諮詢', date: '2026-11-04', startTime: '14:00', allDay: false, updatedAt: 5 });
  });
  it('不在系統內的拍攝（縈寶）→ 進行事曆', () => {
    const c = { uuid: 'c2', action: 'upsert' as const, title: '縈寶拍攝-晚宴', category: '拍攝' as const, vendorName: '縈寶', inSystem: false, startAt: nov4at14 };
    expect(isBookingChange(c)).toBe(false);
    expect(toCalendarEvent(c)?.ip).toBe('縈寶');
  });
  it('系統內拍攝 → 不進（在 shootBookings）', () => expect(toCalendarEvent({ ...up(), category: '拍攝', inSystem: true })).toBeNull());
  it('舊版 Worker 沒帶 category → 當系統內拍攝', () => expect(isBookingChange(up())).toBe(true));
});
