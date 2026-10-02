import { useMemo, useState } from 'react';
import { Vendor, Editor } from '../types';
import { auth } from '../firebase';
import { openMultiFolderPicker, getPickerApiKey } from '../lib/drivePicker';
import { visibleVendors } from '../lib/vendorStatus';
import { ASSET_CATEGORIES, ASSET_CATEGORY_DATALIST_ID } from '../lib/assetCategories';
import toast from 'react-hot-toast';
import { X, Loader2, CheckCircle2, FolderOpen, Trash2 } from 'lucide-react';

/** 下拉選單裡代表「內部剪輯」的值。不是真的 editorId，送出前轉成 internalEdit 旗標（同 RawFootageUpload） */
const INTERNAL = '__internal__';

/**
 * 從雲端認領：同事已經在 Drive（多半是本機的 Drive 桌面版）建好資料夾、丟好影片，
 * 回系統勾選一次，一個資料夾變成一支素材。
 *
 * 為什麼主路徑是這個而不是「先在系統建檔」：同事的習慣是先在雲端把東西弄好就走人，
 * 要他們先回系統拿資料夾等於多一道手續，第一週就因此棄坑。
 * 認領取代的是「在素材資料庫一支一支人工建檔」，不是多出來的一步。
 *
 * ⚠️ 分類／剪輯師是**整批共用**：一次拍攝多半同一個人剪、同一個題材。
 *    要逐支不同的，認領完在素材卡上改就好，不要為了這個把這一頁變成填表地獄。
 */
