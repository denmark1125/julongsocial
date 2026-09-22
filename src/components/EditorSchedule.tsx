import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import {
  Asset, DismissedHabit, PlannedSlotMove, Post, ShootBooking, UserProfile, Vendor,
} from '../types';
import { trackedVendors, visibleVendors } from '../lib/vendorStatus';
import { listPlannedSlots } from '../lib/plannedSlots';
import {
  buildSupplyPlan, buildHorizonDemands, describeSupply,
  postDemandId, slotDemandId, SUPPLY_HORIZON_DAYS, SupplyAssignment,
} from '../lib/materialSupply';
import {
  addDays, addMonths, eachDayOfInterval, endOfMonth, format, getDay,
  isSameDay, isSameMonth, parseISO, startOfDay, startOfMonth, subMonths,
} from 'date-fns';
import {
  CalendarDays, ChevronLeft, ChevronRight, Scissors, CheckCircle2,
  Clock, Camera, AlertTriangle, Minus, Video, Image as ImageIcon,
} from 'lucide-react';
import { clsx } from 'clsx';

/**
 * 剪輯師端的「上片排程」——唯讀。
 *
 * 為什麼要有這一頁：剪輯師原本只看得到一疊待剪的片，看不到「這些片是為了哪一天」，
 * 也看不到「哪幾天還沒有片」。那些資訊全在小編的社群日曆裡，他進不去。
 *
 * ⚠️ **絕對不要在這裡重算排程或素材狀態。** 預排時段一律走 listPlannedSlots()、
 *    素材狀態一律走 buildSupplyPlan()/describeSupply()，跟社群日曆與上片排程表導出
 *    是同一套程式碼。這一頁只是換個地方顯示同一個答案 —— 兩邊講不同的話，
 *    剪輯師就會回頭來問小編，等於這功能白做。
 * ⚠️ 唯讀：不能拖、不能刪、不能建貼文。剪輯師對排程沒有決定權，
 *    給他可以按的東西只會製造「誰動了排程」的爭議。
 */

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 一格要顯示的東西：已經排定的貼文，或還空著的預排時段 */
interface ScheduleItem {
  id: string;
  vendorId: string;
  vendorName: string;
  date: Date;
  time: string;
  contentType: 'video' | 'post';
  title: string;
  /** 這格已經是一則貼文（有標題、有平台），不是只留著的時段 */
  isPost: boolean;
  postStatus?: Post['status'];
}

const TONE_TEXT: Record<string, string> = {
  editor: 'text-amber-600',
  waiting: 'text-sky-600',
  alert: 'text-red-600',
  idle: 'text-gray-500',
};

const TONE_CHIP: Record<string, string> = {
  editor: 'bg-amber-50 text-amber-700 border-amber-100',
  waiting: 'bg-sky-50 text-sky-700 border-sky-100',
  alert: 'bg-red-50 text-red-700 border-red-100',
  idle: 'bg-gray-50 text-gray-500 border-gray-200',
};

function SupplyIcon({ kind, className }: { kind?: SupplyAssignment['kind']; className?: string }) {
  const Icon = {
    attached: CheckCircle2,
    ready: CheckCircle2,
    in_progress: Clock,
    to_edit: Scissors,
    booked: Camera,
    booked_late: AlertTriangle,
    none: AlertTriangle,
    not_video: Minus,
  }[kind || 'not_video'];
  return <Icon className={className} />;
}

