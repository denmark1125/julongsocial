import { useMemo, useState, type DragEvent } from 'react';
import {
  addMonths, differenceInCalendarDays, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay,
  isSameMonth, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { collection, deleteField, doc, writeBatch } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { buildAutoPost, isUntouchedAutoPost, movedSchedule } from '../lib/boardPosts';
import { Asset, DismissedHabit, ExtraSlot, PlannedSlotMove, Post, Vendor } from '../types';
import { useLiveCollection } from '../lib/liveData';
import { buildCompanyQueue } from '../lib/companyQueue';
import { slotVendors } from '../lib/vendorStatus';
import { hasHabitOn, listPlannedSlots, PlannedSlot } from '../lib/plannedSlots';
import { postDemandId } from '../lib/materialSupply';
import { deliveryDeadline, EDIT_LEAD_DAYS, EditorQueueRow } from '../lib/editorQueue';
import { compareRawEditOrder, rankByVendor } from '../lib/editOrder';
import { isWaitingVideoPost } from '../lib/postMatch';
import toast from 'react-hot-toast';
import { CalendarDays, ChevronLeft, ChevronRight, Flame, Info, Lock, Plus, Unlock, X } from 'lucide-react';
import { addExtraSlot, dismissPlannedSlot, removeExtraSlot } from '../lib/extraSlots';

/**
 * 排上片日：左邊是這個 IP 還沒排上片日的毛片，拖到右邊月曆的某一天＝這支預計那天上。
 *
 * 2026-10-20 主管定案，取代「排接下來要上的片」（AirPlanModal 的下拉配對）：
 * 原本系統自動把每支毛片配到 IP 的發片日，剪輯師畫面變成每支都有很近的期限、全部都要剪。
 * 現在**上片日由同事決定**，剪輯師的交片期限＝上片日往前 EDIT_LEAD_DAYS 天。
 *
 * ⚠️ 一次只看一個 IP（上方按鈕切換，比照社群日曆），月曆可以前後翻月。
 *    第一版把所有 IP 的片攤在上方、所有 IP 一列一列排在下方，45 支片把行事曆擠出畫面，拖不到（使用者 10-20）。
 * ⚠️ 小編已經排好的貼文（素材＝待補上）會出現在格子裡。片拖到那一天／那篇貼文上＝綁定那篇
 *    （asset.plannedPostId），之後上片日跟著貼文走，剪好通過自動掛上（見 lib/boundPosts.ts）。
 *    那天沒有小編貼文就只記日子（asset.plannedAirDate）。
 * ⚠️ 虛線框＝那天沒人排，系統先拿這個 IP 剪輯順序第 1 支遞補（跟剪輯師看到的同一份結果）。
 *    把它拖到任何一天（包括原地）就變成人排的。
 * ⚠️ 手機沒有原生拖拉：點一下方框選起來，再點日子（或左邊待排區）放下，走同一個寫入。
 */

const WEEKDAYS = '日一二三四五六';
/*
 * 月曆一次一個月（使用者 10-20：「用月份算比較直觀」），翻頁一次一個月。
 * ⚠️ 已經過去的整週要壓扁（格子矮），不然月中打開時前兩三週的灰格子把本週擠到畫面下面，
 *    看起來像一張空表格 —— 第二版就是這樣被打回來的。
 */
const postDay = (p: Post) => (p.scheduledAt || '').slice(0, 10);

/** 放下去要寫什麼：哪一天、綁哪一篇（null＝不綁）。整個 null＝退回待排 */
type Target = { date: Date; postId: string | null } | null;

/**
 * `embedded`：放在素材資料庫的「排上片日」子分頁裡（2026-10-20 起主要入口），不是跳出視窗。
 * 沒有 onClose 時不顯示關閉鈕。
 */
export default function AirDateBoard({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const vendors = useLiveCollection<Vendor>('vendors');
  const assets = useLiveCollection<Asset>('assets');
  const posts = useLiveCollection<Post>('posts');
  const dismissedHabits = useLiveCollection<DismissedHabit>('dismissedHabits');
  const slotMoves = useLiveCollection<PlannedSlotMove>('plannedSlotMoves');
  const extraSlots = useLiveCollection<ExtraSlot>('extraSlots');

  const [vendorPick, setVendorPick] = useState<string | null>(null);
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  /** 手機備援：點選中的那支（assetId） */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 拖曳經過的那一格／那篇貼文，給個底色讓人知道會放在哪 */
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  /**
   * 已經排好的片預設鎖住，拖不動（使用者 10-20：排好的片一碰就跑掉）。要換先按「解鎖」→ 確認，才拖得動。
   * 只存在這個畫面：重新整理或放到新位置後就又鎖回去。
   */
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(new Set());
  const [confirmUnlockId, setConfirmUnlockId] = useState<string | null>(null);

  const { ipVendors, pending, deliveredIds, demandsByCell, queueByKey, autoDateOf, rank } = useMemo(() => {
    // 冷凍中的 IP 也要能排（冷凍凍的是發片不是剪片，見 stockVisibleVendors），只是它沒有固定發片日。
    // ⚠️ 配對跟剪輯師畫面同一套、同一個視窗，見 lib/companyQueue.ts
    const { visible, pending: pendingAll, delivered: deliveredAll, demands, queue } = buildCompanyQueue({
      vendors, assets, posts, moves: slotMoves, dismissed: dismissedHabits, extras: extraSlots,
    });

    const demandsByCell = new Set(demands.map(d => `${d.vendorId}|${format(d.date, 'yyyy-MM-dd')}`));
    // 系統遞補的列，用需求 id 找（小編貼文那格是 post_xxx，預排是 slot_xxx）
    const queueByKey = new Map<string, EditorQueueRow>();
    const autoDateOf = new Map<string, Date>();
    [...queue.rows, ...queue.stocked].forEach(r => {
      queueByKey.set(r.key, r);
      if (r.kind === 'to_edit' && r.deadlineSource !== 'air' && r.date && r.asset) autoDateOf.set(r.asset.id!, r.date);
      if (r.kind === 'has_stock' && r.date && r.asset && !r.asset.plannedAirDate && !r.asset.plannedPostId) autoDateOf.set(r.asset.id!, r.date);
    });

    // 有發片日或有待剪片的 IP 才有按鈕
    const active = new Set<string>([...demands.map(d => d.vendorId), ...pendingAll.map(a => a.vendorId), ...deliveredAll.map(a => a.vendorId)]);
    const ipVendors = visible.filter(v => active.has(v.id!)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));

    // ⚠️ 可以拖的片＝待剪毛片＋剪好還沒掛上貼文的成片。只收毛片的話，剛交片的片會從板子上消失（使用者 10-20 問「小株番茄」）。
    return {
      ipVendors, pending: [...pendingAll, ...deliveredAll], deliveredIds: new Set(deliveredAll.map(a => a.id!)),
      demandsByCell, queueByKey, autoDateOf, rank: rankByVendor(pendingAll),
    };
  }, [vendors, assets, posts, dismissedHabits, slotMoves, extraSlots]);

  const postById = useMemo(() => new Map(posts.map(p => [p.id!, p])), [posts]);
  /** 這支片綁的小編貼文（還有效的才算：沒被刪、沒掛別支、沒發布） */
  const boundPost = (a: Asset): Post | undefined => {
    const p = a.plannedPostId ? postById.get(a.plannedPostId) : undefined;
    return p && isWaitingVideoPost(p, new Date(0)) ? p : undefined;
  };
  /** 這支片目前排在哪天：有綁貼文就以貼文為準（小編改日期會跟著走），否則用同事排的日子 */
  const placedDay = (a: Asset): string | null => {
    const p = boundPost(a);
    return p ? postDay(p) : (a.plannedAirDate || null);
  };

  /** 同事排好的片（綁了貼文或排了日子）預設鎖住，見 unlockedIds */
  const isLocked = (a: Asset) => !!(boundPost(a) || a.plannedAirDate) && !unlockedIds.has(a.id!);

  const unplacedCount = (vid: string) => pending.filter(a => a.vendorId === vid && !placedDay(a)).length;
  // 預設停在第一個還有片沒排的 IP
  const vendorId = vendorPick ?? (ipVendors.find(v => unplacedCount(v.id!) > 0) ?? ipVendors[0])?.id ?? null;
  const vendor = vendors.find(v => v.id === vendorId);

  const today = startOfDay(new Date());
  const gridDays = eachDayOfInterval({ start: startOfWeek(monthCursor), end: endOfWeek(endOfMonth(monthCursor)) });
  const mine = pending.filter(a => a.vendorId === vendorId);
  // 成片排最上面（現在就能上），毛片照剪輯順序
  const unplaced = mine.filter(a => !placedDay(a))
    .sort((x, y) => Number(!deliveredIds.has(x.id!)) - Number(!deliveredIds.has(y.id!)) || compareRawEditOrder(x, y));
  const myVideoPosts = posts.filter(p => p.vendorId === vendorId && p.contentType !== 'post' && p.scheduledAt);
  /**
   * 這個月要畫成橘色的日子（固定發片日、挪過來的、手動加的，加上小編的影片貼文日）。
   * 只管顯示；遞補和期限仍然只在 SUPPLY_HORIZON_DAYS 內算，那裡要跟剪輯師畫面一致。
   */
  /** 這個月畫得出來的發片日：日子 → 那一格（固定發片日的 × 要拿它記「這次不發」） */
  const shownSlots = useMemo(() => {
    const map = new Map<string, PlannedSlot>();
    if (!vendor) return map;
    listPlannedSlots({
      vendors: slotVendors([vendor]), moves: slotMoves, dismissed: dismissedHabits, extras: extraSlots, posts,
      rangeStart: gridDays[0], rangeEnd: gridDays[gridDays.length - 1], contentType: 'video', fulfilledWindowDays: 1,
    }).forEach(s => { if (!map.has(s.toDate)) map.set(s.toDate, s); });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor, slotMoves, dismissedHabits, extraSlots, posts, monthCursor]);
  /** 這個 IP 手動加的發片日，日子 → extraSlots id（刪除用） */
  const extraByDay = new Map(extraSlots.filter(x => x.vendorId === vendorId).map(x => [x.date, x.id!]));
  // 有合約支數卻沒設固定發片日：只有小編貼文和手動加的日子算發片日，系統不會自己補
  // 冷凍沒填解凍日的 IP 預排不會算（slotVendors），加了也沒用
  const canAddSlot = !!vendor && slotVendors([vendor]).length > 0;
  const noHabits = !!vendor && (vendor.monthlyTargetVideos ?? 0) > 0 && !(vendor.postingHabits?.length);

  const changeExtra = async (write: () => Promise<void>, done: string) => {
    try {
      await write();
      toast.success(done);
    } catch (error) {
      console.error('發片日寫入失敗:', error);
      toast.error('沒有存到，請再試一次');
    }
  };

  /**
   * 寫入一支片的位置。綁到某篇貼文時，原本綁那篇的片要退回待排（一篇只配一支）。
   * ⚠️ 用 batch：兩支片的改動要一起成功，不然會短暫出現兩支綁同一篇。
   */
  const place = async (assetId: string, target: Target) => {
    setSelectedId(null);
    setHoverKey(null);
    const a = pending.find(x => x.id === assetId);
    if (!a) return;
    if (a.vendorId !== vendorId) return;
    if (target && target.date < today) return;
    const nextDay = target ? format(target.date, 'yyyy-MM-dd') : null;
    let nextPost = target?.postId ?? null;
    if ((a.plannedPostId || null) === nextPost && (a.plannedAirDate || null) === nextDay) return;
    if (isLocked(a)) { toast.error(`「${a.title}」已經排好了，要換先按「解鎖」`); return; }
    // 那篇貼文已經綁了別支、而且那支還鎖著：不能直接擠掉
    const holder = nextPost ? pending.find(x => x.id !== assetId && x.plannedPostId === nextPost) : undefined;
    if (holder && isLocked(holder)) { toast.error(`那篇已經排了「${holder.title}」，要換先把它解鎖`); return; }

    setBusyId(assetId);
    try {
      const batch = writeBatch(db);
      // 自動建的待補中貼文（使用者 10-21，見 boardPosts.ts）：那天沒有小編貼文就建一篇綁上；
      // 換到別天就搬同一篇；拉回左邊或改綁小編的貼文，就把系統建、沒人動過的那篇刪掉。
      const oldPost = a.plannedPostId ? posts.find(p => p.id === a.plannedPostId) : undefined;
      const oldAuto = isUntouchedAutoPost(oldPost) ? oldPost : undefined;
      let createdPost = false;
      if (target && !nextPost && vendor) {
        if (oldAuto) {
          batch.update(doc(db, 'posts', oldAuto.id!), movedSchedule(oldAuto, target.date));
          nextPost = oldAuto.id!;
        } else {
          const ref = doc(collection(db, 'posts'));
          batch.set(ref, buildAutoPost(a, vendor, target.date, auth.currentUser?.uid || ''));
          nextPost = ref.id;
          createdPost = true;
        }
      } else if (oldAuto && oldAuto.id !== nextPost) {
        batch.delete(doc(db, 'posts', oldAuto.id!));
      }
      batch.update(doc(db, 'assets', assetId), {
        plannedAirDate: nextDay ?? deleteField(),
        plannedPostId: nextPost ?? deleteField(),
        // 排的當下期限已過＝剪輯師看到「盡快」不是「已超過」（editorQueue.ts 的 deadlineSince）
        plannedAirSetAt: nextDay ? new Date().toISOString() : deleteField(),
      });
      const bumped = nextPost ? pending.find(x => x.id !== assetId && x.plannedPostId === nextPost) : undefined;
      if (bumped) batch.update(doc(db, 'assets', bumped.id!), { plannedAirDate: deleteField(), plannedPostId: deleteField(), plannedAirSetAt: deleteField() });
      // 擠掉別支、而那篇是系統建的：標題換成新這支的片名，不然貼文管理上的標題跟片對不起來
      const targetAuto = nextPost && !createdPost ? posts.find(p => p.id === nextPost) : undefined;
      if (bumped && targetAuto && isUntouchedAutoPost(targetAuto)) batch.update(doc(db, 'posts', targetAuto.id!), { title: a.title, autoTitle: a.title });
      await batch.commit();
      if (createdPost) toast.success(`貼文管理已建一篇 ${format(target!.date, 'M/d')} 待補中，成片通過後會自動掛上`);
      if (bumped) toast(`「${bumped.title}」退回左邊（一篇貼文只配一支片）`);
      // 放到新位置就鎖回去
      setUnlockedIds(prev => { const next = new Set(prev); next.delete(assetId); return next; });
    } catch (error) {
      console.error('排上片日失敗:', error);
      toast.error('沒有存到，請再試一次');
    } finally {
      setBusyId(null);
    }
  };

  /** 放到某一天（不是某篇貼文上）：那天有還沒配片的小編貼文就綁最早那篇，否則只記日子 */
  const placeOnDay = (assetId: string, d: Date) => {
    const dayStr = format(d, 'yyyy-MM-dd');
    const open = myVideoPosts
      .filter(p => postDay(p) === dayStr && isWaitingVideoPost(p, today) && !pending.some(x => x.id !== assetId && x.plannedPostId === p.id))
      .sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt));
    void place(assetId, { date: d, postId: open[0]?.id ?? null });
  };

  const onDragStart = (e: DragEvent, assetId: string) => {
    e.dataTransfer.setData('text/plain', assetId);
    e.dataTransfer.effectAllowed = 'move';
  };
  const over = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (hoverKey !== key) setHoverKey(key);
  };
  const dragged = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); return e.dataTransfer.getData('text/plain'); };

  /**
   * 一支片的方框。dashed＝系統遞補，還沒有人親手排。
   * ⚠️ 寫成函式不寫成元件：元件定義在 render 裡每次都是新型別，拖到一半重整會整顆重掛。
   */
  const chip = (a: Asset, opts: { key?: string; dashed?: boolean; airDate?: Date; placed?: 'post' | 'day' } = {}) => {
    const { dashed = false, airDate, placed } = opts;
    const isStock = deliveredIds.has(a.id!);
    // 成片已經交了，沒有交片期限
    const deadline = airDate && !isStock ? deliveryDeadline(airDate) : null;
    const late = deadline ? differenceInCalendarDays(deadline, today) < 0 : false;
    const selected = selectedId === a.id;
    // 左邊待排區的片如果已經被系統補在某一天，直接講出來 —— 不然同一支在兩邊各出現一次，看起來像重複
    const autoAt = !airDate ? autoDateOf.get(a.id!) : undefined;
    const locked = !!placed && isLocked(a);
    return (
      <div
        key={opts.key ?? a.id}
        draggable={busyId !== a.id && !locked}
        onDragStart={e => onDragStart(e, a.id!)}
        onDragEnd={() => setHoverKey(null)}
        onClick={e => { e.stopPropagation(); if (!locked) setSelectedId(selected ? null : a.id!); }}
        title={a.title}
        className={[
          'rounded-lg px-2 py-1 text-left select-none transition-shadow',
          locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
          // 三種一眼分得出來：同事排定的＝深色粗框＋底色＋「已綁」標籤；系統暫補＝虛線淡色；左邊待排＝白卡（使用者 10-20）
          placed ? 'border-2 border-[#5A5A40] bg-[#5A5A40]/10 shadow-sm text-gray-900'
            : dashed ? 'border border-dashed border-[#5A5A40]/40 bg-white/70 text-gray-500'
              : 'border border-[#5A5A40]/20 bg-white shadow-sm text-gray-800',
          selected ? 'ring-2 ring-[#5A5A40]' : 'hover:shadow-md',
          busyId === a.id ? 'opacity-40' : '',
        ].join(' ')}
      >
        {placed && (
          <div className="flex items-center gap-0.5 text-[11px] font-bold text-[#5A5A40] whitespace-nowrap">
            {locked ? <Lock size={11} className="shrink-0" /> : <Unlock size={11} className="shrink-0" />}
            {placed === 'post' ? '已綁貼文' : '已排這天'}
            {confirmUnlockId === a.id ? (
              <span className="ml-auto flex items-center gap-1">
                <button type="button" onClick={e => { e.stopPropagation(); setUnlockedIds(prev => new Set(prev).add(a.id!)); setConfirmUnlockId(null); }} className="px-1.5 rounded bg-[#5A5A40] text-white">解鎖</button>
                <button type="button" onClick={e => { e.stopPropagation(); setConfirmUnlockId(null); }} className="px-1 rounded text-gray-500 hover:bg-black/5">取消</button>
              </span>
            ) : locked ? (
              <button type="button" onClick={e => { e.stopPropagation(); setConfirmUnlockId(a.id!); }} className="ml-auto font-normal text-gray-500 underline underline-offset-2 hover:text-[#5A5A40]">
                解鎖
              </button>
            ) : (
              <button type="button" onClick={e => { e.stopPropagation(); setUnlockedIds(prev => { const n = new Set(prev); n.delete(a.id!); return n; }); }} className="ml-auto font-normal text-gray-500 underline underline-offset-2 hover:text-[#5A5A40]">
                鎖回
              </button>
            )}
          </div>
        )}
        {confirmUnlockId === a.id && <p className="text-[11px] text-gray-500 whitespace-normal">解鎖後可以拖到別天或拖回左邊</p>}
        <div className="flex items-center gap-1 min-w-0">
          {a.isUrgent && <Flame size={12} className="text-orange-600 shrink-0" />}
          <span className="text-[13px] font-bold truncate">{a.title}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
          {isStock && <span className="text-sky-700 font-bold">成片</span>}
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
    <div className={embedded ? 'flex h-[calc(100vh-150px)] min-h-[560px]' : 'fixed inset-0 bg-black/50 z-50 p-2 sm:p-4 flex'}>
      <div className={`bg-[#F5F5F0] rounded-2xl w-full flex flex-col overflow-hidden ${embedded ? 'border border-black/5' : 'shadow-xl'}`}>
        {/* 標題列。內嵌在素材資料庫時省掉：上面的子分頁已經寫了「排上片日」，多一列會把月曆往下擠（使用者 10-20） */}
        {!embedded && <div className="bg-white flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-black/5">
          <div className="min-w-0">
            <h3 className="text-lg font-bold serif text-[#5A5A40] flex items-center gap-2">
              <CalendarDays size={18} /> 排上片日
            </h3>
            <p className="text-[13px] text-gray-500 truncate">
              把左邊的片拖到那一天或小編的貼文上＝預計那天上，拖回左邊＝取消。剪輯師交片期限＝上片日前 {EDIT_LEAD_DAYS} 天。
            </p>
          </div>
          {onClose && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 shrink-0" aria-label="關閉">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>}

        {/* IP 篩選：比照社群日曆的按鈕列 */}
        <div className={`bg-white px-4 sm:px-6 ${embedded ? 'py-2' : 'py-3'} border-b border-black/5 flex items-center gap-2 overflow-x-auto`}>
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
          {embedded && (
            <span
              className="ml-auto shrink-0 flex items-center gap-1 text-[12px] text-gray-400 whitespace-nowrap cursor-help"
              title={`把左邊的片拖到那一天或小編的貼文上＝預計那天上，拖回左邊＝取消。剪輯師交片期限＝上片日前 ${EDIT_LEAD_DAYS} 天。`}
            >
              <Info size={13} /> 怎麼用
            </span>
          )}
        </div>

        {!vendor ? (
          <p className="text-center text-gray-400 py-16">目前沒有要排的 IP。</p>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 p-3 sm:p-4 overflow-y-auto lg:overflow-hidden">
            {/* 左：還沒排上片日（拖回這裡＝清掉上片日與綁定） */}
            <div
              onDragOver={over('tray')}
              onDrop={e => { const id = dragged(e); if (id) void place(id, null); }}
              onClick={() => { if (selectedId) void place(selectedId, null); }}
              className={`lg:w-64 shrink-0 bg-white rounded-2xl border p-3 flex flex-col lg:min-h-0 ${hoverKey === 'tray' ? 'border-[#5A5A40]/40' : 'border-black/5'}`}
            >
              <p className="text-[13px] font-bold text-[#5A5A40] mb-2 whitespace-nowrap">
                還沒排上片日 <span className="font-normal text-gray-500">{unplaced.length} 支</span>
              </p>
              <div className="flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-x-visible lg:overflow-y-auto lg:min-h-0 pb-1">
                {unplaced.length === 0
                  ? <p className="text-[13px] text-gray-400">{vendor.name} 的毛片都排好了。</p>
                  : unplaced.map(a => <div key={a.id} className="w-44 lg:w-auto shrink-0">{chip(a)}</div>)}
              </div>
            </div>

            {/* 右：月曆 */}
            <div className="flex-1 min-w-0 bg-white rounded-2xl border border-black/5 flex flex-col lg:min-h-0 overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-black/5">
                <span className="text-[15px] font-bold serif text-[#5A5A40] whitespace-nowrap">{format(monthCursor, 'yyyy年M月')}</span>
                {noHabits && !selectedId && (
                  <span className="flex-1 min-w-0 text-[12px] text-gray-500 truncate" title="這個 IP 沒設固定發片日，只有小編排好的貼文和加上去的發片日會算，系統不會自動遞補。">
                    這個 IP 沒設固定發片日，只有小編排好的貼文和加上去的發片日會算，系統不會自動遞補。
                  </span>
                )}
                {selectedId && (
                  <span className="flex-1 min-w-0 text-[13px] text-[#5A5A40] font-bold truncate">
                    已選「{pending.find(a => a.id === selectedId)?.title}」，點一天放下
                  </span>
                )}
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setMonthCursor(m => addMonths(m, -1))} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100" aria-label="往前">
                    <ChevronLeft size={18} />
                  </button>
                  <button onClick={() => setMonthCursor(startOfMonth(new Date()))} className="px-2 py-1 rounded-lg text-[13px] font-bold text-gray-600 hover:bg-gray-100">今天</button>
                  <button onClick={() => setMonthCursor(m => addMonths(m, 1))} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100" aria-label="往後">
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-7 border-b border-black/5">
                {WEEKDAYS.split('').map(w => (
                  <div key={w} className="py-2 text-center text-[13px] font-bold text-gray-500">{w}</div>
                ))}
              </div>
              {/* 每週一樣高（使用者 10-20：過去的週壓矮很醜，要統一） */}
              <div className="grid grid-cols-7 auto-rows-[minmax(104px,1fr)] flex-1 lg:min-h-0 lg:overflow-y-auto">
                {gridDays.map(d => {
                  const dateStr = format(d, 'yyyy-MM-dd');
                  const past = d < today;
                  // ⚠️ 不能只看 demandsByCell：那份只算到今天起 SUPPLY_HORIZON_DAYS（跟剪輯師同一個視窗），
                  //    翻到下個月橘色就全部不見（使用者 10-20）。顯示用另外照這個月算。
                  const isSlotDay = demandsByCell.has(`${vendorId}|${dateStr}`) || shownSlots.has(dateStr);
                  const dayPosts = myVideoPosts.filter(p => postDay(p) === dateStr).sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt));
                  // 只排了日子、沒綁貼文的片
                  const loose = mine.filter(a => !boundPost(a) && a.plannedAirDate === dateStr);
                  // 預排那一格（沒有小編貼文）的系統遞補
                  const slotRows = Array.from<EditorQueueRow>(queueByKey.values()).filter(r =>
                    r.vendorId === vendorId && r.key.startsWith('slot_') && r.date && isSameDay(r.date, d));
                  return (
                    <div
                      key={dateStr}
                      onDragOver={past ? undefined : over(dateStr)}
                      onDrop={past ? undefined : e => { const id = dragged(e); if (id) placeOnDay(id, d); }}
                      onClick={() => { if (selectedId && !past) placeOnDay(selectedId, d); }}
                      className={[
                        'group/day border-r border-b border-black/5 p-1.5 min-w-0 space-y-1 transition-colors',
                        isSameMonth(d, monthCursor) ? '' : 'bg-gray-50/50',
                        past ? 'bg-gray-50/80 opacity-50' : isSlotDay ? 'bg-orange-50/60' : '',
                        hoverKey === dateStr ? '!bg-[#5A5A40]/10' : '',
                        selectedId && !past ? 'cursor-pointer hover:bg-[#5A5A40]/5' : '',
                      ].join(' ')}
                    >
                      <div className="flex items-center gap-1">
                        <span className={`text-[13px] font-bold w-6 h-6 flex items-center justify-center rounded-full shrink-0 ${isSameDay(d, today) ? 'bg-[#5A5A40] text-white' : 'text-gray-500'}`}>
                          {d.getDate() === 1 ? format(d, 'M/d') : d.getDate()}
                        </span>
                        {isSlotDay && !past && <span className="text-[12px] text-orange-700 truncate">{extraByDay.has(dateStr) ? '加的發片日' : '發片日'}</span>}
                        {/* 固定發片日也能拿掉這一次（使用者 10-22：月片數到了，系統補的片拿不掉）。
                            跟社群日曆刪預排同一筆紀錄（dismissPlannedSlot），兩邊一致 */}
                        {!past && !extraByDay.has(dateStr) && shownSlots.get(dateStr) && !shownSlots.get(dateStr)!.extraId && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); if (window.confirm(`${format(d, 'M/d')} 這次不發片？

這天的發片日會拿掉，系統補上的片會退回去等下一個發片日。`)) void changeExtra(() => dismissPlannedSlot(shownSlots.get(dateStr)!), `${format(d, 'M/d')} 這次不發片`); }}
                            className="ml-auto p-0.5 rounded text-orange-700 hover:bg-orange-100 shrink-0"
                            aria-label="這天這次不發片"
                          >
                            <X size={12} />
                          </button>
                        )}
                        {!past && extraByDay.has(dateStr) && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); void changeExtra(() => removeExtraSlot(extraByDay.get(dateStr)!), '已刪除這個發片日'); }}
                            className="ml-auto p-0.5 rounded text-orange-700 hover:bg-orange-100 shrink-0"
                            aria-label="刪除這個加的發片日"
                          >
                            <X size={12} />
                          </button>
                        )}
                        {!past && !isSlotDay && dayPosts.length === 0 && canAddSlot && vendor && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); void changeExtra(() => addExtraSlot(vendor, d), `${format(d, 'M/d')} 加了一個發片日`); }}
                            className="ml-auto hidden group-hover/day:flex items-center text-[12px] text-orange-700 px-1 rounded hover:bg-orange-100 whitespace-nowrap shrink-0"
                          >
                            <Plus size={12} />發片日
                          </button>
                        )}
                      </div>

                      {/* 小編排好的貼文：已掛片的只列標題；還在等片的可以把毛片拖上去綁定。
                          ⚠️ 已經過去的整週只留日期：那幾週的「已排」標籤把本週擠到畫面下面（使用者 10-20 兩次說月曆太低） */}
                      {dayPosts.map(p => {
                        if (!isWaitingVideoPost(p, new Date(0))) {
                          return <p key={p.id} title={p.title} className="text-[12px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 truncate">已排：{p.title}</p>;
                        }
                        const bound = mine.find(a => a.plannedPostId === p.id);
                        const autoRow = !bound ? queueByKey.get(postDemandId(p.id!)) : undefined;
                        // 同事只排了日子（沒綁這篇）的片，下面 loose 會列，這裡不重複
                        const auto = autoRow?.asset && loose.some(x => x.id === autoRow.asset!.id) ? undefined : autoRow;
                        const pKey = `post|${p.id}`;
                        return (
                          <div
                            key={p.id}
                            onDragOver={past ? undefined : over(pKey)}
                            onDrop={past ? undefined : e => { const id = dragged(e); if (id) void place(id, { date: d, postId: p.id! }); }}
                            onClick={e => { if (selectedId && !past) { e.stopPropagation(); void place(selectedId, { date: d, postId: p.id! }); } }}
                            className={`rounded-lg p-1 space-y-1 ${bound ? 'bg-blue-50/70' : 'border border-dashed border-blue-200 bg-blue-50/30'} ${hoverKey === pKey ? 'ring-2 ring-blue-300' : ''}`}
                          >
                            <p title={p.title} className="text-[12px] text-blue-700 truncate px-0.5">
                              小編：{p.title}{!bound && auto?.kind === 'no_material' ? '・等片' : ''}
                            </p>
                            {bound && chip(bound, { airDate: d, placed: 'post' })}
                            {!bound && auto?.kind === 'to_edit' && auto.asset && chip(auto.asset, { key: auto.key, airDate: d, dashed: true })}
                            {!bound && auto?.kind === 'has_stock' && auto.asset && chip(auto.asset, { key: auto.key, airDate: d, dashed: true })}
                          </div>
                        );
                      })}

                      {/* 沒有小編貼文的日子：同事只排了日子的片＋預排的系統遞補 */}
                      {loose.map(a => chip(a, { airDate: d, placed: 'day' }))}
                      {slotRows.map(r => r.asset && loose.some(a => a.id === r.asset!.id)
                        ? null // 同事排在這天的片上面已經列過
                        : (r.kind === 'to_edit' || r.kind === 'has_stock') && r.asset
                          ? chip(r.asset, { key: r.key, airDate: d, dashed: true })
                          : r.kind === 'no_material' && !past
                            ? <p key={r.key} className="text-[12px] px-1 text-amber-700">沒片</p>
                            : null)}
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
