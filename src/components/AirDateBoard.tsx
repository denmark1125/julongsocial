import { useMemo, useState, type DragEvent } from 'react';
import { addDays, differenceInCalendarDays, format, isSameDay, parseISO, startOfDay } from 'date-fns';
import { deleteField, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Asset, DismissedHabit, PlannedSlotMove, Post, Vendor, deriveFlowStage } from '../types';
import { useLiveCollection } from '../lib/liveData';
import { stockVisibleVendors, trackedVendors } from '../lib/vendorStatus';
import { listPlannedSlots } from '../lib/plannedSlots';
import { buildHorizonDemands, SUPPLY_HORIZON_DAYS } from '../lib/materialSupply';
import { buildEditorQueue, deliveryDeadline, EDIT_LEAD_DAYS, EditorQueueRow } from '../lib/editorQueue';
import { compareRawEditOrder, rankByVendor } from '../lib/editOrder';
import { isClosedOutsideSystem } from '../lib/assetFlow';
import toast from 'react-hot-toast';
import { CalendarDays, Flame, X } from 'lucide-react';

/**
 * 排上片日：上面是還沒排上片日的毛片，拖到下面那個 IP 的某一天＝這支預計那天上。
 *
 * 2026-10-20 主管定案，取代「排接下來要上的片」（AirPlanModal 的下拉配對）：
 * 原本系統自動把每支毛片配到 IP 的發片日，剪輯師畫面變成每支都有很近的期限、全部都要剪。
 * 現在**上片日由同事決定**，剪輯師的交片期限＝上片日往前 EDIT_LEAD_DAYS 天。
 *
 * ⚠️ 寫的就是 `asset.plannedAirDate`，剪輯師清單（buildEditorQueue）只認這個欄位。
 * ⚠️ 格子裡虛線的片＝那天沒人排，系統先拿這個 IP 剪輯順序第 1 支遞補（跟剪輯師看到的同一份結果）。
 *    把它拖到任何一天（包括原地）就變成人排的。
 * ⚠️ 手機沒有原生拖拉：點一下方框選起來，再點格子（或上方待排區）放下，走同一個寫入。
 */

/** 還在等人剪的片 */
const isPending = (a: Asset) =>
  a.type === 'video' && !a.voidedAt && a.status !== 'archived' && !isClosedOutsideSystem(a) &&
  (deriveFlowStage(a) === 'to_edit' || deriveFlowStage(a) === 'revising');

/** 剪好交出去、還沒掛上貼文的片（比照剪輯師畫面的 deliveredAssets：它們先補最近的空格） */
const isDelivered = (a: Asset) => {
  if (a.type !== 'video' || a.voidedAt || a.status === 'archived' || a.usedInPostId || isClosedOutsideSystem(a)) return false;
  const stage = deriveFlowStage(a);
  if (stage === 'to_edit' || stage === 'revising') return false;
  return Boolean(a.cloudUploadedAt) || stage === 'client_review' || stage === 'to_upload';
};

const dayLabel = (d: Date) => `${format(d, 'MM/dd')}（${'日一二三四五六'[d.getDay()]}）`;

