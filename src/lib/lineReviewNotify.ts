/**
 * 剪輯師「交片送審」→ 剪輯群組的 LINE 通知（2026-10-22 使用者要求）。
 *
 * 每位剪輯師有自己的群組（editors/{id}.lineGroupId），藏鏡人在裡面。片傳完就發一則 Flex：
 * 請藏鏡人拿去給客戶審，附可一鍵複製的客戶連結、預覽頁、雲端檔案三顆按鈕。
 *
 * ⚠️ 純函式、不 import 任何東西：server.ts 在 Vercel 原生 ESM 下載入，lib 裡沒寫 .js 的 import 會整支掛掉。
 * ⚠️ 「複製」用 LINE 的 clipboard 動作（LINE 14.0 以上），舊版 App 按了沒反應，所以網址本身也印在訊息裡可長按複製。
 */
export interface ReviewNotifyInfo {
  vendorName: string;
  title: string;
  version: number;
  editorName?: string;
  /** 給客戶的預覽頁完整網址 */
  previewUrl: string;
  /** 審核區裡這支片的雲端檔案 id */
  fileId: string;
}

const BRAND = '#5A5A40';

export function buildReviewNotifyMessage(info: ReviewNotifyInfo) {
  const versionText = info.version > 1 ? `修改版・第 ${info.version} 版` : '第 1 版';
  const row = (label: string, value: string) => ({
    type: 'box', layout: 'horizontal', spacing: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8A8A7A', flex: 2 },
      { type: 'text', text: value, size: 'sm', color: '#333333', flex: 6, wrap: true },
    ],
  });
  const driveUrl = `https://drive.google.com/file/d/${encodeURIComponent(info.fileId)}/view`;
  return {
    type: 'flex',
    altText: `成片送審：${info.vendorName}｜${info.title}（${versionText}）`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '16px',
        contents: [
          { type: 'text', text: '🎬 成片送審', color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: '請給客戶審片', color: '#E8E8DC', size: 'sm', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          { type: 'text', text: info.title || '(未命名)', weight: 'bold', size: 'md', wrap: true, color: '#222222' },
          { type: 'separator', margin: 'md' },
          { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: [
            row('IP', info.vendorName || '—'),
            row('版本', versionText),
            ...(info.editorName ? [row('剪輯師', info.editorName)] : []),
          ] },
          { type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '10px', cornerRadius: '8px', backgroundColor: '#F5F5F0',
            contents: [
              { type: 'text', text: '客戶審片連結', size: 'xs', color: '#8A8A7A' },
              { type: 'text', text: info.previewUrl, size: 'sm', color: BRAND, wrap: true, margin: 'xs' },
            ] },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
        contents: [
          { type: 'button', style: 'primary', color: BRAND, height: 'sm',
            action: { type: 'clipboard', label: '複製客戶連結', clipboardText: info.previewUrl } },
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '開啟預覽頁', uri: info.previewUrl } },
            { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: '到雲端看檔案', uri: driveUrl } },
          ] },
        ],
      },
    },
  };
}

/* ───────────── 每 2 天的群組提醒（2026-10-22 使用者要求） ─────────────
 * ① 送審後客戶一直沒審：提醒藏鏡人去催客戶。
 * ② 業主已通過、剪輯師還沒按「完成這支」：提醒剪輯師（沒按完成就不會列入請款）。
 * 送審／通過後滿 2、4、6…個上班日的那天早上，跟著每日 09:30 的排程發一則（同一群合併成一則）。
 * 週六日、國定假日不發也不算（TW_HOLIDAYS）。訊息上的「送審 N 天」仍寫日曆天，跟人的感覺一致。
 * ⚠️ 只看有 reviewFiles 的片（10/21 起走系統送審的）：舊流程的片沒有預覽連結，也不該突然被翻出來每兩天吵一次。
 */
export interface ReminderAsset {
  id: string;
  title?: string;
  vendorName?: string;
  /** deriveFlowStage 的結果 */
  stage: string;
  reviewFiles?: { uploadedAt?: string; previewToken?: string; version?: number }[];
  clientApprovedAt?: string;
  flowLog?: { to: string; at: string }[];
  voidedAt?: string;
  cloudUploadedAt?: string;
}

export interface ReminderItem {
  assetId: string;
  title: string;
  vendorName: string;
  days: number;
  previewToken?: string;
  version?: number;
}

