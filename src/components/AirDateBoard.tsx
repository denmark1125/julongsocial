import { useMemo, useState, type DragEvent } from 'react';
import { addDays, differenceInCalendarDays, format, isSameDay, parseISO, startOfDay, startOfWeek } from 'date-fns';
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
 * 排上片日：左邊是這個 IP 還沒排上片日的毛片，拖到右邊月曆的某一天＝這支預計那天上。
 *
 * 2026-10-20 主管定案，取代「排接下來要上的片」（AirPlanModal 的下拉配對）：
 * 原本系統自動把每支毛片配到 IP 的發片日，剪輯師畫面變成每支都有很近的期限、全部都要剪。
 * 現在**上片日由同事決定**，剪輯師的交片期限＝上片日往前 EDIT_LEAD_DAYS 天。
 *
 * ⚠️ 一次只看一個 IP（上方按鈕切換，比照社群日曆）。
 *    第一版把所有 IP 的片攤在上方、所有 IP 一列一列排在下方，45 支片把行事曆擠出畫面，拖不到（使用者 10-20）。
 * ⚠️ 寫的就是 `asset.plannedAirDate`，剪輯師清單（buildEditorQueue）只認這個欄位。
 * ⚠️ 虛線框＝那天沒人排，系統先拿這個 IP 剪輯順序第 1 支遞補（跟剪輯師看到的同一份結果）。
 *    把它拖到任何一天（包括原地）就變成人排的。
 * ⚠️ 手機沒有原生拖拉：點一下方框選起來，再點日子（或左邊待排區）放下，走同一個寫入。
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

const WEEKDAYS = '日一二三四五六';
/** 月曆顯示幾週（從本週日起）。要蓋過 SUPPLY_HORIZON_DAYS，遞補的片才看得到 */
const WEEKS = 5;

