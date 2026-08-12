import express from "express";
import path from "path";
import cookieParser from "cookie-parser";
import session from "express-session";
import dotenv from "dotenv";
import fetch from "node-fetch";
// 用subpath模組化API而不是 `import * as admin from "firebase-admin"`——
// 後者在tsx/Node的ESM載入器下，CJS命名空間互通有問題，admin.apps會是undefined整個爆掉；
// firebase-admin/app 等子路徑是原生ESM，不會有這個互通問題
import { getApps, initializeApp as initializeAdminApp, cert } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import * as crypto from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { getAvailableVideoAssets, getOwedVideoCount, getVideoStockAlert, hasVideoTrackingScope, getDeficitBreakdown } from "./src/lib/vendorStatus.js";
// 交棒狀態的判定要跟前端同一份，不然推播說的「目前狀態」會跟畫面上不一致
import { deriveFlowStage, FLOW_STAGE_LABEL } from "./src/types.js";

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

// Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Debug Endpoint (Admin Only - but for now let's keep it simple)
app.get("/api/debug", (req, res) => {
  res.json({
    nodeEnv: process.env.NODE_ENV,
    port: PORT,
    firebaseProjectId: firebaseConfig.projectId,
    firebaseDatabaseId: firebaseConfig.firestoreDatabaseId,
    appsInitialized: getApps().length
  });
});

app.use(
  session({
    secret: "social-media-manager-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { 
      secure: true, 
      sameSite: 'none',
      httpOnly: true 
    },
  })
);

// Password Reset Endpoint (Admin Only)
app.post("/api/admin/reset-password", async (req, res) => {
  const { idToken, targetUid, newPassword } = req.body;

  if (!idToken || !targetUid || !newPassword) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!adminAuth || !adminDb) {
    return res.status(500).json({ error: "Firebase Admin not initialized" });
  }

  try {
    // Verify the admin's ID token
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    const adminUid = decodedToken.uid;

    // Check if the user is an admin in Firestore
    const adminDoc = await adminDb.collection("users").doc(adminUid).get();
    const adminData = adminDoc.data();

    if (!adminData || (adminData.role !== "engineer" && adminData.role !== "manager")) {
      // Check for hardcoded admin emails as fallback
      const adminEmail = decodedToken.email;
      if (adminEmail !== "denmark1125@gmail.com" && adminEmail !== "david@forest.system") {
        return res.status(403).json({ error: "Unauthorized: Admin access required" });
      }
    }

    // Update the target user's password
    // Note: newPassword already includes the suffix from the client
    await adminAuth.updateUser(targetUid, {
      password: newPassword,
    });

    res.json({ success: true, message: "Password updated successfully" });
  } catch (error: any) {
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
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json({ success: response.ok });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Failed to trigger webhook" });
  }
});

// ===============================================================
// LINE Messaging API Webhook（取代原本掛掉的Make.com中繼：LINE加好友事件直接打這支）
// ===============================================================
function verifyLineSignature(rawBody: Buffer, signature: string | undefined, channelSecret: string): boolean {
  if (!signature) return false;
  const hash = crypto.createHmac("SHA256", channelSecret).update(rawBody).digest("base64");
  return hash === signature;
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
      const owed = getOwedVideoCount(vendor, posts, vendorAssets.length);
      const alert = getVideoStockAlert(vendor, vendorAssets, owed);
      const hasUpcomingBooking = bookings.some((b: any) =>
        b.vendorId === vendor.id && b.status === "booked" &&
        b.scheduledDate >= today && b.scheduledDate <= sevenDaysFromNow
      );
      const monthEntry = getDeficitBreakdown(vendor, posts, month).monthlyShortfalls.find((e: any) => e.month === month);
      const monthProgress = { target: monthEntry?.target ?? 0, delivered: monthEntry?.delivered ?? 0 };
      return { vendor, alert, hasUpcomingBooking, monthProgress };
    })
    .filter(({ alert, hasUpcomingBooking }: any) => alert.severity === "shoot" && !hasUpcomingBooking);

  if (urgentVendors.length === 0) return null;

  const bubbles = urgentVendors.map(({ vendor, alert, monthProgress }: any) =>
    buildStockAlertBubble(vendor, alert, lastCompletedShootDate(vendor.id), monthProgress)
  );

  return {
    type: "flex",
    altText: `【聚浪拍攝提醒】${urgentVendors.length}個IP庫存告急，需盡快安排拍攝`,
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
    await adminAuth.verifyIdToken(idToken);

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
