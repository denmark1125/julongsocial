import { describe, expect, it } from 'vitest';
import { auditOne, isSettled, shouldAlert, taipeiToDate, unscheduledLivePosts, type LivePost } from '../publishAudit';

// 案例取自 2026-11-01～11-04 正式資料（IG/FB 實際貼文 vs 系統排程）
const live: LivePost[] = [
  { platform: 'IG', id: 'hz1', vendorId: 'hozen', publishedAt: '2026-11-01T12:00:56Z', caption: '在家做西米露總是結塊又軟爛？ 好正點不藏私， 教你兩招煮出完美芋頭西米露！' },
  { platform: 'IG', id: 'tea1', vendorId: 'tea', publishedAt: '2026-11-03T12:01:37Z', caption: '沒有草莓的草莓紅茶？ 這不是在跟你開玩笑🤔 紅茶造咖的草莓紅茶與蘋果紅茶' },
  { platform: 'IG', id: 'kq1', vendorId: 'kq', publishedAt: '2026-11-02T11:01:17Z', caption: '遇到結帳少十塊的客人， 店員如何化解危機？ 這荒謬的發展真的笑死🤣' },
  { platform: 'IG', id: 'cw-nocap', vendorId: 'cworks', publishedAt: '2026-11-02T05:27:28Z', caption: '' },
  { platform: 'FB', id: 'cw-post', vendorId: 'cworks', publishedAt: '2026-11-03T10:58:56Z', caption: '🏁 卓越之路，通往米蘭。 今年 11 月，CWORKS 將帶著對品質' },
];

const post = (over: Partial<{ id: string; vendorId: string; scheduledAt: string; title: string; content: string }>) => ({
  id: 'p', vendorId: 'hozen', scheduledAt: '2026-11-01T20:00', title: '', content: '', ...over,
});

