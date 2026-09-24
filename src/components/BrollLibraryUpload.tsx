import { useEffect, useMemo, useState } from 'react';
import { auth } from '../firebase';
import { Vendor } from '../types';
import { visibleVendors } from '../lib/vendorStatus';
import { openUploadPicker, getPickerApiKey, PickedFile } from '../lib/drivePicker';
import { FolderOpen, Loader2, CheckCircle2, AlertTriangle, FilePlus2 } from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * 這個 IP 共用的 B-roll 素材庫上傳。
 *
 * 跟毛片上傳的差別：**這些檔案不屬於任何一支素材**，跨場次累積
 *（佐禾的「01-Broll下層素材庫」46 檔 7.96 GB 就是這種）。
 * 所以沒有日期資料夾、沒有素材名稱、沒有分類、沒有剪輯需求，檔案直接進人工指定的那個資料夾。
 *
 * ⚠️ **不會在 ERP 產生素材。** 補充畫面不是交付品，產成素材會變成幽靈庫存，
 *    還會跑進剪輯師待辦清單與欠片計算。
 *
 * ⚠️ 資料夾同樣只能由人在廠商建檔那邊用 Picker 指一次（drive.file 看不到不是這個 app
 *    建的資料夾，猜名字一定 404）。這裡沒指定就直接擋住，不自己建一個。
 */

interface Props {
  vendors: Vendor[];
  /** 從毛片分頁切過來時沿用已經選好的 IP，不要讓人再選一次 */
  defaultVendorId?: string;
  /**
   * 把「可以送出了嗎、正在忙嗎、按下去要做什麼」回報給外層 modal，讓送出按鈕跟毛片分頁
   * 一樣待在固定的 footer 裡。
   * ⚠️ 一定要在 useEffect 裡呼叫，不能在 render 期間 —— 那是 render 副作用。
   */
  onSubmitStateChange?: (s: { canSubmit: boolean; busy: boolean; submit: () => void }) => void;
}

const fmtSize = (bytes: number) => {
  if (!bytes) return '';
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
};

export default function BrollLibraryUpload({ vendors, defaultVendorId, onSubmitStateChange }: Props) {
  const [vendorId, setVendorId] = useState(defaultVendorId || '');
  const [busy, setBusy] = useState(false);
  const [freeGB, setFreeGB] = useState<number | null>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ recorded: any[]; rejected: any[]; folderName?: string } | null>(null);

  const options = useMemo(
    () => visibleVendors(vendors).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
    [vendors]
  );
  const vendor = vendors.find(v => v.id === vendorId);
  const folderReady = Boolean(vendor?.brollFolderId);

  const callApi = async (path: string, body: Record<string, unknown>) => {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error('認證已過期，請重新登入');
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: any = new Error(data?.message || data?.error || `伺服器回 ${res.status}`);
      err.code = data?.error;
      throw err;
    }
    return data;
  };

  const handlePick = async () => {
    if (!vendorId) { toast.error('請先選 IP'); return; }
    setBusy(true);
    try {
      const ctx = await callApi('/api/drive/library-upload-target', { vendorId });
      if (ctx.freeGB !== undefined) setFreeGB(ctx.freeGB);
      const picked = await openUploadPicker({
        folderId: ctx.folderId,
        accessToken: ctx.accessToken,
        apiKey: getPickerApiKey(),
        appId: ctx.appId,
        multiple: true,
        title: `上傳到 ${ctx.path}`,
      });
      // 空陣列＝使用者自己取消，不是錯誤
      if (picked.length === 0) return;
      setFiles(prev => [...prev, ...picked.filter(f => !prev.some(o => o.id === f.id))]);
    } catch (e: any) {
      if (e?.code === 'VENDOR_BROLL_FOLDER_UNSET') {
        toast.error(e.message + '請到廠商管理指定。');
      } else {
        toast.error(e?.message || '上傳失敗');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const data = await callApi('/api/drive/record-library-uploads', {
        vendorId,
        files: files.map(f => ({ driveFileId: f.id, note: notes[f.id] || '' })),
      });
      setDone(data);
      if (data.rejected?.length) {
        toast.error(`${data.recorded?.length || 0} 個登記成功，${data.rejected.length} 個失敗`);
      } else {
        toast.success(`${data.recorded?.length || 0} 個檔案已登記`);
      }
    } catch (e: any) {
      toast.error(e?.message || '登記失敗');
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = files.length > 0 && !done;
  useEffect(() => {
    onSubmitStateChange?.({ canSubmit, busy, submit: handleCommit });
    // files/notes/vendorId 變了要重新註冊，否則 footer 按下去用到的是舊的資料
  }, [canSubmit, busy, files, notes, vendorId]);

  if (done) {
    return (
      <div className="space-y-3">
        <p className="text-base font-medium text-slate-800 flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-green-600" />
          {done.recorded.length} 個檔案已放進「{done.folderName}」
        </p>
        <ul className="text-sm text-slate-700 space-y-1">
          {done.recorded.map((r: any, i: number) => <li key={i}>・{r.fileName}</li>)}
        </ul>
        <p className="text-xs text-slate-500">這些是共用素材，不會出現在素材庫的片單裡。</p>
        {done.rejected.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {done.rejected.length} 個沒有登記成功：{done.rejected[0]?.reason}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="max-w-xs">
        <label className="block text-sm font-medium text-slate-700 mb-1">IP</label>
        <select
          value={vendorId}
          onChange={e => setVendorId(e.target.value)}
          disabled={files.length > 0}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base disabled:bg-slate-100"
        >
          <option value="">請選擇</option>
          {options.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>

      {vendorId && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
          <span className="flex items-center gap-1.5 text-slate-700">
            <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
            {folderReady
              ? <span>會放在 <span className="font-medium">{vendor?.brollFolderName}</span></span>
              : <span className="text-amber-700">這個 IP 還沒指定共用 B-roll 資料夾（到廠商管理設定）</span>}
          </span>
          {freeGB !== null && (
            <span className={freeGB < 200 ? 'text-red-600 font-medium whitespace-nowrap' : 'text-slate-500 whitespace-nowrap'}>
              雲端剩餘 {freeGB} GB
            </span>
          )}
        </div>
      )}

      <button
        onClick={handlePick}
        disabled={busy || !vendorId || !folderReady}
        className="w-full py-4 border-2 border-dashed border-slate-300 rounded-xl text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50 disabled:hover:border-slate-300 flex items-center justify-center gap-2 font-medium"
      >
        {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <FilePlus2 className="w-5 h-5" />}
        {busy ? '準備中…' : (files.length > 0 ? '再加檔案' : '選檔案')}
      </button>

      {files.map(f => (
        <div key={f.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <span className="text-sm text-slate-800 break-all">{f.name}</span>
            <span className="text-xs text-slate-500 shrink-0 pt-0.5">{fmtSize(f.sizeBytes)}</span>
          </div>
          <input
            value={notes[f.id] || ''}
            onChange={e => setNotes(prev => ({ ...prev, [f.id]: e.target.value }))}
            placeholder="這段是什麼（可不填）"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
          />
        </div>
      ))}

      {files.length > 0 && (
        <p className="text-xs text-amber-700 flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          檔案已經在雲端了，但還沒登記。現在關掉，系統裡就查不到這批。
        </p>
      )}
    </div>
  );
}
