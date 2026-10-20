import type { RawCheck } from '../types';

/*
 * 素材資料夾 → 檢查結果。server.ts 也會 import 這支，所以**只能有 type import**：
 * Vercel 上是原生 ESM，執行期 import 沒寫 .js 副檔名會整支掛掉（見 feedback_vercel_esm_prod_bugs）。
 * 判斷與顯示在 rawCheck.ts。
 */

/** 資料夾裡的檔案 → 素材檢查結果。files 為 null＝系統看不到這個資料夾 */
export function summarizeFolder(
  files: { mimeType: string; durationSec?: number }[] | null,
  now: Date = new Date(),
): RawCheck {
  const checkedAt = now.toISOString();
  if (!files) return { videoCount: 0, fileCount: 0, checkedAt, unreadable: true };
  // 子資料夾（B-roll）不算檔案
  const real = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
  const videos = real.filter(f => f.mimeType.startsWith('video/'));
  // 有任何一支還沒算出長度（Drive 剛收到還在處理）就不給總長，避免誤判太短
  const allKnown = videos.length > 0 && videos.every(v => v.durationSec != null);
  return {
    videoCount: videos.length,
    fileCount: real.length,
    ...(allKnown ? { totalSec: videos.reduce((sum, v) => sum + (v.durationSec || 0), 0) } : {}),
    checkedAt,
  };
}

