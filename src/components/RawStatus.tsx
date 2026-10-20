import { useEffect, useState } from 'react';
import { deleteField, doc, updateDoc } from 'firebase/firestore';
import { format, parseISO } from 'date-fns';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { auth, db } from '../firebase';
import { Asset, EDITOR_REPORT_REASON_LABEL, EditorReportReason } from '../types';
import { assetRawIssue, rawCheckIssue, rawCheckSummary } from '../lib/rawCheck';

/**
 * 待剪片的「素材狀況」：素材自動檢查的結果＋剪輯師回報。2026-10-20 起，見 lib/rawCheck.ts。
 *
 * - mode='editor'（剪輯師卡片）：看得到素材摘要；小字「素材有問題？」可以回報、改、撤回。
 * - mode='internal'（素材資料庫／製作進度）：看得到回報內容＋「已處理」、素材異常＋「重新檢查」。
 *
 * ⚠️ 剪輯師看到的字一律陳述，不派工（見 feedback_editor_facing_wording）。
 * ⚠️ 「素材有問題？」刻意做成不起眼的小字：不擾民，也不要變成跳過的捷徑。
 */
/**
 * 素材檢查的結果還沒定論時（空的、太短、看不到、影片長度還在處理），畫面打開就在背景重查一次。
 * 同事常常先建檔、後來才把檔案丟進資料夾；不自動重查的話剪輯師那邊會一直顯示「資料夾是空的」（使用者 10-20）。
 * ⚠️ 只重查「已經檢查過、但結果還沒定論」的片：沒檢查過的舊素材不在這裡大量補查。
 * ⚠️ 同一個分頁每支片 2 分鐘最多一次（跟後端節流一樣）。
 */
const lastAutoCheck = new Map<string, number>();
const AUTO_RECHECK_MS = 2 * 60 * 1000;
function needsAutoRecheck(asset: Asset): boolean {
  const c = asset.rawCheck;
  if (!c || (!asset.driveFolderId && !asset.url)) return false;
  const unsettled = c.unreadable || !!rawCheckIssue(c) || (c.videoCount > 0 && c.totalSec == null);
  if (!unsettled) return false;
  const since = Date.now() - Math.max(Date.parse(c.checkedAt) || 0, lastAutoCheck.get(asset.id!) || 0);
  return since > AUTO_RECHECK_MS;
}

