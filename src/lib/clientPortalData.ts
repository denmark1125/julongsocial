/**
 * 客戶端 /c/<代碼>/data 的資料組裝（2026-11-16 從 server.ts 抽出）。
 * 抽出來是為了讓「拿正式資料唯讀跑一次」的驗證腳本跑的是**同一份程式**，不是手抄一份。
 *
 * 資料庫、影片簽名網址、內部剪輯判定都由呼叫端傳入：這支不 import firebase-admin，也不碰 R2 金鑰。
 * ⚠️ import 一律帶 .js（server.ts 在 Vercel 原生 ESM 下載入）。
 *
 * 讀取量（11-17 正式資料）：這個 IP 的全部貼文（最多約 76）＋全部素材（最多約 90）＋拍攝預約，
 * 一次打開約 170 筆。行事曆和庫存共用同一份，不重複讀。
 */
import { deriveFlowStage } from '../types.js';
import { getAvailableVideoAssets } from './vendorStatus.js';
import {
  buildClientNotices, pickLastShoot, pickNextShoot, tiktokProfileUrl, toClientPost, toClientShoot, toClientStock,
  type ClientFlow, type ClientPortalData, type ClientShoot, type ClientVideo,
} from './clientPortal.js';

export interface ClientPortalDeps {
  db: any;
  /** R2 物件 → 短期播放網址 */
  presign: (r2Key: string) => Promise<string>;
  /** 這支片是不是內部剪輯（業主通過後不用上傳雲端） */
  isInternal: (asset: any) => Promise<boolean>;
  /** 台灣今天 YYYY-MM-DD（測試可固定） */
  today?: string;
  /** 現在時間（測試可固定；通知只列近 30 天） */
  now?: Date;
}

/**
 * 這篇算不算在業主看的這個月：**照上片日**（業主看月曆是看日期）；還沒排上片日的才照歸檔月份。
 * 11-16 正式資料有 9 篇歸檔月跟上片日不同月（例：好正點 11/1、11/3 上片的歸在 10 月），照歸檔月抓的話 11 月行事曆會漏掉。
 */
export function inClientMonth(p: { scheduledAt?: string; targetMonth?: string }, month: string): boolean {
  const d = String(p.scheduledAt || '');
  return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) === month : p.targetMonth === month;
}

export async function loadClientPortalData(vendorId: string, month: string, deps: ClientPortalDeps): Promise<ClientPortalData> {
  const { db } = deps;
  const [vendorSnap, postSnap, assetSnap, shootSnap] = await Promise.all([
    db.collection('vendors').doc(vendorId).get(),
    // 全部貼文：庫存的算法（getAvailableVideoAssets）要靠它判斷片掛的貼文還在不在、是不是草稿
    db.collection('posts').where('vendorId', '==', vendorId).get(),
    db.collection('assets').where('vendorId', '==', vendorId).get(),
    db.collection('shootBookings').where('vendorId', '==', vendorId).get(),
  ]);
  const allPosts: any[] = postSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const allAssets: any[] = assetSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  const posts = allPosts.filter(p => inClientMonth(p, month));

  // 每篇貼文掛的片：直接掛在貼文上（assetId），或「排上片日」指到這篇（asset.plannedPostId）——同 publishAuditRows.assetOfPost
  const assetById = new Map<string, any>(allAssets.map(a => [a.id, a]));
  const planned = new Map<string, any>();
  for (const a of allAssets) if (a.plannedPostId && !a.voidedAt) planned.set(a.plannedPostId, a);

  const out = [];
  for (const p of posts) {
    const direct = p.assetId && p.assetId !== 'to_be_added' ? assetById.get(String(p.assetId)) : undefined;
    const a = direct || planned.get(p.id);
    const flow: ClientFlow | null = a ? deriveFlowStage(a) : null;
    let video: ClientVideo | null = null;
    if (a && flow === 'client_review') {
      const latest = (a.reviewFiles || [])[(a.reviewFiles?.length || 0) - 1];
      if (latest?.r2Key) video = { assetId: a.id, kind: 'r2', url: await deps.presign(String(latest.r2Key)), version: Number(latest.version) || 1 };
      else if (latest?.fileId) video = { assetId: a.id, kind: 'drive', url: `https://drive.google.com/file/d/${encodeURIComponent(latest.fileId)}/preview`, version: Number(latest.version) || 1 };
    }
    // 內部剪輯只影響「業主已通過、待上傳」那一格落在哪一站，其他狀態不用查
    const internal = a && flow === 'to_upload' ? await deps.isInternal(a) : false;
    out.push(toClientPost(p, { flow, internal, video }));
  }

  // 庫存：哪些片算庫存一律走公司端同一套（拍攝進度頁、庫存警示都是它），這裡不另外發明
  const stockAssets = getAvailableVideoAssets(vendorId, allAssets, allPosts);
  const postsById = new Map(allPosts.map(p => [p.id, p]));
  const stock = toClientStock(stockAssets, postsById, a => deriveFlowStage(a));

  const today = deps.today || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const allShoots = shootSnap.docs.map((d: any) => toClientShoot(d.data())).filter(Boolean) as ClientShoot[];
  return {
    vendorName: String(vendorSnap.data()?.name || ''),
    month,
    posts: out,
    shoots: allShoots.filter(s => s.date.slice(0, 7) === month),
    nextShoot: pickNextShoot(allShoots, today),
    lastShoot: pickLastShoot(allShoots, today, allAssets.filter(a => !a.voidedAt).map(a => String(a.filmingDate || '').slice(0, 10))),
    stock,
    tiktokUrl: tiktokProfileUrl(vendorSnap.data()?.tiktokHandle),
    // 通知用同一批資料推，不多讀資料庫
    notices: buildClientNotices(allPosts, allAssets, shootSnap.docs.map((d: any) => d.data()), {
      now: deps.now || new Date(), today, flowOf: a => deriveFlowStage(a),
    }),
  };
}
