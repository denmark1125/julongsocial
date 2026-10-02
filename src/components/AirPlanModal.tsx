import { useMemo, useState } from 'react';
import { addDays, format, startOfDay } from 'date-fns';
import { doc, writeBatch, deleteField } from 'firebase/firestore';
import { db } from '../firebase';
import { Asset, Post, Vendor, DismissedHabit, PlannedSlotMove, ShootBooking, deriveFlowStage } from '../types';
import { useLiveCollection } from '../lib/liveData';
import { trackedVendors } from '../lib/vendorStatus';
import { listPlannedSlots } from '../lib/plannedSlots';
import {
  buildHorizonDemands, buildSupplyPlan, describeSupply,
  SUPPLY_HORIZON_DAYS,
} from '../lib/materialSupply';
import toast from 'react-hot-toast';
import { X, Loader2, CheckCircle2, CalendarDays, Flame } from 'lucide-react';

/**
 * 排下週的片：把「哪天缺片」跟「哪支待剪素材」的配對確認下來，順便寫這支要怎麼剪。
 *
 * 為什麼要有這一頁：剪輯師手上五支毛片，哪支先剪全靠 LINE 問。我們排社群日曆時心裡
 * 很清楚「週一廣信缺、週三又生跟祥濱各缺一支」，但那張圖從來沒有傳到剪輯師那邊。
 *
 * ⚠️ **系統算的建議在按下確認之前，剪輯師一律看不到。**
 *    `feedback_editor_facing_wording` 的鐵則是「不要把某支片名接在某一天旁邊」，
 *    理由是那個配對不存在。這一頁的存在就是讓人把配對變成真的 —— 但也只有
 *    人按過確認（寫進 asset.plannedAirDate）的才算數，建議值不算。
 * ⚠️ 配對一律在「今天起 SUPPLY_HORIZON_DAYS 天」這個**固定視窗**上做，畫面上的 7/14 天
 *    只決定顯示幾列。區間一變答案就變的話，這一頁跟剪輯師的日曆會對同一天講不同的話。
 */
