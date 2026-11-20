import { format } from 'date-fns';
import { Asset, Post, Vendor, getVendorDefaultPlatforms } from '../types';
import { defaultSlotTime } from './plannedSlots';

/**
 * 排上片日自動建的「待補中」貼文（2026-10-21 使用者要求）。
 *
 * 藏鏡人把毛片排到某天、那天又沒有小編的貼文時，系統直接建一篇待補中貼文並綁上那支片，
 * 小編不用再重建一次。成片出來、業主通過後，boundPosts 的 attach 會自動掛上、轉草稿。
 *
 * ⚠️ 系統只動「自己建、小編沒碰過」的貼文（isUntouchedAutoPost）：搬日期、換標題、取消排日時刪掉。
 *    小編改過標題、寫了文案、改了狀態或掛了片，就是小編的貼文了，系統一律不碰，只解除綁定。
 */
export const AUTO_POST_SOURCE = 'airDateBoard';

export function buildAutoPost(
  asset: Pick<Asset, 'title'>,
  vendor: Pick<Vendor, 'id' | 'postingHabits' | 'defaultPlatforms'>,
  day: Date,
  createdBy: string,
  now: string = new Date().toISOString(),
): Omit<Post, 'id'> {
  return {
    vendorId: vendor.id!,
    title: asset.title,
    autoTitle: asset.title,
    content: '',
    status: 'pending',
    assetId: 'to_be_added',
    contentType: 'video',
    scheduledAt: `${format(day, 'yyyy-MM-dd')}T${defaultSlotTime(vendor)}`,
    targetMonth: format(day, 'yyyy-MM'),
    type: '專業',
    platforms: getVendorDefaultPlatforms(vendor, 'video'),
    clientConfirmed: false,
    internalConfirmed: false,
    createdFrom: AUTO_POST_SOURCE,
    createdBy,
    createdAt: now,
  };
}

/**
 * 在排上片日直接替某天打「預計片名」（2026-10-22 使用者：PM 要能在這裡先排名稱）。
 * 就是一篇一般的待補中貼文，跟小編在貼文管理新增的一樣；毛片之後拖上去綁。
 * ⚠️ 刻意不寫 autoTitle：這是有人親手打的名字，取消排日時不能刪它（isUntouchedAutoPost 永遠 false）。
 *    但還沒寫文案時，綁上片會改成片名、片搬日子它跟著搬（11-20 使用者，見 isBlankBoardPost）。
 */
export function buildTitledPost(
  title: string,
  vendor: Pick<Vendor, 'id' | 'postingHabits' | 'defaultPlatforms'>,
  day: Date,
  createdBy: string,
  now: string = new Date().toISOString(),
): Omit<Post, 'id'> {
  const { autoTitle: _omit, ...base } = buildAutoPost({ title }, vendor, day, createdBy, now);
  return { ...base, createdFrom: 'airDateBoardTitle' };
}

export function isUntouchedAutoPost(post: Pick<Post, 'createdFrom' | 'status' | 'assetId' | 'content' | 'title' | 'autoTitle'> | undefined): boolean {
  return !!post &&
    post.createdFrom === AUTO_POST_SOURCE &&
    post.status === 'pending' &&
    (!post.assetId || post.assetId === 'to_be_added') &&
    !post.content &&
    post.title === post.autoTitle;
}

/**
 * 排上片日建的貼文（系統自動建的，或 PM 打的預計片名），還沒寫文案、還沒掛片。
 * 這種貼文只是「這天要上哪支」的佔位：
 *  - 綁上片＝標題換成那支片的片名（11-20 使用者：預計片名打合掌村、拖帶團領隊上去，藍字還是合掌村）
 *  - 片搬到別天＝貼文跟著搬（11-20：合掌村搬到 11/21，12/8 還留一篇空的合掌村）
 * 取消排日時要不要刪，仍然只看 isUntouchedAutoPost（預計片名是人打的，拖回左邊時留著當空位）。
 */
export function isBlankBoardPost(post: Pick<Post, 'createdFrom' | 'status' | 'assetId' | 'content'> | undefined): boolean {
  return !!post &&
    (post.createdFrom === AUTO_POST_SOURCE || post.createdFrom === 'airDateBoardTitle') &&
    post.status === 'pending' &&
    (!post.assetId || post.assetId === 'to_be_added') &&
    !(post.content || '').trim();
}

/** 片綁上這篇時，要改的標題欄位（不用改回 null）。系統建的連 autoTitle 一起改，才會繼續被當成沒人動過 */
export function retitleForAsset(post: Pick<Post, 'createdFrom' | 'status' | 'assetId' | 'content' | 'title'> | undefined, assetTitle: string): { title: string; autoTitle?: string } | null {
  if (!isBlankBoardPost(post) || !assetTitle || post!.title === assetTitle) return null;
  return post!.createdFrom === AUTO_POST_SOURCE ? { title: assetTitle, autoTitle: assetTitle } : { title: assetTitle };
}

/** 搬到別天：保留原本的時分，只換日子 */
export function movedSchedule(post: Pick<Post, 'scheduledAt'>, day: Date): { scheduledAt: string; targetMonth: string } {
  const time = (post.scheduledAt || '').slice(11, 16) || '20:00';
  return { scheduledAt: `${format(day, 'yyyy-MM-dd')}T${time}`, targetMonth: format(day, 'yyyy-MM') };
}
