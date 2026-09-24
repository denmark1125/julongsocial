/**
 * 素材的剪輯需求：整支片的方向 ＋ 每個毛片片段的短標籤。上傳毛片時填的。
 *
 * 內部素材庫與剪輯師工作台共用同一支，不要各寫一份會走樣。
 * ⚠️ 獨立成檔而不是放在 AssetDatabase 裡 export：剪輯師端 import 那支會把整個
 *    素材庫模組（含 html-to-image 等重依賴）一起拖進來。
 *
 * ⚠️ 兩個欄位都空就整塊不渲染 —— 上傳毛片功能之前建的素材沒有這些欄位，
 *    它們的卡片要維持原本的樣子。
 * ⚠️ 剪輯師看得到這塊，所以措辭一律是「這支片的資訊」，不要出現「你要剪成…」這種祈使句。
 */
export default function EditingBrief({
  brief,
  clipNotes,
}: {
  brief?: string;
  clipNotes?: { fileName: string; note: string }[];
}) {
  const labelled = (clipNotes || []).filter(c => c.note?.trim());
  if (!brief?.trim() && labelled.length === 0) return null;

  return (
    <div className="mt-2 rounded-xl bg-sky-50/70 px-3 py-2">
      {brief?.trim() && (
        <p className="text-[13px] leading-relaxed text-sky-900 whitespace-pre-wrap">{brief}</p>
      )}
      {labelled.length > 0 && (
        <p className="mt-1 text-[13px] text-sky-700/80">
          {clipNotes!.length} 個片段
          {labelled.map((c, i) => `　${i + 1}.${c.note}`).join('')}
        </p>
      )}
    </div>
  );
}