export default function AirPlanModal({ onClose }: { onClose: () => void }) {
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const posts = useLiveCollection<Post>('posts');
  const dismissedHabits = useLiveCollection<DismissedHabit>('dismissedHabits');
  const slotMoves = useLiveCollection<PlannedSlotMove>('plannedSlotMoves');
  const bookings = useLiveCollection<ShootBooking>('shootBookings');

  const [days, setDays] = useState<7 | 14>(7);
  const [busy, setBusy] = useState(false);
  /** demandId → 這格決定用哪支（空字串＝這格先不排） */
  const [picks, setPicks] = useState<Record<string, string>>({});
  /** assetId → 剪輯需求草稿 */
  const [briefs, setBriefs] = useState<Record<string, string>>({});

  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name || '未知 IP';

  /** 還在等人剪的片。可以被排進某一格的就是這些 */
  const isPending = (a: Asset) =>
    a.type === 'video' && !a.voidedAt && a.status !== 'archived' &&
    (deriveFlowStage(a) === 'to_edit' || deriveFlowStage(a) === 'revising');

  const { rows, plan } = useMemo(() => {
    const now = new Date();
    const slots = listPlannedSlots({
      vendors: trackedVendors(vendors),
      moves: slotMoves,
      dismissed: dismissedHabits,
      posts,
      rangeStart: now,
      rangeEnd: addDays(now, SUPPLY_HORIZON_DAYS),
      fulfilledWindowDays: 1, // 沿用日曆的「前後一天內有發就不用再提醒」
    });
    const demands = buildHorizonDemands({ posts, slots, now });
    const supplyPlan = buildSupplyPlan({ demands, assets, posts, bookings, now });

    const limit = startOfDay(addDays(now, days));
    const visible = demands
      .filter(d => d.contentType === 'video' && d.date <= limit)
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    return { rows: visible, plan: supplyPlan };
  }, [vendors, assets, posts, dismissedHabits, slotMoves, bookings, days]);

  /**
   * 這格現在決定用哪支。
   * 優先序：這次在畫面上改過的 → 已經確認過的（asset.plannedAirDate 對得上）→ 系統建議。
   * ⚠️ 已確認的一定要排在系統建議前面，否則重開這一頁會把人的決定蓋回建議值。
   */
  const pickFor = (demandId: string, vendorId: string, dateStr: string): string => {
    if (demandId in picks) return picks[demandId];
    const confirmed = assets.find(a => a.vendorId === vendorId && a.plannedAirDate === dateStr && isPending(a));
    if (confirmed) return confirmed.id!;
    const suggested = plan.assignments.get(demandId);
    return suggested?.kind === 'to_edit' ? (suggested.assetId || '') : '';
  };

  /** 這家 IP 還能排的待剪素材（已經被這張表別格選走的不再出現） */
  const optionsFor = (vendorId: string, mine: string) => {
    const taken = new Set(rows.map(d => pickFor(d.id, d.vendorId, format(d.date, 'yyyy-MM-dd'))).filter(Boolean));
    return assets.filter(a =>
      a.vendorId === vendorId && isPending(a) && (a.id === mine || !taken.has(a.id!))
    );
  };

  const briefFor = (assetId: string) =>
    assetId in briefs ? briefs[assetId] : (assets.find(a => a.id === assetId)?.editingBrief || '');

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const batch = writeBatch(db);
      const picked = new Map<string, string>(); // assetId → 上片日

      for (const d of rows) {
        const dateStr = format(d.date, 'yyyy-MM-dd');
        const assetId = pickFor(d.id, d.vendorId, dateStr);
        if (assetId) picked.set(assetId, dateStr);
      }

      for (const [assetId, dateStr] of picked) {
        const payload: Record<string, unknown> = { plannedAirDate: dateStr };
        const brief = briefFor(assetId).trim();
        if (brief !== (assets.find(a => a.id === assetId)?.editingBrief || '')) payload.editingBrief = brief;
        batch.update(doc(db, 'assets', assetId), payload);
      }

      // 這次被清掉的格子要把舊日期收回去，不然剪輯師那邊會留著一個已經不算數的上片日。
      // ⚠️ 只清「上片日落在這次看得到的範圍內」的，不要去動更遠的排程。
      const until = format(addDays(new Date(), days), 'yyyy-MM-dd');
      const today = format(new Date(), 'yyyy-MM-dd');
      for (const a of assets) {
        if (!a.plannedAirDate || !isPending(a)) continue;
        if (a.plannedAirDate < today || a.plannedAirDate > until) continue;
        if (picked.has(a.id!)) continue;
        batch.update(doc(db, 'assets', a.id!), { plannedAirDate: deleteField() });
      }

      await batch.commit();
      toast.success(`已排定 ${picked.size} 支，剪輯師看得到順序了`);
      onClose();
    } catch (error) {
      console.error('排片失敗:', error);
      toast.error('排片失敗，請再試一次');
    } finally {
      setBusy(false);
    }
  };

  const plannedCount = rows.filter(d => pickFor(d.id, d.vendorId, format(d.date, 'yyyy-MM-dd'))).length;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-[#5A5A40]" />
            排接下來要上的片
          </h3>
          <button onClick={onClose} disabled={busy} className="text-slate-400 hover:text-slate-600 disabled:opacity-40" aria-label="關閉">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-slate-600 leading-relaxed">
            <p>每一列是社群日曆上「那天要上片」的一格。</p>
            <p>決定用哪支待剪素材、順便寫這支要怎麼剪，按確認之後剪輯師才看得到順序。</p>
          </div>
          <div className="flex gap-1 shrink-0">
            {([7, 14] as const).map(d => (
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

        <div className="px-6 py-4 overflow-y-auto space-y-3">
          {rows.length === 0 ? (
            <p className="text-center text-slate-400 py-12">這段時間的社群日曆上沒有要上的影片。</p>
          ) : rows.map(d => {
            const dateStr = format(d.date, 'yyyy-MM-dd');
            const assignment = plan.assignments.get(d.id);
            const supply = describeSupply(assignment);
            const picked = pickFor(d.id, d.vendorId, dateStr);
            const opts = optionsFor(d.vendorId, picked);
            const pickedAsset = assets.find(a => a.id === picked);

            /**
             * 只有「這格要剪輯師動手」才給下拉。
             *
             * ⚠️ 已經有成片可用的格子不該能排待剪片 —— 那會把片排到不需要的地方，
             *    真正缺片的格子反而餓死。已經排過的（picked）仍然要能改與清掉，
             *    否則人改不回自己上次的決定。
             */
            const editable = !d.attachedAssetId && (assignment?.kind === 'to_edit' || Boolean(picked));

            return (
              <div key={d.id} className="border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-[#5A5A40] whitespace-nowrap">
                    {format(d.date, 'MM/dd')}（{'日一二三四五六'[d.date.getDay()]}）
                  </span>
                  <span className="text-sm font-medium text-slate-800">{vendorName(d.vendorId)}</span>
                  <span className="text-[13px] text-slate-500">{supply.label}{supply.detail ? `・${supply.detail}` : ''}</span>
                  {/* 有成片的格子卻排了待剪片＝之前有人刻意這樣排。不講一句的話這兩行會互相打架 */}
                  {picked && assignment?.kind !== 'to_edit' && (
                    <span className="text-[13px] font-medium text-[#5A5A40] whitespace-nowrap">已改排待剪片</span>
                  )}
                  {pickedAsset?.isUrgent && (
                    <span className="inline-flex items-center gap-1 text-[13px] font-bold text-red-600 whitespace-nowrap">
                      <Flame className="w-3.5 h-3.5" /> 急件
                    </span>
                  )}
                </div>

                {d.attachedAssetId ? (
                  <p className="text-[13px] text-slate-500">這格已經指定好素材了，不用再排。</p>
                ) : !editable ? (
                  <p className="text-[13px] text-slate-500">
                    {assignment?.kind === 'ready' || assignment?.kind === 'in_progress'
                      ? '這格不用剪輯師動手。'
                      : '這家目前沒有待剪素材可以排。'}
                  </p>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-3">
                    <select
                      value={picked}
                      onChange={e => setPicks(prev => ({ ...prev, [d.id]: e.target.value }))}
                      className="sm:w-64 shrink-0 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
                    >
                      <option value="">這格先不排</option>
                      {opts.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                    </select>
                    <input
                      value={picked ? briefFor(picked) : ''}
                      onChange={e => picked && setBriefs(prev => ({ ...prev, [picked]: e.target.value }))}
                      disabled={!picked}
                      placeholder="這支要怎麼剪（剪輯師看得到）"
                      className="flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-100"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[13px] text-slate-500">
            會排定 {plannedCount} 支。沒排到的片剪輯師照樣看得到，只是排在後面。
          </p>
          <div className="flex gap-3">
            <button onClick={onClose} disabled={busy} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-40">
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={busy || rows.length === 0}
              className="px-5 py-2 bg-[#5A5A40] text-white rounded-lg hover:bg-[#4a4a35] disabled:opacity-50 flex items-center gap-2 font-medium"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              確認排片
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