export default function AirDateBoard({ onClose }: { onClose: () => void }) {
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const posts = useLiveCollection<Post>('posts');
  const dismissedHabits = useLiveCollection<DismissedHabit>('dismissedHabits');
  const slotMoves = useLiveCollection<PlannedSlotMove>('plannedSlotMoves');

  const [vendorPick, setVendorPick] = useState<string | null>(null);
  /** 手機備援：點選中的那支（assetId） */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 拖曳經過的那一格，給個底色讓人知道會放在哪 */
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  const { ipVendors, pending, demandsByCell, queueByCell, rank } = useMemo(() => {
    const now = new Date();
    // 冷凍中的 IP 也要能排（冷凍凍的是發片不是剪片，見 stockVisibleVendors），只是它沒有固定發片日
    const visible = stockVisibleVendors(vendors);
    const visibleIds = new Set(visible.map(v => v.id));
    const pendingAll = assets.filter(a => isPending(a) && visibleIds.has(a.vendorId));

    // ⚠️ 配對視窗跟剪輯師畫面一樣固定 SUPPLY_HORIZON_DAYS，否則同一天在這裡跟剪輯師那邊會遞補到不同的片。
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

    // 有發片日或有待剪片的 IP 才有按鈕
    const active = new Set<string>([...demands.map(d => d.vendorId), ...pendingAll.map(a => a.vendorId)]);
    const ipVendors = visible.filter(v => active.has(v.id!)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));

    return { ipVendors, pending: pendingAll, demandsByCell, queueByCell, rank: rankByVendor(pendingAll) };
  }, [vendors, assets, posts, dismissedHabits, slotMoves]);

  const unplacedCount = (vendorId: string) => pending.filter(a => a.vendorId === vendorId && !a.plannedAirDate).length;
  // 預設停在第一個還有片沒排的 IP
  const vendorId = vendorPick ?? (ipVendors.find(v => unplacedCount(v.id!) > 0) ?? ipVendors[0])?.id ?? null;
  const vendor = vendors.find(v => v.id === vendorId);

  const today = startOfDay(new Date());
  const gridDays = Array.from({ length: WEEKS * 7 }, (_, i) => addDays(startOfWeek(today), i));
  const mine = pending.filter(a => a.vendorId === vendorId);
  const unplaced = mine.filter(a => !a.plannedAirDate).sort(compareRawEditOrder);
  // 排在月曆範圍以外（更早或更遠）的片：不列出來的話，拖過去之後就找不到了
  const outside = mine.filter(a => {
    if (!a.plannedAirDate) return false;
    const d = startOfDay(parseISO(a.plannedAirDate));
    return d < gridDays[0] || d > gridDays[gridDays.length - 1];
  }).sort((x, y) => (x.plannedAirDate || '').localeCompare(y.plannedAirDate || ''));

  /** 系統遞補到哪一天（assetId → 日子）。只算沒人排過的片 */
  const autoDateOf = new Map<string, Date>();
  queueByCell.forEach(rows => rows.forEach(r => {
    if (r.kind === 'to_edit' && r.date && r.asset && !r.asset.plannedAirDate) autoDateOf.set(r.asset.id!, r.date);
  }));

  const setAirDate = async (assetId: string, date: Date | null) => {
    const a = pending.find(x => x.id === assetId);
    setSelectedId(null);
    setHoverDay(null);
    if (!a) return;
    const next = date ? format(date, 'yyyy-MM-dd') : null;
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

  const onDragStart = (e: DragEvent, assetId: string) => {
    e.dataTransfer.setData('text/plain', assetId);
    e.dataTransfer.effectAllowed = 'move';
  };
  const allowDrop = (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const dropTo = (e: DragEvent, date: Date | null) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (id) void setAirDate(id, date);
    else setHoverDay(null);
  };

  /**
   * 一支片的方框。dashed＝系統遞補，還沒有人親手排。
   * ⚠️ 寫成函式不寫成元件：元件定義在 render 裡每次都是新型別，拖到一半重整會整顆重掛。
   */
  const chip = (a: Asset, opts: { key?: string; dashed?: boolean; airDate?: Date } = {}) => {
    const { dashed = false, airDate } = opts;
    // 左邊待排區的片如果已經被系統補在某一天，直接講出來 —— 不然同一支在兩邊各出現一次，看起來像重複
    const autoAt = !airDate ? autoDateOf.get(a.id!) : undefined;
    const deadline = airDate ? deliveryDeadline(airDate) : null;
    const late = deadline ? differenceInCalendarDays(deadline, today) < 0 : false;
    const selected = selectedId === a.id;
    return (
      <div
        key={opts.key ?? a.id}
        draggable={busyId !== a.id}
        onDragStart={e => onDragStart(e, a.id!)}
        onDragEnd={() => setHoverDay(null)}
        onClick={e => { e.stopPropagation(); setSelectedId(selected ? null : a.id!); }}
        title={a.title}
        className={[
          'rounded-lg px-2 py-1 text-left cursor-grab active:cursor-grabbing select-none transition-shadow',
          dashed ? 'border border-dashed border-[#5A5A40]/40 bg-white/70 text-gray-500' : 'border border-[#5A5A40]/20 bg-white shadow-sm text-gray-800',
          selected ? 'ring-2 ring-[#5A5A40]' : 'hover:shadow-md',
          busyId === a.id ? 'opacity-40' : '',
        ].join(' ')}
      >
        <div className="flex items-center gap-1 min-w-0">
          {a.isUrgent && <Flame size={12} className="text-orange-600 shrink-0" />}
          <span className="text-[13px] font-bold truncate">{a.title}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
          {!airDate && rank.has(a.id!) && <span className="text-gray-400">順序 {rank.get(a.id!)}</span>}
          {autoAt && <span className="text-gray-400">系統先補在 {format(autoAt, 'M/d')}</span>}
          {deadline && (
            <span className={late ? 'text-red-600 font-bold' : 'text-gray-500'}>
              {format(deadline, 'M/d')} 交片{late ? '・來不及' : ''}
            </span>
          )}
          {dashed && <span className="text-gray-400">系統補</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 p-2 sm:p-4 flex">
      <div className="bg-[#F5F5F0] rounded-2xl w-full flex flex-col shadow-xl overflow-hidden">
        {/* 標題列 */}
        <div className="bg-white flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-black/5">
          <div className="min-w-0">
            <h3 className="text-lg font-bold serif text-[#5A5A40] flex items-center gap-2">
              <CalendarDays size={18} /> 排上片日
            </h3>
            <p className="text-[13px] text-gray-500 truncate">
              把左邊的片拖到那一天＝預計那天上，拖回左邊＝取消。剪輯師交片期限＝上片日前 {EDIT_LEAD_DAYS} 天。
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 shrink-0" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* IP 篩選：比照社群日曆的按鈕列 */}
        <div className="bg-white px-4 sm:px-6 py-3 border-b border-black/5 flex gap-2 overflow-x-auto">
          {ipVendors.map(v => {
            const n = unplacedCount(v.id!);
            const on = v.id === vendorId;
            return (
              <button
                key={v.id}
                onClick={() => { setVendorPick(v.id!); setSelectedId(null); }}
                className={`shrink-0 px-3 py-1.5 rounded-full text-[13px] font-bold whitespace-nowrap border transition-colors ${on
                  ? 'bg-[#5A5A40] border-[#5A5A40] text-white'
                  : 'bg-white border-black/10 text-gray-600 hover:text-[#5A5A40]'}`}
              >
                {v.name}
                {n > 0 && <span className={`ml-1.5 ${on ? 'text-white/70' : 'text-amber-600'}`}>{n}</span>}
              </button>
            );
          })}
        </div>

        {!vendor ? (
          <p className="text-center text-gray-400 py-16">目前沒有要排的 IP。</p>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 p-3 sm:p-4 overflow-y-auto lg:overflow-hidden">
            {/* 左：還沒排上片日（拖回這裡＝清掉上片日） */}
            <div
              onDragOver={allowDrop}
              onDrop={e => dropTo(e, null)}
              onClick={() => { if (selectedId) void setAirDate(selectedId, null); }}
              className="lg:w-64 shrink-0 bg-white rounded-2xl border border-black/5 p-3 flex flex-col lg:min-h-0"
            >
              <p className="text-[13px] font-bold text-[#5A5A40] mb-2 whitespace-nowrap">
                還沒排上片日 <span className="font-normal text-gray-500">{unplaced.length} 支</span>
              </p>
              <div className="flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-x-visible lg:overflow-y-auto lg:min-h-0 pb-1">
                {unplaced.length === 0
                  ? <p className="text-[13px] text-gray-400">{vendor.name} 的毛片都排好了。</p>
                  : unplaced.map(a => <div key={a.id} className="w-44 lg:w-auto shrink-0">{chip(a)}</div>)}
              </div>
              {outside.length > 0 && (
                <div className="mt-3 pt-3 border-t border-black/5 space-y-1.5">
                  <p className="text-[12px] text-gray-500">排在月曆範圍以外</p>
                  {outside.map(a => (
                    <div key={a.id}>
                      <p className="text-[12px] text-gray-400 px-1">{format(parseISO(a.plannedAirDate!), 'M/d')} 上</p>
                      {chip(a, { airDate: startOfDay(parseISO(a.plannedAirDate!)) })}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 右：月曆 */}
            <div className="flex-1 min-w-0 bg-white rounded-2xl border border-black/5 flex flex-col lg:min-h-0 overflow-hidden">
              {selectedId && (
                <p className="px-3 py-2 text-[13px] text-[#5A5A40] font-bold border-b border-black/5">
                  已選「{pending.find(a => a.id === selectedId)?.title}」，點一天放下。
                </p>
              )}
              <div className="grid grid-cols-7 border-b border-black/5">
                {WEEKDAYS.split('').map(w => (
                  <div key={w} className="py-2 text-center text-[13px] font-bold text-gray-500">{w}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 auto-rows-[minmax(96px,1fr)] flex-1 lg:min-h-0 lg:overflow-y-auto">
                {gridDays.map(d => {
                  const dateStr = format(d, 'yyyy-MM-dd');
                  const key = `${vendorId}|${dateStr}`;
                  const past = d < today;
                  const isSlotDay = (demandsByCell.get(key) || 0) > 0;
                  const placed = mine.filter(a => a.plannedAirDate === dateStr);
                  const qRows = queueByCell.get(key) || [];
                  const auto = qRows.filter(r => r.kind === 'to_edit' && r.asset && !r.asset.plannedAirDate);
                  const settledPosts = posts.filter(p =>
                    p.vendorId === vendorId && p.contentType !== 'post' && p.scheduledAt &&
                    p.assetId && p.assetId !== 'to_be_added' && isSameDay(parseISO(p.scheduledAt), d));
                  const stocked = qRows.filter(r => r.kind === 'has_stock').length;
                  const empty = qRows.some(r => r.kind === 'no_material');
                  return (
                    <div
                      key={dateStr}
                      onDragOver={past ? undefined : e => { allowDrop(e); if (hoverDay !== dateStr) setHoverDay(dateStr); }}
                      onDrop={past ? undefined : e => dropTo(e, d)}
                      onClick={() => { if (selectedId && !past) void setAirDate(selectedId, d); }}
                      className={[
                        'border-r border-b border-black/5 p-1.5 min-w-0 space-y-1 transition-colors',
                        past ? 'bg-gray-50/80 opacity-50' : isSlotDay ? 'bg-orange-50/60' : '',
                        hoverDay === dateStr ? '!bg-[#5A5A40]/10' : '',
                        selectedId && !past ? 'cursor-pointer hover:bg-[#5A5A40]/5' : '',
                      ].join(' ')}
                    >
                      <div className="flex items-center gap-1">
                        <span className={`text-[13px] font-bold w-6 h-6 flex items-center justify-center rounded-full shrink-0 ${isSameDay(d, today) ? 'bg-[#5A5A40] text-white' : 'text-gray-500'}`}>
                          {d.getDate() === 1 ? format(d, 'M/d') : d.getDate()}
                        </span>
                        {isSlotDay && !past && <span className="text-[12px] text-orange-700 truncate">發片日</span>}
                      </div>
                      {settledPosts.map(p => (
                        <p key={p.id} title={p.title} className="text-[12px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 truncate">已排：{p.title}</p>
                      ))}
                      {placed.map(a => chip(a, { airDate: d }))}
                      {auto.map(r => chip(r.asset!, { key: r.key, airDate: d, dashed: true }))}
                      {stocked > 0 && <p className="text-[12px] px-1 text-sky-700 truncate">有成片等排程</p>}
                      {empty && !past && <p className="text-[12px] px-1 text-amber-700">沒片</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
