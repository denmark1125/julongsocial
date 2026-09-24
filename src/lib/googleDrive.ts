/**
 * Google Drive 的後端存取層。**只在 server.ts 用，絕對不要從前端 import。**
 *
 * 為什麼是這個形狀：
 * - 用**公司帳號的 refresh token**，不是服務帳戶。個人 Gmail 沒有共用雲端硬碟，
 *   服務帳戶上傳的檔案由它自己擁有、吃它那 15GB，而且那個配額買不到。
 * - scope 只有 `drive.file`（非敏感，不需要 Google 審核，也不用 CASA 安全評估）。
 *   代價是**只看得到這個 app 自己建立的檔案** —— 所以根資料夾必須由 API 自己建，
 *   不能在設定裡填一個現成資料夾的 ID（填了也讀不到）。
 *
 * ⚠️ 位元組永遠不經過我們的後端。Vercel function 的 request body 上限是 4.5 MB，
 *    而毛片動輒幾十 GB。上傳一律由瀏覽器端的 Google Picker 直接送到 Google。
 *    **不要改回「瀏覽器自己打 resumable 端點」** —— 2026-09-23 用真的 session URL 實測：
 *    位元組送得出去，但回應不帶 CORS 標頭，所以 fileId 讀不回來、308 續傳位置也讀不到，
 *    等於沒有進度、沒有續傳、也不知道成功與否。這支只處理 metadata：建資料夾、搬檔、查容量。
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** 這個 app 建立的東西都打上這個記號，日後對帳／掃孤兒才認得出來 */
export const APP_TAG = 'julongsocial';

export class DriveNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Drive 尚未設定，缺少環境變數：${missing.join('、')}`);
    this.name = 'DriveNotConfiguredError';
  }
}

function readConfig() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  const missing = [
    !id && 'GOOGLE_OAUTH_CLIENT_ID',
    !secret && 'GOOGLE_OAUTH_CLIENT_SECRET',
    !refresh && 'GOOGLE_DRIVE_REFRESH_TOKEN',
  ].filter(Boolean) as string[];
  if (missing.length) throw new DriveNotConfiguredError(missing);
  return { id: id!, secret: secret!, refresh: refresh! };
}

/** 設定齊全才回 true。路由用它決定要不要回 503，而不是讓整個 app 開機失敗 —— */
/** ⚠️ vercel.json 把所有流量都導到 /api，這支 function 掛掉等於整個網站掛掉。 */
export function isDriveConfigured(): boolean {
  try { readConfig(); return true; } catch { return false; }
}

// 模組層快取。serverless 實例很短命，預期每隔幾分鐘就要重換一次，多 200ms 可以接受。
// ⚠️ 不要把 access token 存進 Firestore 來跨實例共用 —— 那是把密鑰放進一個靠規則保護的資料庫。
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const { id, secret, refresh } = readConfig();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id, client_secret: secret,
      refresh_token: refresh, grant_type: 'refresh_token',
    }),
  });
  const data: any = await res.json();
  if (!res.ok || !data.access_token) {
    // 只往外拋 Google 的錯誤代碼，不要把任何憑證帶進訊息裡
    throw new Error(`Drive 授權失效（${data?.error || res.status}）。` +
      `最常見原因：同意畫面退回 Testing（token 7 天失效）、或授權被撤銷。`);
  }
  // 提早 60 秒過期，避免剛好卡在邊界
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function driveFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || res.status;
    const msg = data?.error?.message || '未知錯誤';
    const err: any = new Error(`Drive API ${path} 失敗（${reason}）：${msg}`);
    err.reason = reason;
    err.status = res.status;
    throw err;
  }
  return data;
}

export interface DriveQuota {
  limitBytes: number;
  usageBytes: number;
  freeBytes: number;
  trashBytes: number;
  /** 授權帳號，用來確認沒有接錯成個人帳號 */
  accountEmail: string;
}

export async function getQuota(): Promise<DriveQuota> {
  const d = await driveFetch('/about?fields=user(emailAddress),storageQuota');
  const q = d.storageQuota || {};
  const limit = Number(q.limit || 0);
  const usage = Number(q.usage || 0);
  return {
    limitBytes: limit,
    usageBytes: usage,
    freeBytes: Math.max(0, limit - usage),
    // ⚠️ 垃圾桶的空間仍然算在配額裡，要清空才會真的釋放（等 30 天或手動清）
    trashBytes: Number(q.usageInDriveTrash || 0),
    accountEmail: d.user?.emailAddress || '',
  };
}

/**
 * 找或建一個資料夾，回傳 folderId。
 *
 * ⚠️ 這裡用 `files.list` 找同名資料夾是安全的，因為 `drive.file` 下只找得到
 *    **我們自己建的**檔案 —— 不會撈到使用者 Drive 裡其他同名的東西。
 */
export async function ensureFolder(name: string, parentId?: string): Promise<string> {
  const safe = name.replace(/'/g, "\\'");
  const clauses = [
    `name='${safe}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    parentId ? `'${parentId}' in parents` : null,
  ].filter(Boolean).join(' and ');

  const found = await driveFetch(
    `/files?q=${encodeURIComponent(clauses)}&fields=files(id,name)&pageSize=2`
  );
  if (found.files?.length) return found.files[0].id;

  const created = await driveFetch('/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties: { source: APP_TAG },
    }),
  });
  return created.id;
}

