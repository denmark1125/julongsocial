import { describe, expect, it } from 'vitest';
import {
  tiktokProfileUrl, clientCaptionState, clientDayLabel, clientSections, pickLastShoot, socialPlatformOf, toClientStock, clientStageLabel, clientTodoSummary, clientTodo, pickNextShoot, toClientPost, toClientShoot,
} from '../clientPortal';

// 一篇「什麼內部欄位都有」的貼文：用來確認沒有任何一個漏出去
const fullPost = (over: any = {}) => ({
  id: 'p1', vendorId: 'v1', assetId: 'a1', title: '農三代的學習之路', content: '文案內容 #又生農場', status: 'draft',
  scheduledAt: '2026-11-14T20:00', targetMonth: '2026-11', type: '短影音', contentType: 'video', platforms: ['IG', 'FB'],
  clientConfirmed: false, internalConfirmed: true, createdBy: 'uid-staff', createdAt: '2026-11-01T00:00:00.000Z',
  postUrl: 'https://drive.google.com/drive/folders/internal', isRecognized: true, autoTitle: 'x', createdFrom: 'airDateBoard',
  publishAudit: { IG: { status: 'time_mismatch', permalink: 'https://www.instagram.com/reel/abc/', forScheduledAt: '2026-11-14T20:00', diffMinutes: 42, foundOnVendorId: 'v9' } },
  coverCheck: { IG: { status: 'mismatch', note: '內部備註' } },
  captionReview: { sentAt: '2026-11-12T02:00:00.000Z', sentByUid: 'uid-staff', sentByName: '小編阿明', feedback: [{ at: 'x', byName: '業主', text: '內部看的意見', via: 'line' }], history: [{ at: 'x', by: 'client', before: '舊文案' }] },
  ...over,
});
const extra = (over: any = {}) => ({ flow: 'ready' as const, internal: false, video: null, ...over });

describe('toClientPost：只有白名單欄位會離開伺服器', () => {
  it('欄位清單固定（要多給業主一個欄位，請同時改這裡）', () => {
    expect(Object.keys(toClientPost(fullPost(), extra())).sort()).toEqual(
      ['caption', 'captionState', 'editedAfterApproval', 'flow', 'id', 'internal', 'links', 'platforms', 'scheduledAt', 'status', 'title', 'video'].sort());
  });

  it('內部資訊一個都不會出現在回傳內容裡', () => {
    const json = JSON.stringify(toClientPost(fullPost({ status: 'published' }), extra()));
    for (const leak of ['uid-staff', '小編阿明', '內部看的意見', '舊文案', '內部備註', 'time_mismatch', 'mismatch', 'diffMinutes', 'foundOnVendorId', 'v9', 'drive.google.com', 'internalConfirmed', 'vendorId', 'assetId', 'airDateBoard']) {
      expect(json).not.toContain(leak);
    }
  });

  it('小編還沒送審的文案是草稿，不給業主', () => {
    const p = toClientPost(fullPost({ captionReview: undefined, content: '還在改的草稿' }), extra());
    expect(p.captionState).toBe('preparing');
    expect(p.caption).toBe('');
  });

  it('送審後給全文；業主確認、已發布也給', () => {
    expect(toClientPost(fullPost(), extra()).caption).toBe('文案內容 #又生農場');
    expect(toClientPost(fullPost({ clientConfirmed: true, captionReview: undefined }), extra()).captionState).toBe('approved');
    expect(toClientPost(fullPost({ status: 'published', captionReview: undefined }), extra()).caption).toBe('文案內容 #又生農場');
  });

  it('播放網址只在「等業主審片」那一刻給', () => {
    const video = { assetId: 'a1', kind: 'r2' as const, url: 'https://r2.example/signed', version: 2 };
    expect(toClientPost(fullPost(), extra({ flow: 'client_review', video })).video).toEqual(video);
    expect(toClientPost(fullPost(), extra({ flow: 'ready', video })).video).toBeNull();
    expect(toClientPost(fullPost({ status: 'published' }), extra({ flow: 'client_review', video })).video).toBeNull();
  });

  it('已發布才給貼文連結，而且要是這個排程時間查到的那一則', () => {
    expect(toClientPost(fullPost(), extra()).links).toEqual([]);
    expect(toClientPost(fullPost({ status: 'published' }), extra()).links).toEqual([{ pf: 'IG', url: 'https://www.instagram.com/reel/abc/' }]);
    expect(toClientPost(fullPost({ status: 'published', scheduledAt: '2026-11-15T20:00' }), extra()).links).toEqual([]);
  });
});

