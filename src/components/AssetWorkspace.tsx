import { CalendarDays, ListOrdered, Video } from 'lucide-react';
import { Asset, Vendor } from '../types';
import { useLiveCollection } from '../lib/liveData';
import { stockVisibleVendors } from '../lib/vendorStatus';
import AssetDatabase from './AssetDatabase';
import AirDateBoard from './AirDateBoard';
import EditOrderModal from './EditOrderModal';

/**
 * 素材資料庫＋它的兩個子功能（排上片日、排剪輯順序）。2026-10-20 起。
 *
 * 以前這兩個是「製作進度」頁裡的按鈕，要往下捲才找得到。使用者要它們放在一起、
 * 而且歸在素材資料庫底下：藏鏡人上架完素材，同一頁就能接著排。
 *
 * ⚠️ 子分頁就是 App 的 activeTab（videos／airDate／editOrder），不另存一份 state：
 *    側欄子項、網址 ?tab=airDate、製作進度的按鈕才都能直接跳到同一個地方。
 */
export type AssetWorkspaceTab = 'videos' | 'airDate' | 'editOrder';
export const ASSET_WORKSPACE_TABS: { id: AssetWorkspaceTab; label: string; icon: typeof Video }[] = [
  { id: 'videos', label: '素材列表', icon: Video },
  { id: 'airDate', label: '排上片日', icon: CalendarDays },
  { id: 'editOrder', label: '排剪輯順序', icon: ListOrdered },
];

export default function AssetWorkspace({ tab, setTab }: { tab: AssetWorkspaceTab; setTab: (t: AssetWorkspaceTab) => void }) {
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto">
        {ASSET_WORKSPACE_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap border transition-colors ${tab === t.id
              ? 'bg-[#5A5A40] border-[#5A5A40] text-white'
              : 'bg-white border-black/10 text-gray-600 hover:text-[#5A5A40]'}`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'videos' && <AssetDatabase />}
      {tab === 'airDate' && <AirDateBoard embedded />}
      {/* key：資料第一包到之前 vendors 是空的，元件內預設 IP 會選不到；資料到了重掛一次 */}
      {tab === 'editOrder' && (
        <div key={vendors.length && assets.length ? 'ready' : 'loading'}>
          <EditOrderModal embedded vendors={stockVisibleVendors(vendors)} assets={assets} />
        </div>
      )}
    </div>
  );
}
