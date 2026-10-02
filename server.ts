import express from "express";
import path from "path";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";
// 用subpath模組化API而不是 `import * as admin from "firebase-admin"`——
// 後者在tsx/Node的ESM載入器下，CJS命名空間互通有問題，admin.apps會是undefined整個爆掉；
// firebase-admin/app 等子路徑是原生ESM，不會有這個互通問題
import { getApps, initializeApp as initializeAdminApp, cert } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { getAvailableVideoAssets, getOwedVideoCount, getVideoStockAlert, hasVideoTrackingScope, getDeficitBreakdown } from "./src/lib/vendorStatus.js";
// 交棒狀態的判定要跟前端同一份，不然推播說的「目前狀態」會跟畫面上不一致
import { deriveFlowStage, FLOW_STAGE_LABEL } from "./src/types.js";
import { isDriveConfigured, getQuota, ensureFolder, ensureBatchFolder, sanitizeFolderName, ensureFileParent, getFile, getAccessToken, deleteFilePermanently, DriveNotConfiguredError } from "./src/lib/googleDrive.js";
import { BROLL_FOLDER_NAME } from "./src/lib/driveNaming.js";

dotenv.config();

// 原本用`import firebaseConfig from "./firebase-applet-config.json"`本機tsx沒事，
// 但Vercel prod是原生Node ESM，JSON import一定要帶import attribute(`with {type:"json"}`)
// 不同Node版本語法(assert/with)又不一致，改用readFileSync最穩定不挑版本
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const firebaseConfig = JSON.parse(readFileSync(path.join(__dirname, "firebase-applet-config.json"), "utf8"));

let adminAuth: any;
let adminDb: any;

// Initialize Firebase Admin
function initializeFirebaseAdmin() {
  try {
    if (getApps().length === 0) {
      console.log("Initializing Firebase Admin for project:", firebaseConfig.projectId);
      // Vercel serverless runtime不是GCP環境，沒有metadata server也沒有gcloud ADC檔，
      // initializeAdminApp若不帶明確憑證，任何真的碰Firestore/Auth的呼叫都會炸
      // "Could not load the default credentials"。改成從service account key環境變數讀憑證。
      const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      if (serviceAccountKey) {
        initializeAdminApp({
          credential: cert(JSON.parse(serviceAccountKey)),
          projectId: firebaseConfig.projectId,
        });
      } else {
        console.warn("FIREBASE_SERVICE_ACCOUNT_KEY not set, falling back to ADC (will fail outside GCP)");
        initializeAdminApp({
          projectId: firebaseConfig.projectId,
        });
      }
    }
    adminAuth = getAdminAuth(getApps()[0]);
    adminDb = getFirestore(getApps()[0], firebaseConfig.firestoreDatabaseId);
    console.log("Using Firestore database:", firebaseConfig.firestoreDatabaseId);
  } catch (e) {
    console.error("Firebase Admin Initialization Error:", e);
  }
}

const app = express();
const PORT = 3000;

