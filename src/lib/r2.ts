import { AwsClient } from 'aws4fetch';

/**
 * Cloudflare R2（審片影片，2026-10-30）。只在後端用：金鑰在 Vercel 環境變數，前端只拿簽好的短效網址。
 *
 * 為什麼：審片檔放 Google 雲端，就只能用 Google 的播放器（控制列擋畫面）；改走 Vercel 轉送又會吃爆流量（10-27）。
 * 放 R2 → 瀏覽器直接上傳、客戶手機直接播，都不經過 Vercel，R2 看片流量不收錢。
 * 業主通過、剪輯師按上傳雲端時，Cloudflare Worker（review-media-worker）把檔案搬進 Google 成片夾，後續流程照舊。
 *
 * 沒設 R2_BUCKET＝整個功能關閉，審片上傳自動退回原本的 Google 雲端路徑（回滾開關）。
 */

export const R2_PART_SIZE = 16 * 1024 * 1024; // 分段上傳每段 16MB：20GB 上限＝1,280 段，遠低於 10,000 段

export function isR2Configured(): boolean {
  return !!(process.env.R2_BUCKET && process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

let client: AwsClient | null = null;
function r2() {
  if (!isR2Configured()) throw new Error('R2 還沒設定');
  client ??= new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  });
  return client;
}

/** 物件網址；key 每一段都要編碼（中文、空白），但保留斜線 */
export function objectUrl(key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${path}`;
}

async function presign(method: string, url: URL, expiresSec: number): Promise<string> {
  url.searchParams.set('X-Amz-Expires', String(expiresSec));
  const signed = await r2().sign(url.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

async function call(method: string, url: string, body?: string): Promise<Response> {
  const res = await r2().fetch(url, { method, body });
  if (!res.ok) throw new Error(`R2 ${method} 失敗（HTTP ${res.status}）${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res;
}

const xmlTag = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] || '';

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  const res = await r2().fetch(`${objectUrl(key)}?uploads`, { method: 'POST', headers: { 'Content-Type': contentType } });
  if (!res.ok) throw new Error(`R2 開始上傳失敗（HTTP ${res.status}）`);
  const uploadId = xmlTag(await res.text(), 'UploadId');
  if (!uploadId) throw new Error('R2 沒回上傳編號');
  return uploadId;
}

/** 每一段的上傳網址（瀏覽器直接 PUT，6 小時有效：大檔、慢網路也傳得完） */
export async function presignParts(key: string, uploadId: string, partNumbers: number[]): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const n of partNumbers) {
    const url = new URL(objectUrl(key));
    url.searchParams.set('partNumber', String(n));
    url.searchParams.set('uploadId', uploadId);
    out[n] = await presign('PUT', url, 6 * 3600);
  }
  return out;
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: { n: number; etag: string }[]): Promise<void> {
  const url = new URL(objectUrl(key));
  url.searchParams.set('uploadId', uploadId);
  const body = '<CompleteMultipartUpload>' +
    [...parts].sort((a, b) => a.n - b.n)
      .map(p => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag.replace(/[<>&]/g, '')}</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';
  const res = await call('POST', url.toString(), body);
  // S3 規格：完成分段上傳可能回 200 但內容是錯誤
  const text = await res.text();
  if (/<Error>/.test(text)) throw new Error(`R2 合併檔案失敗：${xmlTag(text, 'Message') || xmlTag(text, 'Code')}`);
}

export async function headObject(key: string): Promise<{ size: number; contentType: string } | null> {
  const res = await r2().fetch(objectUrl(key), { method: 'HEAD' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 查檔失敗（HTTP ${res.status}）`);
  return { size: Number(res.headers.get('content-length') || 0), contentType: res.headers.get('content-type') || '' };
}

/** 給預覽頁 <video> 的播放網址：客戶手機直接向 R2 拿，支援拖進度條（Range） */
export async function presignGet(key: string, expiresSec = 6 * 3600): Promise<string> {
  return presign('GET', new URL(objectUrl(key)), expiresSec);
}

export async function deleteObject(key: string): Promise<void> {
  const res = await r2().fetch(objectUrl(key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`R2 刪檔失敗（HTTP ${res.status}）`);
}

/** R2 物件位置：review/<assetId>/v<版本>-<亂數>.<副檔名>（亂數避免重傳同一版時蓋到還在播的舊檔） */
export function reviewObjectKey(assetId: string, version: number, ext: string, rand: string): string {
  const safeExt = /^\.[A-Za-z0-9]{2,5}$/.test(ext) ? ext.toLowerCase() : '.mp4';
  return `review/${assetId}/v${version}-${rand}${safeExt}`;
}
