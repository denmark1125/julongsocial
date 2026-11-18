import { describe, expect, it } from 'vitest';
import {
  buildCaptionReviewMessage, canSendCaption, captionDateLabel, captionPostbackData,
  captionStatus, parseCaptionPostback, shiftMonth, isMonthKey, CAPTION_CARDS_MAX,
} from '../captionReview';

const post = (over: any = {}) => ({ id: 'p1', title: '農三代的學習之路', content: '其實經營農場真的沒那麼簡單！\n#又生農場', status: 'draft', scheduledAt: '2026-11-14T20:00', platforms: ['IG', 'FB'], clientConfirmed: false, ...over });
const card = (over: any = {}) => ({ postId: 'p1', vendorName: '又生農場', title: '農三代的學習之路', content: '文案', scheduledAt: '2026-11-14T20:00', platforms: ['IG', 'FB'], pageUrl: 'https://x.test/c/tok?m=2026-11&p=p1', ...over });

describe('captionStatus', () => {
  it('照流程一步一步走', () => {
    expect(captionStatus(post({ content: '  ' }))).toBe('empty');
    expect(captionStatus(post())).toBe('unsent');
    expect(captionStatus(post({ captionReview: { sentAt: '2026-11-10T01:00:00.000Z' } }))).toBe('sent');
    expect(captionStatus(post({ captionReview: { sentAt: '2026-11-10T01:00:00.000Z', changeRequestedAt: '2026-11-10T02:00:00.000Z' } }))).toBe('change_requested');
    expect(captionStatus(post({ clientConfirmed: true, captionReview: { approvedVia: 'line', approvedContent: post().content } }))).toBe('approved');
    expect(captionStatus(post({ clientConfirmed: true, captionReview: { approvedVia: 'page_edit', approvedContent: post().content } }))).toBe('client_edited');
    expect(captionStatus(post({ status: 'published' }))).toBe('published');
  });

  it('改完再送一次：舊的「要修改」不算，回到等業主', () => {
    expect(captionStatus(post({ captionReview: { changeRequestedAt: '2026-11-10T02:00:00.000Z', sentAt: '2026-11-11T01:00:00.000Z' } }))).toBe('sent');
  });

  it('業主確認後小編又改了文案 → 標出來', () => {
    expect(captionStatus(post({ clientConfirmed: true, captionReview: { approvedVia: 'line', approvedContent: '舊的' } }))).toBe('changed_after');
  });

  it('小編手動打勾（沒有確認當下的文案）一律算已確認，不誤報改過', () => {
    expect(captionStatus(post({ clientConfirmed: true }))).toBe('approved');
  });
});

describe('canSendCaption', () => {
  it('沒文案或已發布不能送', () => {
    expect(canSendCaption(post())).toBe(true);
    expect(canSendCaption(post({ content: '' }))).toBe(false);
    expect(canSendCaption(post({ status: 'published' }))).toBe(false);
  });
});

describe('captionDateLabel', () => {
  it('台灣時間字面值，不做時區換算', () => {
    expect(captionDateLabel('2026-11-14T20:00')).toBe('11/14（六）20:00');
    expect(captionDateLabel('2026-11-03')).toBe('11/3（二）');
    expect(captionDateLabel('')).toBe('');
  });
});

describe('postback', () => {
  it('編出去解得回來', () => {
    expect(parseCaptionPostback(captionPostbackData('ok', 'AbC123xyz'))).toEqual({ action: 'ok', postId: 'AbC123xyz' });
    expect(parseCaptionPostback(captionPostbackData('fix', 'AbC123xyz'))).toEqual({ action: 'fix', postId: 'AbC123xyz' });
  });
  it('別的功能的 postback、亂塞的字串都不認', () => {
    expect(parseCaptionPostback('cap=delete&p=x')).toBeNull();
    expect(parseCaptionPostback('cap=ok&p=a/b')).toBeNull();
    expect(parseCaptionPostback('action=other')).toBeNull();
    expect(parseCaptionPostback(undefined)).toBeNull();
  });
  it('不超過 LINE 的 300 字上限', () => {
    expect(captionPostbackData('fix', 'x'.repeat(64)).length).toBeLessThanOrEqual(300);
  });
});

describe('buildCaptionReviewMessage', () => {
  const bytes = (m: any) => Buffer.byteLength(JSON.stringify(m), 'utf8');

  it('一篇＝一張卡，文案全文都在，三顆按鈕', () => {
    const m: any = buildCaptionReviewMessage([card({ content: '第一行\n第二行 #tag' })]);
    expect(m.contents.type).toBe('bubble');
    expect(JSON.stringify(m.contents.body)).toContain('第一行\\n第二行 #tag');
    const actions = m.contents.footer.contents.map((b: any) => b.action);
    expect(actions.map((a: any) => a.type)).toEqual(['postback', 'postback', 'uri']);
    expect(parseCaptionPostback(actions[0].data)).toEqual({ action: 'ok', postId: 'p1' });
    expect(parseCaptionPostback(actions[1].data)).toEqual({ action: 'fix', postId: 'p1' });
    expect(actions[2].uri).toContain('p=p1');
  });

  it('第二次送審標「修改版」', () => {
    const m: any = buildCaptionReviewMessage([card({ sendCount: 2 })]);
    expect(m.contents.header.contents[0].text).toContain('修改版');
  });

  it('2,200 字（IG 上限）的文案：截斷並提示開網頁，單張不超過 LINE 的 30KB', () => {
    const m: any = buildCaptionReviewMessage([card({ content: '字'.repeat(2200) })]);
    expect(JSON.stringify(m)).toContain('全文請按下方');
    expect(bytes(m.contents)).toBeLessThan(30_000);
  });

  it('12 篇長文案一起送：整則不超過 LINE 的 50KB，超過 12 篇只取前 12', () => {
    const items = Array.from({ length: 15 }, (_, i) => card({ postId: `p${i}`, content: '字'.repeat(2200), title: '題'.repeat(60) }));
    const m: any = buildCaptionReviewMessage(items);
    expect(m.contents.type).toBe('carousel');
    expect(m.contents.contents).toHaveLength(CAPTION_CARDS_MAX);
    expect(bytes(m.contents)).toBeLessThan(50_000);
  });

  it('按鈕文字與 altText 不超過 LINE 上限（label 40、displayText 300、altText 400）', () => {
    const m: any = buildCaptionReviewMessage([card({ title: '題'.repeat(500), vendorName: '名'.repeat(200) })]);
    expect(m.altText.length).toBeLessThanOrEqual(400);
    for (const b of m.contents.footer.contents) {
      expect(b.action.label.length).toBeLessThanOrEqual(40);
      if (b.action.displayText) expect(b.action.displayText.length).toBeLessThanOrEqual(300);
    }
  });

  it('沒有東西可送回 null', () => {
    expect(buildCaptionReviewMessage([])).toBeNull();
  });
});

describe('月份', () => {
  it('切換與格式檢查', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(isMonthKey('2026-11')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('../x')).toBe(false);
  });
});
