/**
 * 剪輯師在系統內上傳成片＋業主通過後自動送客戶資料夾（2026-10-15）。
 *
 * - 上傳：系統代傳。剪輯師不登入 Google、不拿聚浪帳密；後端替這支片在該 IP 成片夾開一個續傳通道，
 *   瀏覽器直接把檔案送進去，檔案以公司身分落地（算聚浪的、剪輯師刪不掉）。
 * - 送客戶：素材變成 ready（已上傳＋業主通過）之後才送。要不要送、送什麼全由後端判斷，
 *   這裡只負責「有可能變 ready 了，請後端看一下」。漏掉也沒關係，每日 cron 會補。
 */
import { auth } from '../firebase';
import type { Asset, Vendor } from '../types';

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
 * 這支片能不能走系統上傳：IP 有設成片夾就可以。否則照舊「自己傳、回來標記」。
 * extraVendorIds：讀不到廠商文件的 IP（逐支指派到別家）由後端回報有成片夾的那幾家，見 fetchFinishedUploadVendors。
 * ⚠️ 2026-10-20 起不再走 Picker（見 uploadFinishedFiles），所以不看 isPickerConfigured。
 */
export function canUploadFinishedInApp(asset: Pick<Asset, 'vendorId'>, vendors: Vendor[], extraVendorIds?: Set<string>): boolean {
  if (vendors.find(v => v.id === asset.vendorId)?.finishedFolderId) return true;
  return !!extraVendorIds?.has(asset.vendorId);
}

/** 問後端：這幾家 IP 哪些有設成片夾（給讀不到廠商文件的逐支指派片用）。失敗就當都沒有＝退回「已自行上傳」 */
export async function fetchFinishedUploadVendors(vendorIds: string[]): Promise<Set<string>> {
  if (vendorIds.length === 0) return new Set();
  try {
    const data = await callApi('/api/drive/editor-upload-vendors', { vendorIds });
    return new Set<string>(data.vendorIds || []);
  } catch {
    return new Set();
  }
}

export interface UploadedFile { id: string; name: string; sizeBytes: number }

/** 讓剪輯師從電腦選檔。取消＝空陣列 */
function chooseFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*';
    let settled = false;
    const done = (files: File[]) => { if (!settled) { settled = true; resolve(files); } };
    input.addEventListener('change', () => done(Array.from(input.files || [])));
    // 按「取消」：新版瀏覽器會發 cancel；舊的沒有，靠視窗重新取得焦點時判斷
    input.addEventListener('cancel', () => done([]));
    window.addEventListener('focus', () => setTimeout(() => done(Array.from(input.files || [])), 800), { once: true });
    input.click();
  });
}

/** 一段 8 MB（必須是 256 KB 的倍數，Google 的規定） */
const CHUNK = 8 * 1024 * 1024;

/**
 * 把一個檔案分段 PUT 進續傳通道。每段失敗最多重試 4 次；重試前先問 Google 收到哪裡，從那裡接著傳。
 */
async function putResumable(uploadUrl: string, file: File, onBytes: (sent: number) => void): Promise<{ id: string }> {
  const total = file.size;
  let offset = 0;
  let attempts = 0;
  while (true) {
    const end = Math.min(offset + CHUNK, total);
    let res: Response;
    try {
      res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        body: file.slice(offset, end),
      });
    } catch (e) {
      // 網路斷掉：問 Google 已經收到多少，再接著傳
      if (++attempts > 4) throw new Error('網路中斷太多次，請檢查網路後重新上傳');
      await new Promise(r => setTimeout(r, 1500 * attempts));
      const probe = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } }).catch(() => null);
      if (probe?.status === 200 || probe?.status === 201) return probe.json();
      const range = probe?.headers.get('range');
      offset = range ? Number(range.split('-')[1]) + 1 : offset;
      continue;
    }
    if (res.status === 200 || res.status === 201) { onBytes(total); return res.json(); }
    if (res.status === 308) {
      // 308＝這一段收到了，Range 告訴我們收到哪裡
      const range = res.headers.get('range');
      offset = range ? Number(range.split('-')[1]) + 1 : 0;
      attempts = 0;
      onBytes(offset);
      continue;
    }
    if (res.status >= 500 && ++attempts <= 4) { await new Promise(r => setTimeout(r, 1500 * attempts)); continue; }
    throw new Error(`上傳被雲端拒絕（${res.status}）`);
  }
}

/**
 * 選檔 → 逐檔開通道直傳公司雲端 → 傳完向後端登記是哪幾個檔。
 * 回傳空陣列＝使用者取消（不是錯誤，什麼都不要標記）。
 *
 * ⚠️ 2026-10-20 起不用 Google Picker 的上傳視窗：它用的是**瀏覽器登入的 Google 帳號**，
 *    剪輯師的帳號沒有公司成片夾權限 → 「Server rejected」，上線後剪輯師一次都沒傳成功。
 *    改成後端開續傳通道（帶網站來源，Google 才回 CORS），瀏覽器直接送，跟剪輯師登入哪個 Google 帳號無關。
 * ⚠️ 「已上傳雲端」（請款依據）不在這裡寫，呼叫端接著走原本的 markUploaded。
 */
