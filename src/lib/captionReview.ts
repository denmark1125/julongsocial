/**
 * 業主審文案（2026-11-16 使用者要求）。
 *
 * 流程：片出來 → 小編在貼文寫文案 → 按「送業主審文案」→ 客戶 LINE 群組收到卡片（全文＋兩顆按鈕）
 *      → 業主按「文案 OK」＝ posts.clientConfirmed=true；按「要修改」＝接著在群組打字，系統收成「業主意見」。
 *      願意點連結的業主另有客戶端 /c/<代碼>（src/client/）：上片行事曆、五站進度、審片、確認／修改文案。
 * 所有 IP 同一張卡片、同一個流程，不做特例。
 *
 * ⚠️ 純函式、不 import 任何東西：server.ts 在 Vercel 原生 ESM 下載入，lib 裡沒寫 .js 的 import 會整支掛掉。
 * ⚠️ 業主在 LINE 打的字**不會自動蓋掉文案**：可能是整篇新文案，也可能只是「第二行改成…」，系統分不出來。
 *    一律存成意見（captionReview.feedback），由小編決定要不要套用。
 * ⚠️ 「業主確認了沒」的唯一來源仍然是 posts.clientConfirmed（發布擋關、發布稽核都看它），
 *    這裡的 captionReview 只是補充「怎麼確認的、有沒有意見」，不要另外發明第二個確認欄位。
 */

export interface CaptionFeedback {
  at: string;
  byName: string;
  text: string;
  /** line＝業主按「要修改」後在群組打的；manual＝小編手動貼上的 */
  via: 'line' | 'manual';
}

export interface CaptionHistoryEntry {
  at: string;
  by: 'client' | 'staff';
  byName?: string;
  /** 改之前的文案 */
  before: string;
}

export interface CaptionReview {
  sentAt?: string;
  sentByUid?: string;
  sentByName?: string;
  /** 第幾次送審（第 2 次起卡片標「修改版」） */
  sendCount?: number;
  approvedAt?: string;
  /** line＝LINE 卡片按鈕；page＝文案頁按鈕；page_edit＝業主在文案頁改字後存檔 */
  approvedVia?: 'line' | 'page' | 'page_edit';
  approvedByName?: string;
  /** 業主確認當下的文案，用來判斷「確認後小編有沒有再改」 */
  approvedContent?: string;
  changeRequestedAt?: string;
  changeRequestedByName?: string;
  feedback?: CaptionFeedback[];
  history?: CaptionHistoryEntry[];
}

export type CaptionStatus =
  | 'published' | 'empty' | 'unsent' | 'sent' | 'change_requested'
  | 'approved' | 'client_edited' | 'changed_after';

interface PostLike {
  id?: string;
  title?: string;
  content?: string;
  status?: string;
  scheduledAt?: string;
  platforms?: string[];
  clientConfirmed?: boolean;
  captionReview?: CaptionReview;
}

/** 這篇文案現在在哪一步。小編端的標籤與文案頁的顏色都從這裡來 */
export function captionStatus(p: PostLike): CaptionStatus {
  if (p.status === 'published') return 'published';
  if (!String(p.content || '').trim()) return 'empty';
  const cr = p.captionReview || {};
  if (p.clientConfirmed) {
    if (cr.approvedContent != null && cr.approvedContent !== (p.content || '')) return 'changed_after';
    return cr.approvedVia === 'page_edit' ? 'client_edited' : 'approved';
  }
  if (cr.changeRequestedAt && (!cr.sentAt || cr.changeRequestedAt >= cr.sentAt)) return 'change_requested';
  return cr.sentAt ? 'sent' : 'unsent';
}

/** 小編端看的標籤 */
export const CAPTION_STATUS_LABEL: Record<CaptionStatus, string> = {
  published: '已發布',
  empty: '還沒寫文案',
  unsent: '未送審',
  sent: '已送審・等業主',
  change_requested: '業主要修改',
  approved: '業主已確認',
  client_edited: '業主已改字並確認',
  changed_after: '確認後有改過',
};

/** 可以送審嗎：有文案、還沒發布 */
export function canSendCaption(p: PostLike): boolean {
  return p.status !== 'published' && !!String(p.content || '').trim();
}

/** IG 文案上限 */
export const CAPTION_MAX_LEN = 2200;
/** 卡片裡最多放幾個字（超過截斷、請對方開網頁看全文）。多篇一起送時每篇更短，整則才不會超過 LINE 的 50KB */
const CARD_TEXT_SINGLE = 1500;
const CARD_TEXT_MULTI = 700;
/** LINE carousel 一則最多 12 張 */
export const CAPTION_CARDS_MAX = 12;
/** 按「要修改」後，同一個人接下來幾分鐘內打的字算意見 */
export const FEEDBACK_WINDOW_MINUTES = 10;

