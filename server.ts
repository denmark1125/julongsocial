import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cookieParser from "cookie-parser";
import session from "express-session";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { getApps, initializeApp as initializeAdminApp } from "firebase-admin/app";
import { getAuth as getAdminAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createClient } from "@supabase/supabase-js";
import firebaseConfig from "./firebase-applet-config.json";

dotenv.config();

let adminAuth: any;
let adminDb: any;

// Initialize Firebase Admin
function initializeFirebaseAdmin() {
  try {
    if (getApps().length === 0) {
      console.log("Initializing Firebase Admin for project:", firebaseConfig.projectId);
      initializeAdminApp({
        projectId: firebaseConfig.projectId,
      });
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

app.use(express.json());
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
// Studio 腳本系統 API（Supabase Julangmeta / schema: studio）
// service key 只活在後端 env；前端一律經過這裡，並先驗 Firebase 登入
// ===============================================================
const studioDb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      db: { schema: "studio" },
      auth: { persistSession: false },
    })
  : null;

async function requireStudioAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!studioDb) {
    return res.status(500).json({ error: "Studio 未設定（缺 SUPABASE_URL / SUPABASE_SERVICE_KEY）" });
  }
  if (!adminAuth) {
    return res.status(500).json({ error: "Firebase Admin not initialized" });
  }
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    (req as any).studioUser = await adminAuth.verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}

// IP 清單（下拉用）
app.get("/api/studio/ips", requireStudioAuth, async (req, res) => {
  const { data, error } = await studioDb!.from("ips").select("*").eq("active", true).order("id");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 腳本列表（?ip_id=&status=）
app.get("/api/studio/scripts", requireStudioAuth, async (req, res) => {
  let q = studioDb!.from("scripts").select("*").order("created_at", { ascending: false }).limit(200);
  if (req.query.ip_id) q = q.eq("ip_id", String(req.query.ip_id));
  if (req.query.status) q = q.eq("status", String(req.query.status));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 手寫腳本貼上（source='human'）
app.post("/api/studio/scripts", requireStudioAuth, async (req, res) => {
  const { ip_id, no, topic, content, hook, props_location, batch } = req.body;
  if (!ip_id || !topic || !content) {
    return res.status(400).json({ error: "缺 ip_id / topic / content" });
  }
  const { data, error } = await studioDb!.from("scripts").insert({
    ip_id, no: no ?? null, topic, content,
    hook: hook || null, props_location: props_location || null,
    batch: batch || null, source: "human",
    created_by: (req as any).studioUser.email || (req as any).studioUser.uid,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 核准 / 駁回（駁回帶 6 標籤 + 選填備註）
app.post("/api/studio/scripts/:id/review", requireStudioAuth, async (req, res) => {
  const { action, tag, note } = req.body; // action: 'approve' | 'reject'
  if (action !== "approve" && action !== "reject") {
    return res.status(400).json({ error: "action 需為 approve / reject" });
  }
  const by = (req as any).studioUser.email || (req as any).studioUser.uid;
  const { error } = await studioDb!.from("scripts")
    .update({ status: action === "approve" ? "approved" : "rejected", updated_at: new Date().toISOString() })
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (action === "reject" && tag) {
    await studioDb!.from("script_feedback").insert({
      script_id: req.params.id, tag, note: note || null, created_by: by,
    });
  }
  res.json({ ok: true });
});

// 就地改稿（自動存 diff＝最誠實的回饋）
app.put("/api/studio/scripts/:id", requireStudioAuth, async (req, res) => {
  const by = (req as any).studioUser.email || (req as any).studioUser.uid;
  const { data: before, error: e0 } = await studioDb!.from("scripts")
    .select("topic,content,hook,props_location,source").eq("id", req.params.id).single();
  if (e0) return res.status(500).json({ error: e0.message });
  const after = {
    topic: req.body.topic ?? before.topic,
    content: req.body.content ?? before.content,
    hook: req.body.hook ?? before.hook,
    props_location: req.body.props_location ?? before.props_location,
  };
  const { error } = await studioDb!.from("scripts").update({
    ...after,
    source: before.source === "ai" ? "ai_edited" : before.source,
    updated_at: new Date().toISOString(),
  }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await studioDb!.from("script_feedback").insert({
    script_id: req.params.id,
    diff: { before: { topic: before.topic, content: before.content, hook: before.hook, props_location: before.props_location }, after },
    created_by: by,
  });
  res.json({ ok: true });
});

// 業主回饋登記（開會後 30 秒填）
app.post("/api/studio/client-feedback", requireStudioAuth, async (req, res) => {
  const { ip_id, said, kind } = req.body;
  if (!ip_id || !said) return res.status(400).json({ error: "缺 ip_id / said" });
  const { error } = await studioDb!.from("client_feedback").insert({
    ip_id, said, kind: kind || null,
    created_by: (req as any).studioUser.email || (req as any).studioUser.uid,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// 爆款靈感牆（雨傘標每日爬蟲推上來）
app.get("/api/studio/inspirations", requireStudioAuth, async (req, res) => {
  let q = studioDb!.from("inspirations").select("*")
    .neq("status", "dismissed")
    .order("found_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (req.query.status) q = q.eq("status", String(req.query.status));
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/studio/inspirations/:id/status", requireStudioAuth, async (req, res) => {
  const { status } = req.body; // starred / used / dismissed / new
  if (!["new", "starred", "used", "dismissed"].includes(status)) {
    return res.status(400).json({ error: "status 不合法" });
  }
  const { error } = await studioDb!.from("inspirations").update({ status }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Vite middleware for development
async function setupServer() {
  console.log("Starting setupServer...");
  initializeFirebaseAdmin();

  if (process.env.NODE_ENV !== "production") {
    console.log("Setting up Vite middleware...");
    try {
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
