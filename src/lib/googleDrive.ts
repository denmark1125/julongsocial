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
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
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
let cachedFullToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const { id, secret, refresh } = readConfig();
  cachedToken = await exchangeRefreshToken(id, secret, refresh);
  return cachedToken.value;
}

/**
 * 整個雲端硬碟範圍（`drive`）的第二把 token，**只在後端用來改舊素材的資料夾名**。
 *
 * 為什麼要第二把：手動貼連結的舊素材資料夾不是這個 app 建的，drive.file 看不到（Google 回 notFound）。
 * ⚠️ **絕對不要回傳給前端，也不要拿去取代 getAccessToken()。** picker-auth 等路由會把
 *    getAccessToken() 的值交給每個非剪輯師的瀏覽器；那把維持 drive.file，
 *    換成這把等於讓所有同事的瀏覽器都能讀寫、刪除公司帳號整個雲端硬碟。
 */
export function isFullDriveConfigured(): boolean {
  return isDriveConfigured() && !!process.env.GOOGLE_DRIVE_FULL_REFRESH_TOKEN;
}

async function getFullAccessToken(): Promise<string> {
  if (cachedFullToken && Date.now() < cachedFullToken.expiresAt) return cachedFullToken.value;
  const { id, secret } = readConfig();
  cachedFullToken = await exchangeRefreshToken(id, secret, process.env.GOOGLE_DRIVE_FULL_REFRESH_TOKEN!);
  return cachedFullToken.value;
}

async function exchangeRefreshToken(id: string, secret: string, refresh: string): Promise<{ value: string; expiresAt: number }> {

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
  return { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
}

async function driveFetch(path: string, init: RequestInit = {}, token?: string): Promise<any> {
  token = token || await getAccessToken();
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

/**
 * 容量查詢的短期快取。
 *
 * 為什麼需要：每按一次「選檔案／建資料夾」都會先查一次容量，而那是一趟完整的 Drive
 * 往返；一次拍攝五支素材就白等五趟。容量是用來擋「快滿了別傳」的，分鐘級的誤差
 * 完全無所謂（2TB 的硬碟不會在 60 秒內少掉 50GB）。
 * ⚠️ 不要把 TTL 拉長到幾十分鐘：真的傳爆的時候要能及時擋下來。
 */
let cachedQuota: { value: DriveQuota; expiresAt: number } | null = null;
const QUOTA_TTL_MS = 60_000;

export async function getQuota(force = false): Promise<DriveQuota> {
  if (!force && cachedQuota && Date.now() < cachedQuota.expiresAt) return cachedQuota.value;
  const d = await driveFetch('/about?fields=user(emailAddress),storageQuota');
  const q = d.storageQuota || {};
  const limit = Number(q.limit || 0);
  const usage = Number(q.usage || 0);
  const quota: DriveQuota = {
    limitBytes: limit,
    usageBytes: usage,
    freeBytes: Math.max(0, limit - usage),
    // ⚠️ 垃圾桶的空間仍然算在配額裡，要清空才會真的釋放（等 30 天或手動清）
    trashBytes: Number(q.usageInDriveTrash || 0),
    accountEmail: d.user?.emailAddress || '',
  };
  cachedQuota = { value: quota, expiresAt: Date.now() + QUOTA_TTL_MS };
  return quota;
}

/**
 * 找或建一個資料夾，回傳 folderId。
 *
 * ⚠️ 這裡用 `files.list` 找同名資料夾是安全的，因為 `drive.file` 下只找得到
 *    **我們自己建的**檔案 —— 不會撈到使用者 Drive 裡其他同名的東西。
 */
export async function ensureFolder(name: string, parentId?: string, opts: { full?: boolean } = {}): Promise<string> {
  // full：父資料夾不是這個 app 建的（例如剪輯師審核區），drive.file 看不到，要用全範圍 token（只在後端）
  const token = opts.full ? await getFullAccessToken() : undefined;
  const safe = name.replace(/'/g, "\\'");
  const clauses = [
    `name='${safe}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    parentId ? `'${parentId}' in parents` : null,
  ].filter(Boolean).join(' and ');

  const found = await driveFetch(
    // orderBy createdTime：萬一同時有兩個請求各建了一個同名資料夾，大家都固定用最早那個
    `/files?q=${encodeURIComponent(clauses)}&fields=files(id,name)&pageSize=2&orderBy=createdTime&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {}, token
  );
  if (found.files?.length) return found.files[0].id;

  const created = await driveFetch('/files?fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties: { source: APP_TAG },
    }),
  }, token);
  return created.id;
}