/** 檔名消毒：Drive 不擋這些字，但 Windows／macOS 下載後會出問題，而且路徑會很難讀。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  if (cleaned.length <= 120) return cleaned || '未命名檔案';
  // 截斷但保留副檔名 —— 砍掉副檔名的話 Drive 與播放器都認不出檔案類型
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 120 - ext.length) + ext;
}

/**
 * 拍攝批次資料夾（例如「2026／0131」），建在**該 IP 自己既有的毛片根底下**。
 *
 * ⚠️ 不要再自己造一棵樹。實際結構每個 IP 都不一樣：
 *      自媒體IP代操/又生農場/剪輯/2026／0131/荔妃的命名故事/
 *      自媒體IP代操/祥濱_縈寶/毛片區/2026／0321/3. 忙了三天三夜…/
 *      自媒體IP代操/杜永霖/剪輯_謝/…
 *    中間那層的名字（剪輯／剪輯_謝／2 剪輯／毛片區）是各家歷史習慣，猜不出來，
 *    所以 rootFolderId 一律由人用 Picker 指一次存進 vendors，這裡只接 id。
 *
 * 批次名預設用拍攝日，但呼叫端可以覆寫成該 IP 既有的寫法。
 */
export async function ensureBatchFolder(opts: {
  /** vendors/{id}.rawFootageFolderId —— 那個 IP 的毛片根 */
  rawRootFolderId: string;
  batchName: string;
}): Promise<string> {
  return ensureFolder(opts.batchName, opts.rawRootFolderId);
}

/**
 * 永久刪除一個檔案。**不是丟垃圾桶** —— 垃圾桶的空間仍然算在配額裡，
 * 要等 30 天或手動清空才會真的釋放。測試檔與作廢的上傳都該用這支。
 */
export async function deleteFilePermanently(fileId: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    const b: any = await res.json().catch(() => ({}));
    throw new Error(`刪除 ${fileId} 失敗（${res.status}）：${b?.error?.message || ''}`);
  }
}

export interface DriveFileInfo {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  webViewLink?: string;
  md5Checksum?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

/** 上傳完成後用它驗證檔案真的落地了 —— **不要相信前端回報的 fileId 與大小**。 */
export async function getFile(fileId: string): Promise<DriveFileInfo> {
  const f = await driveFetch(
    `/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,webViewLink,md5Checksum,parents,appProperties`
  );
  return {
    id: f.id, name: f.name, sizeBytes: Number(f.size || 0), mimeType: f.mimeType,
    webViewLink: f.webViewLink, md5Checksum: f.md5Checksum,
    parents: f.parents, appProperties: f.appProperties,
  };
}

/**
 * 把檔案搬進指定資料夾（已經在那裡就什麼都不做）。
 *
 * ⚠️ 這是 metadata 操作，**不會重傳位元組** —— 幾 GB 的毛片也是瞬間完成。
 *    分組就是靠這支：整批先傳進批次夾，再依分組搬進各自的素材夾。
 * ⚠️ Google 2020 起不支援一個檔案掛多個父資料夾，所以 addParents 一定要搭配 removeParents。
 *
 * `expectedParent` 是防線：**不要相信前端給的 fileId**。帶了它就會確認這個檔案
 * 真的來自這次上傳的批次夾，否則任何登入者都能把我們看得到的別的檔案搬進來。
 */
export async function ensureFileParent(fileId: string, folderId: string, expectedParent?: string): Promise<DriveFileInfo> {
  const current = await getFile(fileId);
  if (expectedParent && !current.parents?.includes(expectedParent) && !current.parents?.includes(folderId)) {
    throw new Error('這個檔案不在這次上傳的資料夾裡');
  }
  if (current.parents?.length === 1 && current.parents[0] === folderId) return current;

  const query = new URLSearchParams({
    addParents: folderId,
    fields: 'id,name,size,mimeType,webViewLink,md5Checksum,parents,appProperties',
  });
  if (current.parents?.length) query.set('removeParents', current.parents.join(','));
  const f = await driveFetch(`/files/${encodeURIComponent(fileId)}?${query.toString()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return {
    id: f.id, name: f.name, sizeBytes: Number(f.size || 0), mimeType: f.mimeType,
    webViewLink: f.webViewLink, md5Checksum: f.md5Checksum,
    parents: f.parents, appProperties: f.appProperties,
  };
}
