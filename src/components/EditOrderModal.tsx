import { useMemo, useState } from 'react';
import { doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { Asset, Vendor, deriveFlowStage } from '../types';
import { compareRawEditOrder, moveInList } from '../lib/editOrder';
import toast from 'react-hot-toast';
import { X, Loader2, CheckCircle2, ListOrdered, Flame, ChevronUp, ChevronDown } from 'lucide-react';

/**
 * 排剪輯順序：同一個 IP 的待剪片誰先剪。
 *
 * 順序＝配上片日的順序（第 1 支配這個 IP 最近的上片日，見 editorQueue 的 rawOrder），
 * 剪輯師看到的交片期限會跟著變。上片／歸片時排的是同一批之內，這裡可以跨批調，新片也能插到舊片前面。
 *
 * ⚠️ 急件永遠最先剪（compareRawEditOrder 的第一條），在這裡固定在最上面、不能往下移，
 *    要讓它排後面請先取消急件。不然畫面上排的跟剪輯師看到的會對不起來。
 * ⚠️ 儲存時整個 IP 的待剪片一起寫成 1…n：只寫動過的那幾支，會跟沒寫過的片比出跟畫面不一樣的順序。
 */
export default function EditOrderModal({
  vendors, assets, defaultVendorId, onClose,
}: {
  vendors: Vendor[];
  assets: Asset[];
  defaultVendorId?: string;
  onClose: () => void;
}) {
  const isPending = (a: Asset) =>
    a.type === 'video' && !a.voidedAt && a.status !== 'archived' &&
    (deriveFlowStage(a) === 'to_edit' || deriveFlowStage(a) === 'revising');

  const pendingByVendor = useMemo(() => {
    const m = new Map<string, Asset[]>();
    assets.filter(isPending).forEach(a => m.set(a.vendorId, [...(m.get(a.vendorId) || []), a]));
    m.forEach(list => list.sort(compareRawEditOrder));
    return m;
  }, [assets]);

  const vendorOptions = vendors.filter(v => pendingByVendor.has(v.id!));
  const [vendorId, setVendorId] = useState(
    defaultVendorId && pendingByVendor.has(defaultVendorId) ? defaultVendorId : vendorOptions[0]?.id || '',
  );
  /** vendorId → 畫面上調過的順序（assetId）。沒調過的 IP 照目前的順序 */
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const current = pendingByVendor.get(vendorId) || [];
  const ids = orders[vendorId] || current.map(a => a.id!);
  const list = ids.map(id => current.find(a => a.id === id)).filter((a): a is Asset => Boolean(a));
  const urgentCount = list.filter(a => a.isUrgent).length;
  const changed = Object.keys(orders).length > 0;

  const move = (index: number, delta: -1 | 1) =>
    setOrders(prev => ({ ...prev, [vendorId]: moveInList(ids, index, delta) }));

  const handleSave = async () => {
    setBusy(true);
    try {
      const batch = writeBatch(db);
      (Object.entries(orders) as [string, string[]][]).forEach(([vid, order]) => {
        const pending = new Set((pendingByVendor.get(vid) || []).map(a => a.id));
        order.filter(id => pending.has(id)).forEach((id, i) => {
          batch.update(doc(db, 'assets', id), { editOrder: i + 1 });
        });
      });
      await batch.commit();
      toast.success('剪輯順序已更新');
      onClose();
    } catch (e: any) {
      toast.error(e?.message || '儲存失敗');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <ListOrdered className="w-5 h-5 text-[#5A5A40]" />
            排剪輯順序
          </h3>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-4 space-y-3">
          <div className="text-sm text-slate-600 leading-relaxed">
            <p>1 最先剪，會配到這個 IP 最近的上片日，剪輯師看到的交片期限跟著這個順序。</p>
            <p>急件永遠最先剪，要排後面請先取消急件。</p>
          </div>
          {vendorOptions.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {vendorOptions.map(v => (
                <button
                  key={v.id}
                  onClick={() => setVendorId(v.id!)}
                  className={vendorId === v.id
                    ? 'px-3 py-1 rounded-full text-[13px] font-bold bg-[#5A5A40] text-white whitespace-nowrap'
                    : 'px-3 py-1 rounded-full text-[13px] font-bold bg-white border border-black/10 text-gray-500 hover:text-[#5A5A40] whitespace-nowrap'}
                >
                  {v.name}（{pendingByVendor.get(v.id!)?.length}）
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 overflow-y-auto space-y-2">
          {list.length === 0 ? (
            <p className="text-center text-slate-400 py-12">目前沒有待剪的片。</p>
          ) : list.map((a, i) => (
            <div key={a.id} className="flex items-center gap-3 bg-slate-50 rounded-lg px-3 py-2.5">
              <span className="shrink-0 w-7 h-7 rounded-full bg-[#5A5A40] text-white text-[13px] font-bold flex items-center justify-center">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 truncate">{a.title}</p>
                <p className="text-[13px] text-slate-500 whitespace-nowrap">
                  {a.filmingDate ? `${a.filmingDate.slice(5).replace('-', '/')} 拍攝` : ''}
                  {deriveFlowStage(a) === 'revising' && '・退回重剪'}
                </p>
              </div>
              {a.isUrgent ? (
                <span className="inline-flex items-center gap-1 text-[13px] font-bold text-red-600 whitespace-nowrap shrink-0">
                  <Flame className="w-3.5 h-3.5" /> 急件
                </span>
              ) : (
                <span className="flex items-center shrink-0">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={busy || i <= urgentCount}
                    className="p-1.5 text-slate-500 hover:text-[#5A5A40] disabled:opacity-25"
                    aria-label="往前"
                  >
                    <ChevronUp className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={busy || i === list.length - 1}
                    className="p-1.5 text-slate-500 hover:text-[#5A5A40] disabled:opacity-25"
                    aria-label="往後"
                  >
                    <ChevronDown className="w-5 h-5" />
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-40">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={busy || !changed}
            className="px-5 py-2 bg-[#5A5A40] text-white rounded-lg hover:bg-[#4a4a35] disabled:opacity-50 flex items-center gap-2 font-medium"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            儲存順序
          </button>
        </div>
      </div>
    </div>
  );
}
