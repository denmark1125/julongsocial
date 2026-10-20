import { Asset, Post, RawCheck, Vendor, deriveFlowStage } from '../types';
import { getAssetEditorOwner } from './editorBilling';
export { summarizeFolder } from './rawFolder';

/**
 * 漏片防護。2026-10-20 起。
 *
 * 剪輯師發現不能剪就直接跳過，內部分不出是「素材沒有」還是「剪輯師漏掉」。三道：
 * 1. 素材自動檢查（rawCheck）：建檔時後端讀資料夾，幾支影片、總長多少。
 * 2. 剪輯師回報（asset.editorReport）：卡片上「素材有問題？」。
 * 3. 疑似跳過（findSkippedAssets）：只給內部看，不通知剪輯師。
 */

/** 總長低於這個秒數算「素材太少」 */
export const RAW_MIN_TOTAL_SEC = 30;

/** 素材有問題就回一句陳述（給剪輯師與內部看），沒問題回 null。看不到資料夾不算問題 */
export function rawCheckIssue(check: RawCheck | undefined): string | null {
  if (!check || check.unreadable) return null;
  if (check.videoCount === 0) return check.fileCount > 0 ? '資料夾裡沒有影片檔' : '資料夾是空的';
  if (check.totalSec != null && check.totalSec < RAW_MIN_TOTAL_SEC) return `素材只有 ${check.totalSec} 秒`;
  return null;
}

/** 「素材 3 支影片・共 4 分 12 秒」。看不到或沒檢查過回 null */
export function rawCheckSummary(check: RawCheck | undefined): string | null {
  if (!check || check.unreadable || check.videoCount === 0) return null;
  const base = `素材 ${check.videoCount} 支影片`;
  if (check.totalSec == null) return base;
  const m = Math.floor(check.totalSec / 60), sec = check.totalSec % 60;
  return `${base}・共 ${m ? `${m} 分 ` : ''}${sec} 秒`;
}

/**
 * 疑似跳過：這支待剪片的交片期限已過，而同一位剪輯師在那之後交了一支**比它晚上片**的片
 * —— 人在剪，而且挑了後面的先剪，就是沒剪這支。
 *
 * ⚠️ 要比「上片日」不能只看「之後有交片」：2026-10-20 改成上片日前 9 天交片後，很多片的期限一夕之間變成
 *    已過去（規則剛改，剪輯師根本沒機會照新期限剪）；只看「之後有交片」會把謝謝那天交了一支更早上片的片
 *    （小株番茄 10/20）解讀成跳過 5 支。
 * ⚠️ 只給內部看。剪輯師那邊不顯示，免得變成催促。
 * ⚠️ 剪輯師已經回報過問題（且還沒處理完）的不算：那是有交代的，不是漏掉。
 * ⚠️ 上片日／交片期限由呼叫端給（buildEditorQueue 算出來的那一份），不在這裡另算一套。
 *
 * @param airDates 待剪片 assetId → 上片日
 * @param deadlines 待剪片 assetId → 交片期限
 */
export function findSkippedAssets(
  pending: Asset[],
  airDates: Map<string, Date>,
  deadlines: Map<string, Date>,
  allAssets: Asset[],
  vendors: Vendor[],
  posts: Pick<Post, 'id' | 'scheduledAt'>[],
  today: Date = new Date(),
): Set<string> {
  const ownerOf = (a: Asset) => {
    const o = getAssetEditorOwner(a, vendors);
    return o.kind === 'editor' ? o.editorId : null;
  };
  const postDate = new Map(posts.map(p => [p.id!, p.scheduledAt]));
  /** 交出去的片預計哪天上：掛上的貼文 → 綁的貼文 → 同事排的日子。都沒有就不知道，不拿來比 */
  const airOf = (a: Asset): number | null => {
    const raw = (a.usedInPostId && postDate.get(a.usedInPostId)) || (a.plannedPostId && postDate.get(a.plannedPostId)) || a.plannedAirDate;
    if (!raw) return null;
    const t = Date.parse(raw.length === 10 ? `${raw}T00:00:00` : raw);
    return Number.isNaN(t) ? null : t;
  };
  // 每位剪輯師交出去的片：交片時間＋上片日
  const submitted = new Map<string, { at: number; air: number }[]>();
  for (const a of allAssets) {
    const owner = ownerOf(a);
    // 撤回到待剪的片身上還留著舊的 submittedAt，不算「交了」
    if (!owner || !a.submittedAt || a.voidedAt) continue;
    const stage = deriveFlowStage(a);
    if (stage === 'to_edit' || stage === 'revising') continue;
    const air = airOf(a);
    if (air == null) continue;
    submitted.set(owner, [...(submitted.get(owner) || []), { at: Date.parse(a.submittedAt), air }]);
  }
  const skipped = new Set<string>();
  for (const a of pending) {
    const deadline = deadlines.get(a.id!), air = airDates.get(a.id!);
    if (!deadline || !air || deadline >= today) continue;
    if (a.editorReport && !a.editorReport.resolvedAt) continue;
    const owner = ownerOf(a);
    if (!owner) continue;
    const endOfDeadline = new Date(deadline);
    endOfDeadline.setHours(23, 59, 59, 999);
    const jumped = (submitted.get(owner) || []).some(s => s.at > endOfDeadline.getTime() && s.air > air.getTime());
    if (jumped) skipped.add(a.id!);
  }
  return skipped;
}
