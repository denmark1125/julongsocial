import React, { useMemo, useState } from 'react';
import { auth } from '../firebase';
import { Vendor, Editor } from '../types';
import { visibleVendors } from '../lib/vendorStatus';
import { ASSET_CATEGORIES, ASSET_CATEGORY_DATALIST_ID } from '../lib/assetCategories';
import { BROLL_FOLDER_NAME } from '../lib/driveNaming';
import BrollLibraryUpload from './BrollLibraryUpload';
import {
  openUploadPicker, openFolderPicker, getPickerApiKey, PickedFile,
} from '../lib/drivePicker';
import {
  X, UploadCloud, FolderOpen, Loader2, CheckCircle2, AlertTriangle, Plus, Trash2, FilePlus2,
} from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * 毛片上傳：一次拍攝帶回來的片段，分成幾支素材各自歸檔。
 *
 * 流程跟同事現在手動在 Drive 做的事一模一樣：
 *   選 IP → 拍攝日（自動帶出日期資料夾）→ 幫這支素材取名字 → 選它的片段 → 再多一支…
 *   → 最後一次建立所有素材
 *
 * ⚠️ **名字一定要打在選檔案之前。** 相機檔名（C0031.MP4、DJI_0104.MOV）不帶任何資訊，
 *    如果先把整批傳上去再回來分組，畫面上只剩一排看不懂的名字，沒有人分得出哪幾支
 *    屬於哪一支素材。**選檔案的那一刻是唯一知道分組的時刻**，離開就沒了。
 *
 * ⚠️ 資料夾結構是**你們既有的**，不是系統自己造的：
 *      自媒體IP代操/{IP}/剪輯/2026／0131/超好吃的金磚/
 *    中間那層每個 IP 都不一樣（剪輯／剪輯_謝／2 剪輯／毛片區），所以根資料夾
 *    一定要由人用 Picker 指一次（授權範圍是 drive.file，猜名字一定 404）。
 */

interface Props {
  vendors: Vendor[];
  editors: Editor[];
  onClose: () => void;
  /** engineer / manager 才能指定 IP 的毛片根資料夾 */
  canSetFolder: boolean;
  /** 預帶的 IP（從拍攝進度那邊開啟時用） */
  defaultVendorId?: string;
  /** 預帶的拍攝日 */
  defaultShotAt?: string;
}

interface Group {
  key: string;
  name: string;
  /** 建好之後才有。有值就代表資料夾已經在 Drive 上了，名字不能再改 */
  folderId?: string;
  path?: string;
  files: PickedFile[];
  /** 素材分類。跟建檔畫面一樣是建議值不是列舉，可以自由輸入 */
  category: string;
  /** 這支片整體怎麼剪。剪輯師的卡片上會看到這段 */
  brief: string;
  /** 補充畫面，放在這支素材資料夾底下的 B-roll 子資料夾。不會另外變成一支素材 */
  brollFiles: PickedFile[];
  /**
   * 逐支指派的剪輯師。空字串＝跟著這個 IP 的負責剪輯師走（跟人工建檔的預設一致）。
   * ⚠️ 不要偷偷把 IP 的剪輯師複製進來：那會凍結指派，之後 IP 換人這支片不會跟著換。
   */
  editorId: string;
  /** 內部自己剪，不派給外包。跟 editorId 是互斥的兩種狀態 */
  internalEdit: boolean;
}

const fmtSize = (bytes: number) => {
  if (!bytes) return '';
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
};

/** 跟後端的 defaultBatchName 同一套寫法（半形斜線），兩邊要一致否則會建出兩個資料夾 */
const defaultBatchName = (shotAt: string) => {
  const [y, m, d] = shotAt.split('-');
  return y && m && d ? `${y}/${m}${d}` : '';
};

// 一次拍攝多半是同一個題材，所以新的一組沿用上一組的分類，少打幾次
/** 下拉選單裡代表「內部剪輯」的值。不是真的 editorId，送出前會轉成 internalEdit 旗標 */
const INTERNAL = '__internal__';

