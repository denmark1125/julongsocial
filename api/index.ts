// Node ESM要求relative import明確帶副檔名，本機tsx跑server.ts不受影響，
// 但Vercel編出來的runtime沒bundle這支，用原本無副檔名的寫法在prod會直接ERR_MODULE_NOT_FOUND
import app from "../server.js";
export default app;
