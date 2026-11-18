import { arrayRemove, arrayUnion, doc, updateDoc } from 'firebase/firestore';
import toast from 'react-hot-toast';
import { auth, db } from '../firebase';
import { Post } from '../types';
import type { CaptionFeedback } from './captionReview';

/**
 * 業主審文案：小編端的動作（送審、複製文案頁連結、整理業主意見）。規格見 src/lib/captionReview.ts。
 * 送審一定走伺服器（要發 LINE、要記額度）；意見與套用文案是單純改貼文欄位，直接寫資料庫。
 */

async function call(path: string, body: Record<string, unknown>) {
  const idToken = await auth.currentUser?.getIdToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, idToken }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || '操作失敗');
  return json;
}

/** 把文案送到該 IP 的客戶 LINE 群組。會先跳確認（發出去就收不回來）。回 true＝有送出 */
export async function sendCaptionReview(posts: Post[], vendorName: string): Promise<boolean> {
  if (!posts.length) return false;
  const what = posts.length === 1 ? `「${posts[0].title}」的文案` : `${posts.length} 篇文案`;
  if (!window.confirm(`確定把${what}送到「${vendorName}」的客戶 LINE 群組請業主確認嗎？`)) return false;
  const t = toast.loading('送出中…');
  try {
    const r = await call('/api/posts/caption-review/send', { postIds: posts.map(p => p.id) });
    toast.success(r.mode === 'test'
      ? '目前是測試模式：卡片只發給管理者，沒有進客戶群組'
      : `已送到客戶群組（${r.count} 篇）`, { id: t, duration: 5000 });
    return true;
  } catch (e: any) {
    toast.error(e?.message || '送審失敗', { id: t, duration: 6000 });
    return false;
  }
}

/** 複製這個 IP 的客戶端連結（固定一條，業主可以存起來） */
export async function copyCaptionPageLink(vendorId: string, month?: string): Promise<void> {
  try {
    const { url } = await call('/api/posts/caption-review/link', { vendorId, month });
    try {
      await navigator.clipboard.writeText(url);
      toast.success('已複製客戶端連結，可以直接貼給業主');
    } catch {
      toast(url, { duration: 10000 });
    }
  } catch (e: any) {
    toast.error(e?.message || '拿不到連結');
  }
}

/** 小編手動補一筆業主意見（業主沒按按鈕、直接在群組講的情況） */
export async function addManualFeedback(post: Post, text: string): Promise<void> {
  const entry: CaptionFeedback = { at: new Date().toISOString(), byName: '業主（小編代貼）', text: text.trim().slice(0, 2000), via: 'manual' };
  if (!entry.text) return;
  try {
    await updateDoc(doc(db, 'posts', post.id!), { 'captionReview.feedback': arrayUnion(entry) });
  } catch {
    toast.error('儲存失敗');
  }
}

export async function removeFeedback(post: Post, entry: CaptionFeedback): Promise<void> {
  try {
    await updateDoc(doc(db, 'posts', post.id!), { 'captionReview.feedback': arrayRemove(entry) });
  } catch {
    toast.error('刪除失敗');
  }
}

/** 把業主打的那段直接當成新文案（改之前的版本留在修改紀錄） */
export async function applyFeedbackAsCaption(post: Post, text: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'posts', post.id!), {
      content: text,
      'captionReview.history': [
        ...(post.captionReview?.history || []),
        { at: new Date().toISOString(), by: 'staff', byName: auth.currentUser?.displayName || '', before: post.content || '' },
      ].slice(-20),
    });
    toast.success('已用業主這段取代文案，記得再送一次給業主確認');
  } catch {
    toast.error('更新失敗');
  }
}
