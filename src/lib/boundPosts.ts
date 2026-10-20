import { Asset, FLOW_STAGE_LABEL, Post, deriveFlowStage } from '../types';

/**
 * 毛片綁小編貼文（asset.plannedPostId）之後，三方各自動了資料要怎麼收斂。2026-10-20 起。
 *
 * 小編管貼文（日期、標題），藏鏡人／同事管「這支毛片給哪一篇」，剪輯師管剪。
 * 誰都不用替別人同步 —— 由一個在同事瀏覽器裡跑的自癒程序（useBoundPostSync）把差異補上：
 *
 * 1. attach：綁定的片業主通過了（to_upload／ready，或已上傳雲端），貼文還在「待補上」→ 掛上。
 * 2. sync：小編改了貼文日期 → 毛片的 plannedAirDate 快照跟著改（剪輯師清單本來就以貼文為準，這只是退路）。
 * 3. unbind：貼文被刪、已經發布、或掛了別支片 → 解除綁定，片退回「還沒排上片日」。
 *
 * ⚠️ 不在「交片／通過」那一刻寫：交片是剪輯師按的（規則不准他寫貼文），通過有好幾條路
 *    （看板、素材庫、剪輯師上傳雲端＝業主通過），追每一條一定會漏一條。自癒只看最終狀態。
 * ⚠️ 每一筆修正都是冪等的：兩個同事同時開著也只會寫同樣的值。
 */
export type BoundPostFix =
  | { kind: 'attach'; assetId: string; postId: string }
  | { kind: 'sync'; assetId: string; date: string }
  | { kind: 'unbind'; assetId: string };

const usable = (id?: string) => !!id && id !== 'to_be_added';

/** 業主已經通過、可以拿去發的片 */
export function isApprovedForAir(asset: Asset): boolean {
  const stage = deriveFlowStage(asset);
  return stage === 'to_upload' || stage === 'ready' || Boolean(asset.cloudUploadedAt);
}

export function findBoundPostFixes(posts: Post[], assets: Asset[]): BoundPostFix[] {
  const postById = new Map(posts.map(p => [p.id!, p]));
  const fixes: BoundPostFix[] = [];
  // 一篇只能綁一支：同一篇被兩支綁到時，先建檔的那支留著
  const seen = new Set<string>();
  const bound = assets
    .filter(a => a.plannedPostId && !a.voidedAt)
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || (a.id || '').localeCompare(b.id || ''));

  for (const a of bound) {
    const post = postById.get(a.plannedPostId!);
    // 已經掛上這支了＝整件事完成，什麼都不用做
    if (post && post.assetId === a.id) { seen.add(post.id!); continue; }
    if (!post || seen.has(post.id!) || usable(post.assetId) || post.status === 'published') {
      fixes.push({ kind: 'unbind', assetId: a.id! });
      continue;
    }
    seen.add(post.id!);

    // 這支片已經掛在別篇貼文上（小編手動掛的）→ 以小編為準，解除這邊的綁定
    if (a.usedInPostId && a.usedInPostId !== post.id) {
      fixes.push({ kind: 'unbind', assetId: a.id! });
      continue;
    }
    if (isApprovedForAir(a) && a.status !== 'archived') {
      fixes.push({ kind: 'attach', assetId: a.id!, postId: post.id! });
      continue;
    }
    // scheduledAt 是本地時間字串（'YYYY-MM-DDTHH:mm'），前 10 碼就是那一天
    const day = (post.scheduledAt || '').slice(0, 10);
    if (day && a.plannedAirDate !== day) fixes.push({ kind: 'sync', assetId: a.id!, date: day });
  }
  return fixes;
}

/**
 * 小編那邊的貼文卡要講「這篇預定用哪支片、剪到哪了」，不然素材欄一直是「待補上」，小編只能去 LINE 問。
 * 還沒綁、或已經掛上素材的貼文回 null（掛上之後就照原本的素材顯示）。
 */
export function boundAssetLabel(post: Pick<Post, 'id' | 'assetId'>, assets: Asset[]): string | null {
  if (usable(post.assetId)) return null;
  const a = assets.find(x => x.plannedPostId === post.id && !x.voidedAt);
  if (!a) return null;
  return `預定：${a.title}（${FLOW_STAGE_LABEL[deriveFlowStage(a)]}）`;
}