export default function ClaimFoldersModal({
  vendors, editors, onClose, canSetFolder, defaultVendorId, defaultShotAt,
}: {
  vendors: Vendor[];
  editors: Editor[];
  onClose: () => void;
  /** 只有工程師/主管能指定 IP 的毛片根目錄；這裡只拿來決定提示怎麼寫 */
  canSetFolder?: boolean;
  defaultVendorId?: string;
  defaultShotAt?: string;
}) {
  const today = new Date().toISOString().split('T')[0];
  const [vendorId, setVendorId] = useState(defaultVendorId || '');
  const [shotAt, setShotAt] = useState(defaultShotAt || today);
  const [category, setCategory] = useState('');
  const [editorChoice, setEditorChoice] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ created: any[]; skipped: any[]; failed: any[] } | null>(null);

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
    if (!res.ok) throw new Error(data?.message || data?.error || `伺服器回 ${res.status}`);
    return data;
  };

  const handlePick = async () => {
    if (!vendorId) { toast.error('請先選 IP'); return; }
    setBusy(true);
    try {
      const cred = await callApi('/api/drive/picker-auth', {});
      const folders = await openMultiFolderPicker({
        accessToken: cred.accessToken,
        apiKey: getPickerApiKey(),
        appId: cred.appId,
        // 起點＝這個 IP 的毛片資料夾。沒有它的話 Google 會列出整個雲端硬碟所有資料夾
        // 的平面清單（實測一團亂，根本挑不到），所以上面按鈕在沒設定時是鎖住的。
        parentFolderId: vendor?.rawFootageFolderId,
        title: `勾選「${vendor?.name || ''}」這次拍攝的素材資料夾（可多選）`,
      });
      // 空陣列＝自己取消，不是錯誤
      if (folders.length === 0) return;
      setPicked(prev => {
        const fresh = folders.filter(f => !prev.some(o => o.id === f.id));
        return [...prev, ...fresh];
      });
    } catch (e: any) {
      toast.error(e?.message || '開啟資料夾視窗失敗');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      const data = await callApi('/api/drive/claim-folders', {
        vendorId, shotAt, category,
        editorId: editorChoice === INTERNAL ? '' : editorChoice,
        internalEdit: editorChoice === INTERNAL,
        folders: picked,
      });
      setDone(data);
      if (data.failed?.length) {
        toast.error(`${data.created.length} 支建好了，${data.failed.length} 支失敗`);
      } else {
        toast.success(`已建立 ${data.created.length} 支素材`);
      }
    } catch (e: any) {
      toast.error(e?.message || '認領失敗');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-blue-600" />
            從雲端認領
          </h3>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        <datalist id={ASSET_CATEGORY_DATALIST_ID}>
          {ASSET_CATEGORIES.map(c => <option key={c} value={c} />)}
        </datalist>

        <div className="px-6 py-5 overflow-y-auto space-y-5">
          {done ? (
            <div className="space-y-3">
              <p className="text-base font-medium text-slate-800 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                已建立 {done.created.length} 支素材
              </p>
              <ul className="text-sm text-slate-700 space-y-1">
                {done.created.map((c: any) => <li key={c.assetId}>・{c.name}</li>)}
              </ul>
              {done.skipped.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  <p className="font-medium mb-1">這幾個跳過了（之前已經認領過）：</p>
                  <ul className="space-y-1">
                    {done.skipped.map((f: any, i: number) => <li key={i}>・{f.name}</li>)}
                  </ul>
                </div>
              )}
              {done.failed.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  <p className="font-medium mb-1">這幾個沒有成功：</p>
                  <ul className="space-y-1">
                    {done.failed.map((f: any, i: number) => <li key={i}>・{f.name}：{f.reason}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="text-sm text-slate-600 leading-relaxed space-y-0.5">
                <p>影片照舊丟在雲端或本機的 Drive 資料夾。</p>
                <p>這裡只是把<span className="font-medium text-slate-800">那幾個資料夾勾起來</span>，一個資料夾變成一支素材。</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">IP</label>
                  <select
                    value={vendorId}
                    onChange={e => setVendorId(e.target.value)}
                    disabled={picked.length > 0}
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
                    onChange={e => setShotAt(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">分類（這批共用）</label>
                  <input
                    list={ASSET_CATEGORY_DATALIST_ID}
                    value={category}
                    onChange={e => setCategory(e.target.value)}
                    placeholder="輸入或選擇"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">剪輯師（這批共用）</label>
                  <select
                    value={editorChoice}
                    onChange={e => setEditorChoice(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-base"
                  >
                    <option value="">跟著 IP{vendor?.editorId ? `（${editors.find(x => x.id === vendor.editorId)?.name || '未指定'}）` : ''}</option>
                    {editors.map(ed => <option key={ed.id} value={ed.id}>{ed.name}</option>)}
                    <option value={INTERNAL}>內部剪輯（不給外包）</option>
                  </select>
                </div>
              </div>

              {vendorId && !folderReady && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1">
                  {/* 分成兩個 <p>：寫成一整段時 JSX 的換行會變成多餘空白，中間會裂開一格 */}
                  <p>「{vendor?.name}」還沒指定毛片資料夾，所以不知道要從雲端的哪一層開始看。</p>
                  <p>
                    請先到「上傳毛片」按<span className="font-medium">「指定資料夾」</span>設一次
                    {canSetFolder ? '，之後就不用再設。' : '（要請工程師或主管設）。'}
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={handlePick}
                disabled={busy || !vendorId || !folderReady}
                className="w-full px-4 py-3 border border-dashed border-slate-300 rounded-lg text-sm text-slate-600 hover:border-blue-400 hover:text-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                {picked.length > 0 ? '再勾一些資料夾' : '選資料夾（可多選）'}
              </button>
              {folderReady && (
                <p className="-mt-3 text-xs text-slate-500">
                  會停在「{vendor?.rawFootageFolderName || '這個 IP 的毛片資料夾'}」底下，點進批次夾就是這次拍的。
                </p>
              )}

              {picked.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-slate-700">會建立這 {picked.length} 支素材：</p>
                  {picked.map(f => (
                    <div key={f.id} className="flex items-center justify-between gap-3 bg-slate-50 rounded-lg px-3 py-2">
                      <span className="text-sm text-slate-800 break-all">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setPicked(prev => prev.filter(x => x.id !== f.id))}
                        className="text-slate-400 hover:text-red-500 shrink-0"
                        aria-label="移除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  <p className="text-xs text-slate-500">資料夾名稱就是素材名稱，認領完可在素材卡改。</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-40">
            {done ? '關閉' : '取消'}
          </button>
          {!done && (
            <button
              onClick={handleSubmit}
              disabled={busy || picked.length === 0}
              className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 font-medium"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              建立 {picked.length} 支素材
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
