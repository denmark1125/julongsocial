/**
 * Drive 上由系統建立的固定資料夾名稱。
 *
 * ⚠️ 前後端共用同一份：後端拿它建資料夾，前端拿它顯示路徑提示。
 *    兩邊各寫一份字串的話，哪天改名就會變成建出兩個資料夾、舊的那個沒人再寫進去。
 */

/** 每支素材底下放補充畫面的子資料夾。祥濱既有的就是這個寫法。 */
export const BROLL_FOLDER_NAME = 'B-roll';

/**
 * 從素材的 url 取出雲端資料夾 id（`.../folders/<id>`）。
 * 舊素材是人手動貼資料夾連結建檔的，沒有 driveFolderId，改片名時靠這個找到資料夾。
 * 不是資料夾連結（檔案連結、其他網址、空白）就回空字串。
 */
export function driveFolderIdFromUrl(url?: string): string {
  return String(url || '').match(/\/folders\/([A-Za-z0-9_-]{10,})/)?.[1] || '';
}