export default function EditorSchedule({ userProfile }: { userProfile: UserProfile | null }) {
  const vendorIds = useMemo(() => userProfile?.assignedVendorIds || [], [userProfile?.assignedVendorIds]);
  const vendorIdsKey = [...vendorIds].sort().join(',');

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [bookings, setBookings] = useState<ShootBooking[]>([]);
  const [slotMoves, setSlotMoves] = useState<PlannedSlotMove[]>([]);
  const [dismissedHabits, setDismissedHabits] = useState<DismissedHabit[]>([]);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedVendorId, setSelectedVendorId] = useState<string>('all');
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  // 手機開在清單：月曆格子在窄螢幕要橫向捲，單手看排程很痛苦
  const [viewMode, setViewMode] = useState<'calendar' | 'list'>(
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'calendar'
  );

  // 逐廠商訂閱單一文件／逐廠商查詢，不用整個 collection ——
  // 規則對 editor 是逐文件核可，未範圍限定的 collection() 查詢會整個 permission-denied。
  useEffect(() => {
    if (vendorIds.length === 0) { setVendors([]); return; }
    const unsubs = vendorIds.map(vid => onSnapshot(doc(db, 'vendors', vid), snap => {
      setVendors(prev => {
        const others = prev.filter(v => v.id !== vid);
        return snap.exists() ? [...others, { id: snap.id, ...snap.data() } as Vendor] : others;
      });
    }));
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  useEffect(() => {
    if (vendorIds.length === 0) { setPosts([]); setAssets([]); setBookings([]); setSlotMoves([]); return; }

    const subscribe = <T,>(name: string, setter: Dispatch<SetStateAction<T[]>>) =>
      vendorIds.map(vid => onSnapshot(
        query(collection(db, name), where('vendorId', '==', vid)),
        snap => setter(prev => [
          ...prev.filter((row: any) => row.vendorId !== vid),
          ...snap.docs.map(d => ({ id: d.id, ...d.data() } as T)),
        ])
      ));

    const unsubs = [
      ...subscribe<Post>('posts', setPosts),
      ...subscribe<Asset>('assets', setAssets),
      ...subscribe<ShootBooking>('shootBookings', setBookings),
      // 小編把預排拖到別天的紀錄。沒有它，剪輯師看到的預排會停在被拖走前的舊日子，
      // 跟小編的日曆對不起來 —— 這正是這一頁最該避免的事。
      ...subscribe<PlannedSlotMove>('plannedSlotMoves', setSlotMoves),
    ];
    return () => unsubs.forEach(u => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorIdsKey]);

  useEffect(() => {
    // dismissedHabits 沒有 vendorId 以外的範圍限制，規則對所有登入者開放讀
    const unsub = onSnapshot(collection(db, 'dismissedHabits'), snap => {
      setDismissedHabits(snap.docs.map(d => ({ id: d.id, ...d.data() } as DismissedHabit)));
    });
    return () => unsub();
  }, []);

  const myVendors = useMemo(() => visibleVendors(vendors), [vendors]);
  const shownVendors = useMemo(
    () => (selectedVendorId === 'all' ? myVendors : myVendors.filter(v => v.id === selectedVendorId)),
    [myVendors, selectedVendorId]
  );

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);

  /** 這個月要畫的預排（含被挪過來的）。冷凍/終止的廠商在共用層就排掉了。 */
  const monthSlots = useMemo(() => listPlannedSlots({
    vendors: trackedVendors(shownVendors),
    moves: slotMoves,
    dismissed: dismissedHabits,
    posts,
    rangeStart: monthStart,
    rangeEnd: monthEnd,
    fulfilledWindowDays: 1,
  }), [shownVendors, slotMoves, dismissedHabits, posts, monthStart, monthEnd]);

  /**
   * 素材狀態。
   * ⚠️ 配對用的是「今天起 SUPPLY_HORIZON_DAYS 天」這個固定視窗，**不是**現在翻到的月份 ——
   *    這樣剪輯師翻到哪個月，同一天的答案都跟小編導出的排程表一模一樣。
   */
  const supplyPlan = useMemo(() => {
    const now = new Date();
    return buildSupplyPlan({
      demands: buildHorizonDemands({
        posts,
        slots: listPlannedSlots({
          vendors: trackedVendors(myVendors),
          moves: slotMoves,
          dismissed: dismissedHabits,
          posts,
          rangeStart: now,
          rangeEnd: addDays(now, SUPPLY_HORIZON_DAYS),
          fulfilledWindowDays: 1,
        }),
        now,
      }),
      assets,
      posts,
      bookings,
    });
  }, [posts, assets, bookings, myVendors, slotMoves, dismissedHabits]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, ScheduleItem[]>();
    const push = (item: ScheduleItem) => {
      const key = format(item.date, 'yyyy-MM-dd');
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    };

    for (const post of posts) {
      if (!post.scheduledAt) continue;
      const date = parseISO(post.scheduledAt);
      if (date < monthStart || date > addDays(monthEnd, 1)) continue;
      const vendor = shownVendors.find(v => v.id === post.vendorId);
      if (!vendor) continue;
      push({
        id: postDemandId(post.id!),
        vendorId: post.vendorId,
        vendorName: vendor.name,
        date,
        time: format(date, 'HH:mm'),
        contentType: post.contentType === 'post' ? 'post' : 'video',
        title: post.title,
        isPost: true,
        postStatus: post.status,
      });
    }

    for (const slot of monthSlots) {
      push({
        id: slotDemandId(slot),
        vendorId: slot.vendorId,
        vendorName: slot.vendorName,
        date: slot.date,
        time: slot.time,
        contentType: slot.habit.contentTypes?.[0] === 'post' ? 'post' : 'video',
        title: '尚未決定發什麼',
        isPost: false,
      });
    }

    for (const list of map.values()) list.sort((a, b) => a.date.getTime() - b.date.getTime());
    return map;
  }, [posts, monthSlots, shownVendors, monthStart, monthEnd]);

  const calendarDays = useMemo(() => {
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const padding = Array.from({ length: getDay(monthStart) }).map(() => null);
    return [...padding, ...days] as (Date | null)[];
  }, [monthStart, monthEnd]);

  // 清單是「接下來要交什麼」，不是流水帳：看當月時從今天開始列，
  // 不然手機上要先滑過月初那幾天已經過去的排程才看得到重點。翻到別的月份就整月列。
  const listDays = useMemo(() => {
    const today = startOfDay(new Date());
    const from = isSameMonth(monthStart, today) && today > monthStart ? today : monthStart;
    if (from > monthEnd) return [];
    return eachDayOfInterval({ start: from, end: monthEnd })
      .filter(d => (itemsByDay.get(format(d, 'yyyy-MM-dd')) || []).length > 0);
  }, [monthStart, monthEnd, itemsByDay]);

  const detailItems = selectedDay ? (itemsByDay.get(format(selectedDay, 'yyyy-MM-dd')) || []) : [];

  if (vendorIds.length === 0) {
    return (
      <div className="bg-white rounded-3xl shadow-sm border border-black/5 p-12 text-center">
        <CalendarDays className="mx-auto mb-3 text-gray-300" size={32} />
        <p className="text-base font-bold text-gray-500">還沒有指派給你的 IP</p>
        <p className="text-sm text-gray-500 mt-1">請聯絡公司窗口幫你設定</p>
      </div>
    );
  }

  const renderChip = (item: ScheduleItem, size: 'tiny' | 'normal') => {
    const assignment = supplyPlan.assignments.get(item.id);
    // 查不到＝這格在配對視窗外（已經過去，或超過 SUPPLY_HORIZON_DAYS）。
    // 那種格子不該擺一個「—」在那裡當噪音，直接不畫。
    if (!assignment) return null;
    // 圖文本來就不經過剪輯。卡片上已經標了「圖文」，再放一個空空的「—」標籤只是雜訊
    // （表格裡的「—」是必要的佔位，卡片沒有這個需要）。
    if (assignment.kind === 'not_video') return null;
    const supply = describeSupply(assignment);
    if (size === 'tiny') {
      return (
        <span className={clsx('flex items-center gap-0.5 font-bold', TONE_TEXT[supply.tone])}>
          <SupplyIcon kind={assignment.kind} className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{supply.label}</span>
        </span>
      );
    }
    return (
      <span className={clsx('inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[13px] font-bold', TONE_CHIP[supply.tone])}>
        <SupplyIcon kind={assignment.kind} className="w-3 h-3 shrink-0" />
        {supply.label}
        {supply.detail && <span className="font-medium opacity-70">・{supply.detail}</span>}
      </span>
    );
  };

  return (
    // readability-surface：手機點擊區 44px、桌面 24px、輸入框 16px（避免 iOS 自動放大整頁）。
    <div className="readability-surface space-y-4">
      <div className="bg-white rounded-3xl shadow-sm border border-black/5 overflow-hidden">
        <div className="p-4 sm:p-6 flex flex-col sm:flex-row items-center justify-between border-b border-black/5 gap-3">
          <div className="flex items-center justify-between w-full sm:w-auto">
            <h3 className="text-xl font-bold serif flex items-center">
              <CalendarDays size={20} className="mr-2" />
              {format(currentDate, 'yyyy年 MM月')}
            </h3>
            <div className="flex bg-gray-100 p-1 rounded-xl md:hidden ml-3">
              {(['calendar', 'list'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all',
                    viewMode === mode ? 'bg-white text-[#5A5A40] shadow-sm' : 'text-gray-500'
                  )}
                >
                  {mode === 'calendar' ? '日曆' : '清單'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center space-x-1">
            <button onClick={() => setCurrentDate(subMonths(currentDate, 1))} className="p-2 hover:bg-[#F5F5F0] rounded-xl transition-colors">
              <ChevronLeft size={20} />
            </button>
            <button onClick={() => setCurrentDate(new Date())} className="px-4 py-2 text-base font-bold hover:bg-[#F5F5F0] rounded-xl transition-colors">
              今天
            </button>
            <button onClick={() => setCurrentDate(addMonths(currentDate, 1))} className="p-2 hover:bg-[#F5F5F0] rounded-xl transition-colors">
              <ChevronRight size={20} />
            </button>
          </div>
        </div>

        {myVendors.length > 1 && (
          <div className="flex items-center space-x-2 overflow-x-auto px-4 sm:px-6 py-3 border-b border-black/5 scrollbar-hide">
            <button
              onClick={() => setSelectedVendorId('all')}
              className={clsx(
                'px-4 py-1.5 rounded-full text-sm font-bold transition-all whitespace-nowrap border',
                selectedVendorId === 'all' ? 'bg-[#5A5A40] text-white border-[#5A5A40]' : 'bg-white text-gray-500 border-black/5'
              )}
            >
              全部 IP
            </button>
            {myVendors.map(vendor => (
              <button
                key={vendor.id}
                onClick={() => setSelectedVendorId(vendor.id!)}
                className={clsx(
                  'px-4 py-1.5 rounded-full text-sm font-bold transition-all whitespace-nowrap border',
                  selectedVendorId === vendor.id ? 'bg-[#5A5A40] text-white border-[#5A5A40]' : 'bg-white text-gray-500 border-black/5'
                )}
              >
                {vendor.name}
              </button>
            ))}
          </div>
        )}

        {viewMode === 'calendar' ? (
          <div className="overflow-x-auto">
            <div className="min-w-[760px] xl:min-w-0">
              <div className="grid grid-cols-7 border-b border-black/5 bg-gray-50/50">
                {WEEK_LABELS.map(d => (
                  <div key={d} className="p-3 text-center text-[13px] font-bold text-gray-500 uppercase tracking-widest">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 auto-rows-[minmax(110px,auto)]">
                {calendarDays.map((day, idx) => {
                  if (!day) return <div key={`pad-${idx}`} className="bg-gray-50/30 border-r border-b border-black/5" />;
                  const items = itemsByDay.get(format(day, 'yyyy-MM-dd')) || [];
                  const isToday = isSameDay(day, new Date());
                  return (
                    <button
                      key={day.toString()}
                      onClick={() => setSelectedDay(day)}
                      className={clsx(
                        'text-left border-r border-b border-black/5 p-2 min-h-[110px] align-top transition-colors',
                        selectedDay && isSameDay(day, selectedDay) ? 'bg-[#F5F5F0]' : 'hover:bg-gray-50'
                      )}
                    >
                      <div className={clsx(
                        'text-sm font-bold w-6 h-6 flex items-center justify-center rounded-full mb-1',
                        isToday ? 'bg-[#5A5A40] text-white' : 'text-gray-500'
                      )}>
                        {format(day, 'd')}
                      </div>
                      <div className="space-y-1">
                        {items.map(item => (
                          <div
                            key={item.id}
                            className={clsx(
                              'text-[13px] p-1 rounded border leading-tight',
                              item.isPost ? 'bg-white border-black/10' : 'bg-orange-50/60 border-orange-100'
                            )}
                          >
                            <div className="flex items-center gap-1 overflow-hidden text-gray-600">
                              <span className="font-bold shrink-0">{item.time}</span>
                              <span className="truncate font-bold">{item.vendorName}</span>
                            </div>
                            <div className="mt-0.5 text-[13px]">{renderChip(item, 'tiny')}</div>
                          </div>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {listDays.length === 0 && (
              <p className="text-center text-base text-gray-500 py-10">這個月沒有排程</p>
            )}
            {listDays.map(day => (
              <div key={day.toString()} className="space-y-2">
                <div className="flex items-center">
                  <div className={clsx('w-1 h-4 rounded-full mr-2', isSameDay(day, new Date()) ? 'bg-[#5A5A40]' : 'bg-gray-300')} />
                  <span className="text-sm font-bold text-gray-500">
                    {format(day, 'MM月dd日')} ({WEEK_LABELS[getDay(day)]})
                  </span>
                </div>
                {(itemsByDay.get(format(day, 'yyyy-MM-dd')) || []).map(item => (
                  <div key={item.id} className="p-4 rounded-2xl border border-black/5 bg-white shadow-sm">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base font-bold text-[#5A5A40]">{item.time}</span>
                      <span className="text-base font-bold text-gray-700">{item.vendorName}</span>
                      <span className="flex items-center gap-0.5 text-[13px] text-gray-500">
                        {item.contentType === 'post' ? <ImageIcon size={10} /> : <Video size={10} />}
                        {item.contentType === 'post' ? '圖文' : '影片'}
                      </span>
                    </div>
                    <p className={clsx('text-sm mb-2', item.isPost ? 'text-gray-600' : 'text-gray-500 italic')}>{item.title}</p>
                    {renderChip(item, 'normal')}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedDay && viewMode === 'calendar' && (
        <div className="bg-white rounded-3xl shadow-sm border border-black/5 p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-base font-bold text-[#5A5A40]">
              {format(selectedDay, 'MM月dd日')} ({WEEK_LABELS[getDay(selectedDay)]})
              {!isSameMonth(selectedDay, currentDate) && <span className="text-gray-500 font-medium">（其他月份）</span>}
            </h4>
            <button onClick={() => setSelectedDay(null)} className="text-sm font-bold text-gray-500 hover:text-gray-600">關閉</button>
          </div>
          {detailItems.length === 0 ? (
            <p className="text-sm text-gray-500">這天沒有排程</p>
          ) : (
            <div className="space-y-3">
              {detailItems.map(item => (
                <div key={item.id} className="flex flex-col sm:flex-row sm:items-center gap-2 pb-3 border-b border-black/5 last:border-0 last:pb-0">
                  <div className="sm:w-[190px] shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-bold text-[#5A5A40]">{item.time}</span>
                      <span className="text-base font-bold text-gray-700">{item.vendorName}</span>
                    </div>
                    <span className="flex items-center gap-0.5 text-[13px] text-gray-500 mt-0.5">
                      {item.contentType === 'post' ? <ImageIcon size={10} /> : <Video size={10} />}
                      {item.contentType === 'post' ? '圖文' : '影片'}
                    </span>
                  </div>
                  <p className={clsx('flex-1 text-sm', item.isPost ? 'text-gray-600' : 'text-gray-500 italic')}>{item.title}</p>
                  <div className="shrink-0">{renderChip(item, 'normal')}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="text-[13px] text-gray-500 leading-relaxed px-1">
        這頁是唯讀的，內容跟公司內部的社群日曆是同一份資料。
        素材狀態只判斷今天起 {SUPPLY_HORIZON_DAYS} 天內的排程，更遠的顯示「—」。
        排程有問題請直接聯絡窗口，不用在這裡處理。
      </p>
    </div>
  );
}
