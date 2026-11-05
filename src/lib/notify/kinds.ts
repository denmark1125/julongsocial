/**
 * 通知中心：所有 LINE 通知的登記表（2026-11-05）。伺服器的 notify() 與「LINE 串接管理 → 通知規則」頁共用。
 *
 * 規則：
 * - 新增任何 LINE 通知，一律先在這裡登記一種 kind，再呼叫 server 的 notify(kind, …)；不准再直接呼叫 sendLinePushMessage。
 * - mode：off＝不發；test＝改發給老闆、前面加「［測試］原本要發給…」；live＝照收件對象發。
 *   畫面上改的存在 Firestore appConfig/notifications，沒改過的用這裡的 defaultMode。
 * - 對客戶的通知（audience=client）預設一律 test：先讓老闆看一兩週，確認都對再切 live。
 */

export type NotifyMode = 'off' | 'test' | 'live';

export interface NotifyKindDef {
  id: string;
  label: string;
  /** 對內（同事、剪輯師、老闆）或對客戶群組 */
  audience: 'internal' | 'client';
  /** 畫面上給人看的收件對象說明 */
  recipientLabel: string;
  /** 什麼時候發 */
  whenLabel: string;
  /**
   * 預設模式。'personalSwitch'＝沿用舊的 LINE_PERSONAL_PUSH 總開關（on→live、其他→off），
   * 讓搬進通知中心的當下行為完全不變；之後在畫面上改了就以畫面為準。
   */
  defaultMode: NotifyMode | 'personalSwitch';
  /** 額度不夠時的優先順序：1 最重要（不擋）、3 最先省掉 */
  priority: 1 | 2 | 3;
  /** 還沒做的（只佔位置，畫面顯示「規劃中」，不能切 live） */
  planned?: boolean;
}

export const NOTIFY_KINDS: NotifyKindDef[] = [
  // ── 剪輯流程（使用者：很順，盡量不動）──
  { id: 'editor_review', label: '剪輯送審通知', audience: 'internal', recipientLabel: '該剪輯師的剪輯群組', whenLabel: '剪輯師交片送審時', defaultMode: 'live', priority: 1 },
  { id: 'editor_reminder', label: '待審提醒', audience: 'internal', recipientLabel: '剪輯群組', whenLabel: '每 2 個上班日 09:30', defaultMode: 'live', priority: 2 },
  // ── 給老闆 ──
  { id: 'publish_audit', label: '發布稽核', audience: 'internal', recipientLabel: '老闆', whenLabel: '12:00、18:00、發布前檢查與發布後有問題時', defaultMode: 'live', priority: 1 },
  { id: 'stock_alert', label: '影片庫存告急', audience: 'internal', recipientLabel: '老闆', whenLabel: '每天 09:00', defaultMode: 'personalSwitch', priority: 3 },
  { id: 'flow_digest', label: '製作進度彙總', audience: 'internal', recipientLabel: '老闆', whenLabel: '每天 09:30', defaultMode: 'personalSwitch', priority: 3 },
  { id: 'flow_event', label: '交棒即時通知', audience: 'internal', recipientLabel: '老闆', whenLabel: '新片送審／上傳雲端時', defaultMode: 'personalSwitch', priority: 3 },
  { id: 'shoot_sync_alert', label: 'TimeTree 同步失敗', audience: 'internal', recipientLabel: '老闆', whenLabel: '同步出錯時', defaultMode: 'personalSwitch', priority: 2 },
  // ── 規劃中（之後幾個階段做）──
  { id: 'air_notice', label: '上片通知', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '發布後確認上線＋緩衝 10 分鐘', defaultMode: 'test', priority: 1, planned: true },
  { id: 'review_chase', label: '內部催片', audience: 'internal', recipientLabel: 'IP 指派的負責同事', whenLabel: '上片前 24 小時還沒審完', defaultMode: 'test', priority: 2, planned: true },
  { id: 'shoot_booking', label: '拍攝預約通知', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '同事按「確認發送」後', defaultMode: 'test', priority: 1, planned: true },
  { id: 'shoot_reminder', label: '拍攝前一天提醒', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '拍攝前一天 12:00', defaultMode: 'test', priority: 1, planned: true },
  { id: 'monthly_billing', label: '每月帳款通知', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '每月固定日（合約流程完成後）', defaultMode: 'off', priority: 2, planned: true },
];

export const NOTIFY_KIND_MAP = new Map(NOTIFY_KINDS.map(k => [k.id, k]));

export type NotifyRules = Record<string, { mode?: NotifyMode; updatedAt?: string; updatedBy?: string }>;

/**
 * 這一刻某種通知的模式。
 * `personalSwitchOn`＝環境變數 LINE_PERSONAL_PUSH 是否為 on（舊總開關，只影響 defaultMode=personalSwitch 的）。
 * 規劃中的通知最多到 test，避免還沒做完就被誤切成正式發給客戶。
 */
export function resolveNotifyMode(kindId: string, rules: NotifyRules | null | undefined, personalSwitchOn: boolean): NotifyMode {
  const def = NOTIFY_KIND_MAP.get(kindId);
  if (!def) return 'off';
  const set = rules?.[kindId]?.mode;
  const base: NotifyMode = set
    || (def.defaultMode === 'personalSwitch' ? (personalSwitchOn ? 'live' : 'off') : def.defaultMode);
  if (def.planned && base === 'live') return 'test';
  return base;
}

export const NOTIFY_MODE_LABEL: Record<NotifyMode, string> = { off: '關閉', test: '測試（只發老闆）', live: '正式' };
