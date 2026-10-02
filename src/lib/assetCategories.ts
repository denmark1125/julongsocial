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
/**
 * 2026-10-02 精簡成四項（老闆定案）。原本是
 * `宣傳/教學/生活/活動/訪談/開箱/圖文/資訊` 八項，分得太細，實際上沒人分得準。
 *
 * ⚠️ **既往不咎**：舊素材上的舊分類字串原封不動留著。
 *    這裡只是 `<datalist>` 的建議值，欄位本身是自由字串（rules 只檢查 is string），
 *    所以舊值照樣顯示得出來、也改得動，不需要資料遷移。
 */
export const ASSET_CATEGORIES = ['專業', '泛流', '人設', '其他'];

/** `<datalist>` 的 id，兩個畫面共用同一個字串，免得其中一邊打錯就靜靜失效 */
export const ASSET_CATEGORY_DATALIST_ID = 'asset-categories';