/**
 * 資料夾名稱消毒。
 *
 * ⚠️ **半形斜線刻意保留**：使用者要求批次資料夾寫成 `2026/0924`。Drive 不是檔案系統，
 *    名稱裡有 `/` 完全合法。代價是「Google 雲端硬碟電腦版」同步到本機時會把它換成別的字
 *    （Windows／macOS 都不允許檔名含 `/`），所以在電腦上看到的資料夾名會跟網頁版不一樣。
 * ⚠️ 其餘 Windows 非法字元照樣換掉，否則下載整夾會失敗。
 * ⚠️ **這個結果不能直接拿來當 Firestore 文件 id** —— id 裡的 `/` 會被當成子集合路徑。
 *    要當 id 的地方自己再換掉一次（見 server.ts 的 driveFolders doc id）。
 */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[\\:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  return (cleaned.slice(0, 120) || '未命名資料夾');
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
 * 開一個「續傳上傳」通道，回傳上傳網址；瀏覽器拿這個網址直接把檔案分段 PUT 進公司雲端。2026-10-20 起。
 *
 * 為什麼不用 Google Picker 的上傳視窗：Picker 上傳時用的是**瀏覽器目前登入的 Google 帳號**，
 * 剪輯師登入的是自己的帳號、沒有公司成片夾的權限 → Google 回「Server rejected」，
 * 上線以來剪輯師一次都沒傳成功過（10/15 測試用的是登入公司帳號的瀏覽器才沒發現）。
 *
 * ⚠️ `origin` 一定要帶（瀏覽器那頁的網址來源）：開通道時有帶，Google 之後對瀏覽器的 PUT 才會回 CORS 標頭，
 *    網頁才讀得到 308 進度與最後的檔案 id。9 月試直傳失敗（「送得出去、讀不回來」）就是少了這個。
 *    2026-10-20 實測：帶 Origin 開通道 → 瀏覽器分兩段 PUT，308＋Range、最後 200＋id 都讀得到，擁有者是公司帳號。
 * ⚠️ 上傳網址本身就是憑證（只能往這個資料夾傳這一個檔），不要記在 log 裡。
 */
export async function createResumableSession(opts: {
  name: string; parentId: string; mimeType: string; size: number; origin: string;
  /** 目的資料夾不是 app 建的（剪輯師審核區）→ 用全範圍 token 開通道。token 本身不會給瀏覽器，給的只有這一個檔的上傳網址 */
  full?: boolean;
}): Promise<string> {
  const token = opts.full ? await getFullAccessToken() : await getAccessToken();
  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,parents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': opts.mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(opts.size),
      Origin: opts.origin,
    },
    body: JSON.stringify({ name: opts.name, parents: [opts.parentId] }),
  });
  const location = res.headers.get('location');
  if (!res.ok || !location) {
    const data: any = await res.json().catch(() => ({}));
    throw new Error(`開上傳通道失敗（${data?.error?.errors?.[0]?.reason || res.status}）`);
  }
  return location;
}

/** 讀一個檔案的基本資料＋影片長度（全範圍 token：審核區的檔案用） */
export async function getFileFull(fileId: string): Promise<DriveFileInfo & { durationSec?: number }> {
  const token = await getFullAccessToken();
  const f = await driveFetch(
    `/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,webViewLink,parents,videoMediaMetadata(durationMillis)&supportsAllDrives=true`,
    {}, token
  );
  const ms = Number(f.videoMediaMetadata?.durationMillis);
  return {
    id: f.id, name: f.name, sizeBytes: Number(f.size || 0), mimeType: f.mimeType,
    webViewLink: f.webViewLink, parents: f.parents, durationSec: ms > 0 ? Math.round(ms / 1000) : undefined,
  };
}

/**
 * 讀檔案的一段位元組（給預覽頁的播放器邊看邊載）。全範圍 token，只在後端用。
 * 回傳 Google 的原始回應（206＋Content-Range），呼叫端負責把它轉給瀏覽器。
 */
export async function fetchFileRange(fileId: string, start: number, end: number, signal?: AbortSignal): Promise<Response> {
  const token = await getFullAccessToken();
  return fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
    signal,
  });
}

