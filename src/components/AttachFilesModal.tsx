import { useState } from 'react';
import { Asset } from '../types';
import { auth } from '../firebase';
import { openFolderContentPicker, getPickerApiKey } from '../lib/drivePicker';
import { BROLL_FOLDER_NAME } from '../lib/driveNaming';
import toast from 'react-hot-toast';
import { X, Loader2, CheckCircle2, FolderOpen } from 'lucide-react';

/**
 * 把「已經傳進雲端資料夾」的檔案掛到這支素材上，順便逐片打標籤。
 *
 * 為什麼需要這一步：2026-09-30 把建檔與上傳拆開之後，同事是在 Drive 那邊自己丟檔案的，
 * 而我們的授權範圍（drive.file）看不到不是這個 app 建立的檔案 —— **人在 Picker 裡挑一次，
 * 那些檔案才進入可存取範圍**，後端才寫得了逐檔紀錄。這不是多餘的確認，是唯一的路。
 *
 * ⚠️ 這裡的 Picker **不傳位元組**：檔案早就在雲端了，所以是秒開秒關。
 *    不要把它跟上傳毛片那個會讓人等到天荒地老的視窗混為一談。
 */
export default function AttachFilesModal({
  asset, onClose, onDone,
}: {
  asset: Asset;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [asBroll, setAsBroll] = useState(false);
  const [busy, setBusy] = useState(false);

  const callApi = async (path: string, body: Record<string, unknown>) => {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('認證已過期，請重新登入');
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `伺服器回 ${res.status}`);
    return data;
  };

  const handlePick = async () => {
    setBusy(true);
    try {
      const cred = await callApi('/api/drive/asset-picker-auth', { assetId: asset.id });
      const files = await openFolderContentPicker({
        folderId: cred.folderId,
        accessToken: cred.accessToken,
        apiKey: getPickerApiKey(),
        appId: cred.appId,
        title: `選「${asset.title}」資料夾裡的檔案`,
      });
      // 空陣列＝自己取消，不是錯誤
      if (files.length === 0) return;
      setPicked(prev => {
        const fresh = files.filter(f => !prev.some(o => o.id === f.id));
        return [...prev, ...fresh.map(f => ({ id: f.id, name: f.name }))];
      });
    } catch (e: any) {
      toast.error(e?.message || '開啟選檔視窗失敗');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      const payload = picked.map(f => ({ driveFileId: f.id, note: notes[f.id] || '' }));
      const data = await callApi('/api/drive/attach-files', {
        assetId: asset.id,
        files: asBroll ? [] : payload,
        brollFiles: asBroll ? payload : [],
      });
      toast.success(`已掛上 ${data.attached} 個檔案`);
      onDone?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || '掛上檔案失敗');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-800">掛上檔案</h3>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto space-y-4">
          <div>
            <p className="text-sm text-slate-500">素材</p>
            <p className="text-base font-medium text-slate-800">{asset.title}</p>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={asBroll}
              onChange={e => setAsBroll(e.target.checked)}
              disabled={picked.length > 0}
              className="rounded border-slate-300"
            />
            這批是 {BROLL_FOLDER_NAME}（補充畫面，會移到子資料夾，不另外變成一支素材）
          </label>

          <button
            type="button"
            onClick={handlePick}
            disabled={busy}
            className="w-full px-4 py-3 border border-dashed border-slate-300 rounded-lg text-sm text-slate-600 hover:border-blue-400 hover:text-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
            從資料夾裡選檔案
          </button>

          {picked.length === 0 ? (
            <p className="text-sm text-slate-500 leading-relaxed">
              檔案要先在雲端資料夾裡才選得到。還沒傳完就等傳完再回來按，不用留在這頁等。
            </p>
          ) : (
            <div className="space-y-2">
              {picked.map(f => (
                <div key={f.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
                  <p className="text-sm text-slate-800 break-all">{f.name}</p>
                  <input
                    value={notes[f.id] || ''}
                    onChange={e => setNotes(prev => ({ ...prev, [f.id]: e.target.value }))}
                    placeholder="這段是什麼（例如：大口吃、浮誇）"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-40">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy || picked.length === 0}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 font-medium"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            掛上 {picked.length} 個檔案
          </button>
        </div>
      </div>
    </div>
  );
}
