import { Link2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Asset } from '../types';

/**
 * 「複製預覽連結」：給客戶看片用（貼到 LINE）。2026-10-21 起。
 * 客戶點 https://…/v/<代碼> 就能直接看，不用登入、不經 LINE 壓縮。業主通過、片搬進成片夾後連結會失效（見 server.ts /v/:token）。
 * 只給內部用；剪輯師畫面不放。
 */
export default function PreviewLinkButton({ asset }: { asset: Pick<Asset, 'reviewFiles' | 'cloudUploadedAt'> }) {
  const files = asset.reviewFiles || [];
  const latest = files[files.length - 1];
  if (!latest?.previewToken || asset.cloudUploadedAt) return null;
  const url = `${window.location.origin}/v/${latest.previewToken}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('已複製預覽連結，可以直接貼給客戶');
    } catch {
      toast(url, { duration: 10000 });
    }
  };
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); void copy(); }}
      className="inline-flex items-center gap-1 text-[13px] font-bold text-sky-700 hover:text-sky-900 underline underline-offset-2 whitespace-nowrap"
    >
      <Link2 size={12} /> 複製預覽連結{files.length > 1 ? `（第 ${files.length} 版）` : ''}
    </button>
  );
}
