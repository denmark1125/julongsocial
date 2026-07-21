import React, { useMemo, useRef, useState } from 'react';
import { Vendor, Asset, Post } from '../types';
import { trackedVendors, getVideoStockAlert, getOwedVideoCount, getAvailableVideoAssets } from '../lib/vendorStatus';
import { format } from 'date-fns';
import { X, Download, Scissors } from 'lucide-react';
import { toJpeg } from 'html-to-image';
import download from 'downloadjs';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';

interface EditReminderExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  vendors: Vendor[];
  assets: Asset[];
  posts: Post[];
}

const UNASSIGNED_EDITOR = '未指定剪輯師';

export default function EditReminderExportModal({ isOpen, onClose, vendors, assets, posts }: EditReminderExportModalProps) {
  const [selectedEditor, setSelectedEditor] = useState<string>('all');
  const exportRef = useRef<HTMLDivElement>(null);

  // 清單即時依當下庫存/週分佈/積欠重新計算，不存快照，確保永遠是最新狀態；
  // 用「有沒有待剪素材(rawStock>0)」判斷要不要上清單，不是看整體severity——
  // 一個廠商可能同時「急需拍片(shoot)」又「有素材躺著沒剪」，這兩件事互不排斥，缺片名單擋不住還要進催剪輯清單
  const editItems = useMemo(() => {
    return trackedVendors(vendors)
      .map(vendor => {
        const vendorVideoAssets = getAvailableVideoAssets(vendor.id!, assets, posts);
        const owed = getOwedVideoCount(vendor, posts, vendorVideoAssets.length);
        const alert = getVideoStockAlert(vendor, vendorVideoAssets, owed);
        return { vendor, alert };
      })
      .filter(item => item.alert.rawStock > 0);
  }, [vendors, assets, posts]);

  const editorNames = useMemo(() => {
    const names = new Set(editItems.map(item => item.vendor.editorName || UNASSIGNED_EDITOR));
    return Array.from(names).sort();
  }, [editItems]);

  const filteredItems = selectedEditor === 'all' ? editItems : editItems.filter(item => (item.vendor.editorName || UNASSIGNED_EDITOR) === selectedEditor);

  const groupedByEditor = useMemo<Record<string, typeof editItems>>(() => {
    const groups: Record<string, typeof editItems> = {};
    filteredItems.forEach(item => {
      const key = item.vendor.editorName || UNASSIGNED_EDITOR;
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    });
    return groups;
  }, [filteredItems]);

  if (!isOpen) return null;

  const handleExport = async () => {
    if (!exportRef.current) return;
    const loadingToast = toast.loading('正在準備導出圖片...');
    try {
      const element = exportRef.current;
      const rect = element.getBoundingClientRect();
      const dataUrl = await toJpeg(element, {
        quality: 1,
        backgroundColor: '#F5F5F0',
        pixelRatio: 3,
        width: rect.width,
        height: rect.height,
        style: { transform: 'scale(1)', transformOrigin: 'top left', margin: '0', padding: '0' },
        filter: (node) => !(node instanceof HTMLElement && node.classList.contains('export-ignore'))
      });
      const editorLabel = selectedEditor === 'all' ? '全部' : selectedEditor;
      const fileName = `催剪輯清單_${editorLabel}_${format(new Date(), 'MMdd')}.jpg`;
      download(dataUrl, fileName);
      toast.success('導出成功', { id: loadingToast });
    } catch (error) {
      console.error('Export failed:', error);
      toast.error('導出失敗', { id: loadingToast });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[90vh] shadow-2xl flex flex-col overflow-hidden">
        <div className="flex justify-between items-center p-6 border-b border-gray-100 export-ignore">
          <h3 className="text-xl font-bold serif flex items-center">
            <Scissors size={22} className="mr-2" /> 導出催剪輯清單
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
            <X size={22} />
          </button>
        </div>

        <div className="px-6 pt-4 pb-2 export-ignore">
          <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">篩選剪輯師</label>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedEditor('all')}
              className={clsx(
                "px-3 py-1.5 rounded-xl text-xs font-bold transition-all border",
                selectedEditor === 'all' ? "bg-[#5A5A40] text-white border-[#5A5A40]" : "bg-white text-gray-400 border-gray-200 hover:border-[#5A5A40]/30"
              )}
            >
              全部（{editItems.length}）
            </button>
            {editorNames.map(name => (
              <button
                key={name}
                onClick={() => setSelectedEditor(name)}
                className={clsx(
                  "px-3 py-1.5 rounded-xl text-xs font-bold transition-all border",
                  selectedEditor === name ? "bg-[#5A5A40] text-white border-[#5A5A40]" : "bg-white text-gray-400 border-gray-200 hover:border-[#5A5A40]/30"
                )}
              >
                {name}（{editItems.filter(i => (i.vendor.editorName || UNASSIGNED_EDITOR) === name).length}）
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 sm:p-6 bg-gray-100">
          <div ref={exportRef} className="bg-[#F5F5F0] p-6 sm:p-8">
            <div className="bg-[#F5F5F0] w-full max-w-[700px] mx-auto">
              <div className="p-10 bg-[#5A5A40] text-white">
                <div className="flex justify-between items-end">
                  <div>
                    <h1 className="text-4xl font-black tracking-tighter mb-2">催剪輯清單</h1>
                    <p className="text-lg opacity-80 font-medium tracking-wide">
                      {selectedEditor === 'all' ? '全部剪輯師' : selectedEditor}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs opacity-60 uppercase tracking-widest mb-1">Snapshot</p>
                    <p className="text-xl font-bold">{format(new Date(), 'yyyy/MM/dd')}</p>
                  </div>
                </div>
              </div>

              <div className="p-10">
                {Object.keys(groupedByEditor).length > 0 ? (
                  Object.keys(groupedByEditor).map((editorName) => {
                    const items = groupedByEditor[editorName];
                    return (
                    <div key={editorName} className="mb-8 last:mb-0">
                      <h2 className="text-sm font-black text-[#5A5A40] uppercase tracking-widest mb-3 pb-2 border-b-2 border-[#5A5A40]/20">
                        剪輯師：{editorName}
                      </h2>
                      <div className="space-y-3">
                        {items.map(({ vendor, alert }) => (
                          <div key={vendor.id} className="flex items-center justify-between py-2">
                            <span className="text-base font-bold text-[#5A5A40]">{vendor.name}</span>
                            <span className="text-sm text-gray-600">
                              待剪 <span className="font-bold text-amber-600">{alert.rawStock}</span> 部
                              {alert.finishedRunwayDays !== null && (
                                <>・成片僅夠撐 <span className="font-bold text-red-600">{Math.max(0, Math.floor(alert.finishedRunwayDays))}</span> 天</>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    );
                  })
                ) : (
                  <p className="text-center text-gray-400 py-12">目前沒有需要催剪輯的項目</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-gray-100 export-ignore">
          <button
            onClick={handleExport}
            disabled={filteredItems.length === 0}
            className="w-full bg-[#5A5A40] text-white py-3 rounded-xl font-bold shadow-lg hover:bg-[#4a4a35] transition-all flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={18} className="mr-2" /> 匯出成 JPG
          </button>
        </div>
      </div>
    </div>
  );
}