const BRAND = '#5A5A40';
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** '2026-11-14T20:00' → '11/14（六）20:00'；沒排時間的回空字串。scheduledAt 是台灣時間的字面值，不做時區換算 */
export function captionDateLabel(scheduledAt?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(scheduledAt || ''));
  if (!m) return '';
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${Number(m[2])}/${Number(m[3])}（${WEEK[dow]}）${m[4] ? `${m[4]}:${m[5]}` : ''}`;
}

/* ───────────── LINE 按鈕（postback） ───────────── */

export type CaptionPostback = { action: 'ok' | 'fix'; postId: string };

export const captionPostbackData = (action: 'ok' | 'fix', postId: string) => `cap=${action}&p=${postId}`;

export function parseCaptionPostback(data: unknown): CaptionPostback | null {
  const m = /^cap=(ok|fix)&p=([A-Za-z0-9_-]{1,64})$/.exec(String(data || ''));
  return m ? { action: m[1] as 'ok' | 'fix', postId: m[2] } : null;
}

/* ───────────── LINE 卡片 ───────────── */

export interface CaptionCardInfo {
  postId: string;
  vendorName: string;
  title: string;
  content: string;
  scheduledAt?: string;
  platforms?: string[];
  /** 第幾次送審 */
  sendCount?: number;
  /** 文案頁上這一篇的網址 */
  pageUrl: string;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

function captionBubble(info: CaptionCardInfo, textMax: number) {
  const when = captionDateLabel(info.scheduledAt);
  const sub = [when, (info.platforms || []).join('／')].filter(Boolean).join('・') || '上片日未定';
  const full = String(info.content || '').trim();
  const cut = full.length > textMax;
  const short = clip(info.title || '(未命名)', 20);
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '16px',
      contents: [
        { type: 'text', text: `📝 文案確認｜${info.vendorName || ''}${(info.sendCount || 1) > 1 ? '（修改版）' : ''}`, color: '#FFFFFF', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: sub, color: '#E8E8DC', size: 'sm', margin: 'xs', wrap: true },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '16px',
      contents: [
        { type: 'text', text: info.title || '(未命名)', weight: 'bold', size: 'md', wrap: true, color: '#222222' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: cut ? `${full.slice(0, textMax)}…` : full, size: 'md', color: '#333333', wrap: true, margin: 'md' },
        ...(cut ? [{ type: 'text', text: '（文案較長，全文請按下方「開啟客戶端」）', size: 'xs', color: '#8A8A7A', wrap: true, margin: 'md' }] : []),
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px',
      contents: [
        { type: 'button', style: 'primary', color: '#2F9E5B', height: 'sm',
          action: { type: 'postback', label: '✅ 文案 OK', data: captionPostbackData('ok', info.postId), displayText: `文案 OK：${when ? `${when} ` : ''}${short}` } },
        { type: 'button', style: 'secondary', height: 'sm',
          action: { type: 'postback', label: '✏️ 要修改', data: captionPostbackData('fix', info.postId), displayText: `要修改：${when ? `${when} ` : ''}${short}` } },
        { type: 'button', style: 'link', height: 'sm', color: BRAND,
          action: { type: 'uri', label: '開啟客戶端（排程／改字）', uri: info.pageUrl } },
      ],
    },
  };
}

/** 一篇＝一張卡；多篇＝左右滑（只扣一次額度）。超過 12 篇的呼叫端要先切 */
export function buildCaptionReviewMessage(items: CaptionCardInfo[]) {
  const list = items.slice(0, CAPTION_CARDS_MAX);
  const first = list[0];
  if (!first) return null;
  if (list.length === 1) {
    return {
      type: 'flex',
      altText: clip(`文案確認：${first.vendorName}｜${first.title}`, 300),
      contents: captionBubble(first, CARD_TEXT_SINGLE),
    };
  }
  return {
    type: 'flex',
    altText: clip(`文案確認：${first.vendorName} ${list.length} 篇，請左右滑逐篇確認`, 300),
    contents: { type: 'carousel', contents: list.map(i => captionBubble(i, CARD_TEXT_MULTI)) },
  };
}

/** 業主按完按鈕後機器人在群組回的那句（回覆不扣額度） */
export function captionReplyText(kind: 'ok' | 'already' | 'fix' | 'received' | 'published' | 'gone' | 'wrong_group', p?: PostLike): string {
  const name = p ? `${captionDateLabel(p.scheduledAt) ? `${captionDateLabel(p.scheduledAt)} ` : ''}《${clip(p.title || '未命名', 30)}》` : '';
  switch (kind) {
    case 'ok': return `✅ ${name}文案已確認，謝謝！`;
    case 'already': return `${name}文案先前已經確認過了，謝謝！`;
    case 'fix': return `好的，${name}請直接在這裡打要修改的地方（${FEEDBACK_WINDOW_MINUTES} 分鐘內），我們會轉給小編。`;
    case 'received': return '收到，已轉給小編，改好會再傳一次給您確認。';
    case 'published': return `${name}已經發布了，要調整請直接告訴我們。`;
    case 'gone': return '這篇貼文已經不在排程裡了，請直接告訴我們要確認哪一篇。';
    case 'wrong_group': return '這張卡片不是這個群組的，按鈕在這裡沒有作用。';
  }
}

/* ───────────── 月份（客戶端 /c/<代碼>?m=YYYY-MM 用）───────────── */

export const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const isMonthKey = (s: unknown): s is string => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