// Start listening immediately to satisfy the platform's health check
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is listening on port ${PORT}`);
});

// LINE webhook 簽章驗證需要原始bytes，JSON.stringify(req.body)不保證跟LINE原始送來的一致，
// 所以在解析當下順便留一份原始buffer，只有LINE webhook那支API會用到，其他路由不受影響
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(cookieParser());

type AuthedRole = 'engineer' | 'manager' | 'employee' | 'editor';
interface AuthedUser {
  uid: string;
  email?: string;
  role: AuthedRole;
  displayName?: string;
  linkedEditorId?: string;
  assignedVendorIds?: string[];
}

/**
 * 從請求裡認出是誰。
 *
 * 沿用這個專案既有的慣例：**idToken 放在 request body**（前端所有呼叫點都是這形狀，
 * 混用兩套只會製造 bug）；同時也接受 Authorization header，給沒有 body 的 GET 用。
 *
 * ⚠️ admin SDK 會繞過 firestore.rules，所以角色判斷一定要在這裡自己做，不能靠規則兜底。
 */
async function requireUser(req: any): Promise<AuthedUser> {
  if (!adminAuth || !adminDb) throw Object.assign(new Error("Firebase Admin 尚未初始化"), { httpStatus: 500 });
  const raw = req.body?.idToken || String(req.headers?.authorization || '').replace(/^Bearer /, '');
  if (!raw) throw Object.assign(new Error("缺少身分憑證"), { httpStatus: 401 });

  let decoded: any;
  try {
    decoded = await adminAuth.verifyIdToken(raw);
  } catch {
    throw Object.assign(new Error("身分憑證無效或已過期"), { httpStatus: 401 });
  }
  const snap = await adminDb.collection("users").doc(decoded.uid).get();
  // 沒有 users 文件＝不是系統建立的帳號（例如隨便一個 Google 帳號登入）。
  // 以前這裡會預設成 employee，等於任何 Google 帳號都能拿到 Drive 權杖。
  if (!snap.exists) throw Object.assign(new Error("這個帳號尚未被授權"), { httpStatus: 403 });
  const d = snap.data() || {};
  return {
    uid: decoded.uid,
    email: decoded.email,
    role: (d.role as AuthedRole) || 'employee',
    displayName: d.displayName || d.username,
    linkedEditorId: d.linkedEditorId || '',
    assignedVendorIds: d.assignedVendorIds || [],
  };
}

function sendAuthError(res: any, e: any) {
  const status = e?.httpStatus || 500;
  return res.status(status).json({ error: e?.message || "驗證失敗" });
}

/** Drive 沒設定時回 503，而不是讓路由整個炸掉 */
function requireDriveConfigured(res: any): boolean {
  if (isDriveConfigured()) return true;
  res.status(503).json({ error: "Drive 尚未設定（伺服器缺少 GOOGLE_OAUTH_* 環境變數）" });
  return false;
}

/**
 * 查公司 Drive 還剩多少。manager 以上才看得到。
 * 這支同時是「授權這條鏈通不通」的健康檢查：回得出 accountEmail 就代表 refresh token 還有效。
 */
app.get("/api/drive/quota", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role !== 'engineer' && me.role !== 'manager') {
      return res.status(403).json({ error: "只有管理者可以查看雲端容量" });
    }
    const q = await getQuota();
    const GB = (n: number) => Math.round(n / 1024 ** 3 * 10) / 10;
    return res.json({
      accountEmail: q.accountEmail,
      limitGB: GB(q.limitBytes),
      usageGB: GB(q.usageBytes),
      freeGB: GB(q.freeBytes),
      trashGB: GB(q.trashBytes),
      usagePct: q.limitBytes ? Math.round(q.usageBytes / q.limitBytes * 100) : 0,
    });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/quota failed:", e?.message);
    return res.status(502).json({ error: e?.message || "讀取 Drive 失敗" });
  }
});

/**
 * 一次性：建立 Drive 的根資料夾，把 id 記在 appConfig/drive。
 *
 * ⚠️ 根資料夾**必須由 API 自己建**。scope 是 `drive.file`，看不到「不是我們建的」資料夾，
 *    所以不能在設定裡填一個現成資料夾的 ID —— 填了也讀不到。
 * 重複呼叫是安全的：ensureFolder 找得到同名的就直接沿用。
 */
app.post("/api/admin/drive-bootstrap", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role !== 'engineer') return res.status(403).json({ error: "只有工程師可以初始化 Drive" });

    const rootName = req.body?.rootName || "聚浪社群系統";
    const rootFolderId = await ensureFolder(rootName);
    await adminDb.collection("appConfig").doc("drive").set({
      rootFolderId, rootName,
      createdAt: new Date().toISOString(),
      createdByUid: me.uid,
    }, { merge: true });

    return res.json({ rootFolderId, rootName });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive-bootstrap failed:", e?.message);
    return res.status(502).json({ error: e?.message || "初始化 Drive 失敗" });
  }
});

/** 剩這麼多以下就不給開新的上傳。系統不能有「安靜地把硬碟塞爆」這個選項。 */
const DRIVE_MIN_FREE_BYTES = 50 * 1024 ** 3;

async function getRootFolderId(): Promise<string> {
  const snap = await adminDb.collection("appConfig").doc("drive").get();
  const id = snap.data()?.rootFolderId;
  if (!id) throw Object.assign(new Error("Drive 尚未初始化，請先呼叫 /api/admin/drive-bootstrap"), { httpStatus: 409 });
  return id;
}

/**
 * 只給 Picker 用的短效憑證。
 *
 * 為什麼要單獨一支：「指定資料夾」發生在**還沒有資料夾的時候**，走 upload-context
 * 會被 VENDOR_FOLDER_UNSET 擋掉，變成雞生蛋的死結。
 * ⚠️ 限 engineer/manager —— 這顆 token 看得到我們建立的所有檔案。
 */
app.post("/api/drive/picker-auth", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    // 2026-10-01 從 manager/engineer 放寬到「非剪輯師」：認領流程要用這支開資料夾視窗，
    // 而認領是小編日常工作。這不是權限放寬 —— 真正的守門在寫入端：
    // set-vendor-folder（改 IP 根目錄）仍然自己鎖 manager/engineer，
    // 而這支吐出來的 token 是 drive.file 範圍，只動得了這個 app 建過或被挑過的檔案。
    if (me.role === 'editor') {
      return res.status(403).json({ error: "剪輯師無法使用系統上傳" });
    }
    return res.json({
      accessToken: await getAccessToken(),
      appId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').split('-')[0],
    });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/picker-auth failed:", e?.message);
    return res.status(502).json({ error: e?.message || "取得憑證失敗" });
  }
});

/**
 * 指定某個 IP 的毛片根資料夾。**只能由人在畫面上用 Google Picker 挑一次。**
 *
 * ⚠️ 為什麼一定要人挑：授權範圍是 `drive.file`，看不到「不是這個 app 建立的」資料夾。
 *    你們既有的 自媒體IP代操/{IP}/剪輯 是人工建的，拿名稱去查一定 404。
 *    但只要使用者透過 Picker 把它交給我們，那個資料夾就進入可存取範圍，之後都自動。
 * ⚠️ 中間那層每個 IP 都不一樣（剪輯／剪輯_謝／2 剪輯／毛片區），**不要試圖猜或寫死**。
 */
app.post("/api/drive/set-vendor-folder", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role !== 'engineer' && me.role !== 'manager') {
      return res.status(403).json({ error: "只有工程師或管理者可以設定資料夾" });
    }
    // vendorId 是選填：廠商還在建檔中（文件還不存在）的時候，這支只負責「驗這個資料夾
    // 我們存取得到嗎」，驗過後由前端連同廠商資料一起存。有帶 vendorId 才直接寫回。
    // field 決定寫哪一個欄位：毛片根或共用 B-roll 素材庫。**不要為了第二個欄位複製一支路由。**
    const { vendorId, folderId, field } = req.body || {};
    if (!folderId) return res.status(400).json({ error: "缺少 folderId" });
    const target = field === 'broll' ? 'broll' : 'raw';

    if (vendorId) {
      const vSnap = await adminDb.collection("vendors").doc(vendorId).get();
      if (!vSnap.exists) return res.status(404).json({ error: "找不到這個 IP" });
    }

    // 真的去問 Google 一次。挑錯東西現在就要擋下來，不要等到第一次上傳才炸在使用者臉上。
    let info;
    try {
      info = await getFile(folderId);
    } catch (err: any) {
      if (err?.status === 404) {
        // 最常見的原因：操作的人在瀏覽器裡登入的是自己的 Google 帳號，
        // Picker 顯示的是他個人的雲端硬碟，挑出來的資料夾我們的公司授權當然看不到。
        return res.status(400).json({
          error: "選到的資料夾我們存取不到。請確認這個瀏覽器登入的是公司 Google 帳號，再挑一次。",
        });
      }
      throw err;
    }
    if (info.mimeType !== 'application/vnd.google-apps.folder') {
      return res.status(400).json({ error: "選到的不是資料夾" });
    }

    if (vendorId) {
      await adminDb.collection("vendors").doc(vendorId).set(
        target === 'broll'
          ? { brollFolderId: info.id, brollFolderName: info.name }
          : { rawFootageFolderId: info.id, rawFootageFolderName: info.name },
        { merge: true }
      );
    }

    return res.json({ folderId: info.id, folderName: info.name, field: target, saved: Boolean(vendorId) });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/set-vendor-folder failed:", e?.message);
    return res.status(502).json({ error: e?.message || "設定資料夾失敗" });
  }
});

/**
 * 批次資料夾的預設名稱。
 * ⚠️ 使用者指定用**半形斜線**（`2026/0924`）。既有的 126 個資料夾是全形 ／，
 *    所以新舊會並存，這是使用者知情後的決定。
 * ⚠️ 前端 RawFootageUpload 有一份同樣的實作，兩邊要一致，
 *    不然會建出兩個只差一個字元的資料夾。
 */
function defaultBatchName(shotAt?: string): string {
  const d = shotAt && /^\d{4}-\d{2}-\d{2}$/.test(shotAt) ? shotAt : new Date().toISOString().slice(0, 10);
  const [y, m, day] = d.split('-');
  return `${y}/${m}${day}`;
}

/**
 * 某一組毛片的目標資料夾 ＋ 一顆短效 token（給 Google Picker 用）。
 *
 * 一組＝一支素材＝一個資料夾（例如「超好吃的金磚」底下 1–5 個片段）。
 * 路徑是 {IP 的毛片根}/{拍攝批次}/{素材名稱}，批次那層可以不要。
 *
 * ⚠️ 為什麼是「先命名、再選檔案」而不是「先全部傳、回來分組」：
 *    相機檔名（C0031.MP4、DJI_0104.MOV）不帶任何資訊。整批傳完之後畫面上只剩一排
 *    無意義的名字，沒有人分得出哪幾支屬於哪一支素材，要分還得一支支點開看。
 *    **選檔案的那一刻是唯一知道分組的時刻**，所以資料夾必須在上傳前就建好。
 *
 * ⚠️ **一定要擋掉剪輯師。** 這顆 token 是 drive.file 範圍，拿到它就看得到我們建立的
 *    所有檔案（所有 IP 的毛片成片），對外包來說權限太大。本輪剪輯師完全不碰 Drive。
 */
app.post("/api/drive/group-folder", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "剪輯師無法使用系統上傳" });

    const { vendorId, shotAt, batchName, groupName, sub } = req.body || {};
    if (!vendorId) return res.status(400).json({ error: "缺少 vendorId" });
    const group = sanitizeFolderName(String(groupName || '').trim());
    if (!group) return res.status(400).json({ error: "請先幫這支素材取名字" });

    const vSnap = await adminDb.collection("vendors").doc(vendorId).get();
    if (!vSnap.exists) return res.status(404).json({ error: "找不到這個 IP" });
    const vendor = vSnap.data() || {};
    const vendorName = vendor.name || vendorId;

    const rawRootFolderId = vendor.rawFootageFolderId;
    if (!rawRootFolderId) {
      // 前端靠這個代碼決定要不要跳「先指定資料夾」，所以不要改這個字串
      return res.status(409).json({
        error: "VENDOR_FOLDER_UNSET",
        message: `「${vendorName}」還沒指定毛片要放在雲端哪個資料夾。`,
      });
    }

    // 容量預檢擋在最前面：與其讓人傳到一半被 Google 打回票，不如現在就說清楚。
    // Picker 的錯誤是 Google 自己顯示的，我們攔不到。
    const quota = await getQuota();
    if (quota.freeBytes < DRIVE_MIN_FREE_BYTES) {
      return res.status(507).json({
        error: "DRIVE_QUOTA_LOW",
        message: `公司雲端硬碟只剩 ${Math.round(quota.freeBytes / 1024 ** 3)} GB，已暫停上傳以免塞爆。請先清理或擴充容量。`,
        freeGB: Math.round(quota.freeBytes / 1024 ** 3 * 10) / 10,
      });
    }

    // 批次（日期）資料夾是**選配**。你們的實際結構兩種都有：
    //   又生農場／祥濱  剪輯/2026／0131/素材名稱/     ← 有日期層
    //   彭彭            剪輯/01毛片備份/素材名稱/      ← 沒有日期層
    // 前端傳空字串＝不要這一層，素材資料夾直接建在該 IP 的毛片根底下。
    // ⚠️ 空字串與「沒帶這個欄位」意思不同：沒帶＝用預設日期名。
    const wantsBatch = !(typeof batchName === 'string' && batchName.trim() === '');
    const batch = wantsBatch ? sanitizeFolderName(String(batchName || defaultBatchName(shotAt))) : '';
    const parentId = wantsBatch
      ? await ensureBatchFolder({ rawRootFolderId, batchName: batch })
      : rawRootFolderId;

    const groupFolderId = await ensureFolder(group, parentId);

    // sub='broll'：補充畫面放在這支素材資料夾底下再一層。
    // 祥濱既有的就是這個寫法，名稱由 driveNaming.ts 統一（前後端共用同一個字串）。
    const targetId = sub === 'broll'
      ? await ensureFolder(BROLL_FOLDER_NAME, groupFolderId)
      : groupFolderId;
    // ⚠️ 只拿來顯示（Picker 標題、畫面上的「已建資料夾」）。用 › 不用斜線：
    //    批次名稱本身可能含半形斜線，混在一起會看不出層級。
    const path = [vendor.rawFootageFolderName || '', batch, group, sub === 'broll' ? BROLL_FOLDER_NAME : '']
      .filter(Boolean).join(' › ');

    // 可推導的 doc id ⇒ 之後永遠只要一次 getDoc，不需要查詢也不需要索引。
    // 這張表同時是孤兒對帳的依據：這裡有紀錄、assetUploads 卻沒有，就是傳了沒登記。
    // ⚠️ 文件 id 裡的 `/` 會被 Firestore 當成子集合路徑，而批次名現在可能含半形斜線
    //（例如 2026/0924）。這裡單獨換掉，不要直接用資料夾名稱當 id。
    const idPart = (v: string) => v.replace(/[/.]/g, '_');
    await adminDb.collection("driveFolders")
      .doc(`v3_${vendorId}_${sub === 'broll' ? 'broll' : 'raw'}_${idPart(batch) || 'root'}_${idPart(group)}`).set({
        folderId: targetId, parentFolderId: parentId, path,
        vendorId, kind: sub === 'broll' ? 'broll' : 'raw', batchName: batch, groupName: group,
        createdAt: new Date().toISOString(), createdByUid: me.uid,
      }, { merge: true });

    return res.json({
      // groupFolderId 就是這次要傳進去的那一層：sub='broll' 時是 B-roll 子資料夾
      groupFolderId: targetId, groupName: group, batchName: batch, path, vendorName,
      accessToken: await getAccessToken(),
      // Picker 在 drive.file 範圍下要知道是哪個 Cloud 專案在存取檔案，
      // 那就是 client ID 最前面那串專案編號。從既有環境變數推導，不另開一個。
      appId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').split('-')[0],
      freeGB: Math.round(quota.freeBytes / 1024 ** 3 * 10) / 10,
    });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/group-folder failed:", e?.message);
    return res.status(502).json({ error: e?.message || "準備上傳失敗" });
  }
});

/**
 * 這個 IP 共用的 B-roll 素材庫：上傳目標 ＋ 一顆短效 token。
 *
 * 跟 group-folder 的差別：**它不屬於任何一支素材**，跨場次累積（佐禾那個 46 檔 7.96 GB
 * 就是這種）。所以沒有日期夾、沒有素材名稱，檔案直接進人工指定的那個資料夾。
 *
 * ⚠️ 一樣擋掉剪輯師：token 是 drive.file 範圍，拿到就看得到我們建立的所有檔案。
 */
app.post("/api/drive/library-upload-target", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "剪輯師無法使用系統上傳" });

    const { vendorId } = req.body || {};
    if (!vendorId) return res.status(400).json({ error: "缺少 vendorId" });

    const vSnap = await adminDb.collection("vendors").doc(vendorId).get();
    if (!vSnap.exists) return res.status(404).json({ error: "找不到這個 IP" });
    const vendor = vSnap.data() || {};
    const vendorName = vendor.name || vendorId;

    if (!vendor.brollFolderId) {
      // 前端靠這個代碼決定要不要跳「先指定資料夾」，所以不要改這個字串
      return res.status(409).json({
        error: "VENDOR_BROLL_FOLDER_UNSET",
        message: `「${vendorName}」還沒指定共用 B-roll 資料夾。`,
      });
    }

    const quota = await getQuota();
    if (quota.freeBytes < DRIVE_MIN_FREE_BYTES) {
      return res.status(507).json({
        error: "DRIVE_QUOTA_LOW",
        message: `公司雲端硬碟只剩 ${Math.round(quota.freeBytes / 1024 ** 3)} GB，已暫停上傳以免塞爆。請先清理或擴充容量。`,
        freeGB: Math.round(quota.freeBytes / 1024 ** 3 * 10) / 10,
      });
    }

    return res.json({
      folderId: vendor.brollFolderId,
      path: vendor.brollFolderName || '',
      vendorName,
      accessToken: await getAccessToken(),
      appId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').split('-')[0],
      freeGB: Math.round(quota.freeBytes / 1024 ** 3 * 10) / 10,
    });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/library-upload-target failed:", e?.message);
    return res.status(502).json({ error: e?.message || "準備上傳失敗" });
  }
});

/**
 * 共用 B-roll 上傳收尾：只留紀錄。
 *
 * ⚠️ **不建 Asset、不核銷拍攝預約。** 這些檔案不是交付品，
 *    產成素材會變成幽靈庫存，還會跑進剪輯師待辦與欠片計算。
 */
app.post("/api/drive/record-library-uploads", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "剪輯師無法使用系統上傳" });

    const { vendorId, files } = req.body || {};
    if (!vendorId || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "缺少 vendorId / files" });
    }
    if (files.length > 100) return res.status(400).json({ error: "一次最多 100 個檔案" });

    const vSnap = await adminDb.collection("vendors").doc(vendorId).get();
    if (!vSnap.exists) return res.status(404).json({ error: "找不到這個 IP" });
    const vendor = vSnap.data() || {};
    const folderId = vendor.brollFolderId;
    if (!folderId) return res.status(409).json({ error: "VENDOR_BROLL_FOLDER_UNSET" });
    const vendorName = vendor.name || vendorId;

    const now = new Date().toISOString();
    const recorded: any[] = [];
    const rejected: any[] = [];

    for (const f of files) {
      try {
        // 不相信前端給的 fileId：向 Google 確認它存在、而且真的在這個資料夾裡
        const info = await ensureFileParent(f.driveFileId, folderId, folderId);
        await adminDb.collection("assetUploads").doc().set({
          kind: 'broll', storage: 'drive',
          vendorId, vendorName,
          assetId: null,          // 共用素材庫不屬於任何一支素材
          batchId: null, batchFolderId: null,
          groupName: null, groupFolderId: null,
          driveFileId: info.id, driveFolderId: folderId,
          webViewLink: info.webViewLink || null,
          md5Checksum: info.md5Checksum || null,
          fileName: info.name, sizeBytes: info.sizeBytes, mimeType: info.mimeType,
          note: f.note || null,
          shotAt: null,
          uploadedByUid: me.uid,
          uploadedByName: me.displayName || me.email || null,
          createdAt: now,
        });
        recorded.push({ fileName: info.name, sizeBytes: info.sizeBytes });
      } catch (err: any) {
        rejected.push({ driveFileId: f.driveFileId, reason: err?.message || "查不到這個檔案" });
      }
    }
    return res.json({ recorded, rejected, folderName: vendor.brollFolderName || '' });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/record-library-uploads failed:", e?.message);
    return res.status(502).json({ error: e?.message || "登記失敗" });
  }
});

/**
 * 拍攝預約核銷。跟 AssetDatabase.tsx 的 autoResolveBooking 同一套規則：
 * 有 booked 就結掉它，否則把今天已結的那筆交件數 +1。
 * ⚠️ 核銷失敗不能讓上傳整個失敗 —— 檔案跟素材都已經好了，所以只記 log。
 */
async function autoResolveShootBooking(vendorId: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  try {
    const booked = await adminDb.collection("shootBookings")
      .where("vendorId", "==", vendorId).where("status", "==", "booked").get();
    if (!booked.empty) {
      await booked.docs[0].ref.update({
        status: 'completed', deliveredCount: 1, resolvedAt: new Date().toISOString(),
      });
      return;
    }
    const done = await adminDb.collection("shootBookings")
      .where("vendorId", "==", vendorId).where("status", "==", "completed").get();
    const sameDay = done.docs.find(d => String(d.data()?.resolvedAt || '').startsWith(today));
    if (sameDay) {
      await sameDay.ref.update({ deliveredCount: (sameDay.data()?.deliveredCount || 0) + 1 });
    }
  } catch (e: any) {
    console.error('autoResolveShootBooking failed', e?.message);
  }
}

/**
 * 收尾：把這次上傳的每一組登記成 ERP 的一支素材。
 *
 * 檔案在 Picker 上傳時就已經落在正確的資料夾了（前端先打 group-folder 拿到 id 才開 Picker），
 * 所以**這裡不搬檔**，只做三件事：向 Google 確認檔案真的在、建素材、寫 assetUploads。
 *
 * ERP 與資料夾的連動有三層，缺一不可：
 *   素材 → 資料夾（給人點）  asset.url ＝ 資料夾 webViewLink，既有「素材連結」UI 自動生效
 *   素材 → 資料夾（給程式）  asset.driveFolderId，不依賴會被人編輯的網址字串
 *   資料夾 → 素材            assetUploads 每個片段一筆，帶 assetId / groupFolderId
 *
 * ⚠️ **不相信前端給的任何東西。** 每個 fileId 都用 ensureFileParent 向 Google 確認過
 *    存在、而且確實在這一組的資料夾裡，否則任何登入者都能塞一筆「我上傳了」進來。
 * ⚠️ admin SDK 會繞過 firestore.rules，所以角色判斷一定要在這裡自己做。
 */
app.post("/api/drive/commit-groups", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "剪輯師無法使用系統上傳" });

    const { vendorId, shotAt, groups } = req.body || {};
    if (!vendorId || !Array.isArray(groups) || groups.length === 0) {
      return res.status(400).json({ error: "缺少 vendorId / groups" });
    }
    if (groups.length > 30) return res.status(400).json({ error: "一次最多 30 支素材" });
    const fileCount = groups.reduce((n: number, g: any) => n + (g.files?.length || 0) + (g.brollFiles?.length || 0), 0);
    if (fileCount === 0) return res.status(400).json({ error: "每一支素材至少要有一個片段" });
    if (fileCount > 100) return res.status(400).json({ error: "一次最多 100 個檔案" });

    const vSnap = await adminDb.collection("vendors").doc(vendorId).get();
    if (!vSnap.exists) return res.status(404).json({ error: "找不到這個 IP" });
    const vendorName = vSnap.data()?.name || vendorId;

    const now = new Date().toISOString();
    const created: any[] = [];
    const failed: any[] = [];

    for (const g of groups) {
      const groupName = sanitizeFolderName(String(g.name || '').trim());
      const groupFolderId = String(g.groupFolderId || '');
      if (!groupName || !groupFolderId) {
        failed.push({ name: g.name || '(未命名)', reason: "這一組沒有名字或沒有資料夾" }); continue;
      }
      if (!Array.isArray(g.files) || g.files.length === 0) {
        failed.push({ name: groupName, reason: "這一組沒有檔案" }); continue;
      }
      const rawList = g.files;
      try {
        const checked: any[] = [];
        for (const f of rawList) {
          // 檔案本來就該在這個資料夾裡；ensureFileParent 是冪等的，
          // 在對的位置就只做一次 getFile，等於「向 Google 確認它真的存在且在這裡」。
          const info = await ensureFileParent(f.driveFileId, groupFolderId, groupFolderId);
          checked.push({ info, note: f.note || null, kind: 'raw' as const });
        }

        // B-roll：補充畫面，放在這支素材底下的 B-roll 子資料夾。
        // ⚠️ **刻意不另外建 Asset** —— 它不是交付品，產成素材會變成幽靈庫存，
        //    還會跑進剪輯師待辦清單與欠片計算。只歸檔、只留上傳紀錄。
        const brollList = Array.isArray(g.brollFiles) ? g.brollFiles : [];
        if (brollList.length) {
          const brollFolderId = await ensureFolder(BROLL_FOLDER_NAME, groupFolderId);
          for (const f of brollList) {
            const info = await ensureFileParent(f.driveFileId, brollFolderId, brollFolderId);
            checked.push({ info, note: f.note || null, kind: 'broll' as const });
          }
        }

        // 素材建檔。欄位刻意跟畫面上人工建檔（handleAddAsset）一字不差，
        // 少一個 status/approved 就會在交棒看板上變成幽靈卡。
        const folderInfo = await getFile(groupFolderId);
        const assetRef = adminDb.collection("assets").doc();
        await assetRef.set({
          title: groupName,
          // 給人點的連結：點進去就是那一組的全部片段
          url: folderInfo.webViewLink || '',
          // 給程式用的外鍵：網址被改掉也還在，孤兒對帳與日後送客戶都靠它
          driveFolderId: groupFolderId,
          vendorId,
          vendorName,
          // 空字串＝跟著 IP 的負責剪輯師走（getWorkingEditorId 的退路），
          // 有值＝逐片指名，那位剪輯師即使沒被指派這家 IP 也看得到這一支。
          editorId: String(g.editorId || '').trim(),
          // 內部自己剪：不進任何外包剪輯師的待辦（見 EditorAssetQueue 的 myVideos 過濾）
          internalEdit: Boolean(g.internalEdit),
          category: String(g.category || '').trim() || '未分類',
          // 整支片的剪輯方向，以及每個片段的短標籤。
          // clipNotes 是刻意的反正規化：權威紀錄在 assetUploads，但規則擋住剪輯師讀那張表，
          // 而他們正是要看這些字的人（理由同 vendorName 快照）。
          editingBrief: String(g.brief || '').trim(),
          clipNotes: checked.map((c: any) => ({
            fileName: c.info.name,
            note: c.note || '',
            kind: c.kind,
          })),
          type: 'video',
          stage: 'raw',
          filmingDate: shotAt || now.slice(0, 10),
          status: 'available',
          approved: false,
          createdAt: now,
          createdBy: me.uid,
        });

        for (const c of checked) {
          // ⚠️ driveFolderId 要用檔案**實際所在**的資料夾，B-roll 在子資料夾裡。
          //    寫成 groupFolderId 的話日後對帳會找錯地方。
          const actualFolderId = c.info.parents?.[0] || groupFolderId;
          await adminDb.collection("assetUploads").doc().set({
            kind: c.kind, storage: 'drive',
            vendorId, vendorName,
            assetId: assetRef.id,
            batchId: groupFolderId,
            batchFolderId: folderInfo.parents?.[0] || null,
            groupName, groupFolderId,
            driveFileId: c.info.id, driveFolderId: actualFolderId,
            webViewLink: c.info.webViewLink || null,
            md5Checksum: c.info.md5Checksum || null,
            fileName: c.info.name, sizeBytes: c.info.sizeBytes, mimeType: c.info.mimeType,
            note: c.note,
            shotAt: shotAt || null,
            uploadedByUid: me.uid,
            uploadedByName: me.displayName || me.email || null,
            createdAt: now,
          });
        }

        // 拍攝預約核銷：跟畫面上人工建檔的行為一致，一支素材算一次交件
        await autoResolveShootBooking(vendorId);

        created.push({
          assetId: assetRef.id, name: groupName,
          fileCount: checked.filter((c: any) => c.kind === 'raw').length,
          brollCount: checked.filter((c: any) => c.kind === 'broll').length,
          folderUrl: folderInfo.webViewLink || '',
        });
      } catch (err: any) {
        failed.push({ name: groupName, reason: err?.message || "這一組處理失敗" });
      }
    }

    return res.json({ created, failed });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/commit-groups failed:", e?.message);
    return res.status(502).json({ error: e?.message || "登記失敗" });
  }
});

/**
 * 認領：把同事**已經在雲端建好、也丟好檔案**的資料夾，一次收成 N 支素材。
 *
 * 為什麼是這個方向（2026-10-01，第一週同事棄坑之後）：
 * 他們的習慣是先在 Drive（多半是本機的 Drive 桌面版）建資料夾、把影片拖進去就走人。
 * 系統原本要求反過來——先回來建檔才拿得到資料夾——所以變成多一道手續，同事直接不用了。
 * 認領取代的是「在素材資料庫一支一支人工建檔」，**不是多出來的一步**：
 * 一次拍攝從「回系統 5 次」變成「回系統按 1 次」。
 *
 * ⚠️ 資料夾是人在 Picker 裡挑的，所以**不需要**這個 IP 事先指定過毛片根目錄，
 *    也不需要後端有能力列出別人建的資料夾（那是 drive.file 做不到的事）。
 * ⚠️ **一定要擋重複認領**：同事手滑按兩次就會多一倍素材，而那些幽靈片會進剪輯師
 *    待辦、庫存與欠片計算。靠 assets.driveFolderId 查，已經有人認領過就跳過。
 */
app.post("/api/drive/claim-folders", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "剪輯師無法使用系統上傳" });

    const { vendorId, folders, shotAt, category, editorId, internalEdit } = req.body || {};
    if (!vendorId || !Array.isArray(folders) || folders.length === 0) {
      return res.status(400).json({ error: "缺少 vendorId / folders" });
    }
    if (folders.length > 30) return res.status(400).json({ error: "一次最多 30 支素材" });

    const vSnap = await adminDb.collection("vendors").doc(vendorId).get();
    if (!vSnap.exists) return res.status(404).json({ error: "找不到這個 IP" });
    const vendorName = vSnap.data()?.name || vendorId;

    const now = new Date().toISOString();
    const created: any[] = [];
    const skipped: any[] = [];
    const failed: any[] = [];

    for (const f of folders) {
      const folderId = String(f?.id || '');
      if (!folderId) { failed.push({ name: f?.name || '(未命名)', reason: "沒有資料夾 id" }); continue; }
      try {
        // 向 Google 確認它真的存在、而且真的是資料夾（不相信前端送上來的東西）
        const info = await getFile(folderId);
        if (info.mimeType !== 'application/vnd.google-apps.folder') {
          failed.push({ name: info.name || folderId, reason: "這不是資料夾" }); continue;
        }

        // 重複認領防護
        const dup = await adminDb.collection("assets").where("driveFolderId", "==", folderId).limit(1).get();
        if (!dup.empty) {
          skipped.push({ name: info.name, reason: "這個資料夾已經有對應的素材了" }); continue;
        }

        const assetRef = adminDb.collection("assets").doc();
        await assetRef.set({
          // 資料夾名稱就是素材名稱。同事本來就會好好命名，不另外要他們再打一次。
          title: info.name,
          url: info.webViewLink || '',
          driveFolderId: folderId,
          vendorId,
          vendorName,
          editorId: String(editorId || '').trim(),
          internalEdit: Boolean(internalEdit),
          // 逐支分類；前端沒帶就退回這批的預設值（舊版前端只送批次層的 category）
          category: String(f?.category || category || '').trim() || '未分類',
          // 整支片的剪輯方向。逐支給（跟上傳毛片那條路一致），剪輯師的卡片上直接看得到。
          // ⚠️ 空字串也要寫進去，不要用 undefined —— Firestore 會整個略過該欄位，
          //    之後在畫面上改成空白時會變成「改不掉」。
          editingBrief: String(f?.brief || '').trim(),
          type: 'video',
          stage: 'raw',
          filmingDate: shotAt || now.slice(0, 10),
          status: 'available',
          approved: false,
          createdAt: now,
          createdBy: me.uid,
        });

        // 跟 commit-groups 一樣留一筆資料夾紀錄，日後孤兒對帳才對得上。
        // ⚠️ 文件 id 不能含 `/`（Firestore 會當成子集合路徑），所以直接用 folderId 當 id。
        await adminDb.collection("driveFolders").doc(`claim_${folderId}`).set({
          folderId, parentFolderId: info.parents?.[0] || null,
          path: info.name, vendorId, kind: 'raw',
          batchName: '', groupName: info.name,
          claimed: true,
          createdAt: now, createdByUid: me.uid,
        }, { merge: true });

        created.push({ assetId: assetRef.id, name: info.name, folderUrl: info.webViewLink || '' });
      } catch (err: any) {
        failed.push({ name: f?.name || folderId, reason: err?.message || "這個資料夾處理失敗" });
      }
    }

    // 拍攝預約核銷：跟人工建檔與 commit-groups 一致，整批算一次
    if (created.length) await autoResolveShootBooking(vendorId);

    return res.json({ created, skipped, failed });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/claim-folders failed:", e?.message);
    return res.status(502).json({ error: e?.message || "認領失敗" });
  }
});

/**
 * 「掛上檔案」要用的短效憑證。
 *
 * ⚠️ 刻意不重用 picker-auth：那支是給「指定 IP 毛片根目錄」用的，限 manager/engineer，
 *    而掛檔案是小編日常工作。把 picker-auth 放寬會連帶讓一般同事能改 IP 的根目錄。
 */
app.post("/api/drive/asset-picker-auth", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "剪輯師無法使用系統上傳" });

    const { assetId } = req.body || {};
    if (!assetId) return res.status(400).json({ error: "缺少 assetId" });
    const aSnap = await adminDb.collection("assets").doc(String(assetId)).get();
    if (!aSnap.exists) return res.status(404).json({ error: "找不到這支素材" });
    const folderId = String(aSnap.data()?.driveFolderId || '');
    if (!folderId) {
      return res.status(409).json({
        error: "ASSET_FOLDER_UNSET",
        message: "這支素材沒有雲端資料夾（多半是以前人工建檔的），請改用上傳毛片流程。",
      });
    }
    return res.json({
      folderId,
      accessToken: await getAccessToken(),
      appId: (process.env.GOOGLE_OAUTH_CLIENT_ID || '').split('-')[0],
    });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/asset-picker-auth failed:", e?.message);
    return res.status(502).json({ error: e?.message || "取得憑證失敗" });
  }
});

/**
 * 把「已經在 Drive 上的檔案」掛到一支既有素材底下。
 *
 * 兩個用途合而為一：
 *   ① 補登逐片說明（檔案已經在雲端，這裡只是把它們登記進來並打標籤）
 *   ② 事後補片段 —— 以前完全沒有入口，同事只能把整批重跑一次，
 *      而那會再建一支**重複的素材**（commit-groups 每次都 assets.doc()），
 *      然後那支幽靈片會跑進剪輯師待辦與庫存。
 *
 * ⚠️ **不相信前端給的任何東西**：每個 fileId 都用 ensureFileParent 向 Google 確認
 *    存在、而且確實落在這支素材自己的資料夾裡，否則任何登入者都能把別人的檔案掛過來。
 * ⚠️ B-roll 一樣**不另外建 Asset**：不是交付品，建了會變幽靈庫存並跑進欠片計算。
 */
app.post("/api/drive/attach-files", async (req, res) => {
  if (!requireDriveConfigured(res)) return;
  try {
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "剪輯師無法使用系統上傳" });

    const { assetId, files, brollFiles } = req.body || {};
    if (!assetId) return res.status(400).json({ error: "缺少 assetId" });
    const rawList = Array.isArray(files) ? files : [];
    const brollList = Array.isArray(brollFiles) ? brollFiles : [];
    if (rawList.length + brollList.length === 0) return res.status(400).json({ error: "沒有要掛上的檔案" });
    if (rawList.length + brollList.length > 100) return res.status(400).json({ error: "一次最多 100 個檔案" });

    const assetRef = adminDb.collection("assets").doc(String(assetId));
    const aSnap = await assetRef.get();
    if (!aSnap.exists) return res.status(404).json({ error: "找不到這支素材" });
    const asset: any = aSnap.data();

    const groupFolderId = String(asset.driveFolderId || '');
    if (!groupFolderId) {
      return res.status(409).json({
        error: "ASSET_FOLDER_UNSET",
        message: "這支素材沒有雲端資料夾（多半是以前人工建檔的），請改用上傳毛片流程。",
      });
    }
    // 資料夾是我們建的，讀得到就代表它還在。讀不到就別再往下寫紀錄。
    const folderInfo = await getFile(groupFolderId);

    const now = new Date().toISOString();
    const checked: any[] = [];
    for (const f of rawList) {
      const info = await ensureFileParent(String(f.driveFileId), groupFolderId, groupFolderId);
      checked.push({ info, note: f.note || null, kind: 'raw' as const });
    }
    if (brollList.length) {
      const brollFolderId = await ensureFolder(BROLL_FOLDER_NAME, groupFolderId);
      for (const f of brollList) {
        const info = await ensureFileParent(String(f.driveFileId), brollFolderId, brollFolderId);
        checked.push({ info, note: f.note || null, kind: 'broll' as const });
      }
    }

    for (const c of checked) {
      // ⚠️ driveFolderId 要用檔案**實際所在**的資料夾，B-roll 在子夾裡（同 commit-groups）
      const actualFolderId = c.info.parents?.[0] || groupFolderId;
      await adminDb.collection("assetUploads").doc().set({
        kind: c.kind, storage: 'drive',
        vendorId: asset.vendorId, vendorName: asset.vendorName || null,
        assetId: assetRef.id,
        batchId: groupFolderId,
        batchFolderId: folderInfo.parents?.[0] || null,
        groupName: asset.title || '', groupFolderId,
        driveFileId: c.info.id, driveFolderId: actualFolderId,
        webViewLink: c.info.webViewLink || null,
        md5Checksum: c.info.md5Checksum || null,
        fileName: c.info.name, sizeBytes: c.info.sizeBytes, mimeType: c.info.mimeType,
        note: c.note,
        shotAt: asset.filmingDate || null,
        uploadedByUid: me.uid,
        uploadedByName: me.displayName || me.email || null,
        createdAt: now,
      });
    }

    // clipNotes 是給剪輯師看的反正規化快照（規則擋住他們讀 assetUploads）。
    // 用 fileName 去重：同一個檔案被掛第二次時更新標籤，而不是列兩行。
    const existing: any[] = Array.isArray(asset.clipNotes) ? asset.clipNotes : [];
    const merged = [...existing];
    for (const c of checked) {
      const row = { fileName: c.info.name, note: c.note || '', kind: c.kind };
      const at = merged.findIndex(x => x.fileName === row.fileName);
      if (at >= 0) merged[at] = row; else merged.push(row);
    }

    await assetRef.update({ clipNotes: merged });

    return res.json({
      attached: checked.length,
      fileCount: checked.filter((c: any) => c.kind === 'raw').length,
      brollCount: checked.filter((c: any) => c.kind === 'broll').length,
    });
  } catch (e: any) {
    if (e instanceof DriveNotConfiguredError) return res.status(503).json({ error: e.message });
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("drive/attach-files failed:", e?.message);
    return res.status(502).json({ error: e?.message || "掛上檔案失敗" });
  }
});

// Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Password Reset Endpoint (Admin Only)
app.post("/api/admin/reset-password", async (req, res) => {
  const { targetUid, newPassword } = req.body;

  if (!targetUid || !newPassword) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 2026-09-30：拿掉寫死的 email 白名單（@forest.system 是假網域，驗證不了），一律看 users 文件的 role。
    const me = await requireUser(req);
    if (me.role !== "engineer" && me.role !== "manager") {
      return res.status(403).json({ error: "Unauthorized: Admin access required" });
    }
    // 經理不能重設 engineer 的密碼，否則等於能登入老闆帳號＝升級成老闆
    if (me.role !== "engineer") {
      const targetDoc = await adminDb.collection("users").doc(targetUid).get();
      if (targetDoc.data()?.role === "engineer") {
        return res.status(403).json({ error: "只有工程師可以重設工程師的密碼" });
      }
    }

    // Update the target user's password
    // Note: newPassword already includes the suffix from the client
    await adminAuth.updateUser(targetUid, {
      password: newPassword,
    });

    res.json({ success: true, message: "Password updated successfully" });
  } catch (error: any) {
    if (error?.httpStatus) return sendAuthError(res, error);
    console.error("Password reset error details:", {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.status(500).json({ 
      error: error.message || "Unknown error occurred",
      code: error.code || "INTERNAL_ERROR"
    });
  }
});

// Make Webhook Proxy
app.post("/api/webhook/make", async (req, res) => {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(500).json({ error: "MAKE_WEBHOOK_URL not configured" });
  }

  try {
    // 2026-09-30：原本不用登入就能打，任何人都能透過這支往 Make 灌資料。
    // 身分放 Authorization header（body 要原封不動轉給 Make，不能混進 idToken）。
    const me = await requireUser(req);
    if (me.role === 'editor') return res.status(403).json({ error: "無權限" });

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json({ success: response.ok });
  } catch (error: any) {
    if (error?.httpStatus) return sendAuthError(res, error);
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Failed to trigger webhook" });
  }
});

// ===============================================================
// LINE Messaging API Webhook（取代原本掛掉的Make.com中繼：LINE加好友事件直接打這支）
// ===============================================================
function verifyLineSignature(rawBody: Buffer, signature: string | undefined, channelSecret: string): boolean {
  if (!signature) return false;
  const hash = Buffer.from(crypto.createHmac("SHA256", channelSecret).update(rawBody).digest("base64"));
  const given = Buffer.from(signature);
  // 定時比較，避免用回應時間一個字元一個字元猜出簽章
  return hash.length === given.length && crypto.timingSafeEqual(hash, given);
}

app.post("/api/webhook/line", async (req: any, res) => {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelSecret || !accessToken) {
    console.error("LINE webhook called but LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN not configured");
    return res.status(500).json({ error: "LINE not configured" });
  }

  const signature = req.headers["x-line-signature"] as string | undefined;
  if (!verifyLineSignature(req.rawBody, signature, channelSecret)) {
    console.error("LINE webhook signature verification failed");
    return res.status(401).json({ error: "invalid signature" });
  }

  // 原本先回200再背景處理，但Vercel serverless function一送出回應就可能凍結/砍掉執行環境，
  // 導致後面的fetch/Firestore寫入直接斷線(EPIPE)。改成處理完再回應，events數量少、動作快，不會逾時
  const events = req.body?.events || [];
  for (const event of events) {
    if (event?.type !== "follow" || event?.source?.type !== "user") continue;
    const lineUserId = event.source.userId;
    try {
      const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const profile: any = profileRes.ok ? await profileRes.json() : {};

      if (!adminDb) continue;
      const existingSnap = await adminDb.collection("line_connections").where("lineUserId", "==", lineUserId).limit(1).get();
      const data = {
        lineUserId,
        lineDisplayName: profile.displayName || "",
        linePictureUrl: profile.pictureUrl || "",
        // 保留既有綁定，重新加好友不會清掉已經綁好的系統帳號
        UserId: existingSnap.empty ? "" : (existingSnap.docs[0].data().UserId || ""),
        createdAt: existingSnap.empty ? new Date().toISOString() : existingSnap.docs[0].data().createdAt
      };
      if (existingSnap.empty) {
        await adminDb.collection("line_connections").add(data);
      } else {
        await adminDb.collection("line_connections").doc(existingSnap.docs[0].id).update(data);
      }
      console.log("LINE follow event recorded for", lineUserId);
    } catch (e) {
      console.error("LINE follow event handling failed", e);
    }
  }

  res.status(200).json({ ok: true });
});

// ===============================================================
// LINE 影片庫存告急主動推播（每日彙整一則，只推 severity='shoot' 的IP）
// ===============================================================
async function sendLinePushMessage(to: string, message: any) {
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) throw new Error("LINE_CHANNEL_ACCESS_TOKEN not configured");
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ to, messages: [message] }),
  });
  if (!res.ok) {
    throw new Error(`LINE push failed (${res.status}): ${await res.text()}`);
  }
}

const SEVERITY_COLOR = "#B95755"; // 使用者覺得原本#DC2626太飽和，改用磚紅色調，同樣目前只有shoot一種嚴重度會用到

function buildStockAlertBubble(
  vendor: any,
  alert: any,
  lastShootDate: string | null,
  monthProgress: { target: number; delivered: number }
) {
  const statusText = alert.owed > 0
    ? `已欠 ${alert.owed} 支`
    : `庫存剩 ${Math.max(0, Math.floor(alert.totalRunwayDays))} 天`;

  const row = (label: string, value: string) => ({
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: "#999999", flex: 2 },
      { type: "text", text: value, size: "sm", color: "#333333", flex: 5, wrap: true },
    ],
  });

  const monthPct = monthProgress.target > 0
    ? Math.max(0, Math.min(100, Math.round((monthProgress.delivered / monthProgress.target) * 100)))
    : 0;

  const monthProgressRow = {
    type: "box",
    layout: "vertical",
    margin: "sm",
    spacing: "xs",
    contents: [
      {
        type: "box",
        layout: "horizontal",
        contents: [
          { type: "text", text: "本月進度", size: "sm", color: "#999999", flex: 2 },
          { type: "text", text: `${monthProgress.delivered}/${monthProgress.target} 支`, size: "sm", color: "#333333", flex: 5 },
        ],
      },
      {
        type: "box",
        layout: "vertical",
        backgroundColor: "#EEEEEE",
        cornerRadius: "3px",
        height: "6px",
        contents: [
          { type: "box", layout: "vertical", backgroundColor: SEVERITY_COLOR, cornerRadius: "3px", width: `${monthPct}%`, height: "6px", contents: [] },
        ],
      },
    ],
  };

  return {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: SEVERITY_COLOR,
      paddingAll: "12px",
      contents: [
        { type: "text", text: "🔴 需拍片", color: "#FFFFFF", weight: "bold", size: "sm" },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      contents: [
        { type: "text", text: vendor.name, weight: "bold", size: "xl" },
        { type: "separator", margin: "md" },
        row("狀態", statusText),
        monthProgressRow,
        row("庫存", `成片 ${alert.finishedStock}・素材 ${alert.rawStock}`),
        row("上次拍攝", lastShootDate || "尚無紀錄"),
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          color: SEVERITY_COLOR,
          action: { type: "uri", label: "前往安排拍攝", uri: "https://julongsocial.vercel.app/?tab=shootBookings" },
        },
      ],
    },
  };
}

// 跟 Dashboard.tsx 的「影片素材警示」卡片同一套公式(getAvailableVideoAssets/getOwedVideoCount/getVideoStockAlert)，
// 避免前端跟推播兩邊各算一份、數字對不起來。
// 只推 severity==='shoot'（真的不夠/有積欠，最急迫）；'edit'(催剪輯)不推，那是內部流程不用主動吵。
// 7天內已有預約(status='booked')的IP先不推——已經排進去了，重複推是雜訊。
async function buildStockAlertMessage(): Promise<any | null> {
  const [vendorsSnap, postsSnap, assetsSnap, bookingsSnap] = await Promise.all([
    adminDb.collection("vendors").get(),
    adminDb.collection("posts").get(),
    adminDb.collection("assets").get(),
    adminDb.collection("shootBookings").get(),
  ]);
  const vendors = vendorsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const posts = postsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const assets = assetsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const bookings = bookingsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const today = now.toISOString().slice(0, 10);
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const lastCompletedShootDate = (vendorId: string): string | null => {
    const completed = bookings
      .filter((b: any) => b.vendorId === vendorId && b.status === "completed")
      .sort((a: any, b: any) => b.scheduledDate.localeCompare(a.scheduledDate));
    if (completed.length === 0) return null;
    const [, m, d] = completed[0].scheduledDate.split("-");
    return `${m}/${d}`;
  };

  const urgentVendors = vendors
    .filter((v: any) => hasVideoTrackingScope(v, month))
    .map((vendor: any) => {
      const vendorAssets = getAvailableVideoAssets(vendor.id, assets, posts);
      const owed = getOwedVideoCount(vendor, posts, assets, vendorAssets.length);
      const alert = getVideoStockAlert(vendor, vendorAssets, owed);
      const hasUpcomingBooking = bookings.some((b: any) =>
        b.vendorId === vendor.id && b.status === "booked" &&
        b.scheduledDate >= today && b.scheduledDate <= sevenDaysFromNow
      );
      const monthEntry = getDeficitBreakdown(vendor, posts, assets, month).monthlyShortfalls.find((e: any) => e.month === month);
      const monthProgress = { target: monthEntry?.target ?? 0, delivered: monthEntry?.delivered ?? 0 };
      return { vendor, alert, hasUpcomingBooking, monthProgress };
    })
    .filter(({ alert, hasUpcomingBooking }: any) => alert.severity === "shoot" && !hasUpcomingBooking);

  if (urgentVendors.length === 0) return null;

  // LINE carousel 上限 12 張，超過整則會被回 400，告急家數一多反而一則都送不出去。
  // 欠片多的排前面，欠片一樣則庫存天數少的在前，被截掉的才是相對不那麼急的。
  const shown = [...urgentVendors]
    .sort((a: any, b: any) =>
      (b.alert.owed - a.alert.owed) || (a.alert.totalRunwayDays - b.alert.totalRunwayDays)
    )
    .slice(0, 12);

  const bubbles = shown.map(({ vendor, alert, monthProgress }: any) =>
    buildStockAlertBubble(vendor, alert, lastCompletedShootDate(vendor.id), monthProgress)
  );

  // 數字給真的總數，但有截掉就要講，不然看到 12 張會以為就這些。
  const omitted = urgentVendors.length - shown.length;
  return {
    type: "flex",
    altText: omitted > 0
      ? `【聚浪拍攝提醒】${urgentVendors.length}個IP庫存告急，需盡快安排拍攝（卡片先附最急的 12 家）`
      : `【聚浪拍攝提醒】${urgentVendors.length}個IP庫存告急，需盡快安排拍攝`,
    contents: { type: "carousel", contents: bubbles },
  };
}

// 依角色找出已綁定LINE的推播對象。
//
// 注意：users.lineUserId 存的其實是 line_connections 的文件ID(UserManagement.tsx綁定時寫入的是
// connection.id，不是真正的LINE user ID)，要推播必須再查一次 line_connections 文件本身的
// lineUserId 欄位(U開頭)才是LINE Messaging API push要的真正對象。
async function getRecipientsByRoles(roles: string[]): Promise<string[]> {
  const snaps = await Promise.all(
    roles.map((role) => adminDb.collection("users").where("role", "==", role).get())
  );
  const connectionIds = snaps
    .flatMap((snap: any) => snap.docs)
    .map((d: any) => d.data().lineUserId)
    .filter((id: any): id is string => !!id);

  const recipients = await Promise.all([...new Set(connectionIds)].map(async (connId: any) => {
    const connDoc = await adminDb.collection("line_connections").doc(connId).get();
    return connDoc.exists ? connDoc.data()?.lineUserId : null;
  }));
  return [...new Set(recipients.filter((id: any): id is string => !!id))];
}

async function getStockAlertRecipients(): Promise<string[]> {
  return getRecipientsByRoles(["engineer"]);
}

// ─── 製作交棒通知 ────────────────────────────────────────────────
// 這幾個事件就是過去只能靠 LINE 私訊口耳相傳、一漏就整條線斷掉的交接點。
//
// ⚠️ 現階段每種事件都只推給 engineer（老闆本人）——老闆明確說怕吵到同事，
// 等工作流跑順、大家習慣用系統之後，再把 roles 換成註解裡寫的真正對象即可，呼叫端不用改。
type FlowNotifyKind = "submitted" | "uploaded" | "client_slow" | "due_soon";

// ⚠️ 四種都還寫死 engineer，等於全部塞給老闆一個人 —— 這是「LINE 好吵」的第三個原因。
// 角色路由（藏鏡人／小編）還沒做，之後要拆的話改這裡就好。
// client_slow / due_soon 目前**沒有任何地方會送出**（卡關提醒已於 2026-08-12 拿掉），
// 型別與文案留著是為了將來要加回來時不用重寫。
const FLOW_NOTIFY_ROLES: Record<FlowNotifyKind, string[]> = {
  submitted: ["engineer"],   // 未來：藏鏡人 —— 有新片轉成片了，拿去給業主審
  uploaded: ["engineer"],    // 未來：小編 —— 雲端已上傳，可以排程了
  client_slow: ["engineer"], // 停用中
  due_soon: ["engineer"],    // 停用中
};

const FLOW_NOTIFY_STYLE: Record<FlowNotifyKind, { title: string; color: string }> = {
  submitted: { title: "🎬 有新片要給業主審", color: "#5A5A40" },
  uploaded: { title: "✅ 雲端已上傳，可排程", color: "#2F7D5B" },
  client_slow: { title: "⏳ 業主遲遲未回覆", color: "#B95755" },
  due_soon: { title: "⚠️ 快到發布日還沒片", color: "#B95755" },
};

// 業主審核拖過幾天才算「拖太久」。跟前端 FLOW_STALE_DAYS.client_review 一致。
const CLIENT_REVIEW_SLOW_DAYS = 3;
// 發布日前幾天內還沒走到「可排程」就提醒
const DUE_SOON_DAYS = 3;

function buildFlowBubble(
  kind: FlowNotifyKind,
  info: { vendorName: string; title: string; stageLabel: string; scheduledAt?: string | null; days?: number; note?: string | null; revisionCount?: number }
) {
  const style = FLOW_NOTIFY_STYLE[kind];
  const row = (label: string, value: string) => ({
    type: "box",
    layout: "horizontal",
    margin: "sm",
    contents: [
      { type: "text", text: label, size: "sm", color: "#999999", flex: 2 },
      { type: "text", text: value, size: "sm", color: "#333333", flex: 5, wrap: true },
    ],
  });

  const rows: any[] = [row("IP", info.vendorName), row("目前狀態", info.stageLabel)];
  if (info.scheduledAt) {
    const d = new Date(info.scheduledAt);
    if (!Number.isNaN(d.getTime())) {
      rows.push(row("預定發布", `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`));
    }
  }
  if (typeof info.days === "number") rows.push(row("已停留", `${info.days} 天`));
  if (info.revisionCount) rows.push(row("退回次數", `${info.revisionCount} 次`));
  if (info.note) rows.push(row("業主意見", info.note));

  return {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: style.color,
      paddingAll: "12px",
      contents: [{ type: "text", text: style.title, color: "#FFFFFF", weight: "bold", size: "sm" }],
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      contents: [
        // 片名放最大：老闆特別要求通知要帶片名，不然收到也不知道是哪一支
        { type: "text", text: info.title, weight: "bold", size: "lg", wrap: true },
        { type: "separator", margin: "md" },
        ...rows,
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          color: style.color,
          action: { type: "uri", label: "查看製作進度", uri: "https://julongsocial.vercel.app/?tab=shootBookings" },
        },
      ],
    },
  };
}

// 剪輯師/小編在畫面上推進交棒後，前端呼叫這支發即時通知。
// 內容一律由伺服器重新讀 Firestore 組出來，不採用前端傳來的文字，避免被偽造成任意推播內容。
//
// ⚠️ Vercel serverless 在回應後就會凍結執行，所以推播一定要 await 完才 res.json，
// 不能為了讓前端快一點而 fire-and-forget（那在正式站會靜默不送）。
app.post("/api/notify/flow-event", async (req, res) => {
  const { idToken, assetId, kind } = req.body as { idToken?: string; assetId?: string; kind?: FlowNotifyKind };
  if (!idToken || !assetId || !kind) return res.status(400).json({ error: "Missing idToken/assetId/kind" });
  if (!(kind in FLOW_NOTIFY_ROLES)) return res.status(400).json({ error: "Unknown kind" });
  if (!adminAuth || !adminDb) return res.status(500).json({ error: "Firebase Admin not initialized" });

  try {
    // 只要是本系統的登入者就能觸發（剪輯師也要能觸發「轉成片」通知）；
    // 內容不由呼叫端決定，所以不需要再限角色。
    // ⚠️ 但一定要是系統建立的帳號（有 users 文件），不然任何 Google 帳號都能拿來狂推 LINE。
    await requireUser(req);

    const assetDoc = await adminDb.collection("assets").doc(assetId).get();
    if (!assetDoc.exists) return res.status(404).json({ error: "asset not found" });
    const asset: any = assetDoc.data();

    const vendorDoc = await adminDb.collection("vendors").doc(asset.vendorId).get();
    const vendorName = vendorDoc.exists ? vendorDoc.data()?.name || "未知IP" : "未知IP";

    let scheduledAt: string | null = null;
    if (asset.usedInPostId) {
      const postDoc = await adminDb.collection("posts").doc(asset.usedInPostId).get();
      if (postDoc.exists) scheduledAt = postDoc.data()?.scheduledAt || null;
    }

    const message = {
      type: "flex",
      altText: `【聚浪製作進度】${FLOW_NOTIFY_STYLE[kind].title}：${asset.title}`,
      contents: buildFlowBubble(kind, {
        vendorName,
        title: asset.title || "(未命名素材)",
        stageLabel: FLOW_STAGE_LABEL[deriveFlowStage(asset)] || "未知",
        scheduledAt,
        revisionCount: asset.revisionCount,
      }),
    };

    const recipients = await getRecipientsByRoles(FLOW_NOTIFY_ROLES[kind]);
    if (recipients.length === 0) return res.json({ pushed: false, reason: "no recipients bound" });

    await Promise.all(recipients.map((to) => sendLinePushMessage(to, message)));
    res.json({ pushed: true, recipientCount: recipients.length });
  } catch (e: any) {
    if (e?.httpStatus) return sendAuthError(res, e);
    console.error("flow-event notify failed", e);
    res.status(500).json({ error: e.message || "unknown error" });
  }
});

// 每日掃「卡住的片」：業主拖太久、以及快到發布日卻還沒走到可排程。
// 這是老闆最痛的那一刀——過去要等小編排程時才發現沒片，那時候已經來不及了。
// 每日交片彙總：昨天到今天有哪些片「交片送審」或「上傳雲端」，一天推一則。
//
// 為什麼不再即時推：老闆 2026-08-12 回報「LINE 好吵」，剪輯師每轉一支成片就跳一則。
// 交片這件事本身不急（球在業主那邊，我們也不是收到通知就馬上能做什麼），彙總成一則就夠。
//
// 為什麼卡關提醒(業主遲遲未回覆／快到發布日)整個拿掉：老闆 2026-08-12 決定不要這種提醒。
// 原本的實作還有兩個 bug 讓它特別吵——沒有排除「不列入統計/冷凍中/已終止」的廠商
// （實測 32 張卡有 31 張是秀姨、小馬的練習片跟已終止的二寶P媽），而且每天重推同一批、
// 完全沒有去重（有一支已經連推 89 天）。整條拿掉之後這兩個問題自然消失。
// ⚠️ 如果哪天要把「快到發布日還沒片」加回來，記得先做廠商過濾跟去重，不然會重演。
async function buildFlowDigestMessage(): Promise<any | null> {
  const [assetsSnap, postsSnap, vendorsSnap] = await Promise.all([
    adminDb.collection("assets").get(),
    adminDb.collection("posts").get(),
    adminDb.collection("vendors").get(),
  ]);
  const posts = postsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const postById = new Map(posts.map((p: any) => [p.id, p]));

  // 只推「還在跑的客戶」。不列入統計(秀姨/小馬等內部練習帳號)、冷凍中、已終止的一律不吵。
  // 這是原本卡關提醒最大的雜訊來源，新的彙總不能再犯。
  const today = new Date().toISOString().slice(0, 10);
  const activeVendor = new Map<string, string>();
  for (const d of vendorsSnap.docs) {
    const v: any = d.data();
    if (v.excludeFromStats) continue;
    if (v.status === "ended") continue;
    if (v.status === "paused" && (!v.pausedUntil || v.pausedUntil > today)) continue;
    activeVendor.set(d.id, v.name || "未知IP");
  }

  const now = new Date();
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const inWindow = (iso?: string) => !!iso && new Date(iso).getTime() >= since;

  const bubbles: any[] = [];
  for (const d of assetsSnap.docs) {
    const asset: any = { id: d.id, ...d.data() };
    if (asset.type !== "video" || asset.status === "archived" || asset.voidedAt) continue;
    const vName = activeVendor.get(asset.vendorId);
    if (!vName) continue;

    // 一支片同一天可能又送審又上傳，以較後面那一棒為準，只推一張卡
    const kind: FlowNotifyKind | null = inWindow(asset.cloudUploadedAt)
      ? "uploaded"
      : inWindow(asset.submittedAt)
        ? "submitted"
        : null;
    if (!kind) continue;

    const post: any = asset.usedInPostId ? postById.get(asset.usedInPostId) : null;
    bubbles.push({
      kind,
      bubble: buildFlowBubble(kind, {
        vendorName: vName,
        title: asset.title || "(未命名素材)",
        stageLabel: FLOW_STAGE_LABEL[deriveFlowStage(asset)] || "未知",
        scheduledAt: post?.scheduledAt || null,
        revisionCount: asset.revisionCount,
      }),
    });
  }

  if (bubbles.length === 0) return null;
  // 可排程的排前面（那是小編真的能動手的），LINE carousel 上限 12
  const ordered = [...bubbles.filter(b => b.kind === "uploaded"), ...bubbles.filter(b => b.kind !== "uploaded")].slice(0, 12);
  return {
    type: "flex",
    altText: `【聚浪製作進度】今日交片 ${bubbles.length} 支`,
    contents: { type: "carousel", contents: ordered.map(b => b.bubble) },
  };
}

app.get("/api/cron/flow-digest-push", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!adminDb) return res.status(500).json({ error: "Firebase Admin not initialized" });

  try {
    const message = await buildFlowDigestMessage();
    if (!message) return res.json({ pushed: false, reason: "no handoffs today" });

    const recipients = await getRecipientsByRoles(
      [...new Set([...FLOW_NOTIFY_ROLES.submitted, ...FLOW_NOTIFY_ROLES.uploaded])]
    );
    if (recipients.length === 0) return res.json({ pushed: false, reason: "no recipients bound" });

    await Promise.all(recipients.map((to) => sendLinePushMessage(to, message)));
    res.json({ pushed: true, recipientCount: recipients.length });
  } catch (e: any) {
    console.error("flow-digest-push failed", e);
    res.status(500).json({ error: e.message || "unknown error" });
  }
});

// 後台「測試製作進度推播」用，方便驗證不用等隔天排程
app.post("/api/admin/test-flow-digest-push", async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: "Missing idToken" });
  if (!adminAuth || !adminDb) return res.status(500).json({ error: "Firebase Admin not initialized" });

  try {
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    const requesterDoc = await adminDb.collection("users").doc(decodedToken.uid).get();
    if (requesterDoc.data()?.role !== "engineer") {
      return res.status(403).json({ error: "Unauthorized: engineer only" });
    }

    const message = await buildFlowDigestMessage();
    if (!message) return res.json({ pushed: false, reason: "no handoffs today" });

    const recipients = await getRecipientsByRoles(["engineer"]);
    if (recipients.length === 0) return res.json({ pushed: false, reason: "no recipients bound" });

    await Promise.all(recipients.map((to) => sendLinePushMessage(to, message)));
    res.json({ pushed: true, recipientCount: recipients.length, message });
  } catch (error: any) {
    console.error("test-flow-digest-push failed", error);
    res.status(500).json({ error: error.message || "Unknown error occurred" });
  }
});

// Vercel Cron 排程打這支，用 CRON_SECRET 擋住，避免被外部亂打。
app.get("/api/cron/stock-alert-push", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!adminDb) return res.status(500).json({ error: "Firebase Admin not initialized" });

  try {
    const message = await buildStockAlertMessage();
    if (!message) return res.json({ pushed: false, reason: "no urgent vendors" });

    const recipients = await getStockAlertRecipients();
    if (recipients.length === 0) return res.json({ pushed: false, reason: "no recipients bound" });

    await Promise.all(recipients.map((to) => sendLinePushMessage(to, message)));
    res.json({ pushed: true, recipientCount: recipients.length });
  } catch (e: any) {
    console.error("stock-alert-push failed", e);
    res.status(500).json({ error: e.message || "unknown error" });
  }
});

// 後台「測試推播」按鈕用：只要是engineer本人登入就能手動觸發一次，方便驗證不用等明天9點的排程
app.post("/api/admin/test-stock-alert-push", async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: "Missing idToken" });
  if (!adminAuth || !adminDb) return res.status(500).json({ error: "Firebase Admin not initialized" });

  try {
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    const requesterDoc = await adminDb.collection("users").doc(decodedToken.uid).get();
    const requesterData = requesterDoc.data();
    if (!requesterData || requesterData.role !== "engineer") {
      return res.status(403).json({ error: "Unauthorized: engineer only" });
    }

    const message = await buildStockAlertMessage();
    if (!message) return res.json({ pushed: false, reason: "no urgent vendors" });

    const recipients = await getStockAlertRecipients();
    if (recipients.length === 0) return res.json({ pushed: false, reason: "no recipients bound" });

    await Promise.all(recipients.map((to) => sendLinePushMessage(to, message)));
    res.json({ pushed: true, recipientCount: recipients.length, message });
  } catch (error: any) {
    console.error("test-stock-alert-push failed", error);
    res.status(500).json({ error: error.message || "Unknown error occurred" });
  }
});

// Vite middleware for development
async function setupServer() {
  console.log("Starting setupServer...");
  initializeFirebaseAdmin();

  if (process.env.NODE_ENV !== "production") {
    console.log("Setting up Vite middleware...");
    try {
      // vite/rollup只有本機開發要用，動態import讓production bundle完全不碰它們，
      // 順便閃過rollup平台原生二進位optional dependency在Vercel Linux runtime常見的npm bug
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware attached.");
    } catch (err) {
      console.error("Error setting up Vite middleware:", err);
    }
  } else {
    console.log("Serving static files from dist...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
}

setupServer().catch(err => {
  console.error("Failed to setup server middleware:", err);
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Global error handler:", err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

export default app;