describe('已發布連結：稽核沒查到就用小編手填的，但只認社群網站', () => {
  const pub = (over: any) => fullPost({ status: 'published', publishAudit: undefined, ...over });
  it('手填 IG／FB 貼文網址會出現', () => {
    expect(toClientPost(pub({ postUrl: 'https://www.instagram.com/reel/xyz/' }), extra()).links).toEqual([{ pf: 'IG', url: 'https://www.instagram.com/reel/xyz/' }]);
    expect(toClientPost(pub({ postUrl: 'https://m.facebook.com/reel/123' }), extra()).links[0].pf).toBe('FB');
  });
  it('雲端、Notion、http、亂填的一律不給', () => {
    for (const u of ['https://drive.google.com/drive/folders/x', 'https://www.notion.so/abc', 'http://www.instagram.com/p/x', '前往雲端', '', 'https://instagram.com.evil.example/p/x']) {
      expect(toClientPost(pub({ postUrl: u }), extra()).links).toEqual([]);
    }
  });
  it('稽核查到了就用稽核的，不再加手填的', () => {
    expect(toClientPost(fullPost({ status: 'published', postUrl: 'https://www.facebook.com/x' }), extra()).links).toEqual([{ pf: 'IG', url: 'https://www.instagram.com/reel/abc/' }]);
  });
  it('socialPlatformOf', () => {
    expect(socialPlatformOf('https://www.tiktok.com/@x/video/1')).toBe('TikTok');
    expect(socialPlatformOf('https://vt.tiktok.com/abc')).toBe('TikTok');
    expect(socialPlatformOf('https://www.threads.net/@x/post/1')).toBe('Threads');
    expect(socialPlatformOf('https://example.com')).toBe('');
  });
});

describe('確認後小編又改了文字', () => {
  it('業主確認時的文案跟現在不同 → 標出來；相同或沒有紀錄（小編手動打勾）→ 不標', () => {
    expect(toClientPost(fullPost({ clientConfirmed: true, captionReview: { approvedContent: '舊的' } }), extra()).editedAfterApproval).toBe(true);
    expect(toClientPost(fullPost({ clientConfirmed: true, captionReview: { approvedContent: '文案內容 #又生農場' } }), extra()).editedAfterApproval).toBe(false);
    expect(toClientPost(fullPost({ clientConfirmed: true, captionReview: undefined }), extra()).editedAfterApproval).toBe(false);
    expect(toClientPost(fullPost({ status: 'published', captionReview: { approvedContent: '舊的' } }), extra()).editedAfterApproval).toBe(false);
  });
});

describe('clientCaptionState', () => {
  it('有草稿但沒送審＝準備中；送審＝等您確認', () => {
    expect(clientCaptionState({ content: '草稿', status: 'draft' })).toBe('preparing');
    expect(clientCaptionState({ content: '草稿', status: 'draft', captionReview: { sentAt: 'x' } })).toBe('waiting');
    expect(clientCaptionState({ content: '', status: 'draft', captionReview: { sentAt: 'x' } })).toBe('preparing');
  });
  it('業主留言要改＝依您的意見修改中（不再算等您處理）；確認後回到已確認', () => {
    const p = { content: '草稿', status: 'draft', captionReview: { sentAt: 'x', changeRequestedAt: 'y' } };
    expect(clientCaptionState(p)).toBe('revising');
    expect(clientTodo({ flow: null, captionState: 'revising', status: 'draft' } as any).caption).toBe(false);
    expect(clientCaptionState({ ...p, clientConfirmed: true })).toBe('approved');
    // 小編改好重送（送審時間比要改的時間新）→ 回到等您確認
    expect(clientCaptionState({ ...p, captionReview: { sentAt: '2026-11-18T10:00', changeRequestedAt: '2026-11-18T09:00' } })).toBe('waiting');
  });
});