/** 每幾個工作天提醒一次 */
export const REMIND_EVERY_DAYS = 2;

/**
 * 不提醒、也不算天數的國定假日（週六日另外判斷）。使用者 10-22：遇到六日或休假日直接跨過。
 * ⚠️ 2027 年起要等行政院人事行政總處公告後補上（每年約 6 月公布），沒補的話只會少跳過假日、不會壞。
 *    公司自己的休假日也加在這裡。
 */
export const TW_HOLIDAYS = new Set<string>([
  '2026-10-26', // 光復節（10/25 週日）補假
  '2026-12-25', // 行憲紀念日
]);

const TW_OFFSET = 8 * 3600 * 1000;
const twDayNum = (t: number) => Math.floor((t + TW_OFFSET) / 86400000);
/** 台灣日期 YYYY-MM-DD */
const dayKey = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);

/** 台灣時間的這一天是不是上班日（週一到五、不是國定假日） */
export function isTwWorkday(n: number): boolean {
  const dow = new Date(n * 86400000).getUTCDay();
  return dow !== 0 && dow !== 6 && !TW_HOLIDAYS.has(dayKey(n));
}

/** 台灣時間的日曆天差 */
export function twDayDiff(since: string, now: Date): number {
  return twDayNum(now.getTime()) - twDayNum(Date.parse(since));
}

/** 從 since 隔天到今天（含）之間有幾個上班日 */
export function twWorkdaysSince(since: string, now: Date): number {
  const from = twDayNum(Date.parse(since));
  const to = twDayNum(now.getTime());
  let n = 0;
  for (let d = from + 1; d <= to; d++) if (isTwWorkday(d)) n++;
  return n;
}

/** LINE carousel 一則最多 12 張，超過整則會被回 400 */
const CAROUSEL_MAX = 12;

const lastLogAt = (a: ReminderAsset, to: string) =>
  [...(a.flowLog || [])].reverse().find(l => l.to === to)?.at;

export function pickReviewReminders(assets: ReminderAsset[], now: Date = new Date()) {
  const clientSlow: ReminderItem[] = [];
  const notCompleted: ReminderItem[] = [];
  for (const a of assets) {
    if (a.voidedAt || a.cloudUploadedAt || !a.reviewFiles?.length) continue;
    const latest = a.reviewFiles[a.reviewFiles.length - 1];
    const since = a.stage === 'client_review' ? latest.uploadedAt
      : a.stage === 'to_upload' ? (a.clientApprovedAt || lastLogAt(a, 'to_upload'))
        : undefined;
    if (!since || Number.isNaN(Date.parse(since))) continue;
    // 週末、國定假日不提醒也不算天數：滿 2、4、6…個上班日的那個上班日才發
    if (!isTwWorkday(twDayNum(now.getTime()))) continue;
    const workdays = twWorkdaysSince(since, now);
    if (workdays < REMIND_EVERY_DAYS || workdays % REMIND_EVERY_DAYS !== 0) continue;
    const days = twDayDiff(since, now);
    const item: ReminderItem = {
      assetId: a.id, title: a.title || '(未命名)', vendorName: a.vendorName || '', days,
      previewToken: latest.previewToken, version: latest.version,
    };
    (a.stage === 'client_review' ? clientSlow : notCompleted).push(item);
  }
  return { clientSlow, notCompleted };
}

/* ───────────── 群組裡打「待審」→ 機器人回清單（2026-10-28 使用者要求） ─────────────
 * 10-28 LINE 免費額度 200 則用完，送審通知整批發不出去（群組推播按人數計費，7 人群一則算 7 則）。
 * 回覆（reply）不算額度，所以給一個不靠推播的備案：群組裡有人打「待審」，就回目前所有還沒結束的片。
 * 跟提醒不同：不看「滿 2 個上班日」，只要還在客戶審片／業主已通過未完成就列。
 */
export function isPendingQuery(text: string): boolean {
  return /^(待審|待審片|審片清單|送審清單)$/.test(String(text || '').replace(/\s/g, ''));
}

