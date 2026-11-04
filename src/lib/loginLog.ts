import { addDoc, collection, doc, setDoc } from 'firebase/firestore';
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

/**
 * 使用時段（2026-11-04 使用者：想找大家比較少用的時間更新版本）。
 * 分頁開著、而且最近 5 分鐘內真的有動（點、打字、捲動），就記「這個人這個小時有在用」。
 * 一人一小時只記一筆：文件 id 固定為 uid_yyyyMMddHH，第二次寫會被規則（不准 update）擋掉，錯誤吞掉。
 */
export function startActivityHeartbeat(uid: string, profile: UserProfile): () => void {
  let lastInput = Date.now();
  const written = new Set<string>();
  const onInput = () => { lastInput = Date.now(); };
  const events = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
  events.forEach(e => window.addEventListener(e, onInput, { passive: true, capture: true }));

  const tick = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastInput > 5 * 60_000) return;
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const hourKey = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}`;
    if (written.has(hourKey)) return;
    written.add(hourKey);
    setDoc(doc(db, 'loginLogs', `${uid}_${hourKey}`), {
      uid,
      username: profile.username || '',
      displayName: profile.displayName || '',
      role: profile.role,
      kind: 'active',
      device: deviceLabel(),
      at: now.toISOString(),
    }).catch(() => { /* 這小時別的分頁已記過，或沒網路：都不影響使用 */ });
  };
  tick();
  const timer = window.setInterval(tick, 60_000);
  const onVisible = () => { if (document.visibilityState === 'visible') { lastInput = Date.now(); tick(); } };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    events.forEach(e => window.removeEventListener(e, onInput, { capture: true }));
  };
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
