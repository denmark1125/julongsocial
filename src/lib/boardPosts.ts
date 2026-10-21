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

export function isUntouchedAutoPost(post: Pick<Post, 'createdFrom' | 'status' | 'assetId' | 'content' | 'title' | 'autoTitle'> | undefined): boolean {
  return !!post &&
    post.createdFrom === AUTO_POST_SOURCE &&
    post.status === 'pending' &&
    (!post.assetId || post.assetId === 'to_be_added') &&
    !post.content &&
    post.title === post.autoTitle;
}

/** 搬到別天：保留原本的時分，只換日子 */
export function movedSchedule(post: Pick<Post, 'scheduledAt'>, day: Date): { scheduledAt: string; targetMonth: string } {
  const time = (post.scheduledAt || '').slice(11, 16) || '20:00';
  return { scheduledAt: `${format(day, 'yyyy-MM-dd')}T${time}`, targetMonth: format(day, 'yyyy-MM') };
}
