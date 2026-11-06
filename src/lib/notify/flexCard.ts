/**
 * 把通知文字排成 LINE Flex 卡片（2026-11-06 使用者：純文字通知很難讀）。
 *
 * 文字格式沿用原本各通知產生的那套（第一行＝標題、「・」開頭＝清單、emoji 開頭＝狀態列、
 * 「｜」分隔＝主資訊｜狀態、「詳情：網址」＝按鈕），所以頁面、日報存檔照舊用文字，只有推 LINE 時換成卡片。
 * 卡片送失敗（格式被 LINE 拒絕）時 server 的 notify() 會自動退回純文字，不會漏發。
 */

export interface FlexProgress { label: string; done: number; total: number }
export interface FlexOptions {
  /** 標題下的進度條，例如「成片已好 2/3」 */
  progress?: FlexProgress[];
  /** 卡片最下面的灰色小字（例如「藏鏡人還沒綁 LINE，先通知管理者」） */
  footnote?: string;
}

const RED = '#D64545';
const AMBER = '#C77800';
const GREEN = '#2E8B57';
const BLUE = '#3B6FD8';
const OLIVE = '#5A5A40';
const GRAY = '#8A8A8A';
const TEXT = '#1F1F1F';

/** 標題 emoji → 卡片頂端顏色 */
function themeOf(title: string): string {
  if (/^(🔔|🚨|❌|🖼️)/u.test(title)) return RED;
  if (/^(⏰|⚠️|🗓️)/u.test(title)) return AMBER;
  if (/^(☀️|📋)/u.test(title)) return BLUE;
  return OLIVE;
}

/** 狀態片段的顏色：⚠️/❌ 紅、✓/✅ 綠，其他灰 */
function toneOf(s: string): string {
  if (/[❌]/u.test(s)) return RED;
  if (/[⚠️⏰❓]/u.test(s)) return AMBER;
  if (/[✓✅]/u.test(s)) return GREEN;
  return GRAY;
}

const LEAD = /^(\p{Extended_Pictographic}️?|・|—)\s*/u;

function text(t: string, extra: Record<string, any> = {}) {
  return { type: 'text', text: t || ' ', wrap: true, size: 'sm', color: TEXT, ...extra };
}

function progressBar(p: FlexProgress) {
  const pct = p.total ? Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100))) : 0;
  const color = pct >= 100 ? GREEN : pct >= 50 ? AMBER : RED;
  return {
    type: 'box', layout: 'vertical', spacing: 'xs', contents: [
      { type: 'box', layout: 'horizontal', contents: [
        text(p.label, { size: 'xs', color: GRAY, flex: 1 }),
        text(`${p.done}/${p.total}`, { size: 'xs', color, weight: 'bold', flex: 0, align: 'end' }),
      ] },
      { type: 'box', layout: 'vertical', height: '6px', cornerRadius: '3px', backgroundColor: '#E8E8E8', contents: [
        // 0% 時 LINE 不接受寬度 0%，給 1% 看起來一樣是空的
        { type: 'box', layout: 'vertical', width: `${Math.max(pct, 1)}%`, height: '6px', cornerRadius: '3px', backgroundColor: color, contents: [] },
      ] },
    ],
  };
}

/** 一行通知 → 卡片裡的一列 */
function rowOf(line: string) {
  const m = line.match(LEAD);
  const icon = m ? (m[1] === '・' ? '•' : m[1]) : '';
  const body = m ? line.slice(m[0].length) : line;
  const [main, ...rest] = body.split('｜');
  const right = [
    text(main, { weight: rest.length ? 'bold' : 'regular' }),
    ...rest.map(r => text(r.trim(), { size: 'xs', color: toneOf(r) })),
  ];
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
      ...(icon ? [text(icon, { flex: 0, color: icon === '•' ? GRAY : TEXT })] : []),
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'none', contents: right },
    ],
  };
}

/** 沒有「」、短短一行、emoji 開頭 → 當段落小標題（例如「🌙 今晚待發」「🎵 TikTok 發布檢查」） */
function isSection(line: string): boolean {
  return LEAD.test(line) && !/[「｜→]/.test(line) && line.length <= 20 && !/\d+ 支正確/.test(line);
}

const MAX_ROWS = 35;

/** 通知文字 → LINE flex 訊息。`_fallbackText` 給 notify() 退回純文字用，送出前會拿掉 */
export function textToFlex(full: string, opts: FlexOptions = {}): any {
  const lines = full.split('\n').map(l => l.trimEnd());
  const title = lines.shift() || '通知';
  const theme = themeOf(title);
  let url: string | undefined;
  const body: any[] = [];
  let rows = 0;
  let hidden = 0;
  for (const line of lines) {
    const link = line.match(/^詳情：(https?:\/\/\S+)/);
    if (link) { url = link[1]; continue; }
    if (!line.trim()) { if (body.length) body.push({ type: 'separator', margin: 'md' }); continue; }
    if (rows >= MAX_ROWS) { hidden++; continue; }
    if (isSection(line) && body.length) {
      body.push({ type: 'separator', margin: 'lg' });
      body.push(text(line, { weight: 'bold', color: theme, margin: 'md' }));
      continue;
    }
    if (isSection(line)) { body.push(text(line, { weight: 'bold', color: theme })); continue; }
    body.push(rowOf(line));
    rows++;
  }
  if (hidden) body.push(text(`…還有 ${hidden} 則，請看系統`, { size: 'xs', color: GRAY }));
  if (!body.length) body.push(text('沒有要注意的', { color: GRAY }));

  const header = {
    type: 'box', layout: 'vertical', backgroundColor: theme, paddingAll: '14px', spacing: 'md', contents: [
      text(title, { size: 'md', weight: 'bold', color: '#FFFFFF' }),
    ],
  };
  const top = opts.progress?.length
    ? [{ type: 'box', layout: 'vertical', spacing: 'sm', contents: opts.progress.map(progressBar) }, { type: 'separator', margin: 'lg' }]
    : [];
  const bubble: any = {
    type: 'bubble', size: 'mega',
    header,
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [...top, ...body] },
  };
  const footer: any[] = [];
  if (opts.footnote) footer.push(text(opts.footnote, { size: 'xxs', color: GRAY }));
  if (url) footer.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '打開系統看詳情', uri: url } });
  if (footer.length) bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer };

  return {
    type: 'flex',
    altText: title.slice(0, 380),
    contents: bubble,
    _fallbackText: [full, opts.footnote].filter(Boolean).join('\n').slice(0, 4900),
  };
}

/** 送出前拿掉內部欄位；fallback=true 時把卡片換回純文字 */
export function finalizeMessages(msgs: any[], fallback = false): any[] {
  return msgs.map(m => {
    if (m?.type !== 'flex') return m;
    const { _fallbackText, ...rest } = m;
    return fallback ? { type: 'text', text: _fallbackText || m.altText } : rest;
  });
}
