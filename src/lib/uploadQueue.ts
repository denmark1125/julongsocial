import { useSyncExternalStore } from 'react';

/**
 * 剪輯師上傳成片的進度（全頁共用）。2026-10-21 起。
 *
 * 系統直傳本來就能同時傳好幾支，但以前進度只在右上角一則小通知，剪輯師以為要卡著等一支傳完。
 * 現在卡片上直接顯示進度，右下角有「上傳中」面板（UploadPanel）。
 *
 * ⚠️ 放模組層、不放元件 state：「我的剪輯任務」「我的所有片」是兩個分頁，切換時元件會卸載，
 *    傳輸本身（promise）不會停，進度也不能跟著不見。
 * ⚠️ 每支片各自一筆：以前共用一個 busyId，同時傳兩支時第一支傳完會把第二支的「處理中」清掉。
 */
export interface UploadItem {
  assetId: string;
  title: string;
  percent: number;
  status: 'uploading' | 'done' | 'failed';
  error?: string;
}

type Runner = (onProgress: (percent: number) => void) => Promise<boolean>;

let items: UploadItem[] = [];
const runners = new Map<string, Runner>();
const listeners = new Set<() => void>();
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: UploadItem[]) {
  items = next;
  listeners.forEach(l => l());
}

function patch(assetId: string, change: Partial<UploadItem>) {
  emit(items.map(i => (i.assetId === assetId ? { ...i, ...change } : i)));
}

/** 傳到一半關頁＝白傳。有在傳的才擋，提醒裡帶支數 */
function onBeforeUnload(e: BeforeUnloadEvent) {
  const n = items.filter(i => i.status === 'uploading').length;
  if (!n) return;
  e.preventDefault();
  e.returnValue = `還有 ${n} 支在上傳`;
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload);

/** 全部傳完（沒有在傳、也沒有失敗）幾秒後把完成的列收掉 */
function scheduleClear() {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    if (items.some(i => i.status === 'uploading')) return;
    emit(items.filter(i => i.status === 'failed'));
  }, 5000);
}

/**
 * 開始傳一支。run 回傳 false＝使用者在選檔時取消（那就什麼都不留）。
 * 第一次回報進度時才出現在面板上：選檔視窗開著的時候不要先冒一列「0%」。
 */
export async function startUpload(assetId: string, title: string, run: Runner): Promise<boolean> {
  if (items.some(i => i.assetId === assetId && i.status === 'uploading')) return false;
  runners.set(assetId, run);
  let shown = false;
  const onProgress = (percent: number) => {
    if (!shown) {
      shown = true;
      emit([...items.filter(i => i.assetId !== assetId), { assetId, title, percent, status: 'uploading' }]);
    } else {
      patch(assetId, { percent });
    }
  };
  try {
    const ok = await run(onProgress);
    if (!ok) {
      emit(items.filter(i => i.assetId !== assetId));
      return false;
    }
    if (!shown) emit([...items, { assetId, title, percent: 100, status: 'done' }]);
    else patch(assetId, { percent: 100, status: 'done' });
    runners.delete(assetId);
    scheduleClear();
    return true;
  } catch (e: any) {
    const error = e?.message || '上傳失敗';
    if (!shown) emit([...items, { assetId, title, percent: 0, status: 'failed', error }]);
    else patch(assetId, { status: 'failed', error });
    throw e;
  }
}

/** 失敗那一列的「重試」：用同一個 run 再來一次（會重新選檔） */
export function retryUpload(assetId: string): Promise<boolean> | null {
  const run = runners.get(assetId);
  const item = items.find(i => i.assetId === assetId);
  if (!run || !item) return null;
  return startUpload(assetId, item.title, run).catch(() => false);
}

export function dismissUpload(assetId: string) {
  runners.delete(assetId);
  emit(items.filter(i => i.assetId !== assetId));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const snapshot = () => items;

/** 目前的上傳列（測試與非 React 程式用） */
export function getUploads(): UploadItem[] {
  return items;
}

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
