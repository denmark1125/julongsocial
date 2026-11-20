import type { Asset } from '../types';

/**
 * 「關聯素材」要打開的是**成片**，不是毛片資料夾（11-06 使用者：社群日曆點了只到素材）。
 * 社群日曆（PostDetailModal）和發布稽核（11-20）共用同一套。
 * 優先序：剪輯師上傳到 IP 成片夾的檔 → 送客戶夾的副本 → 最新一版審片檔 → 預覽頁 → 最後才退回素材連結。
 */
export function finishedLink(a: Asset): { url: string; label: string } | null {
  const drive = (id: string) => `https://drive.google.com/file/d/${id}/view`;
  const fin = a.finishedFiles?.[a.finishedFiles.length - 1];
  if (fin?.id) return { url: drive(fin.id), label: '看成片' };
  const copy = a.clientCopies?.[a.clientCopies.length - 1];
  if (copy?.id) return { url: drive(copy.id), label: '看成片' };
  const rev = a.reviewFiles?.[a.reviewFiles.length - 1];
  if (rev?.fileId) return { url: drive(rev.fileId), label: `看成片（審片第 ${rev.version} 版）` };
  if (rev?.previewToken) return { url: `${window.location.origin}/v/${rev.previewToken}`, label: '看成片（預覽頁）' };
  // 舊片（系統內上傳成片之前）只有一個雲端連結：是單一檔案就當成片，是資料夾就照實講
  if (a.url) {
    if (/drive\.google\.com\/file\//.test(a.url)) return { url: a.url, label: '看成片' };
    return { url: a.url, label: a.stage === 'raw' ? '素材資料夾（還沒有成片）' : '雲端資料夾' };
  }
  return null;
}
