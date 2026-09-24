import React, { useMemo, useState } from 'react';
import { auth } from '../firebase';
import { Vendor } from '../types';
import { visibleVendors } from '../lib/vendorStatus';
import {
  openUploadPicker, openFolderPicker, getPickerApiKey, PickedFile,
} from '../lib/drivePicker';
import {
  X, UploadCloud, FolderOpen, Loader2, CheckCircle2, AlertTriangle, Plus, Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * 毛片上傳：一次拍攝帶回來的片段，分成幾支素材各自歸檔。
 *
 * 流程：選 IP 與拍攝日 → 一次把整批傳進「拍攝批次」資料夾 → 回來分組命名
 * → 每組建一個資料夾、把該組檔案搬進去、並在 ERP 建一支素材。
 *
 * 為什麼是「先全部傳、再分組」而不是「一組一組傳」：
 * 搬檔是 metadata 操作、不重傳位元組，所以分組可以事後做；
 * 這樣使用者只要開一次 Picker，而不是五組開五次。
 *
 * ⚠️ 資料夾結構是**你們既有的**，不是系統自己造的：
 *      自媒體IP代操/{IP}/剪輯/2026／0131/超好吃的金磚/
 *    中間那層每個 IP 都不一樣（剪輯／剪輯_謝／2 剪輯／毛片區），所以根資料夾
 *    一定要由人用 Picker 指一次（授權範圍是 drive.file，猜名字一定 404）。
 */

interface Props {
  vendors: Vendor[];
  onClose: () => void;
  /** engineer / manager 才能指定 IP 的毛片根資料夾 */
  canSetFolder: boolean;
  /** 預帶的 IP（從拍攝進度那邊開啟時用） */
  defaultVendorId?: string;
  /** 預帶的拍攝日 */
  defaultShotAt?: string;
}

interface UploadContext {
  batchFolderId: string;
  batchName: string;
  vendorName: string;
  rootFolderName: string;
  accessToken: string;
  appId: string;
  freeGB: number;
}

interface Group {
  key: string;
  name: string;
}

const fmtSize = (bytes: number) => {
  if (!bytes) return '';
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
};

/** 跟後端的 defaultBatchName 同一套寫法（2026／0131），兩邊要一致否則會建出兩個資料夾 */
const defaultBatchName = (shotAt: string) => {
  const [y, m, d] = shotAt.split('-');
  return y && m && d ? `${y}／${m}${d}` : '';
};

export default function RawFootageUpload({
  vendors, onClose, canSetFolder, defaultVendorId, defaultShotAt,
}: Props) {
  const today = new Date().toISOString().split('T')[0];
  const [vendorId, setVendorId] = useState(defaultVendorId || '');
  const [shotAt, setShotAt] = useState(defaultShotAt || today);
  const [batchName, setBatchName] = useState(defaultBatchName(defaultShotAt || today));
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState<UploadContext | null>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [groups, setGroups] = useState<Group[]>([{ key: 'g1', name: '' }]);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ created: any[]; failed: any[] } | null>(null);

  const options = useMemo(
    () => visibleVendors(vendors).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
    [vendors]
  );
  const vendor = vendors.find(v => v.id === vendorId);
  const folderReady = Boolean(vendor?.rawFootageFolderId);

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

  /** 每個 IP 只做一次：把既有的毛片資料夾指給系統 */
  const handlePickFolder = async () => {
    if (!vendorId) { toast.error('請先選 IP'); return; }
    setBusy(true);
    try {
      // 借 upload-context 拿 token 會被「還沒指定資料夾」擋住，所以走 quota 那支拿不到 token；
      // 這裡改用一支不需要資料夾的輕量呼叫：後端的 set-vendor-folder 前置資訊。
      const auth0 = await callApi('/api/drive/picker-auth', {});
      const picked = await openFolderPicker({
        accessToken: auth0.accessToken,
        apiKey: getPickerApiKey(),
        appId: auth0.appId,
        title: `選擇「${vendor?.name || ''}」的毛片資料夾`,
      });
      if (!picked) return;
      await callApi('/api/drive/set-vendor-folder', { vendorId, folderId: picked.id });
      toast.success(`已指定：${picked.name}`);
    } catch (e: any) {
      toast.error(e?.message || '指定資料夾失敗');
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    if (!vendorId) { toast.error('請先選 IP'); return; }
    setBusy(true);
    try {
      const context: UploadContext = await callApi('/api/drive/upload-context', {
        vendorId, shotAt, batchName: batchName || undefined,
      });
      setCtx(context);

      const picked = await openUploadPicker({
        folderId: context.batchFolderId,
        accessToken: context.accessToken,
        apiKey: getPickerApiKey(),
        appId: context.appId,
        multiple: true,
        title: `上傳到 ${context.rootFolderName}／${context.batchName}`,
      });

      // 空陣列＝使用者自己取消，不是錯誤，不要跳紅字
      if (picked.length === 0) return;
      const fresh = picked.filter(f => !files.some(x => x.id === f.id));
      setFiles(prev => [...prev, ...fresh]);
      setAssign(prev => {
        const next = { ...prev };
        fresh.forEach(f => { next[f.id] = groups[0].key; });
        return next;
      });
    } catch (e: any) {
      if (e?.code === 'VENDOR_FOLDER_UNSET') {
        toast.error(e.message + (canSetFolder ? '請先按上面的「指定資料夾」。' : '請找工程師指定。'));
      } else {
        toast.error(e?.message || '上傳失敗');
      }
    } finally {
      setBusy(false);
    }
  };

  const addGroup = () => {
    const key = `g${Date.now()}`;
    setGroups(prev => [...prev, { key, name: '' }]);
  };

  const removeGroup = (key: string) => {
    if (groups.length === 1) return;
    const fallback = groups.find(g => g.key !== key)!.key;
    setAssign(prev => Object.fromEntries(
      Object.entries(prev).map(([fid, gk]) => [fid, gk === key ? fallback : gk])
    ));
    setGroups(prev => prev.filter(g => g.key !== key));
  };

  const handleCommit = async () => {
    if (!ctx) return;
    const used = groups
      .map(g => ({ ...g, items: files.filter(f => assign[f.id] === g.key) }))
      .filter(g => g.items.length > 0);

    if (used.length === 0) { toast.error('每一支素材至少要有一個片段'); return; }
    const unnamed = used.filter(g => !g.name.trim());
    if (unnamed.length) { toast.error('每一組都要取名字（會變成素材標題與資料夾名稱）'); return; }

    setBusy(true);
    try {
      const data = await callApi('/api/drive/commit-groups', {
        vendorId,
        batchFolderId: ctx.batchFolderId,
        shotAt,
        groups: used.map(g => ({
          name: g.name.trim(),
          files: g.items.map(f => ({ driveFileId: f.id, note: notes[f.id] || '' })),
        })),
      });
      setDone(data);
      if (data.failed?.length) {
        toast.error(`${data.created?.length || 0} 支建好了，${data.failed.length} 組失敗`);
      } else {
        toast.success(`已建立 ${data.created?.length || 0} 支素材`);
      }
    } catch (e: any) {
      toast.error(e?.message || '建立素材失敗');
    } finally {
      setBusy(false);
    }
  };

  const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
  const lockHeader = files.length > 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-blue-600" />
            上傳毛片
          </h3>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto space-y-5">
          {done ? (
            <div className="space-y-3">
              <p className="text-base font-medium text-slate-800 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                已建立 {done.created.length} 支素材
              </p>
              <ul className="text-sm text-slate-700 space-y-1">
                {done.created.map((c: any) => (
                  <li key={c.assetId}>・{c.name}（{c.fileCount} 個片段）</li>
                ))}
              </ul>
              {done.failed.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  <p className="font-medium mb-1">這幾組沒有成功，檔案還留在批次資料夾裡：</p>
                  <ul className="space-y-1">
                    {done.failed.map((f: any, i: number) => <li key={i}>・{f.name}：{f.reason}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">IP</label>
                  <select
                    value={vendorId}
                    onChange={e => { setVendorId(e.target.value); setCtx(null); }}
                    disabled={lockHeader}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base disabled:bg-slate-100"
                  >
                    <option value="">請選擇</option>
                    {options.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">拍攝日</label>
                  <input
                    type="date"
                    value={shotAt}
                    onChange={e => {
                      setShotAt(e.target.value);
                      setBatchName(defaultBatchName(e.target.value));
                      setCtx(null);
                    }}
                    disabled={lockHeader}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base disabled:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">批次資料夾名稱</label>
                  <input
                    value={batchName}
                    onChange={e => { setBatchName(e.target.value); setCtx(null); }}
                    disabled={lockHeader}
                    placeholder="2026／0924"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base disabled:bg-slate-100"
                  />
                </div>
              </div>

              {vendorId && (
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                  <span className="flex items-center gap-1.5 text-slate-700">
                    <FolderOpen className="w-4 h-4 text-amber-500" />
                    {folderReady
                      ? <span>毛片放在 <span className="font-medium">{vendor?.rawFootageFolderName}</span>／{batchName}</span>
                      : <span className="text-amber-700">這個 IP 還沒指定毛片資料夾</span>}
                  </span>
                  {ctx && (
                    <span className={ctx.freeGB < 200 ? 'text-red-600 font-medium' : 'text-slate-500'}>
                      雲端剩餘 {ctx.freeGB} GB
                    </span>
                  )}
                  {!lockHeader && canSetFolder && (
                    <button onClick={handlePickFolder} disabled={busy} className="text-blue-600 hover:underline disabled:opacity-50">
                      {folderReady ? '換一個資料夾' : '指定資料夾'}
                    </button>
                  )}
                </div>
              )}

              {files.length === 0 ? (
                <button
                  onClick={handleUpload}
                  disabled={busy || !vendorId || !folderReady}
                  className="w-full py-4 border-2 border-dashed border-slate-300 rounded-xl text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50 disabled:hover:border-slate-300 flex items-center justify-center gap-2 font-medium"
                >
                  {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <UploadCloud className="w-5 h-5" />}
                  {busy ? '準備中…' : '選擇這次拍攝的所有片段'}
                </button>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1">
                    {/* ⚠️ 兩段都 nowrap：中文沒有詞界，這行在手機上會從「分成幾支素／材就建幾組」
                        中間斷開。寧可讓按鈕自己掉一行，也不要把詞斷掉。 */}
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <p className="text-sm text-slate-700 whitespace-nowrap">
                        已上傳 {files.length} 個片段{totalBytes > 0 && `（${fmtSize(totalBytes)}）`}
                      </p>
                      <button onClick={handleUpload} disabled={busy} className="text-sm text-blue-600 hover:underline disabled:opacity-50 whitespace-nowrap">
                        再加片段
                      </button>
                    </div>
                    <p className="text-sm text-slate-500">分成幾支素材，就建幾組</p>
                  </div>

                  {groups.map((g, gi) => {
                    const items = files.filter(f => assign[f.id] === g.key);
                    return (
                      <div key={g.key} className="border border-slate-200 rounded-xl p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-500 shrink-0">第 {gi + 1} 支</span>
                          <input
                            value={g.name}
                            onChange={e => setGroups(prev => prev.map(x => x.key === g.key ? { ...x, name: e.target.value } : x))}
                            placeholder="素材名稱，例如：超好吃的金磚"
                            className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-base"
                          />
                          {groups.length > 1 && (
                            <button onClick={() => removeGroup(g.key)} className="text-slate-400 hover:text-red-600 shrink-0" aria-label="刪掉這一組">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>

                        {items.length === 0 ? (
                          <p className="text-sm text-slate-400">還沒有片段分到這一組</p>
                        ) : items.map(f => (
                          <div key={f.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-sm text-slate-800 break-all">{f.name}</span>
                              <span className="text-xs text-slate-500 shrink-0 pt-0.5">{fmtSize(f.sizeBytes)}</span>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <input
                                value={notes[f.id] || ''}
                                onChange={e => setNotes(prev => ({ ...prev, [f.id]: e.target.value }))}
                                placeholder="這段要怎麼剪、腳本要改什麼（可不填）"
                                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                              />
                              {/* 只有一組時這個選單沒有任何用處，不要佔位 */}
                              {groups.length > 1 && (
                                <select
                                  value={assign[f.id]}
                                  onChange={e => setAssign(prev => ({ ...prev, [f.id]: e.target.value }))}
                                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white sm:w-48"
                                >
                                  {groups.map((x, i) => (
                                    <option key={x.key} value={x.key}>
                                      第 {i + 1} 支{x.name ? `：${x.name}` : ''}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}

                  <button onClick={addGroup} className="w-full py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600 flex items-center justify-center gap-1.5">
                    <Plus className="w-4 h-4" /> 再多一支素材
                  </button>

                  <p className="text-xs text-amber-700 flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    片段已經在雲端的批次資料夾了，但還沒分組、也還沒建素材。現在關掉，這批就要靠人工整理。
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg">
            {done ? '關閉' : '取消'}
          </button>
          {files.length > 0 && !done && (
            <button
              onClick={handleCommit}
              disabled={busy}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 font-medium"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              建立素材並歸檔
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
