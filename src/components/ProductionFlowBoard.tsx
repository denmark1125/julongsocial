import { useEffect, useState, type ReactNode } from 'react';
import { collection, doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import {
  Asset,
  AssetFlowStage,
  Editor,
  Post,
  UserProfile,
  Vendor,
  deriveFlowStage,
  FLOW_STAGE_LABEL,
  FLOW_STAGE_OWNER,
  FLOW_OWNER_LABEL,
} from '../types';
import { buildFlowUpdate, getClientApprovalTarget, getFlowDaysStuck, getFlowDueInfo, isFlowStale, sortFlowColumn } from '../lib/assetFlow';
import { Scissors, UserCheck, PenLine, Clock, Flame, CalendarClock, ThumbsUp } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import toast from 'react-hot-toast';

// 「球在誰手上、卡了幾天」的交棒看板。
// 過去一支片經過剪輯師→藏鏡人→業主→小編四手，每一棒的交接只存在 LINE 對話裡，
// 所以小編常常要排程了才發現沒片，回頭追才知道卡在哪一段。這頁就是把那段對話變成畫面。

// 沒有 'revising'：老闆 2026-08-11 決定業主要改一律走 LINE，系統不做退回流程。
// 型別上仍留著 revising（deriveFlowStage 可能從舊資料推出來），但沒有任何 UI 產生或顯示它。
const COLUMN_ORDER: AssetFlowStage[] = ['to_edit', 'client_review', 'to_upload', 'ready'];

const OWNER_ICON: Record<AssetFlowStage, ReactNode> = {
  to_edit: <Scissors size={11} />,
  client_review: <UserCheck size={11} />,
  revising: <Scissors size={11} />,
  to_upload: <Scissors size={11} />,
  ready: <PenLine size={11} />,
};

const COLUMN_TONE: Record<AssetFlowStage, { head: string; dot: string }> = {
  to_edit: { head: 'text-[#5A5A40]', dot: 'bg-[#5A5A40]' },
  client_review: { head: 'text-violet-700', dot: 'bg-violet-500' },
  revising: { head: 'text-red-600', dot: 'bg-red-500' },
  to_upload: { head: 'text-sky-700', dot: 'bg-sky-500' },
  ready: { head: 'text-green-700', dot: 'bg-green-500' },
};

export default function ProductionFlowBoard({
  vendors,
  assets,
  posts,
  me,
}: {
  vendors: Vendor[];
  assets: Asset[];
  posts: Post[];
  me: UserProfile | null;
}) {
  const [editors, setEditors] = useState<Editor[]>([]);
  const [vendorFilter, setVendorFilter] = useState<string>('all');
  const [editorFilter, setEditorFilter] = useState<string>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(collection(db, 'editors'), (s) =>
      setEditors(s.docs.map(d => ({ id: d.id, ...d.data() } as Editor)))
    );
  }, []);

  const vendorMap = new Map(vendors.map(v => [v.id, v]));
  // 素材可以逐支覆寫剪輯師，沒填的才回退到廠商的負責剪輯師（跟素材資料庫同一套判斷）
  const effectiveEditorId = (a: Asset) => a.editorId || vendorMap.get(a.vendorId)?.editorId || '';
  const editorName = (id: string) => editors.find(e => e.id === id)?.name || '未指派';

  const settledPostIds = new Set(
    posts.filter(p => p.status === 'scheduled' || p.status === 'published').map(p => p.id)
  );

  const inFlow = assets.filter(a =>
    a.type === 'video' &&
    a.status !== 'archived' &&
    // 作廢＝這支不該存在（多半是重複建檔），不該再佔看板欄位
    !a.voidedAt &&
    // 已排程/已發布代表真的用掉了，不再是「在製作中」
    !(a.usedInPostId && settledPostIds.has(a.usedInPostId)) &&
    (vendorFilter === 'all' || a.vendorId === vendorFilter) &&
    (editorFilter === 'all' || effectiveEditorId(a) === editorFilter)
  );

  const columns = COLUMN_ORDER.map(stage => ({
    stage,
    items: sortFlowColumn(inFlow.filter(a => deriveFlowStage(a) === stage), posts),
  }));

  const stuckCount = inFlow.filter(a => isFlowStale(a)).length;

  const advance = async (asset: Asset, to: AssetFlowStage, successMsg: string, note?: string) => {
    setBusyId(asset.id!);
    try {
      await updateDoc(
        doc(db, 'assets', asset.id!),
        buildFlowUpdate(asset, to, {
          byUid: auth.currentUser?.uid,
          byName: me?.displayName || me?.username,
          note,
        })
      );
      toast.success(successMsg);
    } catch (error) {
      console.error('Flow advance failed:', error);
      toast.error('操作失敗，請稍後再試');
    } finally {
      setBusyId(null);
    }
  };

  const toggleUrgent = async (asset: Asset) => {
    try {
      await updateDoc(doc(db, 'assets', asset.id!), { isUrgent: !asset.isUrgent });
    } catch (error) {
      console.error('Toggle urgent failed:', error);
      toast.error('急件標記失敗');
    }
  };

  // 有指派剪輯師的廠商才需要出現在「依剪輯師」篩選裡
  const usedEditorIds = Array.from(new Set(assets.map(effectiveEditorId).filter(Boolean)));

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-lg font-bold serif text-[#5A5A40] flex items-center gap-2">
            <Scissors size={18} /> 製作交棒進度
          </h3>
          <p className="text-[11px] text-gray-400">
            每支片現在球在誰手上、卡了幾天。紅色代表停太久，不用再回頭一個個問。
          </p>
        </div>
        {stuckCount > 0 && (
          <div className="bg-white px-4 py-2 rounded-2xl border border-red-200 shadow-sm flex items-center gap-3">
            <div className="bg-red-50 p-2 rounded-lg text-red-600"><Clock size={16} /></div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">卡住的片</p>
              <p className="text-lg font-bold leading-none">{stuckCount} <span className="text-xs font-normal text-gray-400">支</span></p>
            </div>
          </div>
        )}
      </div>

      {/* 依 IP 或依剪輯師篩選：過去的排序清單是一份全公司共用的順序，
          回答不了「這是哪個剪輯師的工作量」 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-gray-400 w-14 shrink-0">依 IP</span>
          <button
            onClick={() => setVendorFilter('all')}
            className={vendorFilter === 'all'
              ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
              : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
          >
            全部
          </button>
          {vendors.filter(v => v.status !== 'ended').map(v => (
            <button
              key={v.id}
              onClick={() => setVendorFilter(v.id!)}
              className={vendorFilter === v.id
                ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
                : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
            >
              {v.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-gray-400 w-14 shrink-0">依剪輯師</span>
          <button
            onClick={() => setEditorFilter('all')}
            className={editorFilter === 'all'
              ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
              : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
          >
            全部
          </button>
          {usedEditorIds.map(eid => (
            <button
              key={eid}
              onClick={() => setEditorFilter(eid)}
              className={editorFilter === eid
                ? 'px-3 py-1 rounded-full text-[11px] font-bold bg-[#5A5A40] text-white'
                : 'px-3 py-1 rounded-full text-[11px] font-bold bg-white border border-black/5 text-gray-500 hover:text-[#5A5A40]'}
            >
              {editorName(eid)}
            </button>
          ))}
        </div>
      </div>

      {/* 交棒看板 */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        {columns.map(col => {
          const tone = COLUMN_TONE[col.stage];
          const owner = FLOW_STAGE_OWNER[col.stage];
          return (
            <div key={col.stage} className="bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden flex flex-col">
              <div className="px-4 pt-4 pb-3 border-b border-black/5">
                <h4 className={`text-xs font-bold flex items-center gap-2 ${tone.head}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                  {FLOW_STAGE_LABEL[col.stage]}
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-black/5 text-gray-500">
                    {col.items.length}
                  </span>
                </h4>
                <p className="text-[10px] text-gray-400 mt-1">球在 {FLOW_OWNER_LABEL[owner]}</p>
              </div>

              <div className="divide-y divide-black/5 flex-1">
                {col.items.length === 0 ? (
                  <div className="p-6 text-center text-gray-300 italic text-[11px]">—</div>
                ) : (
                  col.items.map(a => {
                    const due = getFlowDueInfo(a, posts);
                    const days = getFlowDaysStuck(a);
                    const stale = isFlowStale(a);
                    return (
                      <div key={a.id} className="p-3 space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[11px] font-bold text-[#5A5A40]">
                            {vendorMap.get(a.vendorId)?.name || '未知IP'}
                          </span>
                          <button
                            onClick={() => toggleUrgent(a)}
                            title={a.isUrgent ? '取消急件' : '標為急件'}
                            className={a.isUrgent
                              ? 'shrink-0 text-red-500'
                              : 'shrink-0 text-gray-300 hover:text-red-400'}
                          >
                            <Flame size={12} />
                          </button>
                        </div>

                        <p className="text-[11px] text-gray-600 leading-snug break-words">{a.title}</p>

                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center gap-1 text-[9.5px] text-gray-400">
                            {OWNER_ICON[col.stage]} {editorName(effectiveEditorId(a))}
                          </span>
                          <span className={stale
                            ? 'inline-flex items-center gap-0.5 text-[9.5px] font-bold text-red-600'
                            : 'inline-flex items-center gap-0.5 text-[9.5px] text-gray-400'}
                          >
                            <Clock size={9} /> {days} 天
                          </span>
                        </div>

                        {due && (
                          <p className={due.overdue
                            ? 'inline-flex items-center gap-1 text-[9.5px] font-bold text-red-600'
                            : due.imminent
                              ? 'inline-flex items-center gap-1 text-[9.5px] font-bold text-amber-600'
                              : 'inline-flex items-center gap-1 text-[9.5px] text-gray-400'}
                          >
                            <CalendarClock size={9} />
                            {format(parseISO(due.scheduledAt), 'MM/dd')} 要上
                            {due.overdue ? ' ⚠ 已逾期' : due.imminent ? ` 剩${due.daysUntil}天` : ''}
                          </p>
                        )}

                        {/* 業主結果只有內部同事回填得了（業主不在系統裡），
                            這是唯一能把「業主到底過了沒」變成系統事實的地方。
                            老闆 2026-08-11 決定拿掉「要改」：業主要改一律走 LINE，系統不介入。 */}
                        {col.stage === 'client_review' && (
                          <div className="flex gap-1.5 pt-1">
                            <button
                              // 剪輯師可能在業主審核期間就先上傳了（我們在 LINE 上請他傳，不等後台）。
                              // 那種情況下業主一通過就等於兩個條件都成立，直接進可排程，不要再叫他按一次。
                              onClick={() => getClientApprovalTarget(a) === 'ready'
                                ? advance(a, 'ready', '業主已通過，這支已上傳過雲端，直接可排程')
                                : advance(a, 'to_upload', '已記錄業主通過，等剪輯師上傳雲端')}
                              disabled={busyId === a.id}
                              className="flex-1 flex items-center justify-center gap-1 bg-green-600 text-white px-2 py-1.5 rounded-lg text-[10px] font-bold hover:bg-green-700 transition-all disabled:opacity-50"
                            >
                              <ThumbsUp size={10} /> 業主通過
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
