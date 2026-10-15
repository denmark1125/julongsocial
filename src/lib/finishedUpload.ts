/**
 * 剪輯師在系統內上傳成片＋業主通過後自動送客戶資料夾（2026-10-15）。
 *
 * - 上傳：系統代傳。剪輯師不登入 Google、不拿聚浪帳密；後端發一顆限這支片、限該 IP 成片夾的
 *   短效 token 給 Google 上傳視窗，檔案以公司身分落地（算聚浪的、剪輯師刪不掉）。
 * - 送客戶：素材變成 ready（已上傳＋業主通過）之後才送。要不要送、送什麼全由後端判斷，
 *   這裡只負責「有可能變 ready 了，請後端看一下」。漏掉也沒關係，每日 cron 會補。
 */
import { auth } from '../firebase';
import type { Asset, Vendor } from '../types';
import { openUploadPicker, getPickerApiKey, isPickerConfigured, type PickedFile } from './drivePicker';

async function callApi(path: string, body: Record<string, unknown>) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('認證已過期，請重新登入');
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `伺服器回 ${res.status}`);
  return data;
}

/**
 * 這支片能不能走系統上傳：IP 有設成片夾，而且 Picker 設定好了。否則照舊「自己傳、回來標記」。
 * extraVendorIds：讀不到廠商文件的 IP（逐支指派到別家）由後端回報有成片夾的那幾家，見 fetchFinishedUploadVendors。
 */
export function canUploadFinishedInApp(asset: Pick<Asset, 'vendorId'>, vendors: Vendor[], extraVendorIds?: Set<string>): boolean {
  if (!isPickerConfigured()) return false;
  if (vendors.find(v => v.id === asset.vendorId)?.finishedFolderId) return true;
  return !!extraVendorIds?.has(asset.vendorId);
}

/** 問後端：這幾家 IP 哪些有設成片夾（給讀不到廠商文件的逐支指派片用）。失敗就當都沒有＝退回「已自行上傳」 */
export async function fetchFinishedUploadVendors(vendorIds: string[]): Promise<Set<string>> {
  if (vendorIds.length === 0 || !isPickerConfigured()) return new Set();
  try {
    const data = await callApi('/api/drive/editor-upload-vendors', { vendorIds });
    return new Set<string>(data.vendorIds || []);
  } catch {
    return new Set();
  }
}

/**
 * 開上傳視窗 → 傳完向後端登記是哪幾個檔。
 * 回傳空陣列＝使用者取消（不是錯誤，什麼都不要標記）。
 * ⚠️ 「已上傳雲端」（請款依據）不在這裡寫，呼叫端接著走原本的 markUploaded。
 */
export async function uploadFinishedFiles(asset: Asset): Promise<PickedFile[]> {
  const cred = await callApi('/api/drive/editor-upload-auth', { assetId: asset.id });
  const files = await openUploadPicker({
    accessToken: cred.accessToken,
    apiKey: getPickerApiKey(),
    appId: cred.appId,
    folderId: cred.folderId,
    multiple: true,
    title: `上傳成片：${asset.title}`,
  });
  if (files.length === 0) return [];
  await callApi('/api/drive/editor-upload-done', { assetId: asset.id, fileIds: files.map(f => f.id) });
  return files;
}

/**
 * 「這支片可能剛變成 ready，請後端看要不要送客戶」。
 * 刻意不等、不報錯：送客戶是背景工作，不能讓按鈕卡住或跳錯誤嚇到人；失敗交給每日 cron 補。
 */
export function requestClientCopy(assetId: string | undefined): void {
  if (!assetId) return;
  callApi('/api/drive/copy-to-client', { assetId }).catch(err => {
    console.warn('copy-to-client deferred to daily sweep:', err?.message);
  });
}
