import { format, parseISO, startOfDay } from 'date-fns';
import { Asset, Post } from '../types';

/**
 * 藏鏡人上架毛片時「這支是拍哪一篇小編貼文」的候選與猜測。2026-10-20 起。
 *
 * 小編先排好一個月的標題＋日期（素材＝待補上），毛片上架時要對回其中一篇。
 * ⚠️ 只猜不綁：藏鏡人取的片名常常跟小編標題不一樣（「披薩」vs「蘑菇滿滿的超大披薩！」），
 *    配錯了剪輯師的期限就錯。所以猜到的只當下拉的預設值，藏鏡人按確認才算數。
 */

/** 這篇貼文還在等片：影片、今天以後、還沒掛素材 */
export function isWaitingVideoPost(post: Post, today: Date = startOfDay(new Date())): boolean {
  if (post.contentType === 'post' || !post.scheduledAt) return false;
  if (post.assetId && post.assetId !== 'to_be_added') return false;
  if (post.status === 'published') return false;
  return startOfDay(parseISO(post.scheduledAt)) >= today;
}

/**
 * 這個 IP 可以選的貼文：還在等片、而且沒有被別支毛片綁走。日期由近到遠。
 * `exceptAssetId`：正在改的那一支自己綁的那篇要留著，不然下拉選不回自己。
 */
export function waitingPostsFor(
  vendorId: string, posts: Post[], assets: Pick<Asset, 'id' | 'plannedPostId' | 'voidedAt'>[], exceptAssetId?: string
): Post[] {
  const taken = new Set(assets
    .filter(a => a.plannedPostId && !a.voidedAt && a.id !== exceptAssetId)
    .map(a => a.plannedPostId!));
  return posts
    .filter(p => p.vendorId === vendorId && isWaitingVideoPost(p) && !taken.has(p.id!))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** 下拉選項的文字：「10/25（六）蘑菇滿滿的超大披薩！」 */
export function postOptionLabel(post: Pick<Post, 'scheduledAt' | 'title'>): string {
  const d = parseISO(post.scheduledAt);
  return `${format(d, 'M/d')}（${'日一二三四五六'[d.getDay()]}）${post.title || '（沒有標題）'}`;
}

/** 只留中英數字，大小寫不分。標點、空白、emoji、全形符號都不算 */
function normalize(text: string): string {
  return (text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function bigrams(text: string): Set<string> {
  const s = normalize(text);
  const out = new Set<string>();
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 兩個名稱有多像（0～1）。分母用**比較短的那一個**：藏鏡人的片名通常是小編標題的縮寫，
 * 「披薩」整個包含在「蘑菇滿滿的超大披薩」裡就該算很像，用聯集當分母會被長標題稀釋。
 */
export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  x.forEach(g => { if (y.has(g)) hit++; });
  return hit / Math.min(x.size, y.size);
}

/** 低於這個分數不預選，預設留在「不屬於任何一篇」 */
export const POST_MATCH_THRESHOLD = 0.5;

/** 回傳最像的那篇貼文 id；都不夠像就回 ''（＝不屬於任何一篇） */
export function guessPostForTitle(title: string, candidates: Pick<Post, 'id' | 'title'>[]): string {
  let best = '', bestScore = 0;
  for (const p of candidates) {
    const s = titleSimilarity(title, p.title || '');
    if (s > bestScore) { best = p.id!; bestScore = s; }
  }
  return bestScore >= POST_MATCH_THRESHOLD ? best : '';
}

/**
 * 一張表單同時上架好幾支時，每支實際要綁哪一篇。
 * `pick`：null＝藏鏡人沒動過（用猜的）；''＝選了「不屬於任何一篇」；其他＝選定的貼文 id。
 * ⚠️ 同一篇只能給一支：前面的先拿走，後面的不會再猜到同一篇（手動選定的優先於猜的）。
 */
export function resolvePostPicks(
  items: { name: string; pick: string | null }[], candidates: Pick<Post, 'id' | 'title'>[]
): string[] {
  // 選過的貼文已經不在候選裡（換了 IP、或那篇剛被掛走）＝當作沒動過，重新猜
  const valid = (pick: string | null) => pick === '' || (!!pick && candidates.some(c => c.id === pick));
  const manual = new Set(items.map(i => i.pick).filter((p): p is string => !!p && valid(p)));
  const taken = new Set<string>();
  return items.map(i => {
    if (valid(i.pick)) { if (i.pick) taken.add(i.pick); return i.pick!; }
    const guess = guessPostForTitle(i.name, candidates.filter(c => !taken.has(c.id!) && !manual.has(c.id!)));
    if (guess) taken.add(guess);
    return guess;
  });
}
