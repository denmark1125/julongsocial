import { deriveFlowStage } from '../../types.js';
import { taipeiToDate } from '../publishAudit.js';

/**
 * 內部催片（2026-11-05）：排定上片前 48 小時、前 24 小時，片子還沒過業主審 → 通知該 IP 的藏鏡人＋PM。
 *
 * 使用者決定：
 * - 48 小時提醒一次、24 小時再提醒一次（「要盡早跳通知」）；但只在平日 09:30／週末 13:00 發（不打擾下班）
 * - 不只「客戶還沒審」，還沒有片／還在剪／客戶要改也一起催
 * - 同一支片每個時間點只催一次（post.reviewChase.h48 / h24 記已催時間）
 * 判斷審過沒一律走 deriveFlowStage（to_upload／ready＝業主已通過），不要直接讀 asset.approved。
 */

export type ChaseTier = 48 | 24;

/**
 * 什麼時候催（11-05 使用者：晚上是同事休息時間，不要打擾）：
 * 平日 09:30、週末 13:00，一天查一次。國定假日目前當平日（要的話再加假日表）。
 */
export function chaseTimeFor(now: Date): string {
  const tpe = new Date(now.getTime() + 8 * 3600_000);
  const dow = tpe.getUTCDay(); // 0＝週日、6＝週六（台北日期）
  return dow === 0 || dow === 6 ? '13:00' : '09:30';
}

export interface ChasePost {
  id: string;
  vendorId: string;
  scheduledAt: string;
  title?: string;
  status?: string;
  contentType?: string;
  assetId?: string;
  reviewChase?: { h48?: string; h24?: string; forScheduledAt?: string };
}

export interface ChaseItem {
  postId: string;
  vendorId: string;
  scheduledAt: string;
  title: string;
  tier: ChaseTier;
  stage: string; // 白話：還沒有片／還在剪／客戶要改／客戶還沒審
}

/** 片子現在卡在哪；已經過業主審就回 null（不用催） */
export function chaseStage(asset: any | null | undefined): string | null {
  if (!asset) return '還沒有片';
  const s = deriveFlowStage(asset);
  if (s === 'to_upload' || s === 'ready') return null;
  if (s === 'client_review') return '客戶還沒審';
  if (s === 'revising') return '客戶要改，還在改';
  return '還在剪，還沒送客戶審';
}

/** 貼文直接掛的素材 id（待補中＝沒有） */
export function directAssetId(p: ChasePost): string | null {
  return p.assetId && p.assetId !== 'to_be_added' ? p.assetId : null;
}

/**
 * 這一刻該催哪些片。
 * - 只看影片（圖文不走審片流程）、沒發布的、還沒到時間的
 * - 剩 ≤24h → 24 小時那一級（沒催過才催）；剩 24～48h → 48 小時那一級
 * - 排程時間改過（forScheduledAt 對不上）→ 之前催過的不算，重新算
 */
export function pickChases(posts: ChasePost[], assetFor: (post: ChasePost) => any, now: Date): ChaseItem[] {
  const out: ChaseItem[] = [];
  for (const p of posts) {
    if (p.contentType === 'post' || p.status === 'published' || !p.scheduledAt) continue;
    const hoursLeft = (taipeiToDate(p.scheduledAt).getTime() - now.getTime()) / 3600_000;
    if (hoursLeft <= 0 || hoursLeft > 48) continue;
    const tier: ChaseTier = hoursLeft <= 24 ? 24 : 48;
    const sent = p.reviewChase?.forScheduledAt === p.scheduledAt ? p.reviewChase : undefined;
    if (tier === 24 ? sent?.h24 : sent?.h48) continue;
    // 片可能是直接掛在貼文上（post.assetId），也可能是在「排上片日」指到這篇（asset.plannedPostId）——
    // 由呼叫端兩邊都找，找不到才算「還沒有片」（11-05 康青龍就是後者，只看 assetId 會誤判）
    const stage = chaseStage(assetFor(p));
    if (!stage) continue;
    out.push({ postId: p.id, vendorId: p.vendorId, scheduledAt: p.scheduledAt, title: p.title || '', tier, stage });
  }
  return out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** 一個 IP 一則訊息 */
export function chaseMessage(vendorName: string, items: ChaseItem[]): string {
  const urgent = items.some(i => i.tier === 24);
  const head = urgent ? `🚨 催片：${vendorName} 剩不到 24 小時就要上片` : `⏰ 催片：${vendorName} 2 天內要上片`;
  const lines = items.map(i => {
    const d = i.scheduledAt;
    return `・${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${d.slice(11, 16)}「${i.title.slice(0, 20)}」${i.stage}`;
  });
  return [head, ...lines, '請藏鏡人跟客戶確認，PM 幫忙盯'].join('\n');
}
