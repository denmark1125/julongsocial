import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cookieParser from "cookie-parser";
import session from "express-session";
import dotenv from "dotenv";
import fetch from "node-fetch";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import firebaseConfig from "./firebase-applet-config.json";

dotenv.config();

// Initialize Firebase Admin
try {
  if (admin.apps.length === 0) {
    console.log("Initializing Firebase Admin for project:", firebaseConfig.projectId);
    admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });
  }
} catch (e) {
  console.error("Firebase Admin Initialization Error:", e);
}

const adminAuth = admin.auth();
const adminDb = getFirestore(admin.app(), firebaseConfig.firestoreDatabaseId);
console.log("Using Firestore database:", firebaseConfig.firestoreDatabaseId);

const app = express();
const PORT = 3000;

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
    appsInitialized: admin.apps.length
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

// Vite middleware for development
async function setupServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

setupServer().catch(err => {
  console.error("Failed to start server:", err);
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Global error handler:", err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

export default app;