export default function RawStatus({ asset, mode, myName, large }: {
  asset: Asset;
  mode: 'editor' | 'internal';
  /** 回報人名字（剪輯師） */
  myName?: string;
  /** 電腦版精簡卡用大一號的字 */
  large?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<EditorReportReason | null>(asset.editorReport?.reason ?? null);
  const [note, setNote] = useState(asset.editorReport?.note ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!needsAutoRecheck(asset)) return;
    lastAutoCheck.set(asset.id!, Date.now());
    // 背景重查：成功會直接改到資料庫，畫面跟著即時資料更新；失敗不打擾人
    auth.currentUser?.getIdToken()
      .then(idToken => fetch(`/api/assets/${asset.id}/recheck-raw`, { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } }))
      .catch(() => {});
  }, [asset.id, asset.rawCheck?.checkedAt]);

  const summary = rawCheckSummary(asset.rawCheck);
  const issue = assetRawIssue(asset);
  const report = asset.editorReport && !asset.editorReport.resolvedAt ? asset.editorReport : null;
  const text = large ? 'text-[13px] lg:text-[15px]' : 'text-[13px]';

  const write = async (data: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await updateDoc(doc(db, 'assets', asset.id!), data);
      toast.success(done);
      setOpen(false);
    } catch (e: any) {
      console.error('素材狀況寫入失敗:', e);
      toast.error('沒有存到，請再試一次');
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!reason) return;
    const trimmed = note.trim().slice(0, 500);
    void write({
      editorReport: {
        reason,
        at: new Date().toISOString(),
        ...(myName ? { byName: myName } : {}),
        // 規則不收空字串，沒寫就整個不帶
        ...(trimmed ? { note: trimmed } : {}),
      },
    }, '已回報，內部會看到');
  };

  const recheck = async () => {
    setBusy(true);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const res = await fetch(`/api/assets/${asset.id}/recheck-raw`, {
        method: 'POST', headers: { Authorization: `Bearer ${idToken}` },
      });
      const data: any = await res.json().catch(() => null);
      // 本機預覽（只開 vite、沒有後端）會回 404 網頁，不是 JSON —— 講清楚，不要只丟一句「檢查失敗」
      if (!data) throw new Error(res.status === 404 ? '這裡連不到後端（本機預覽），請到正式站按' : `檢查失敗（${res.status}）`);
      if (!res.ok) throw new Error(data.message || data.error || `檢查失敗（${res.status}）`);
      const next = rawCheckIssue(data.rawCheck);
      toast.success(next ? `檢查完了：${next}` : data.rawCheck?.unreadable ? '系統看不到這個資料夾的內容' : '檢查完了，素材正常');
    } catch (e: any) {
      toast.error(e?.message || '檢查失敗');
    } finally {
      setBusy(false);
    }
  };

  const reportLine = report && (
    <p className={`${text} ${mode === 'internal' ? 'text-red-600 font-bold' : 'text-amber-700'}`}>
      {mode === 'internal' ? '剪輯師回報' : '已回報'}：{EDITOR_REPORT_REASON_LABEL[report.reason]}
      {report.note ? `－${report.note}` : ''}
      <span className="font-normal text-gray-400">（{format(parseISO(report.at), 'M/d')}{mode === 'internal' && report.byName ? `・${report.byName}` : ''}）</span>
    </p>
  );

  return (
    <div className="mt-1.5 space-y-1">
      {issue ? (
        <p className={`${text} font-bold text-amber-700 flex items-center gap-1`}>
          <AlertTriangle size={12} className="shrink-0" /> {issue}
          {mode === 'internal' && (asset.driveFolderId || asset.url) && (
            <button type="button" onClick={recheck} disabled={busy} className="ml-1 inline-flex items-center gap-0.5 font-normal text-gray-500 hover:text-[#5A5A40] underline underline-offset-2 disabled:opacity-50 whitespace-nowrap">
              <RefreshCw size={11} /> 重新檢查
            </button>
          )}
        </p>
      ) : summary ? (
        <p className={`${text} text-gray-500`}>{summary}</p>
      ) : mode === 'internal' && asset.rawCheck?.unreadable ? (
        // 認領的資料夾：系統權限看不到裡面（要全範圍 token），不是「沒有素材」。只給內部看，剪輯師那邊不顯示
        <p className={`${text} text-gray-400 flex items-center gap-1 flex-wrap`}>
          素材未檢查（系統看不到這個資料夾的內容）
          <button type="button" onClick={recheck} disabled={busy} className="inline-flex items-center gap-0.5 text-gray-500 hover:text-[#5A5A40] underline underline-offset-2 disabled:opacity-50 whitespace-nowrap">
            <RefreshCw size={11} /> 重新檢查
          </button>
        </p>
      ) : null}

      {reportLine}

      {mode === 'internal' && report && (
        <button
          type="button"
          onClick={() => void write({ editorReport: { ...report, resolvedAt: new Date().toISOString() } }, '已標成處理完')}
          disabled={busy}
          className="text-[13px] font-bold text-[#5A5A40] underline underline-offset-2 disabled:opacity-50"
        >
          已處理
        </button>
      )}

      {mode === 'editor' && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${text} text-gray-400 hover:text-[#5A5A40] underline decoration-dotted underline-offset-2`}
        >
          {report ? '修改回報' : '素材有問題？'}
        </button>
      )}

      {mode === 'editor' && open && (
        <div className="rounded-xl border border-black/10 bg-gray-50 p-3 space-y-2">
          <div className="flex gap-1.5 flex-wrap">
            {(Object.keys(EDITOR_REPORT_REASON_LABEL) as EditorReportReason[]).map(r => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`px-3 py-1 rounded-full text-[13px] font-bold whitespace-nowrap border ${reason === r
                  ? 'bg-[#5A5A40] border-[#5A5A40] text-white'
                  : 'bg-white border-black/10 text-gray-600'}`}
              >
                {EDITOR_REPORT_REASON_LABEL[r]}
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="備註（選填），例如：只有一支 5 秒的片段"
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-[13px] focus:outline-none focus:border-[#5A5A40]"
          />
          <div className="flex items-center gap-3">
            <button type="button" onClick={submit} disabled={!reason || busy} className="px-3 py-1.5 rounded-lg bg-[#5A5A40] text-white text-[13px] font-bold disabled:opacity-40">
              送出
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-[13px] text-gray-500">取消</button>
            {report && (
              <button type="button" onClick={() => void write({ editorReport: deleteField() }, '已撤回回報')} disabled={busy} className="ml-auto text-[13px] text-gray-500 hover:text-red-500 underline decoration-dotted underline-offset-2">
                撤回回報
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