export async function uploadFinishedFiles(
  asset: Asset,
  onProgress?: (p: { fileIndex: number; fileCount: number; fileName: string; percent: number }) => void,
): Promise<UploadedFile[]> {
  const files = await chooseFiles();
  if (files.length === 0) return [];
  if (files.length > 20) throw new Error('一次最多 20 個檔案');

  const grand = files.reduce((n, f) => n + f.size, 0) || 1;
  let doneBytes = 0;
  const uploaded: UploadedFile[] = [];
  // 關頁提醒由 uploadQueue 統一處理（帶「還有 N 支」），這裡不再各掛一個
  onProgress?.({ fileIndex: 0, fileCount: files.length, fileName: files[0].name, percent: 0 });
  {
    for (const [i, file] of files.entries()) {
      const { uploadUrl } = await callApi('/api/drive/editor-upload-session', {
        assetId: asset.id, fileName: file.name, size: file.size, mimeType: file.type || 'application/octet-stream',
      });
      const result = await putResumable(uploadUrl, file, sent =>
        onProgress?.({ fileIndex: i, fileCount: files.length, fileName: file.name, percent: Math.floor(((doneBytes + sent) / grand) * 100) }));
      doneBytes += file.size;
      uploaded.push({ id: result.id, name: file.name, sizeBytes: file.size });
    }
  }
  await callApi('/api/drive/editor-upload-done', { assetId: asset.id, fileIds: uploaded.map(f => f.id) });
  return uploaded;
}

/**
 * 交片送審：把剪輯師選的那一支直傳到「剪輯影片審核區 / YYYY/MM / IP名」，傳完登記並拿到給客戶的預覽頁網址。2026-10-21 起。
 * ⚠️ 送審本身（轉業主審核中、記送審時間）在呼叫端先寫好；這裡只負責檔案，失敗可以從上傳面板重試，不影響送審狀態。
 */
export async function uploadReviewFile(
  asset: Asset, file: File, onProgress?: (percent: number) => void,
): Promise<{ previewUrl: string | null }> {
  const session = await callApi('/api/drive/review-upload-session', {
    assetId: asset.id, fileName: file.name, size: file.size, mimeType: file.type || 'video/mp4', r2: true,
  });
  onProgress?.(0);
  const percent = (sent: number) => onProgress?.(Math.floor((sent / (file.size || 1)) * 100));
  let done;
  if (session.mode === 'r2') {
    const durationSec = await readDuration(file);
    const parts = await putR2Parts(session, file, asset.id!, percent);
    done = await callApi('/api/drive/review-upload-done', {
      assetId: asset.id, key: session.key, uploadId: session.uploadId, parts, name: session.name, durationSec,
    });
  } else {
    const result = await putResumable(session.uploadUrl, file, percent);
    done = await callApi('/api/drive/review-upload-done', { assetId: asset.id, fileId: result.id });
  }
  return { previewUrl: done.previewUrl ? `${window.location.origin}${done.previewUrl}` : null };
}

/**
 * 審片檔直傳 R2（2026-10-30）：切成 16MB 一段、同時傳 3 段，每段失敗重試 4 次。
 * 傳完收集每段的 ETag 交給後端合併。ETag 要靠 bucket 的 CORS 設定「露出 ETag」才讀得到。
 */
async function putR2Parts(
  session: { key: string; uploadId: string; partSize: number; partCount: number; partUrls: Record<number, string> },
  file: File, assetId: string, onBytes: (sent: number) => void,
): Promise<{ n: number; etag: string }[]> {
  const urls: Record<number, string> = { ...session.partUrls };
  const etags: { n: number; etag: string }[] = [];
  let sent = 0;
  let next = 1;
  const urlFor = async (n: number) => {
    if (!urls[n]) {
      const want = Array.from({ length: Math.min(100, session.partCount - n + 1) }, (_, i) => n + i);
      const r = await callApi('/api/drive/review-upload-part-urls', { assetId, key: session.key, uploadId: session.uploadId, parts: want });
      Object.assign(urls, r.partUrls);
    }
    return urls[n];
  };
  const lane = async () => {
    while (next <= session.partCount) {
      const n = next++;
      const start = (n - 1) * session.partSize;
      const blob = file.slice(start, Math.min(start + session.partSize, file.size));
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(await urlFor(n), { method: 'PUT', body: blob });
          if (!res.ok) throw new Error(`上傳被拒絕（${res.status}）`);
          const etag = res.headers.get('ETag');
          if (!etag) throw new Error('上傳設定有問題（讀不到檔案驗證碼），請通知主管');
          etags.push({ n, etag });
          sent += blob.size;
          onBytes(sent);
          break;
        } catch (e) {
          if (attempt >= 4) throw e instanceof Error ? e : new Error('網路中斷太多次，請檢查網路後重新上傳');
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }
  };
  await Promise.all([lane(), lane(), lane()]);
  return etags;
}

/** 影片秒數：以前靠 Google 處理完才知道，現在檔案不經過 Google，上傳前在瀏覽器讀。讀不到就算了，不擋上傳 */
function readDuration(file: File): Promise<number | undefined> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const finish = (sec?: number) => { URL.revokeObjectURL(url); resolve(sec); };
    const timer = setTimeout(() => finish(undefined), 8000);
    v.preload = 'metadata';
    v.onloadedmetadata = () => { clearTimeout(timer); finish(Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : undefined); };
    v.onerror = () => { clearTimeout(timer); finish(undefined); };
    v.src = url;
  });
}

/** 業主通過後「上傳雲端」：審核區已經有這支片，請後端搬進 IP 成片夾（不重傳） */
export async function finalizeReviewFile(asset: Asset): Promise<void> {
  await callApi('/api/drive/review-to-finished', { assetId: asset.id });
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