const newGroup = (category = ''): Group => ({
  key: `g${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  name: '', files: [], brollFiles: [], category, brief: '', editorId: '', internalEdit: false,
});

export default function RawFootageUpload({
  vendors, editors, onClose, canSetFolder, defaultVendorId, defaultShotAt,
}: Props) {
  const today = new Date().toISOString().split('T')[0];
  const [vendorId, setVendorId] = useState(defaultVendorId || '');
  const [shotAt, setShotAt] = useState(defaultShotAt || today);
  const [batchName, setBatchName] = useState(defaultBatchName(defaultShotAt || today));
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [freeGB, setFreeGB] = useState<number | null>(null);
  const [groups, setGroups] = useState<Group[]>([newGroup()]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ created: any[]; failed: any[] } | null>(null);
  // 毛片 vs 這個 IP 共用的 B-roll 素材庫。**兩者是不同的事**（這支片的補充畫面
  // vs 跨場次累積的公用素材），不是同一件事的兩種做法，所以用分頁而不是設定開關。
  const [mode, setMode] = useState<'raw' | 'library'>('raw');
  // 共用 B-roll 分頁把送出狀態回報上來，讓按鈕跟毛片分頁一樣待在 footer
  const [libSubmit, setLibSubmit] = useState<{ canSubmit: boolean; busy: boolean; submit: () => void } | null>(null);

  const options = useMemo(
    () => visibleVendors(vendors).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
    [vendors]
  );
  const vendor = vendors.find(v => v.id === vendorId);
  const folderReady = Boolean(vendor?.rawFootageFolderId);

  // 只要有任何一組已經建了資料夾，上面那三個欄位就不能再動 —— 改了路徑就對不上了
  const lockHeader = groups.some(g => g.folderId);
  const uploadedCount = groups.reduce((n, g) => n + g.files.length + g.brollFiles.length, 0);

  const patch = (key: string, next: Partial<Group>) =>
    setGroups(prev => prev.map(g => (g.key === key ? { ...g, ...next } : g)));

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
      // 這一步發生在「還沒有資料夾」的時候，所以不能走 group-folder（會被 409 擋住），
      // 要用一支不需要資料夾就能拿 token 的路由，否則是雞生蛋的死結。
      const cred = await callApi('/api/drive/picker-auth', {});
      const picked = await openFolderPicker({
        accessToken: cred.accessToken,
        apiKey: getPickerApiKey(),
        appId: cred.appId,
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

  /**
   * 某一支素材：建好它的資料夾，然後開 Picker 把片段直接傳進去。
   * `sub='broll'` 時目標是該素材底下的 B-roll 子資料夾。
   */
  const handlePickFiles = async (g: Group, sub?: 'broll') => {
    if (!g.name.trim()) { toast.error('請先幫這支素材取名字'); return; }
    setBusyKey(g.key + (sub || ''));
    try {
      // 每次都重新要一次：這支路由是冪等的（資料夾已存在就直接沿用），
      // 而且順便拿到沒過期的 token 與最新容量。「再加片段」也走同一條路。
      const cred = await callApi('/api/drive/group-folder', {
        vendorId, shotAt,
        // ⚠️ 一律送字串。空字串在後端代表「不要日期資料夾」，
        //    跟「沒帶這個欄位＝用預設日期名」是兩件事，不能用 || undefined 吃掉。
        batchName,
        groupName: g.name.trim(),
        sub,
      });

      if (cred.freeGB !== undefined) setFreeGB(cred.freeGB);
      // ⚠️ 只有主片段那次才記 folderId／path：B-roll 回的是子資料夾，
      //    記進去的話畫面會顯示成「這支素材建在 …/B-roll」，而且提交時會送錯 id。
      if (!sub) patch(g.key, { folderId: cred.groupFolderId, path: cred.path });

      const picked = await openUploadPicker({
        folderId: cred.groupFolderId,
        accessToken: cred.accessToken,
        apiKey: getPickerApiKey(),
        appId: cred.appId,
        multiple: true,
        title: `上傳到 ${cred.path}`,
      });

      // 空陣列＝使用者自己取消，不是錯誤，不要跳紅字
      if (picked.length === 0) return;
      setGroups(prev => prev.map(x => {
        if (x.key !== g.key) return x;
        const list = sub ? x.brollFiles : x.files;
        const fresh = picked.filter(f => !list.some(o => o.id === f.id));
        return sub
          ? { ...x, brollFiles: [...x.brollFiles, ...fresh] }
          : { ...x, files: [...x.files, ...fresh] };
      }));
    } catch (e: any) {
      if (e?.code === 'VENDOR_FOLDER_UNSET') {
        toast.error(e.message + (canSetFolder ? '請先按上面的「指定資料夾」。' : '請找工程師指定。'));
      } else {
        toast.error(e?.message || '上傳失敗');
      }
    } finally {
      setBusyKey(null);
    }
  };

  const removeGroup = (key: string) => {
    setGroups(prev => (prev.length === 1
      ? [newGroup(prev[0].category)]
      : prev.filter(g => g.key !== key)));
  };

  const handleCommit = async () => {
    // ⚠️ 只有 B-roll 沒有主片段的組不送：B-roll 是補充畫面，
    //    沒有主片段的話會建出一支空殼素材。
    const used = groups.filter(g => g.folderId && g.files.length > 0);
    const brollOnly = groups.filter(g => g.files.length === 0 && g.brollFiles.length > 0);
    if (brollOnly.length) {
      toast.error(`「${brollOnly[0].name || '未命名'}」只有 B-roll 沒有主片段，請先選主片段`);
      return;
    }
    if (used.length === 0) { toast.error('至少要有一支素材傳了片段'); return; }

    setBusy(true);
    try {
      const data = await callApi('/api/drive/commit-groups', {
        vendorId, shotAt,
        groups: used.map(g => ({
          name: g.name.trim(),
          groupFolderId: g.folderId,
          category: g.category,
          brief: g.brief,
          editorId: g.editorId,
          internalEdit: g.internalEdit,
          files: g.files.map(f => ({ driveFileId: f.id, note: notes[f.id] || '' })),
          brollFiles: g.brollFiles.map(f => ({ driveFileId: f.id, note: notes[f.id] || '' })),
        })),
      });
      setDone(data);
      if (data.failed?.length) {
        toast.error(`${data.created?.length || 0} 支建好了，${data.failed.length} 支失敗`);
      } else {
        toast.success(`已建立 ${data.created?.length || 0} 支素材`);
      }
    } catch (e: any) {
      toast.error(e?.message || '建立素材失敗');
    } finally {
      setBusy(false);
    }
  };

  const pathHint = () => {
    const root = vendor?.rawFootageFolderName || '';
    // ⚠️ 用 › 當分隔而不是斜線：批次資料夾名稱本身現在可能含半形斜線（2026/0924），
    //    兩種斜線混在一起看不出哪個是分隔、哪個是名稱的一部分。
    return [root, batchName, '素材名稱'].filter(Boolean).join(' › ');
  };

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

        <datalist id={ASSET_CATEGORY_DATALIST_ID}>
          {ASSET_CATEGORIES.map(c => <option key={c} value={c} />)}
        </datalist>

        <div className="px-6 pt-3 border-b border-slate-200 flex gap-1">
          {([['raw', '毛片'], ['library', `共用 ${BROLL_FOLDER_NAME}`]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              // 已經傳了東西還切分頁會讓人以為那批不見了，所以傳過就鎖住
              disabled={uploadedCount > 0 || Boolean(done)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px disabled:opacity-40 ${
                mode === key
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="px-6 py-5 overflow-y-auto space-y-5">
          {mode === 'library' ? (
            <BrollLibraryUpload vendors={vendors} defaultVendorId={vendorId} onSubmitStateChange={setLibSubmit} />
          ) : done ? (
            <div className="space-y-3">
              <p className="text-base font-medium text-slate-800 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                已建立 {done.created.length} 支素材
              </p>
              <ul className="text-sm text-slate-700 space-y-1">
                {done.created.map((c: any) => (
                  <li key={c.assetId}>・{c.name}（{c.fileCount} 個片段{c.brollCount ? `，${c.brollCount} 個 B-roll` : ''}）</li>
                ))}
              </ul>
              {done.failed.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  <p className="font-medium mb-1">這幾支沒有成功，檔案還在雲端資料夾裡：</p>
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
                    onChange={e => setVendorId(e.target.value)}
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
                    onChange={e => { setShotAt(e.target.value); setBatchName(defaultBatchName(e.target.value)); }}
                    disabled={lockHeader}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base disabled:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">批次資料夾</label>
                  <input
                    value={batchName}
                    onChange={e => setBatchName(e.target.value)}
                    disabled={lockHeader}
                    placeholder="留空＝不分批次"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base disabled:bg-slate-100"
                  />
                  {/* 不一定是日期：彭彭是「01毛片備份」、佐禾是產品系列名 */}
                  <p className="text-xs text-slate-500 mt-1">預設拍攝日，可以改成自己的名稱</p>
                </div>
              </div>

              {vendorId && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                  <span className="flex items-center gap-1.5 text-slate-700">
                    <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                    {folderReady
                      ? <span>會建在 <span className="font-medium">{pathHint()}</span></span>
                      : <span className="text-amber-700">這個 IP 還沒指定毛片資料夾</span>}
                  </span>
                  <span className="flex items-center gap-3">
                    {freeGB !== null && (
                      <span className={freeGB < 200 ? 'text-red-600 font-medium whitespace-nowrap' : 'text-slate-500 whitespace-nowrap'}>
                        雲端剩餘 {freeGB} GB
                      </span>
                    )}
                    {!lockHeader && canSetFolder && (
                      <button onClick={handlePickFolder} disabled={busy} className="text-blue-600 hover:underline disabled:opacity-50 whitespace-nowrap">
                        {folderReady ? '換一個資料夾' : '指定資料夾'}
                      </button>
                    )}
                  </span>
                </div>
              )}

              <div className="space-y-3">
                {groups.map((g, gi) => {
                  const locked = Boolean(g.folderId);
                  const thisBusy = busyKey === g.key;
                  const brollBusy = busyKey === g.key + 'broll';
                  return (
                    <div key={g.key} className="border border-slate-200 rounded-xl p-4 space-y-3">
                      {/* ⚠️ 手機上名稱欄會被按鈕擠成「荔妃的命」。給輸入框一個最小寬度，
                          寬度不夠時讓按鈕自己換到下一行，而不是壓縮輸入框。 */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-slate-500 shrink-0 whitespace-nowrap">第 {gi + 1} 支</span>
                        <input
                          value={g.name}
                          onChange={e => patch(g.key, { name: e.target.value })}
                          // ⚠️ 資料夾建了就不能改名：改了畫面叫 A、Drive 叫 B，之後對不回來。
                          //    要改只能把整組刪掉重來。
                          disabled={locked}
                          placeholder="素材名稱，例如：超好吃的金磚"
                          className="flex-1 min-w-[12rem] px-3 py-2 border border-slate-300 rounded-lg text-base disabled:bg-slate-100 disabled:text-slate-600"
                        />
                        <button
                          onClick={() => handlePickFiles(g)}
                          disabled={!g.name.trim() || !folderReady || thisBusy}
                          className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                        >
                          {thisBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FilePlus2 className="w-4 h-4" />}
                          {g.files.length > 0 ? '再加片段' : '選檔案'}
                        </button>
                        {/* 次要樣式：B-roll 是補充，不要跟主片段搶視覺 */}
                        <button
                          onClick={() => handlePickFiles(g, 'broll')}
                          disabled={!g.name.trim() || !folderReady || brollBusy}
                          className="px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-sm hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                        >
                          {brollBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                          {BROLL_FOLDER_NAME}
                        </button>
                        {(groups.length > 1 || g.files.length > 0) && (
                          <button onClick={() => removeGroup(g.key)} className="text-slate-400 hover:text-red-600 shrink-0" aria-label="刪掉這一支">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      {locked && (
                        <p className="text-xs text-slate-500">
                          已建資料夾 {g.path}
                          {g.files.length === 0 && '（還沒傳片段）'}
                        </p>
                      )}

                      <div className="flex flex-wrap items-start gap-3">
                        <div className="w-full sm:w-44">
                          <label className="block text-xs font-medium text-slate-600 mb-1">分類</label>
                          {/* 跟建檔畫面同一套：可以選也可以自己打，不要改成 select */}
                          <input
                            value={g.category}
                            onChange={e => patch(g.key, { category: e.target.value })}
                            list={ASSET_CATEGORY_DATALIST_ID}
                            placeholder="輸入或選擇"
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                          />
                        </div>
                        <div className="w-full sm:w-52">
                          <label className="block text-xs font-medium text-slate-600 mb-1">剪輯師</label>
                          <select
                            value={g.internalEdit ? INTERNAL : g.editorId}
                            onChange={e => patch(g.key, e.target.value === INTERNAL
                              ? { internalEdit: true, editorId: '' }
                              : { internalEdit: false, editorId: e.target.value })}
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                          >
                            <option value="">
                              跟著 IP（{vendor?.editorName || '未設定'}）
                            </option>
                            <option value={INTERNAL}>內部剪輯（不派給外包）</option>
                            {editors.map(ed => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
                          </select>
                          {!g.internalEdit && !g.editorId && !vendor?.editorId && (
                            // 三個都空＝這支片不會出現在任何人的待辦裡，現在就要講
                            <p className="text-xs text-amber-700 mt-1">
                              這個 IP 沒有負責剪輯師，不指定的話沒有人會看到這支片
                            </p>
                          )}
                        </div>
                        <div className="flex-1 min-w-[14rem]">
                          <label className="block text-xs font-medium text-slate-600 mb-1">剪輯需求（整支片的方向）</label>
                          <textarea
                            value={g.brief}
                            onChange={e => patch(g.key, { brief: e.target.value })}
                            rows={2}
                            placeholder="例如：針對中秋檔期，顏色要黃色調"
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                          />
                        </div>
                      </div>

                      {g.files.map(f => (
                        <div key={f.id} className="bg-slate-50 rounded-lg p-3 space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <span className="text-sm text-slate-800 break-all">{f.name}</span>
                            <span className="text-xs text-slate-500 shrink-0 pt-0.5">{fmtSize(f.sizeBytes)}</span>
                          </div>
                          <input
                            value={notes[f.id] || ''}
                            onChange={e => setNotes(prev => ({ ...prev, [f.id]: e.target.value }))}
                            placeholder="這段是什麼（例如：大口吃、浮誇）"
                            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                          />
                        </div>
                      ))}

                      {g.brollFiles.length > 0 && (
                        <div className="border-t border-dashed border-slate-200 pt-3 space-y-2">
                          <p className="text-xs font-medium text-slate-500">{BROLL_FOLDER_NAME}（補充畫面，不會另外變成一支素材）</p>
                          {g.brollFiles.map(f => (
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
                        </div>
                      )}
                    </div>
                  );
                })}

                <button
                  onClick={() => setGroups(prev => [...prev, newGroup(prev[prev.length - 1]?.category || '')])}
                  className="w-full py-2 border border-dashed border-slate-300 rounded-lg text-sm text-slate-600 hover:border-blue-400 hover:text-blue-600 flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> 再多一支素材
                </button>
              </div>

              {uploadedCount > 0 && (
                <p className="text-xs text-amber-700 flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  片段已經傳到雲端了，但還沒建成素材。現在關掉，這批就只存在於 Drive、系統裡查不到。
                </p>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg">
            {done ? '關閉' : '取消'}
          </button>
          {mode === 'library' && libSubmit?.canSubmit && (
            <button
              onClick={libSubmit.submit}
              disabled={libSubmit.busy}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 font-medium"
            >
              {libSubmit.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              登記檔案
            </button>
          )}
          {mode === 'raw' && uploadedCount > 0 && !done && (
            <button
              onClick={handleCommit}
              disabled={busy}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 font-medium"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              建立素材
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
