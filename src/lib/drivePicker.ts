/**
 * Google Picker：**位元組全部交給 Google 自己的上傳器。**
 *
 * 為什麼不是自己寫上傳器（2026-09-23 用真的 resumable session URL 實測過，別再試一次）：
 * - 帶 `Content-Range` 的 PUT 會觸發 preflight，preflight 被擋 → 請求根本沒送出去。
 * - 不帶任何自訂標頭的「簡單請求」PUT **位元組送得出去、檔案真的會落地**，
 *   但回應不帶 CORS 標頭，所以 JS 拿到的是 `Failed to fetch`：
 *   讀不到 fileId、讀不到 308 的續傳位置。等於沒有進度、沒有續傳、也不知道成功與否。
 * - 後端中轉也不行：Vercel function 的 request body 上限是 4.5 MB，而毛片動輒幾十 GB。
 *
 * 兩條路都斷掉，剩下的就是 Picker —— 而且進度條、續傳、大檔分塊全是它內建的。
 *
 * ⚠️ accessToken 由後端用公司 refresh token 簽出來（1 小時效期），**同事不必登入 Google**。
 *    它是 drive.file 範圍，拿到就看得到我們建立的所有檔案，所以後端擋掉剪輯師，
 *    這裡也不要把它寫進 log 或網址。
 */

const GAPI_SRC = 'https://apis.google.com/js/api.js';

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
  // 這個專案沒有引入 vite/client 的型別（是刻意的——補上去會連帶噴出一堆既有錯誤），
  // 所以只把這支真正用到的那一個變數宣告出來，不動全域設定。
  interface ImportMetaEnv {
    readonly VITE_GOOGLE_PICKER_API_KEY?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export interface PickedFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
}

export interface PickedFolder {
  id: string;
  name: string;
}

/** 載入 api.js 並備好 picker 模組。整個 session 只做一次，重複呼叫共用同一個 promise。 */
let loadPromise: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const done = () => {
      if (!window.gapi) { reject(new Error('Google API 載入了但 gapi 不在')); return; }
      window.gapi.load('picker', {
        callback: () => resolve(),
        onerror: () => reject(new Error('Picker 模組載入失敗')),
      });
    };

    // ⚠️ 刻意動態載入，不進 bundle：這支腳本只有真的要上傳時才需要，
    //    而且 Google 要求從它自己的網域載入（自行打包的版本不受支援）。
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GAPI_SRC}"]`);
    if (existing) {
      if (window.gapi) { done(); return; }
      existing.addEventListener('load', done, { once: true });
      existing.addEventListener('error', () => reject(new Error('Google API 載入失敗')), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = GAPI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = done;
    s.onerror = () => {
      // 失敗就把快取清掉，下次按按鈕可以重試（網路斷掉是很常見的情況）
      loadPromise = null;
      reject(new Error('連不到 Google，請確認網路後再試一次'));
    };
    document.body.appendChild(s);
  });
  return loadPromise;
}

interface PickerAuth {
  /** 後端簽出來的短效 token */
  accessToken: string;
  /** 瀏覽器端金鑰（VITE_GOOGLE_PICKER_API_KEY），靠 GCP 的網站限制保護 */
  apiKey: string;
  /** Cloud 專案編號。drive.file 範圍下 Picker 需要它才認得出是哪個 app 在存取 */
  appId: string;
}

function buildBase(picker: any, auth: PickerAuth, title?: string) {
  let b = new picker.PickerBuilder()
    .setOAuthToken(auth.accessToken)
    .setDeveloperKey(auth.apiKey)
    .setAppId(auth.appId);
  if (title) b = b.setTitle(title);
  return b;
}

/**
 * 上傳視窗。檔案直接落在 `folderId`。
 *
 * 回傳空陣列＝使用者取消（**不是錯誤**，呼叫端不要跳錯誤訊息）。
 */
export async function openUploadPicker(opts: PickerAuth & {
  folderId: string;
  multiple: boolean;
  title?: string;
}): Promise<PickedFile[]> {
  await loadPicker();
  const picker = window.google?.picker;
  if (!picker) throw new Error('Picker 尚未就緒，請重新整理後再試');

  return new Promise<PickedFile[]>((resolve, reject) => {
    try {
      const view = new picker.DocsUploadView().setParent(opts.folderId);
      // 不讓人在 Picker 裡自己開新資料夾 —— 分類是系統的職責，開了就散掉了
      if (typeof view.setIncludeFolders === 'function') view.setIncludeFolders(false);

      let b = buildBase(picker, opts, opts.title).addView(view).setCallback((data: any) => {
        if (data.action === picker.Action.PICKED) {
          resolve((data.docs || []).map((d: any) => ({
            id: d.id,
            name: d.name,
            // Picker 回的是字串，而且偶爾會缺；真正的大小以後端 files.get 為準
            sizeBytes: Number(d.sizeBytes || 0),
            mimeType: d.mimeType || '',
          })));
        } else if (data.action === picker.Action.CANCEL) {
          resolve([]);
        }
      });
      if (opts.multiple) b = b.enableFeature(picker.Feature.MULTISELECT_ENABLED);

      b.build().setVisible(true);
    } catch (e: any) {
      reject(new Error(e?.message || '開啟上傳視窗失敗'));
    }
  });
}

/**
 * 挑一個**既有的**資料夾（每個 IP 只需要做一次）。
 *
 * ⚠️ 這是整套設計裡唯一能突破 `drive.file` 的地方：我們的授權看不到「不是這個 app
 *    建立的」資料夾，拿名稱或 id 去查一定 404。但使用者透過 Picker 把資料夾交給我們，
 *    它就進入可存取範圍。所以 `自媒體IP代操/{IP}/剪輯` 這種人工建的資料夾，
 *    只能用這支指進來，**不能在設定畫面貼一個資料夾網址了事**。
 *
 * ⚠️ 操作的人必須在這個瀏覽器裡登入**公司 Google 帳號**，否則 Picker 看到的是他自己的
 *    雲端硬碟，挑出來的資料夾我們的後端存取不到（set-vendor-folder 會擋下來）。
 */
export async function openFolderPicker(opts: PickerAuth & { title?: string }): Promise<PickedFolder | null> {
  await loadPicker();
  const picker = window.google?.picker;
  if (!picker) throw new Error('Picker 尚未就緒，請重新整理後再試');

  return new Promise<PickedFolder | null>((resolve, reject) => {
    try {
      const view = new picker.DocsView(picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder');

      buildBase(picker, opts, opts.title || '選擇這個 IP 的毛片資料夾')
        .addView(view)
        .setCallback((data: any) => {
          if (data.action === picker.Action.PICKED) {
            const d = (data.docs || [])[0];
            resolve(d ? { id: d.id, name: d.name } : null);
          } else if (data.action === picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build()
        .setVisible(true);
    } catch (e: any) {
      reject(new Error(e?.message || '開啟資料夾選擇視窗失敗'));
    }
  });
}

/** 金鑰沒設就不要顯示上傳入口，免得人按了才看到錯誤。 */
export function isPickerConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GOOGLE_PICKER_API_KEY);
}

export function getPickerApiKey(): string {
  return import.meta.env.VITE_GOOGLE_PICKER_API_KEY || '';
}