describe('拍攝', () => {
  it('只給日期時間，不給 TimeTree 標題與登記的同事', () => {
    const s = toClientShoot({ vendorId: 'v1', scheduledDate: '2026-11-25', startTime: '14:00', status: 'booked', title: '大發超哥拍攝-Kai', bookedByName: 'Kai', bookedByUid: 'u' });
    expect(s).toEqual({ date: '2026-11-25', time: '14:00', done: false });
  });
  it('延期、取消的不顯示', () => {
    expect(toClientShoot({ scheduledDate: '2026-11-25', status: 'postponed' })).toBeNull();
    expect(toClientShoot({ scheduledDate: '2026-11-25', status: 'cancelled' })).toBeNull();
    expect(toClientShoot({ scheduledDate: 'bad', status: 'booked' })).toBeNull();
  });
  it('下次拍攝＝今天以後最近、還沒拍的那一次', () => {
    const shoots = [
      { date: '2026-11-10', time: '10:00', done: true },
      { date: '2026-12-02', time: '', done: false },
      { date: '2026-11-25', time: '14:00', done: false },
    ];
    expect(pickNextShoot(shoots, '2026-11-16')).toEqual({ date: '2026-11-25', time: '14:00', done: false });
    expect(pickNextShoot(shoots, '2026-12-03')).toBeNull();
  });
});

describe('給業主看的文字', () => {
  const p = (over: any = {}) => ({ flow: null, captionState: 'preparing' as const, scheduledAt: '2026-11-14T20:00', ...over });
  it('每一站', () => {
    expect(clientStageLabel(p(), 0).label).toBe('等拍攝');
    expect(clientStageLabel(p({ flow: 'to_edit' }), 1).label).toBe('剪輯中');
    expect(clientStageLabel(p({ flow: 'revising' }), 1).label).toBe('依您的意見修改中');
    expect(clientStageLabel(p({ flow: 'client_review' }), 2)).toMatchObject({ tone: 'action', label: '等您審片' });
    expect(clientStageLabel(p({ flow: 'to_upload' }), 2).label).toBe('審片已通過');
    expect(clientStageLabel(p({ flow: 'ready', captionState: 'waiting' }), 3)).toMatchObject({ tone: 'action', label: '等您確認文案' });
    expect(clientStageLabel(p({ flow: 'ready', captionState: 'approved' }), 3).label).toBe('準備排程');
    expect(clientStageLabel(p(), 4)).toMatchObject({ label: '已排程', detail: '11/14 20:00 發布' });
    expect(clientStageLabel(p(), 5).label).toBe('已發布');
  });
  it('文案可以比影片先審：有文案在等就講文案，影片進度放後面', () => {
    expect(clientStageLabel(p({ flow: 'to_edit', captionState: 'waiting' }), 1)).toEqual({ tone: 'action', label: '等您確認文案', detail: '影片剪輯中' });
    expect(clientStageLabel(p({ flow: null, captionState: 'waiting' }), 0)).toEqual({ tone: 'action', label: '等您確認文案', detail: '影片等拍攝' });
    expect(clientStageLabel(p({ flow: 'revising', captionState: 'waiting' }), 1).detail).toBe('影片依您的意見修改中');
    expect(clientStageLabel(p({ flow: 'client_review', captionState: 'waiting' }), 2)).toMatchObject({ tone: 'action', label: '等您審片・確認文案' });
    expect(clientStageLabel(p({ flow: 'to_upload', captionState: 'waiting' }), 2).detail).toBe('審片已通過');
    expect(clientStageLabel(p({ flow: 'ready', captionState: 'waiting' }), 4)).toEqual({ tone: 'action', label: '等您確認文案', detail: '11/14 20:00 發布' });
  });

  it('不出現剪輯師、上傳雲端、稽核等內部用語', () => {
    const all = [0, 1, 2, 3, 4, 5].flatMap(c => ['to_edit', 'revising', 'client_review', 'to_upload', 'ready', null].map(f => JSON.stringify(clientStageLabel(p({ flow: f }), c))));
    for (const t of all) expect(t).not.toMatch(/剪輯師|上傳雲端|稽核|機器人|TikTok/);
  });
  it('日期', () => {
    expect(clientDayLabel('2026-11-25')).toBe('11/25（三）');
    expect(clientDayLabel('')).toBe('');
  });
});

