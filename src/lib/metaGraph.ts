import type { LivePost } from './publishAudit.js';

/**
 * Meta Graph 讀取（伺服器用）。2026-11-05 發布稽核。
 *
 * Token：一把**永不過期**的使用者 token（環境變數 META_PUBLISH_AUDIT_TOKEN），
 * 用 /me/accounts 換出各粉專自己的 page token，所有代操 IP 都在裡面。
 * ⚠️ 不要改回 clients.json 的 fb_token（多數是空的）或 meta_API-sync 的 GitHub secrets（讀不出來）。
 * ⚠️ 這把 token 也有發文權限（instagram_content_publish / pages_manage_posts），本檔**只准讀**。
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  igUserId?: string;
  igUsername?: string;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    throw new Error(`Meta Graph ${res.status}: ${body?.error?.message || 'unknown error'}`);
  }
  return body;
}

let pageCache: { at: number; pages: MetaPage[] } | null = null;

/** 這把 token 管得到的所有粉專（快取 1 小時：每分鐘的稽核不用每次都問） */
export async function listMetaPages(userToken: string, now = Date.now()): Promise<MetaPage[]> {
  if (pageCache && now - pageCache.at < 3600_000) return pageCache.pages;
  const pages: MetaPage[] = [];
  let url: string | undefined =
    `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account%7Busername%7D&limit=100&access_token=${encodeURIComponent(userToken)}`;
  while (url) {
    const body = await getJson(url);
    for (const p of body.data || []) {
      pages.push({
        id: p.id, name: p.name, accessToken: p.access_token,
        igUserId: p.instagram_business_account?.id, igUsername: p.instagram_business_account?.username,
      });
    }
    url = body.paging?.next;
  }
  pageCache = { at: now, pages };
  return pages;
}

const toIso = (t: string) => new Date(t.replace(/\+0000$/, 'Z')).toISOString();

/** FB 粉專近期貼文＋Reels（Reels 有時不會出現在 /posts，兩邊都要問）。since 之前的不要 */
export async function fetchFacebookPosts(page: MetaPage, vendorId: string, sinceIso: string): Promise<LivePost[]> {
  const since = Math.floor(new Date(sinceIso).getTime() / 1000);
  const t = encodeURIComponent(page.accessToken);
  const [posts, reels] = await Promise.all([
    getJson(`${GRAPH}/${page.id}/posts?fields=id,created_time,message,permalink_url,full_picture&since=${since}&limit=50&access_token=${t}`),
    getJson(`${GRAPH}/${page.id}/video_reels?fields=id,created_time,description,permalink_url,picture&limit=25&access_token=${t}`),
  ]);
  const fromReels: LivePost[] = (reels.data || [])
    .filter((m: any) => m.created_time && toIso(m.created_time) >= sinceIso)
    .map((m: any) => ({
      platform: 'FB', id: `reel_${m.id}`, vendorId, publishedAt: toIso(m.created_time),
      caption: m.description || '',
      permalink: m.permalink_url ? `https://www.facebook.com${m.permalink_url}` : undefined,
      thumbnailUrl: m.picture,
    }));
  const fromPosts: LivePost[] = (posts.data || []).map((m: any) => ({
    platform: 'FB', id: m.id, vendorId, publishedAt: toIso(m.created_time),
    caption: m.message || '', permalink: m.permalink_url, thumbnailUrl: m.full_picture,
  }));
  // 同一支 Reel 會在 /posts 再出現一次（同文案、時間差幾秒）→ 留 Reel 那筆，不然會多一則「系統沒排的貼文」
  const dup = (p: LivePost) => fromReels.some(r =>
    Math.abs(new Date(r.publishedAt).getTime() - new Date(p.publishedAt).getTime()) < 3 * 60_000
    && (r.caption || '').slice(0, 30) === (p.caption || '').slice(0, 30));
  return [...fromReels, ...fromPosts.filter(p => !dup(p))];
}

/** IG 近期貼文（含 Reels）。縮圖：影片用 thumbnail_url、圖片用 media_url */
export async function fetchInstagramPosts(page: MetaPage, vendorId: string, sinceIso: string): Promise<LivePost[]> {
  if (!page.igUserId) return [];
  const body = await getJson(
    `${GRAPH}/${page.igUserId}/media?fields=id,timestamp,caption,permalink,thumbnail_url,media_url,media_type&limit=25&access_token=${encodeURIComponent(page.accessToken)}`);
  return (body.data || [])
    .map((m: any): LivePost => ({
      platform: 'IG', id: m.id, vendorId, publishedAt: toIso(m.timestamp), caption: m.caption || '',
      permalink: m.permalink, thumbnailUrl: m.thumbnail_url || (m.media_type === 'VIDEO' ? undefined : m.media_url),
    }))
    .filter((l: LivePost) => l.publishedAt >= sinceIso);
}
