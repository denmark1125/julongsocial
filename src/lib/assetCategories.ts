/**
 * 素材分類的建議清單。
 *
 * 原本是 AssetDatabase.tsx 裡的區域常數，上傳毛片時也要用同一份，所以抽出來共用。
 * ⚠️ 這是**建議值不是列舉**：欄位在 firestore.rules 只檢查 `is string`，
 *    建檔畫面用的是 `<input list> + <datalist>`（可以自由輸入），不是 `<select>`。
 *    加欄位時請維持這個行為，不要在某一個畫面偷偷改成只能選清單內的值。
 *
 * ⚠️ 不要跟 PostManagement 的 `postTypes` 搞混 —— 那是**貼文類型**，語義不同的另一份清單。
 */
export const ASSET_CATEGORIES = ['宣傳', '教學', '生活', '活動', '訪談', '開箱', '圖文', '資訊'];

/** `<datalist>` 的 id，兩個畫面共用同一個字串，免得其中一邊打錯就靜靜失效 */
export const ASSET_CATEGORY_DATALIST_ID = 'asset-categories';
