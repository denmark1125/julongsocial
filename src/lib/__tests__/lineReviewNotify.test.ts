import { describe, expect, it } from 'vitest';
import { buildReminderMessage, buildReviewNotifyMessage, pickReviewReminders, twDayDiff, twWorkdaysSince } from '../lineReviewNotify';

// 台灣 10/27（二）09:30。10/24、10/25 週末，10/26 光復節補假
const now = new Date('2026-10-27T01:30:00Z');
const rf = (uploadedAt: string, version = 1) => [{ uploadedAt, previewToken: 'tok', version }];

describe('twDayDiff 台灣日曆天', () => {
  it('台灣 10/22 23:00 送審 → 10/27 早上是 5 個日曆天、2 個上班日（跨過週末和補假）', () => {
    expect(twDayDiff('2026-10-22T15:00:00Z', now)).toBe(5);
    expect(twWorkdaysSince('2026-10-22T15:00:00Z', now)).toBe(2);
  });
});

describe('pickReviewReminders 每 2 天提醒', () => {
  it('週四送審、隔週二（中間週末＋補假）滿 2 個上班日 → 提醒藏鏡人，訊息寫日曆天', () => {
    const r = pickReviewReminders([{ id: 'a', stage: 'client_review', reviewFiles: rf('2026-10-22T03:00:00Z') }], now);
    expect(r.clientSlow.map(x => x.days)).toEqual([5]);
  });
  it('1、3 個上班日不提醒；4 個上班日再提醒', () => {
    const at = (d: string) => pickReviewReminders([{ id: 'a', stage: 'client_review', reviewFiles: rf(d) }], now).clientSlow.length;
    expect(at('2026-10-23T03:00:00Z')).toBe(0);
    expect(at('2026-10-21T03:00:00Z')).toBe(0);
    expect(at('2026-10-20T03:00:00Z')).toBe(1);
  });
  it('週末、國定假日當天不發', () => {
    const at = (iso: string) => pickReviewReminders([{ id: 'a', stage: 'client_review', reviewFiles: rf('2026-10-20T03:00:00Z') }], new Date(iso)).clientSlow.length;
    expect(at('2026-10-24T01:30:00Z')).toBe(0); // 週六
    expect(at('2026-10-26T01:30:00Z')).toBe(0); // 補假
  });
  it('業主通過滿 2 天還沒按完成 → 提醒剪輯師', () => {
    const r = pickReviewReminders([{ id: 'a', stage: 'to_upload', reviewFiles: rf('2026-10-20T03:00:00Z'), clientApprovedAt: '2026-10-22T03:00:00Z' }], now);
    expect(r.notCompleted).toHaveLength(1);
    expect(r.clientSlow).toHaveLength(0);
  });
  it('沒按預覽頁、在內部按通過：看交棒紀錄的時間', () => {
    const r = pickReviewReminders([{ id: 'a', stage: 'to_upload', reviewFiles: rf('2026-10-20T03:00:00Z'), flowLog: [{ to: 'to_upload', at: '2026-10-22T03:00:00Z' }] }], now);
    expect(r.notCompleted).toHaveLength(1);
  });
  it('舊流程（沒有 reviewFiles）、作廢、已完成都不提醒', () => {
    const r = pickReviewReminders([
      { id: 'a', stage: 'client_review' },
      { id: 'b', stage: 'client_review', reviewFiles: rf('2026-10-22T03:00:00Z'), voidedAt: 'x' },
      { id: 'c', stage: 'to_upload', reviewFiles: rf('2026-10-20T03:00:00Z'), clientApprovedAt: '2026-10-22T03:00:00Z', cloudUploadedAt: 'x' },
    ], now);
    expect(r.clientSlow.length + r.notCompleted.length).toBe(0);
  });
  it('修改版從最新一版的送審時間算', () => {
    const r = pickReviewReminders([{ id: 'a', stage: 'client_review', reviewFiles: [...rf('2026-10-18T03:00:00Z'), { uploadedAt: '2026-10-23T03:00:00Z', version: 2 }] }], now);
    expect(r.clientSlow).toHaveLength(0);
  });
});

describe('訊息', () => {
  it('送審通知：複製按鈕帶客戶連結、雲端按鈕連到檔案', () => {
    const m: any = buildReviewNotifyMessage({ vendorName: '自然風', title: '熱泵', version: 2, previewUrl: 'https://x/v/t', fileId: 'F1' });
    const json = JSON.stringify(m);
    expect(m.altText).toContain('第 2 版');
    expect(json).toContain('"clipboardText":"https://x/v/t"');
    expect(json).toContain('https://drive.google.com/file/d/F1/view');
  });
  it('沒有要提醒的就不發', () => {
    expect(buildReminderMessage({ clientSlow: [], notCompleted: [] }, 'https://x')).toBeNull();
  });
});
