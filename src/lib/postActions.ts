import { doc, updateDoc } from 'firebase/firestore';
import toast from 'react-hot-toast';
import { db } from '../firebase';
import { Post, PostStatus, Asset, Vendor } from '../types';

// 貼文狀態／審核／平台發布的共用動作。
// 原本只寫在 PostManagement.tsx 裡，社群日曆的貼文詳情也要能直接改狀態之後抽出來共用——
// 這幾個動作帶著業務規則(發布前必須過業主審核、素材沒審核不能發、排程/發布要打 Make webhook)，
// 各寫一份遲早會分岔，變成「從日曆改就繞過審核」的後門。要改規則只改這裡一處。

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
  draft: '草稿',
  pending: '待補中',
  scheduled: '已排程',
  published: '已發布',
};

interface StatusChangeContext {
  assets: Asset[];
  vendors: Vendor[];
}

function fireMakeWebhook(post: Post, newStatus: PostStatus, vendors: Vendor[]) {
  const vendor = vendors.find(v => v.id === post.vendorId);
  const webhookData = {
    action: 'status_change',
    postId: post.id,
    status: newStatus,
    title: post.title,
    content: post.content,
    scheduledAt: post.scheduledAt,
    vendorName: vendor?.name,
    platforms: post.platforms,
    type: post.type,
    contentType: post.contentType
  };

  // 先走自家 proxy，失敗才退回環境變數裡的直連網址
  const fetchFn = globalThis.fetch || window.fetch;
  fetchFn('/api/webhook/make', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookData)
  }).then(res => {
    if (!res.ok) throw new Error('Proxy failed');
  }).catch(err => {
    console.warn('Webhook proxy failed, checking for direct URL...', err);
    const directUrl = (import.meta as any).env?.VITE_MAKE_WEBHOOK_URL;
    if (directUrl) {
      fetchFn(directUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookData)
      }).catch(e => console.error('Direct webhook call failed', e));
    }
  });
}

/** 改發布狀態。回傳 false＝被業務規則擋下或寫入失敗（呼叫端不用自己再 toast） */
export async function setPostStatus(
  post: Post,
  newStatus: PostStatus,
  { assets, vendors }: StatusChangeContext
): Promise<boolean> {
  if (newStatus === 'published') {
    if (!post.clientConfirmed) {
      toast.error('必須先經業主審核確認後才可發布');
      return false;
    }
    if (post.assetId && post.assetId !== 'to_be_added') {
      const asset = assets.find(a => a.id === post.assetId);
      if (asset && !asset.approved) {
        toast.error('素材尚未通過審核，無法發布');
        return false;
      }
    }
  }

  if (newStatus === 'scheduled') {
    // 素材沒審核只提醒不擋
    if (post.assetId && post.assetId !== 'to_be_added') {
      const asset = assets.find(a => a.id === post.assetId);
      if (asset && !asset.approved) {
        toast('提醒：成片素材尚未審核', { icon: '⚠️', duration: 4000 });
      }
    }
  }

  try {
    await updateDoc(doc(db, 'posts', post.id!), { status: newStatus });
    toast.success(`狀態已更新為${POST_STATUS_LABEL[newStatus]}`);
    if (newStatus === 'scheduled' || newStatus === 'published') {
      fireMakeWebhook(post, newStatus, vendors);
    }
    return true;
  } catch (error) {
    toast.error('更新失敗');
    return false;
  }
}

export async function togglePostConfirmation(post: Post, field: 'clientConfirmed' | 'internalConfirmed'): Promise<void> {
  try {
    await updateDoc(doc(db, 'posts', post.id!), { [field]: !post[field] });
  } catch (error) {
    toast.error('更新失敗');
  }
}

export async function togglePostPlatformPublished(post: Post, platform: string): Promise<void> {
  try {
    const current = post.publishedPlatforms || [];
    const updated = current.includes(platform)
      ? current.filter(p => p !== platform)
      : [...current, platform];
    await updateDoc(doc(db, 'posts', post.id!), { publishedPlatforms: updated });
    toast.success(`${platform} 發布狀態已更新`);
  } catch (error) {
    toast.error('更新失敗');
  }
}