export function listPendingReviews(assets: ReminderAsset[], now: Date = new Date()) {
  const clientSlow: ReminderItem[] = [];
  const notCompleted: ReminderItem[] = [];
  for (const a of assets) {
    if (a.voidedAt || a.cloudUploadedAt || !a.reviewFiles?.length) continue;
    if (a.stage !== 'client_review' && a.stage !== 'to_upload') continue;
    const latest = a.reviewFiles[a.reviewFiles.length - 1];
    const since = a.stage === 'client_review' ? latest.uploadedAt : (a.clientApprovedAt || lastLogAt(a, 'to_upload'));
    const days = since && !Number.isNaN(Date.parse(since)) ? Math.max(0, twDayDiff(since, now)) : 0;
    const item: ReminderItem = {
      assetId: a.id, title: a.title || '(未命名)', vendorName: a.vendorName || '', days,
      previewToken: latest.previewToken, version: latest.version,
    };
    (a.stage === 'client_review' ? clientSlow : notCompleted).push(item);
  }
  // 等最久的排前面
  clientSlow.sort((x, y) => y.days - x.days);
  notCompleted.sort((x, y) => y.days - x.days);
  return { clientSlow, notCompleted };
}

/** 「待審」的回覆：有片就用提醒同一套卡片，沒片回一句文字 */
export function buildPendingListMessage(
  r: { clientSlow: ReminderItem[]; notCompleted: ReminderItem[] },
  baseUrl: string,
) {
  const n = r.clientSlow.length + r.notCompleted.length;
  if (!n) return { type: 'text', text: '目前沒有送審中的片' };
  const msg = buildReminderMessage(r, baseUrl)!;
  msg.altText = `送審中 ${n} 支：客戶還沒審 ${r.clientSlow.length}、業主已通過 ${r.notCompleted.length}`
    + (n > CAROUSEL_MAX ? `（卡片先列 ${CAROUSEL_MAX} 支）` : '');
  return msg;
}

/**
 * 一支片一張卡、左右滑（使用者 10-22：跟聚浪拍攝提醒一樣，訊息才不會爆一堆）。
 * 客戶還沒審的排前面（要藏鏡人動手），再來是還沒按完成的；超過 12 張的在 altText 講總數。
 */
export function buildReminderMessage(
  r: { clientSlow: ReminderItem[]; notCompleted: ReminderItem[] },
  baseUrl: string,
) {
  const n = r.clientSlow.length + r.notCompleted.length;
  if (!n) return null;
  const card = (it: ReminderItem, kind: 'clientSlow' | 'notCompleted') => {
    const slow = kind === 'clientSlow';
    const link = slow && it.previewToken ? `${baseUrl}/v/${it.previewToken}` : undefined;
    const row = (label: string, value: string) => ({
      type: 'box', layout: 'horizontal', spacing: 'md', margin: 'sm',
      contents: [
        { type: 'text', text: label, size: 'sm', color: '#8A8A7A', flex: 2 },
        { type: 'text', text: value, size: 'sm', color: '#333333', flex: 5, wrap: true },
      ],
    });
    return {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: slow ? '#B07A1E' : '#2F7D5B',
        contents: [
          { type: 'text', text: slow ? '⏳ 客戶還沒審片' : '✅ 業主已通過', color: '#FFFFFF', weight: 'bold', size: 'md' },
          { type: 'text', text: slow ? '請藏鏡人提醒客戶' : '剪輯師按「完成這支」才列入請款', color: '#FFFFFFCC', size: 'xs', margin: 'xs', wrap: true },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '14px',
        contents: [
          { type: 'text', text: it.vendorName || '—', weight: 'bold', size: 'lg', color: '#222222' },
          { type: 'text', text: it.title, size: 'sm', color: '#444444', wrap: true, maxLines: 3, margin: 'xs' },
          { type: 'separator', margin: 'md' },
          slow ? row('送審', `${it.days} 天${it.version && it.version > 1 ? `・第 ${it.version} 版` : ''}`) : row('通過', `${it.days} 天`),
        ],
      },
      ...(link ? { footer: { type: 'box', layout: 'vertical', paddingAll: '10px', contents: [
        { type: 'button', style: 'primary', color: BRAND, height: 'sm', action: { type: 'clipboard', label: '複製客戶連結', clipboardText: link } },
      ] } } : {}),
    };
  };
  const cards = [
    ...r.clientSlow.map(it => card(it, 'clientSlow')),
    ...r.notCompleted.map(it => card(it, 'notCompleted')),
  ].slice(0, CAROUSEL_MAX);
  return {
    type: 'flex',
    altText: `審片提醒：${n} 支片等待處理${n > CAROUSEL_MAX ? `（卡片先列 ${CAROUSEL_MAX} 支）` : ''}`,
    contents: { type: 'carousel', contents: cards },
  };
}
