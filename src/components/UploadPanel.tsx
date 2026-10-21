import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, RotateCw, UploadCloud, X, XCircle } from 'lucide-react';
import { dismissUpload, retryUpload, useUploads } from '../lib/uploadQueue';

/**
 * 右下角的「上傳中」面板（剪輯師）。2026-10-21 起。
 *
 * 以前進度只在右上角一則小通知，剪輯師以為要卡著等一支傳完才能做下一支。
 * 這裡常駐列出每一支的進度，第一行就講「可以繼續做別的事」。全部傳完幾秒後自己收掉（見 uploadQueue）。
 * ⚠️ 手機底部有導覽列，面板要墊在它上面。
 */
export default function UploadPanel() {
  const uploads = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (uploads.length === 0) return null;

  const active = uploads.filter(u => u.status === 'uploading').length;
  const title = active ? `上傳中（${active}）` : uploads.some(u => u.status === 'failed') ? '有上傳沒有成功' : '上傳完成';

  return (
    <div className="fixed z-50 right-3 left-3 bottom-24 md:left-auto md:right-6 md:bottom-6 md:w-96 bg-white rounded-2xl shadow-2xl border border-black/10 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[#5A5A40] text-white"
      >
        <span className="flex items-center gap-2 font-bold whitespace-nowrap"><UploadCloud size={16} /> {title}</span>
        {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {!collapsed && (
        <div className="max-h-72 overflow-y-auto">
          {active > 0 && (
            <p className="px-4 pt-3 text-[13px] text-gray-500">可以繼續做別的事，傳完會自動標記完成</p>
          )}
          <ul className="px-4 py-2 space-y-2.5">
            {uploads.map(u => (
              <li key={u.assetId} className="space-y-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex-1 min-w-0 truncate text-sm text-gray-800" title={u.title}>{u.title}</span>
                  {u.status === 'uploading' && <span className="shrink-0 text-[13px] font-bold text-sky-700">{u.percent}%</span>}
                  {u.status === 'done' && <span className="shrink-0 flex items-center gap-1 text-[13px] font-bold text-green-700 whitespace-nowrap"><CheckCircle2 size={14} /> 完成</span>}
                  {u.status === 'failed' && (
                    <span className="shrink-0 flex items-center gap-1.5 whitespace-nowrap">
                      <XCircle size={14} className="text-red-600" />
                      <button type="button" onClick={() => void retryUpload(u.assetId)} className="flex items-center gap-0.5 text-[13px] font-bold text-[#5A5A40] underline underline-offset-2">
                        <RotateCw size={12} /> 重試
                      </button>
                      <button type="button" onClick={() => dismissUpload(u.assetId)} className="text-gray-400 hover:text-gray-600" aria-label="關掉這一列">
                        <X size={14} />
                      </button>
                    </span>
                  )}
                </div>
                {u.status === 'uploading' && (
                  <div className="h-1.5 rounded-full bg-sky-100 overflow-hidden">
                    <div className="h-full bg-sky-600 transition-all" style={{ width: `${u.percent}%` }} />
                  </div>
                )}
                {u.status === 'failed' && u.error && <p className="text-[12px] text-red-600 truncate" title={u.error}>{u.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
