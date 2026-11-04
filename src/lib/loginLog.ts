import { addDoc, collection } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile } from '../types';

/**
 * 登入紀錄（2026-11-04 使用者：工程師頁要看每個帳號登入次數與時間）。
 *
 * 兩種事件：
 *   login ＝真的輸入帳密登入（按「登入系統」成功）
 *   open  ＝已經是登入狀態，直接打開系統（Firebase 會記住登入，大多數人其實是這種）
 * open 每個瀏覽器分頁階段只記一次，重新整理不重複記，不然一天會有幾十筆。
 * 寫入失敗一律吞掉：紀錄不能影響登入本身。
 */

const JUST_LOGGED_IN = 'loginLog.justLoggedIn';
const OPEN_LOGGED = 'loginLog.openLoggedUid';

/** 按下登入成功前呼叫，讓接下來的 onAuthStateChanged 知道這次是真的輸入帳密 */
export function markExplicitLogin() {
  try { sessionStorage.setItem(JUST_LOGGED_IN, '1'); } catch { /* ignore */ }
}

export function deviceLabel(ua: string = navigator.userAgent): string {
  if (/iPhone|Android.+Mobile|Mobile Safari/i.test(ua)) return '手機';
  if (/iPad|Android|Tablet/i.test(ua)) return '平板';
  return '電腦';
}

export async function recordLogin(uid: string, profile: UserProfile) {
  let kind: 'login' | 'open' = 'open';
  try {
    if (sessionStorage.getItem(JUST_LOGGED_IN) === '1') {
      kind = 'login';
      sessionStorage.removeItem(JUST_LOGGED_IN);
    } else if (sessionStorage.getItem(OPEN_LOGGED) === uid) {
      return; // 這個分頁已經記過了（重新整理）
    }
    sessionStorage.setItem(OPEN_LOGGED, uid);
  } catch { /* sessionStorage 被擋就照記，最多多記幾筆 */ }

  try {
    await addDoc(collection(db, 'loginLogs'), {
      uid,
      username: profile.username || '',
      displayName: profile.displayName || '',
      role: profile.role,
      kind,
      device: deviceLabel(),
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('登入紀錄寫入失敗（不影響使用）', e);
  }
}
