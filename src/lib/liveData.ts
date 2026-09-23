import { useCallback, useSyncExternalStore } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * 共用的即時資料層：同一份 collection 整個 session 只訂閱一次。
 *
 * 為什麼需要：`App.tsx` 的 renderContent() 切分頁時會卸載上一個元件，元件裡的
 * onSnapshot 跟著斷掉，下次再開又整份重讀。而 vendors 被 7 個畫面各訂一次、
 * assets 6 次、posts 5 次 —— 走過 5 個分頁一趟就是約 4,740 次讀取，
 * 而 Firebase 免費額度是一天 50,000 次。等於一天只夠走 10 趟。
 *
 * 解法的證據就在專案裡：`Layout` 也訂了 assets/posts/vendors/dismissedHabits，
 * 但它從登入到登出都不會卸載，所以那 4 份本來就只讀一次。這支只是把同樣的
 * 生命週期給其他畫面用。
 *
 * ⚠️ 監聽故意放在**模組層**而不是 React state：元件卸載時不取消訂閱，
 *    切回來才不會重讀。只有登出時才由 disposeAllLive() 全部關掉。
 *
 * ⚠️ **剪輯師那三頁不要用這支。** 他們用的是 where('vendorId','==',vid) 這種
 *    帶條件的查詢，那是安全規則要求的（拿掉條件會整條 permission-denied，
 *    不是回空陣列），而且他們本來就不該讀到全庫。
 */

/** 只放「被兩個以上畫面訂閱」的。vendorSecrets／assetReviewNotes 各只有一處用，留在原地。 */
export type LiveCollectionName =
  | 'vendors'
  | 'assets'
  | 'posts'
  | 'dismissedHabits'
  | 'editors'
  | 'shootBookings'
  | 'plannedSlotMoves'
  | 'billingRecords'
  | 'billingContracts';

interface LiveStore {
  /** 目前的資料。**只有內容真的變了才換新陣列** —— useSyncExternalStore 靠參照判斷要不要重繪 */
  docs: unknown[];
  listeners: Set<() => void>;
  unsubscribe: () => void;
}

const registry = new Map<LiveCollectionName, LiveStore>();

function ensureStore(name: LiveCollectionName): LiveStore {
  const existing = registry.get(name);
  if (existing) return existing;

  const store: LiveStore = { docs: [], listeners: new Set(), unsubscribe: () => {} };
  registry.set(name, store);

  store.unsubscribe = onSnapshot(
    collection(db, name),
    (snapshot) => {
      store.docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      store.listeners.forEach(notify => notify());
    },
    (error) => {
      // 讀取失敗保留上一次的資料，不要把畫面清空 —— 清空會讓人以為東西被刪了。
      console.error(`即時訂閱 ${name} 失敗:`, error);
    }
  );

  return store;
}

/**
 * 取得某個 collection 的即時資料。第一個用到的元件負責建立訂閱，之後都共用。
 *
 * 回傳的是原始陣列，**排序／過濾／型別轉換一律留在呼叫端原地不動** ——
 * 這支只換資料來源，不動任何既有邏輯。
 */
const EMPTY: unknown[] = [];

export function useLiveCollection<T>(name: LiveCollectionName, enabled: boolean = true): T[] {
  // ⚠️ `enabled` 不是方便而已，是必須的：**剪輯師角色不能跑未限定範圍的
  //    collection() 查詢**，安全規則會直接 permission-denied（不是回空陣列），
  //    把整個外殼弄壞。Layout 對剪輯師就是靠這個跳過。
  const store = enabled ? ensureStore(name) : null;
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (!store) return () => {};
    store.listeners.add(onStoreChange);
    // ⚠️ 這裡刻意**不**取消 Firestore 訂閱，只移除自己的重繪通知。
    //    取消的話就退回「切分頁重讀」，整支的意義就沒了。
    return () => { store.listeners.delete(onStoreChange); };
  }, [store]);
  const getSnapshot = useCallback(() => (store ? store.docs : EMPTY) as T[], [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 登出時呼叫。不關掉的話：舊監聽會繼續燒讀取量，而且下一個登入的人會先看到上一個人的資料。
 * App.tsx 的 onAuthStateChanged 收到登出時要叫這支。
 */
export function disposeAllLive(): void {
  registry.forEach(store => {
    store.unsubscribe();
    store.listeners.clear();
  });
  registry.clear();
}
