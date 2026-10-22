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

export function buildReminderMessage(
  r: { clientSlow: ReminderItem[]; notCompleted: ReminderItem[] },
  baseUrl: string,
) {
  if (!r.clientSlow.length && !r.notCompleted.length) return null;
  const itemBox = (it: ReminderItem, note: string, link?: string) => ({
    type: 'box', layout: 'vertical', margin: 'md', paddingAll: '10px', cornerRadius: '8px', backgroundColor: '#F5F5F0',
    contents: [
      { type: 'text', text: `${it.vendorName}｜${it.title}`, size: 'sm', weight: 'bold', wrap: true, color: '#222222' },
      { type: 'text', text: note, size: 'xs', color: '#8A8A7A', margin: 'xs' },
      ...(link ? [{ type: 'button', style: 'link', height: 'sm', color: BRAND,
        action: { type: 'clipboard', label: '複製客戶連結', clipboardText: link } }] : []),
    ],
  });
  const section = (title: string, color: string, boxes: unknown[]) => [
    { type: 'text', text: title, size: 'sm', weight: 'bold', color, margin: 'lg', wrap: true },
    ...boxes,
  ];
  const body: unknown[] = [];
  if (r.clientSlow.length) body.push(...section('⏳ 客戶還沒審片，請藏鏡人提醒客戶', '#B07A1E',
    r.clientSlow.map(it => itemBox(it,
      `送審 ${it.days} 天${it.version && it.version > 1 ? `・第 ${it.version} 版` : ''}`,
      it.previewToken ? `${baseUrl}/v/${it.previewToken}` : undefined))));
  if (r.notCompleted.length) body.push(...section('✅ 業主已通過，剪輯師還沒按「完成這支」（按了才列入請款）', '#2F7D5B',
    r.notCompleted.map(it => itemBox(it, `業主通過 ${it.days} 天`))));
  const n = r.clientSlow.length + r.notCompleted.length;
  return {
    type: 'flex',
    altText: `審片提醒：${n} 支片等待處理`,
    contents: {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '16px', contents: [
        { type: 'text', text: '🔔 審片進度提醒', color: '#FFFFFF', weight: 'bold', size: 'lg' },
      ] },
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: body },
    },
  };
}