describe('clientSections：要處理的在上、已發布在下', () => {
  const row = (id: string, scheduledAt: string, over: any = {}) => ({ id, scheduledAt, status: 'draft', flow: 'to_edit', captionState: 'preparing', ...over });
  it('等您處理 → 接下來 → 已發布；已發布最近的在前', () => {
    const r = clientSections([
      row('pub1', '2026-11-02T20:00', { status: 'published', flow: null, captionState: 'published' }),
      row('pub2', '2026-11-13T20:00', { status: 'published', flow: null, captionState: 'published' }),
      row('next2', '2026-11-27T20:00'),
      row('todoCap', '2026-11-24T20:00', { flow: 'ready', captionState: 'waiting' }),
      row('next1', '2026-11-17T20:00', { status: 'scheduled' }),
      row('todoVid', '2026-11-18T20:00', { flow: 'client_review' }),
      row('noDate', ''),
    ] as any[]);
    expect(r.todo.map(p => p.id)).toEqual(['todoVid', 'todoCap']);
    expect(r.upcoming.map(p => p.id)).toEqual(['next1', 'next2', 'noDate']);
    expect(r.done.map(p => p.id)).toEqual(['pub2', 'pub1']);
  });
});

describe('clientTodoSummary', () => {
  it('數出等業主的事，並指到日期最早的那一篇', () => {
    const posts: any[] = [
      { id: 'b', scheduledAt: '2026-11-20T20:00', status: 'draft', flow: 'ready', captionState: 'waiting' },
      { id: 'a', scheduledAt: '2026-11-14T20:00', status: 'draft', flow: 'client_review', captionState: 'preparing' },
      { id: 'c', scheduledAt: '2026-11-01T20:00', status: 'published', flow: null, captionState: 'published' },
    ];
    expect(clientTodoSummary(posts)).toEqual({ video: 1, caption: 1, firstId: 'a' });
  });
});

