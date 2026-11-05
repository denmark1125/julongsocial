/**
 * 通知中心：所有 LINE 通知的登記表（2026-11-05）。伺服器的 notify() 與「LINE 串接管理 → 通知規則」頁共用。
 *
 * 規則：
 * - 新增任何 LINE 通知，一律先在這裡登記一種 kind，再呼叫 server 的 notify(kind, …)；不准再直接呼叫 sendLinePushMessage。
 * - mode：off＝不發；test＝改發給管理者（工程師帳號）、前面加「［測試］原本要發給…」；live＝照收件對象發。
 *   畫面上改的存在 Firestore appConfig/notifications，沒改過的用這裡的 defaultMode。
 * - 對客戶的通知（audience=client）預設一律 test：先讓管理者看一兩週，確認都對再切 live。
 */

export type NotifyMode = 'off' | 'test' | 'live';
export type NotifyTargetGroup = 'owner' | 'editorGroup' | 'staff' | 'clientGroup';

/** 通知規則頁的分組順序與名稱 */
export const NOTIFY_TARGET_GROUPS: { id: NotifyTargetGroup; label: string; hint: string }[] = [
  { id: 'owner', label: '給管理者（工程師帳號）', hint: '推給「員工管理」裡角色是工程師、而且綁好 LINE 的人' },
  { id: 'staff', label: '給同事個人', hint: '推給同事自己的 LINE（要先在「同事個人通知」綁定）' },
  { id: 'editorGroup', label: '給剪輯群組', hint: '每位剪輯師一個群組（在「剪輯群組」綁定）' },
  { id: 'clientGroup', label: '給客戶群組', hint: '每個 IP 一個群組（在「客戶群組」綁定）；群組按人數扣額度' },
];

export interface NotifyKindDef {
  id: string;
  label: string;
  /** 對內（同事、剪輯師、老闆）或對客戶群組 */
  audience: 'internal' | 'client';
  /** 畫面分組用的發送對象（使用者 11-05：照發送對象分類比較好懂） */
  target: NotifyTargetGroup;
  /** 畫面上給人看的收件對象說明 */
  recipientLabel: string;
  /** 什麼時候發 */
  whenLabel: string;
  /** 白話說明這是什麼（使用者 11-05：名詞看不懂） */
  description: string;
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
  { id: 'editor_review', target: 'editorGroup', label: '剪輯送審通知', description: '剪輯師交片後，通知藏鏡人「有新片可以拿給業主審」', audience: 'internal', recipientLabel: '該剪輯師的剪輯群組', whenLabel: '剪輯師交片送審時', defaultMode: 'live', priority: 1 },
  { id: 'editor_reminder', target: 'editorGroup', label: '待審提醒', description: '提醒剪輯群組：哪些片客戶還沒審、哪些審過還沒上傳雲端', audience: 'internal', recipientLabel: '剪輯群組', whenLabel: '每 2 個上班日 09:30', defaultMode: 'live', priority: 2 },
  // ── 給老闆 ──
  { id: 'publish_audit', target: 'owner', label: '發布稽核', description: '今天要發哪些片、Meta 排了沒、發出去有沒有發錯帳號／時間', audience: 'internal', recipientLabel: '管理者', whenLabel: '12:00、18:00、發布前檢查與發布後有問題時', defaultMode: 'live', priority: 1 },
  { id: 'stock_alert', target: 'owner', label: '影片庫存快用完', description: '某個 IP 能用的成片快用完了（兩週內不夠發），要趕快安排拍攝', audience: 'internal', recipientLabel: '管理者', whenLabel: '每天 09:00', defaultMode: 'personalSwitch', priority: 3 },
  { id: 'flow_digest', target: 'owner', label: '每日製作進度整理', description: '每天早上整理昨天的進度：哪些片送客戶審了、哪些已上傳雲端可排程（跟「即時通知」二選一）', audience: 'internal', recipientLabel: '管理者', whenLabel: '每天 09:30', defaultMode: 'personalSwitch', priority: 3 },
  { id: 'flow_event', target: 'owner', label: '製作進度即時通知', description: '跟「每日製作進度整理」同一類，但不等隔天，每有一支片送審或上傳就馬上推一則（兩個二選一）', audience: 'internal', recipientLabel: '管理者', whenLabel: '新片送審／上傳雲端時', defaultMode: 'personalSwitch', priority: 3 },
  { id: 'shoot_sync_alert', target: 'owner', label: 'TimeTree 同步失敗', description: '拍攝行事曆從 TimeTree 同步進系統時出錯，要人去看', audience: 'internal', recipientLabel: '管理者', whenLabel: '同步出錯時', defaultMode: 'personalSwitch', priority: 2 },
  // ── 規劃中（之後幾個階段做）──
  { id: 'air_notice', target: 'clientGroup', label: '上片通知', description: '片子確認上線後，通知客戶「影片已於幾點準時發布」', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '發布後確認上線＋緩衝 10 分鐘', defaultMode: 'test', priority: 1, planned: true },
  { id: 'review_chase', target: 'staff', label: '內部催片', description: '上片前 48、24 小時片子還沒過業主審（還沒有片／還在剪／客戶要改／客戶還沒審），提醒藏鏡人和 PM 去催', audience: 'internal', recipientLabel: '該 IP 的藏鏡人＋PM（廠商管理勾選的）', whenLabel: '上片前 48 小時、前 24 小時', defaultMode: 'test', priority: 2 },
  { id: 'shoot_booking', target: 'clientGroup', label: '拍攝預約通知', description: 'TimeTree 有新的拍攝預約，同事確認沒登錯後通知客戶', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '同事按「確認發送」後', defaultMode: 'test', priority: 1, planned: true },
  { id: 'shoot_reminder', target: 'clientGroup', label: '拍攝前一天提醒', description: '拍攝前一天提醒客戶「明天幾點要拍」', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '拍攝前一天 12:00', defaultMode: 'test', priority: 1, planned: true },
  { id: 'monthly_billing', target: 'clientGroup', label: '每月帳款通知', description: '每月通知客戶本月帳款（等合約流程做好）', audience: 'client', recipientLabel: '該 IP 的客戶群組', whenLabel: '每月固定日（合約流程完成後）', defaultMode: 'off', priority: 2, planned: true },
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

export const NOTIFY_MODE_LABEL: Record<NotifyMode, string> = { off: '關閉', test: '測試（只發管理者）', live: '正式' };
