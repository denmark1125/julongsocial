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
