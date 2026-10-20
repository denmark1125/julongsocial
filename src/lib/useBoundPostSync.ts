import { useEffect, useRef } from 'react';
import { deleteField, doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { Asset, Post } from '../types';
import { isLiveCollectionLoaded } from './liveData';
import { findBoundPostFixes } from './boundPosts';

/**
 * 把「毛片綁小編貼文」的差異補上（掛上通過的片／跟著改日期／解除失效的綁定）。規則見 boundPosts.ts。
 *
 * 掛在 Layout：它從登入到登出都不會卸載，而且本來就訂了 posts 與 assets。
 * ⚠️ 只給非剪輯師跑（enabled）：規則不准剪輯師寫貼文。
 * ⚠️ 兩份資料都載入完才算：還沒到的那一瞬間 posts 是空的，會把所有綁定都當成「貼文被刪」解除掉。
 */
export function useBoundPostSync(posts: Post[], assets: Asset[], enabled: boolean): void {
  const busy = useRef(false);
  /** 上一次寫過的內容。寫入後資料回來前可能再觸發一次，不要重送同一批 */
  const lastSent = useRef('');

  useEffect(() => {
    if (!enabled || busy.current) return;
    if (!isLiveCollectionLoaded('posts') || !isLiveCollectionLoaded('assets')) return;
    const fixes = findBoundPostFixes(posts, assets);
    if (!fixes.length) return;
    const signature = JSON.stringify(fixes);
    if (signature === lastSent.current) return;

    busy.current = true;
    lastSent.current = signature;
    const batch = writeBatch(db);
    for (const f of fixes) {
      const assetRef = doc(db, 'assets', f.assetId);
      if (f.kind === 'attach') {
        // 跟貼文管理手動掛素材同一組寫入（PostManagement 存檔那段），兩邊才不會對不起來
        batch.update(doc(db, 'posts', f.postId), { assetId: f.assetId });
        batch.update(assetRef, { status: 'used', usedInPostId: f.postId });
      } else if (f.kind === 'sync') {
        batch.update(assetRef, { plannedAirDate: f.date });
      } else {
        batch.update(assetRef, { plannedPostId: deleteField(), plannedAirDate: deleteField() });
      }
    }
    batch.commit()
      .catch(error => {
        // 背景程序，失敗不打擾人；下次資料變動會再試
        console.error('同步毛片與小編貼文失敗:', error);
        lastSent.current = '';
      })
      .finally(() => { busy.current = false; });
  }, [posts, assets, enabled]);
}