/** 把檔案搬到另一個資料夾（metadata 操作，不重傳）。全範圍 token */
export async function moveFileFull(fileId: string, toFolderId: string): Promise<void> {
  const token = await getFullAccessToken();
  const cur = await driveFetch(`/files/${encodeURIComponent(fileId)}?fields=parents&supportsAllDrives=true`, {}, token);
  const q = new URLSearchParams({ addParents: toFolderId, fields: 'id,parents', supportsAllDrives: 'true' });
  if (cur.parents?.length) q.set('removeParents', cur.parents.join(','));
  await driveFetch(`/files/${encodeURIComponent(fileId)}?${q}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }, token);
}

/**
 * 開／關「知道連結的人都能看」。給客戶的預覽頁（/v/代碼）內嵌雲端播放器要靠它，客戶才不用登入。
 * 回傳建立的權限 id（關閉時要用）。
 */
export async function setAnyoneReader(fileId: string): Promise<string> {
  const token = await getFullAccessToken();
  const r = await driveFetch(`/files/${encodeURIComponent(fileId)}/permissions?fields=id&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }),
  }, token);
  return r.id;
}
export async function removePermission(fileId: string, permissionId: string): Promise<void> {
  const token = await getFullAccessToken();
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`關閉公開連結失敗（${res.status}）`);
}

export interface FolderFile {
  id?: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** 影片長度（秒）。Drive 剛收到檔案時還在處理，可能暫時沒有 */
  durationSec?: number;
}

/**
 * 列出資料夾裡的檔案（不含子資料夾內容），給「素材夠不夠剪」用。2026-10-20 起。
 *
 * ⚠️ drive.file 只看得到這個 app 建的檔案：系統上傳的資料夾列得到，**藏鏡人自己放、再認領的資料夾列出來是空的**
 *    （又生兩支實測）。認領的要傳 full: true 用全範圍 token；沒設那把就回 null＝看不到，不要當成「沒有素材」。
 */
export async function listFolderFiles(folderId: string, opts: { full?: boolean } = {}): Promise<FolderFile[] | null> {
  let token: string | undefined;
  if (opts.full) {
    if (!isFullDriveConfigured()) return null;
    token = await getFullAccessToken();
  }
  const files: FolderFile[] = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,size,videoMediaMetadata(durationMillis))',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await driveFetch(`/files?${query.toString()}`, {}, token);
    for (const f of data.files || []) {
      const ms = Number(f.videoMediaMetadata?.durationMillis);
      files.push({ id: f.id, name: f.name, mimeType: f.mimeType, sizeBytes: Number(f.size || 0), durationSec: ms > 0 ? Math.round(ms / 1000) : undefined });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

/**
 * 把成片**真的複製一份**到另一個資料夾（業主通過後送進客戶資料夾用）。
 *
 * ⚠️ 用 copy 不用捷徑：捷徑只是指標，客戶要同時有原檔權限才打得開，而內部成片夾不開給客戶。
 * ⚠️ 副本擁有者是公司帳號，一樣吃公司配額 —— 每支交付的成片在雲端就是兩份。
 * 2026-10-15 已用自然風人工建的「0成片」實測：Picker 挑過的資料夾可以複製進去。
 */
export async function copyFile(fileId: string, parentId: string, name?: string): Promise<DriveFileInfo> {
  const f = await driveFetch(
    `/files/${encodeURIComponent(fileId)}/copy?fields=id,name,size,mimeType,webViewLink,parents`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parents: [parentId], ...(name ? { name } : {}) }),
    }
  );
  return {
    id: f.id, name: f.name, sizeBytes: Number(f.size || 0), mimeType: f.mimeType,
    webViewLink: f.webViewLink, parents: f.parents,
  };
}

/**
 * 改檔案／資料夾名稱。素材改片名時，用來讓雲端那一組毛片資料夾跟著改。
 * 只動 metadata，資料夾裡的檔案完全不受影響。
 *
 * 有設整個雲端硬碟範圍的 token 就用它（舊素材手動建的資料夾才改得到），沒有就退回 drive.file。
 */
export async function renameFile(fileId: string, name: string): Promise<void> {
  const token = isFullDriveConfigured() ? await getFullAccessToken() : undefined;
  await driveFetch(`/files/${encodeURIComponent(fileId)}?fields=id,name&supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }, token);
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