export default function AirDateBoard({ onClose }: { onClose: () => void }) {
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const posts = useLiveCollection<Post>('posts');
  const dismissedHabits = useLiveCollection<DismissedHabit>('dismissedHabits');
  const slotMoves = useLiveCollection<PlannedSlotMove>('plannedSlotMoves');

  const [days, setDays] = useState<14 | 28>(14);
  /** 手機備援：點選中的那支（assetId） */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { rowVendors, dates, pending, unplaced, demandsByCell, queueByCell, rank } = useMemo(() => {
    const now = new Date();
    const today = startOfDay(now);
    // 冷凍中的 IP 也要能排（冷凍凍的是發片不是剪片，見 stockVisibleVendors），只是它沒有固定發片日
    const visible = stockVisibleVendors(vendors);
    const visibleIds = new Set(visible.map(v => v.id));
    const pendingAll = assets.filter(a => isPending(a) && visibleIds.has(a.vendorId));

    // ⚠️ 配對視窗跟剪輯師畫面一樣固定 SUPPLY_HORIZON_DAYS，畫面上的 14/28 天只決定顯示幾欄，
    //    否則同一天在這裡跟剪輯師那邊會遞補到不同的片。
    const slots = listPlannedSlots({
      vendors: trackedVendors(vendors),
      moves: slotMoves,
      dismissed: dismissedHabits,
      posts,
      rangeStart: now,
      rangeEnd: addDays(now, SUPPLY_HORIZON_DAYS),
      fulfilledWindowDays: 1,
    });
    const demands = buildHorizonDemands({ posts, slots, now }).filter(d => d.contentType === 'video');
    const queue = buildEditorQueue({
      demands,
      pendingAssets: pendingAll,
      deliveredAssets: assets.filter(a => isDelivered(a) && visibleIds.has(a.vendorId)),
    });

    const cellKey = (vendorId: string, d: Date) => `${vendorId}|${format(d, 'yyyy-MM-dd')}`;
    const demandsByCell = new Map<string, number>();
    demands.forEach(d => demandsByCell.set(cellKey(d.vendorId, d.date), (demandsByCell.get(cellKey(d.vendorId, d.date)) || 0) + 1));
    const queueByCell = new Map<string, EditorQueueRow[]>();
    [...queue.rows, ...queue.stocked, ...queue.settled].forEach(r => {
      if (!r.date) return;
      const k = cellKey(r.vendorId, r.date);
      queueByCell.set(k, [...(queueByCell.get(k) || []), r]);
    });

    const dates = Array.from({ length: days }, (_, i) => addDays(today, i));
    // 有發片日或有待剪片的 IP 才一列
    const active = new Set<string>([...demands.map(d => d.vendorId), ...pendingAll.map(a => a.vendorId)]);
    const rowVendors = visible.filter(v => active.has(v.id!)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));

    return {
      rowVendors, dates, queueByCell, demandsByCell,
      pending: pendingAll,
      unplaced: pendingAll.filter(a => !a.plannedAirDate).sort(compareRawEditOrder),
      rank: rankByVendor(pendingAll),
    };
  }, [vendors, assets, posts, dismissedHabits, slotMoves, days]);

  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name || '未知 IP';

  const setAirDate = async (assetId: string, date: Date | null) => {
    const a = pending.find(x => x.id === assetId);
    if (!a) return;
    const next = date ? format(date, 'yyyy-MM-dd') : null;
    setSelectedId(null);
    if ((a.plannedAirDate || null) === next) return;
    setBusyId(assetId);
    try {
      await updateDoc(doc(db, 'assets', assetId), { plannedAirDate: next ?? deleteField() });
    } catch (error) {
      console.error('排上片日失敗:', error);
      toast.error('沒有存到，請再試一次');
    } finally {
      setBusyId(null);
    }
  };

  /** 放到某個 IP 的某一天。只能放在同一個 IP 的那一列。 */
  const placeInto = (assetId: string, vendorId: string, date: Date) => {
    const a = pending.find(x => x.id === assetId);
    if (!a) return;
    if (a.vendorId !== vendorId) {
      toast.error(`這支是 ${vendorName(a.vendorId)} 的片，只能排在 ${vendorName(a.vendorId)} 那一列`);
      return;
    }
    void setAirDate(assetId, date);
  };

  const onDragStart = (e: DragEvent, assetId: string) => {
    e.dataTransfer.setData('text/plain', assetId);
    e.dataTransfer.effectAllowed = 'move';
  };
  const allowDrop = (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };

  /**
   * 一支片的方框。dashed＝系統遞補，還沒有人親手排。
   * ⚠️ 寫成函式不寫成元件：元件定義在 render 裡每次都是新型別，拖到一半重整會整顆重掛。
   */
  const chip = (a: Asset, opts: { key?: string; dashed?: boolean; airDate?: Date } = {}) => {
    const { dashed = false, airDate } = opts;
    const deadline = airDate ? deliveryDeadline(airDate) : null;
    const left = deadline ? differenceInCalendarDays(deadline, new Date()) : null;
    const selected = selectedId === a.id;
    return (
      <div
        key={opts.key ?? a.id}
        draggable={busyId !== a.id}
        onDragStart={e => onDragStart(e, a.id!)}
        onClick={e => { e.stopPropagation(); setSelectedId(selected ? null : a.id!); }}
        title={a.title}
        className={[
          'rounded-lg px-2 py-1.5 text-left cursor-grab active:cursor-grabbing select-none transition-shadow',
          dashed ? 'border border-dashed border-[#5A5A40]/40 bg-white/60 text-gray-500' : 'border border-[#5A5A40]/20 bg-white shadow-sm text-gray-800',
          selected ? 'ring-2 ring-[#5A5A40]' : 'hover:shadow-md',
          busyId === a.id ? 'opacity-40' : '',
        ].join(' ')}
      >
        <div className="flex items-center gap-1 min-w-0">
          {a.isUrgent && <Flame size={12} className="text-orange-600 shrink-0" />}
          <span className="text-[13px] font-bold truncate">{a.title}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
          {rank.has(a.id!) && <span className="text-gray-400">順序 {rank.get(a.id!)}</span>}
          {deadline && (
            <span className={left !== null && left < 0 ? 'text-red-600 font-bold' : 'text-gray-500'}>
              {format(deadline, 'MM/dd')} 交片{left !== null && left < 0 ? '・來不及' : ''}
            </span>
          )}
          {dashed && <span className="text-gray-400">系統遞補</span>}
        </div>
      </div>
    );
  };

  const unplacedByVendor = rowVendors
    .map(v => ({ v, list: unplaced.filter(a => a.vendorId === v.id) }))
    .filter(g => g.list.length > 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-2xl w-full max-w-7xl max-h-[94vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-[#5A5A40]" />
            排上片日
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 sm:px-6 pt-4 flex items-start justify-between gap-3 flex-wrap">
          <div className="text-sm text-slate-600 leading-relaxed">
            <p>把上面的片拖到下面那個 IP 的日子，就是預計那天上。拖回上面＝取消。</p>
            <p>剪輯師的交片期限＝上片日前 {EDIT_LEAD_DAYS} 天。橘底是固定發片日；虛線框是那天沒人排，系統先拿順序第 1 支補上。</p>
          </div>
          <div className="flex gap-1 shrink-0">
            {([14, 28] as const).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={days === d
                  ? 'px-3 py-1.5 rounded-xl text-[13px] font-bold bg-[#5A5A40] text-white'
                  : 'px-3 py-1.5 rounded-xl text-[13px] font-bold bg-white border border-black/10 text-gray-500 hover:text-[#5A5A40]'}
              >
                未來 {d} 天
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 sm:px-6 py-4 overflow-y-auto space-y-4">
          {/* 待排：拖回這裡＝清掉上片日 */}
          <div
            onDragOver={allowDrop}
            onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) void setAirDate(id, null); }}
            onClick={() => { if (selectedId) void setAirDate(selectedId, null); }}
            className="rounded-2xl border border-black/10 bg-[#F5F5F0] p-3"
          >
            <p className="text-[13px] font-bold text-[#5A5A40] mb-2 whitespace-nowrap">
              還沒排上片日 <span className="font-normal text-gray-500">{unplaced.length} 支</span>
            </p>
            {unplacedByVendor.length === 0 ? (
              <p className="text-[13px] text-gray-400">全部的毛片都排好上片日了。</p>
            ) : (
              <div className="space-y-2">
                {unplacedByVendor.map(({ v, list }) => (
                  <div key={v.id} className="flex items-start gap-2">
                    <span className="text-[13px] text-gray-500 w-20 shrink-0 pt-1.5 truncate" title={v.name}>{v.name}</span>
                    <div className="flex flex-wrap gap-1.5 min-w-0">
                      {list.map(a => <div key={a.id} className="w-44">{chip(a)}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedId && (
            <p className="text-[13px] text-[#5A5A40] font-bold">
              已選「{pending.find(a => a.id === selectedId)?.title}」，點 {vendorName(pending.find(a => a.id === selectedId)?.vendorId || '')} 那一列的日子放下。
            </p>
          )}

          {/* 行事曆：一列一個 IP，一欄一天 */}
          <div className="overflow-x-auto rounded-2xl border border-black/10">
            <table className="border-collapse text-left">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-white border-b border-r border-black/10 px-2 py-2 text-[13px] text-gray-500 whitespace-nowrap">IP</th>
                  {dates.map(d => (
                    <th
                      key={d.toISOString()}
                      className={`border-b border-black/10 px-2 py-2 text-[13px] whitespace-nowrap ${isSameDay(d, new Date()) ? 'text-[#5A5A40] font-bold' : 'text-gray-500 font-medium'} ${d.getDay() === 0 || d.getDay() === 6 ? 'bg-gray-50' : ''}`}
                    >
                      {dayLabel(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowVendors.map(v => (
                  <tr key={v.id}>
                    <td className="sticky left-0 z-10 bg-white border-b border-r border-black/10 px-2 py-2 text-[13px] font-bold text-gray-700 whitespace-nowrap max-w-[7rem] truncate" title={v.name}>
                      {v.name}
                    </td>
                    {dates.map(d => {
                      const dateStr = format(d, 'yyyy-MM-dd');
                      const key = `${v.id}|${dateStr}`;
                      const isSlotDay = (demandsByCell.get(key) || 0) > 0;
                      const placed = pending.filter(a => a.vendorId === v.id && a.plannedAirDate === dateStr);
                      const qRows = queueByCell.get(key) || [];
                      const auto = qRows.filter(r => r.kind === 'to_edit' && r.deadlineSource !== 'air' && r.asset && !r.asset.plannedAirDate);
                      const settled = qRows.filter(r => r.kind === 'settled').length;
                      const stocked = qRows.filter(r => r.kind === 'has_stock').length;
                      const empty = qRows.filter(r => r.kind === 'no_material').length;
                      return (
                        <td
                          key={key}
                          onDragOver={allowDrop}
                          onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (id) placeInto(id, v.id!, d); }}
                          onClick={() => { if (selectedId) placeInto(selectedId, v.id!, d); }}
                          className={`align-top border-b border-black/5 p-1 w-40 min-w-[10rem] ${isSlotDay ? 'bg-orange-50' : ''} ${selectedId && pending.find(a => a.id === selectedId)?.vendorId === v.id ? 'cursor-pointer hover:bg-[#5A5A40]/10' : ''}`}
                        >
                          <div className="space-y-1">
                            {placed.map(a => chip(a, { airDate: d }))}
                            {auto.map(r => chip(r.asset!, { key: r.key, airDate: d, dashed: true }))}
                            {settled > 0 && <p className="text-[12px] text-gray-400 px-1 whitespace-nowrap">已掛片 {settled > 1 ? `×${settled}` : ''}</p>}
                            {stocked > 0 && <p className="text-[12px] text-sky-700 px-1 whitespace-nowrap">有成片等排程{stocked > 1 ? ` ×${stocked}` : ''}</p>}
                            {empty > 0 && <p className="text-[12px] text-amber-700 px-1 whitespace-nowrap">沒片</p>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 排在畫面範圍以外（更早或更遠）的片：不然拖過去之後就找不到了 */}
          {(() => {
            const last = dates[dates.length - 1];
            const outside = pending.filter(a => {
              if (!a.plannedAirDate) return false;
              const d = startOfDay(parseISO(a.plannedAirDate));
              return d < dates[0] || d > last;
            }).sort((x, y) => (x.plannedAirDate || '').localeCompare(y.plannedAirDate || ''));
            if (!outside.length) return null;
            return (
              <div className="rounded-2xl border border-black/10 p-3">
                <p className="text-[13px] font-bold text-gray-600 mb-2">排在這段時間以外 <span className="font-normal text-gray-500">{outside.length} 支</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {outside.map(a => (
                    <div key={a.id} className="w-44">
                      <p className="text-[12px] text-gray-500 px-1 whitespace-nowrap">{vendorName(a.vendorId)}・{dayLabel(parseISO(a.plannedAirDate!))} 上</p>
                      {chip(a, { airDate: startOfDay(parseISO(a.plannedAirDate!)) })}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