describe('目前庫存 toClientStock', () => {
  const flowOf = (a: any) => a.flow;
  const posts = new Map<string, any>([
    ['p1', { scheduledAt: '2026-11-21T20:00' }],
    ['p2', { scheduledAt: '2026-11-19T20:00' }],
  ]);
  const asset = (over: any) => ({
    id: 'a', vendorId: 'v1', title: '片名', flow: 'to_edit', editorFee: 700, editorId: 'ed1', billableEditorId: 'ed1',
    editorInvoiceId: 'inv1', url: 'https://drive.google.com/drive/folders/secret', reviewFiles: [{ r2Key: 'k' }], ...over,
  });

  it('分三格：還沒剪好（含修改中）、等業主審片、成片可發布', () => {
    const s = toClientStock([
      asset({ title: 'A', flow: 'to_edit' }), asset({ title: 'B', flow: 'revising' }),
      asset({ title: 'C', flow: 'client_review' }), asset({ title: 'D', flow: 'to_upload' }), asset({ title: 'E', flow: 'ready' }),
    ], posts, flowOf);
    expect(s.total).toBe(5);
    expect(s.raw.map(i => i.title).sort()).toEqual(['A', 'B']);
    expect(s.review.map(i => i.title)).toEqual(['C']);
    expect(s.ready.map(i => i.title).sort()).toEqual(['D', 'E']);
  });

  it('上片日：綁了貼文以貼文日期為準（plannedAirDate 只是快照），沒綁才看 plannedAirDate；排了的近到遠、沒排的在後', () => {
    const s = toClientStock([
      asset({ title: '沒排', flow: 'ready' }),
      asset({ title: '綁貼文', flow: 'ready', plannedPostId: 'p1', plannedAirDate: '2026-11-01' }),
      asset({ title: '只有快照', flow: 'ready', plannedAirDate: '2026-11-20' }),
      asset({ title: '掛草稿', flow: 'ready', usedInPostId: 'p2' }),
      asset({ title: '綁的貼文不見了', flow: 'ready', plannedPostId: 'gone' }),
    ], posts, flowOf);
    expect(s.ready.map(i => [i.title, i.airDate, i.postId])).toEqual([
      ['掛草稿', '2026-11-19T20:00', 'p2'],
      ['只有快照', '2026-11-20', ''],
      ['綁貼文', '2026-11-21T20:00', 'p1'],
      ['沒排', '', ''],
      ['綁的貼文不見了', '', ''],
    ]);
  });

  it('只給片名、分格、上片日、貼文 id：剪輯費、剪輯師、請款單、雲端連結都不出去', () => {
    const s = toClientStock([asset({})], posts, flowOf);
    expect(Object.keys(s.raw[0]).sort()).toEqual(['airDate', 'bucket', 'postId', 'title']);
    const json = JSON.stringify(s);
    for (const leak of ['700', 'ed1', 'inv1', 'drive.google.com', 'r2Key', 'vendorId']) expect(json).not.toContain(leak);
  });

  it('沒片名的寫「（未命名）」', () => {
    expect(toClientStock([asset({ title: '' })], posts, flowOf).raw[0].title).toBe('（未命名）');
  });
});

describe('上次拍攝 pickLastShoot', () => {
  it('完成的或日期已過的，最近的那一次', () => {
    const shoots = [
      { date: '2026-11-06', time: '09:30', done: true },
      { date: '2026-11-12', time: '', done: false },
      { date: '2026-11-25', time: '14:00', done: false },
    ];
    expect(pickLastShoot(shoots, '2026-11-17')).toEqual({ date: '2026-11-12', time: '', done: false });
    expect(pickLastShoot([], '2026-11-17')).toBeNull();
  });
  it('素材拍攝日比預約晚就用素材（11-18 大發：預約只有 7/24，10/20 有拍片）；未來日期、壞日期不算', () => {
    const shoots = [{ date: '2026-07-24', time: '15:00', done: true }];
    expect(pickLastShoot(shoots, '2026-11-18', ['2026-10-15', '2026-10-20', '2026-12-01', ''])).toEqual({ date: '2026-10-20', time: '', done: true });
  });
  it('同一天有預約就用預約那筆（有時間）', () => {
    const shoots = [{ date: '2026-10-20', time: '13:00', done: false }];
    expect(pickLastShoot(shoots, '2026-11-18', ['2026-10-20'])).toEqual({ date: '2026-10-20', time: '13:00', done: false });
  });
});

describe('tiktokProfileUrl（11-18 客戶端改連 TikTok 帳號首頁）', () => {
  it('帳號名稱、帶 @、整串網址都吃', () => {
    expect(tiktokProfileUrl('dafacar')).toBe('https://www.tiktok.com/@dafacar');
    expect(tiktokProfileUrl(' @pat_jodie_josh ')).toBe('https://www.tiktok.com/@pat_jodie_josh');
    expect(tiktokProfileUrl('https://www.tiktok.com/@forever_82788?lang=zh-Hant-TW')).toBe('https://www.tiktok.com/@forever_82788');
  });
  it('登入用 email、空白、亂填一律不給（組出來會是錯網址）', () => {
    expect(tiktokProfileUrl('dafa900327@gmail.com')).toBe('');
    expect(tiktokProfileUrl('')).toBe('');
    expect(tiktokProfileUrl(undefined)).toBe('');
    expect(tiktokProfileUrl('大發 超哥')).toBe('');
  });
});
