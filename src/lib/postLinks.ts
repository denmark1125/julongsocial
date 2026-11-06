import type { Post } from '../types';

/**
 * 這篇貼文真正發出去的網址（11-06：「前往貼文」跑到雲端資料夾）。
 * 先用發布稽核查到的 IG／FB 網址；沒有才用手填的「貼文位置連結」，而且雲端／文件連結不算貼文。
 */
export function publishedPostUrl(post: Pick<Post, 'publishAudit' | 'scheduledAt' | 'postUrl'>): string | undefined {
  for (const pf of ['IG', 'FB'] as const) {
    const a = post.publishAudit?.[pf];
    if (a?.permalink && a.forScheduledAt === post.scheduledAt) return a.permalink;
  }
  const manual = post.postUrl;
  return manual && !/drive\.google\.com|docs\.google\.com/.test(manual) ? manual : undefined;
}