describe('taipeiToDate', () => {
  it('不帶時區的排程一律當台北時間（伺服器在 UTC）', () => {
    expect(taipeiToDate('2026-11-01T20:00').toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });
});

describe('auditOne', () => {
  const now = new Date('2026-11-04T00:00:00Z');

  it('康青龍 11/2 19:00 準時發 → 正確', () => {
    const r = auditOne({ post: post({ vendorId: 'kq', scheduledAt: '2026-11-02T19:00', content: '遇到結帳少十塊的客人， 店員如何化解危機？' }), platform: 'IG', strictTiming: true, live, now });
    expect(r.status).toBe('ok');
    expect(r.diffMinutes).toBe(1);
  });

  it('好正點 11/1 排 17:40 實際 20:00 → 排程時間跟實際不同（準時 IP）', () => {
    const r = auditOne({ post: post({ scheduledAt: '2026-11-01T17:40', content: '在家做西米露總是結塊又軟爛？ 好正點不藏私' }), platform: 'IG', strictTiming: true, live, now });
    expect(r.status).toBe('time_mismatch');
    expect(r.diffMinutes).toBe(141);
    expect(shouldAlert(r)).toBe(true);
  });

  it('同一支片在彈性 IP → 時間不管，算正確', () => {
    const r = auditOne({ post: post({ scheduledAt: '2026-11-01T17:40', content: '在家做西米露總是結塊又軟爛？' }), platform: 'IG', strictTiming: false, live, now });
    expect(r.status).toBe('ok');
  });

  it('紅茶造咖 11/3 排 19:00 實際 20:01 → 排程時間跟實際不同', () => {
    const r = auditOne({ post: post({ vendorId: 'tea', scheduledAt: '2026-11-03T19:00', title: '草莓紅茶沒有草莓，酵素咖啡真的有酵素？' }), platform: 'IG', strictTiming: true, live, now });
    expect(r.status).toBe('time_mismatch');
  });

  it('發到別的 IP 帳號 → 疑似發錯帳號', () => {
    const r = auditOne({ post: post({ vendorId: 'dafa', scheduledAt: '2026-11-03T20:00', content: '沒有草莓的草莓紅茶？ 這不是在跟你開玩笑🤔 紅茶造咖的草莓紅茶與蘋果紅茶' }), platform: 'IG', strictTiming: true, live, now });
    expect(r.status).toBe('wrong_account');
    expect(r.foundOnVendorId).toBe('tea');
  });

  it('沒寫文案的 Reel：當天自己帳號只有這一則 → 用時間配得到', () => {
    const r = auditOne({ post: post({ vendorId: 'cworks', scheduledAt: '2026-11-02T13:30', title: '機車零件疑難雜症交給凱茜' }), platform: 'IG', strictTiming: true, live, now });
    expect(r.livePostId).toBe('cw-nocap');
  });

  it('準時 IP 過 5 分鐘沒看到 → 還沒看到並推 LINE；4 分鐘內還在等', () => {
    const p = post({ vendorId: 'hozen', scheduledAt: '2026-11-05T20:00', content: '完全不同的新片' });
    const r4 = auditOne({ post: p, platform: 'IG', strictTiming: true, live, now: new Date('2026-11-05T12:04:00Z') });
    expect(r4.status).toBe('pending');
    const r5 = auditOne({ post: p, platform: 'IG', strictTiming: true, live, now: new Date('2026-11-05T12:05:00Z') });
    expect(r5.status).toBe('not_seen');
    expect(shouldAlert(r5)).toBe(true);
  });

  it('推過一次之後不再推，隔天變成沒有發', () => {
    const p = post({ scheduledAt: '2026-11-05T20:00', content: '完全不同的新片' });
    const prev = { status: 'not_seen' as const, checkedAt: '', alertedAt: '2026-11-05T12:05:00Z', forScheduledAt: '2026-11-05T20:00' };
    const r = auditOne({ post: p, platform: 'IG', strictTiming: true, live, now: new Date('2026-11-05T16:30:00Z'), previous: prev });
    expect(r.status).toBe('missing');
    expect(shouldAlert(r)).toBe(false);
  });

  it('彈性 IP（自然風）沒發 → 不算錯、不推', () => {
    const r = auditOne({ post: post({ vendorId: 'ziran', scheduledAt: '2026-11-05T20:00', content: 'x' }), platform: 'FB', strictTiming: false, live, now: new Date('2026-11-05T13:00:00Z') });
    expect(r.status).toBe('skipped');
    expect(shouldAlert(r)).toBe(false);
  });

  it('TikTok 還沒接 → 尚未支援，不誤報漏發', () => {
    expect(auditOne({ post: post({}), platform: 'TikTok', strictTiming: true, live, now }).status).toBe('unsupported');
  });

  it('已被別筆排程認走的貼文不能重複配', () => {
    const r = auditOne({ post: post({ vendorId: 'kq', scheduledAt: '2026-11-02T19:00', content: '遇到結帳少十塊的客人' }), platform: 'IG', strictTiming: true, live, now, claimed: new Set(['kq1']) });
    expect(r.status).not.toBe('ok');
  });
});

describe('isSettled / unscheduledLivePosts', () => {
  it('配到了但還沒有封面縮圖、10 分鐘內 → 還要再查', () => {
    const a = { status: 'ok' as const, checkedAt: '', forScheduledAt: '2026-11-05T20:00' };
    expect(isSettled(a, new Date('2026-11-05T12:10:00Z'), '2026-11-05T20:00')).toBe(false);
    expect(isSettled({ ...a, thumbnailUrl: 'x' }, new Date('2026-11-05T12:10:00Z'), '2026-11-05T20:00')).toBe(true);
  });

  it('CWORKS 11/3 那則系統沒排的 FB 貼文 → 列為非排程貼文', () => {
    const r = unscheduledLivePosts(live, new Set(), '2026-11-03');
    expect(r.map(l => l.id)).toEqual(['tea1', 'cw-post']);
  });
});

describe('文案對不上', () => {
  const now = new Date('2026-11-04T00:00:00Z');
  const live2: LivePost[] = [
    { platform: 'IG', id: 'notice', vendorId: 'cworks', publishedAt: '2026-10-21T05:31:09Z', caption: 'TOYOTA TSUSHO 豐田通商 CWORKS 第一屆社員大會圓滿落幕' },
    { platform: 'IG', id: 'v1021', vendorId: 'cworks', publishedAt: '2026-10-21T12:01:37Z', caption: '第一次代理機車零件就砸了2000萬， 甚至關掉經營多年的機車行' },
    { platform: 'IG', id: 'apple', vendorId: 'tea', publishedAt: '2026-10-23T12:01:29Z', caption: '買蘋果紅茶竟然沒有加蘋果醬？ 客人氣到拍桌說下次不買了！' },
  ];

  it('CWORKS 10/21 系統沒填文案、當天還有一則公告 → 配時間最近的那支，算正確', () => {
    const r = auditOne({ post: { id: 'p', vendorId: 'cworks', scheduledAt: '2026-10-21T20:00', title: '扛下上千萬的目標營業額卻賣跟副廠一樣的價格?', content: '' }, platform: 'IG', strictTiming: true, live: live2, now });
    expect(r.status).toBe('ok');
    expect(r.livePostId).toBe('v1021');
  });

  it('紅茶造咖 10/23 準時有發但文案完全不同 → 文案跟系統不同，只進日報不即時推', () => {
    const r = auditOne({ post: { id: 'p', vendorId: 'tea', scheduledAt: '2026-10-23T19:00', title: 'POV:當客戶需要情緒價值', content: '8樓有間紅茶造咖 來都來了，搭電梯上來喝杯好茶 🍃不加料就是有料' }, platform: 'IG', strictTiming: true, live: live2, now });
    expect(r.status).toBe('content_mismatch');
    expect(shouldAlert(r)).toBe(false);
  });
});

describe('改了排程時間', () => {
  it('小編照提醒把排程改掉 → 舊結果作廢、重查、可以再推', () => {
    const prev = { status: 'not_seen' as const, checkedAt: '', alertedAt: 'x', forScheduledAt: '2026-11-05T19:00' };
    expect(isSettled(prev, new Date('2026-11-05T13:00:00Z'), '2026-11-05T20:00')).toBe(false);
    const r = auditOne({ post: post({ scheduledAt: '2026-11-05T20:00', content: '完全不同的新片' }), platform: 'IG', strictTiming: true, live, now: new Date('2026-11-05T12:06:00Z'), previous: prev });
    expect(r.alertedAt).toBeUndefined();
    expect(shouldAlert(r)).toBe(true);
  });
});

describe('TikTok 發布後（只比時間）', () => {
  const tt: LivePost[] = [{ platform: 'TikTok', id: 'tt1', vendorId: 'xiang', publishedAt: '2026-11-03T11:56:00Z' }];
  it('祥濱 11/3 排 20:00、TikTok 19:56 發 → 正確（差 4 分鐘）', () => {
    const r = auditOne({ post: { id: 'p', vendorId: 'xiang', scheduledAt: '2026-11-03T20:00', content: '誰說辦桌不能超浪漫' }, platform: 'TikTok', strictTiming: true, live: tt, now: new Date('2026-11-04T01:35:00Z'), allowTikTok: true });
    expect(r.status).toBe('ok');
  });
  it('沒開 allowTikTok（每分鐘的 Meta 稽核）→ 不碰 TikTok', () => {
    const r = auditOne({ post: { id: 'p', vendorId: 'xiang', scheduledAt: '2026-11-03T20:00' }, platform: 'TikTok', strictTiming: true, live: tt, now: new Date('2026-11-04T01:35:00Z') });
    expect(r.status).toBe('unsupported');
  });
  it('隔天早上還找不到 → 沒有發', () => {
    const r = auditOne({ post: { id: 'p', vendorId: 'xiang', scheduledAt: '2026-11-05T20:00' }, platform: 'TikTok', strictTiming: true, live: tt, now: new Date('2026-11-06T01:35:00Z'), allowTikTok: true });
    expect(r.status).toBe('missing');
  });
});
