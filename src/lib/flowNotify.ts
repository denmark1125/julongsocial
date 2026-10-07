import { auth } from '../firebase';

// 從 assetFlow.ts 搬出來：assetFlow 要保持純函式（不碰 Firebase），才能在 node 跑自動測試。

/**
 * 交棒完成後發即時 LINE 通知。
 *
 * ⚠️ 2026-08-12 起沒有任何地方呼叫這支——老闆回報「LINE 好吵」，即時推播改成
 * 每日 09:30 的彙總（server.ts 的 buildFlowDigestMessage）。函式跟 /api/notify/flow-event
 * 端點都留著，是為了將來要恢復即時通知時不用重寫。
 * 通知失敗絕不能讓交棒本身失敗——狀態已經寫進 Firestore 了，所以這裡只記 log 不擋流程。
 * 內容由伺服器自己讀 Firestore 組出來，這裡只送 assetId + 事件種類。
 */
export async function notifyFlowEvent(assetId: string, kind: 'submitted' | 'uploaded'): Promise<void> {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const idToken = await user.getIdToken();
    await fetch('/api/notify/flow-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, assetId, kind }),
    });
  } catch (e) {
    console.warn('flow event notify failed (狀態已更新，僅通知未送出)', e);
  }
}
