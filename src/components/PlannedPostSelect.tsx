import { Post } from '../types';
import { postOptionLabel } from '../lib/postMatch';

/**
 * 上架毛片時「這支是拍哪一篇小編貼文」的下拉。2026-10-20 起。
 *
 * 預設值是系統依名稱猜的（resolvePostPicks），旁邊標「系統猜的」讓人知道要看一眼。
 * 選了之後上片日就跟著那篇貼文，剪輯師期限自動算好，同事不用再到「排上片日」拖。
 * 選「不屬於任何一篇」的片，之後由同事在「排上片日」決定。
 */
export default function PlannedPostSelect({
  value, guessed, candidates, onChange, takenElsewhere = [],
}: {
  /** 實際生效的那篇（'' ＝不屬於任何一篇） */
  value: string;
  /** value 是不是系統猜的（人還沒動過） */
  guessed: boolean;
  /** 這個 IP 還在等片的貼文（waitingPostsFor） */
  candidates: Post[];
  onChange: (postId: string) => void;
  /** 同一張表單別支已經選走的，不讓重複選 */
  takenElsewhere?: string[];
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1 whitespace-nowrap">
        這支是拍哪一篇
        {guessed && value && <span className="ml-1.5 text-amber-700">系統猜的，請確認</span>}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"
      >
        <option value="">不屬於任何一篇（之後再排上片日）</option>
        {candidates.map(p => (
          <option key={p.id} value={p.id} disabled={p.id !== value && takenElsewhere.includes(p.id!)}>
            {postOptionLabel(p)}
          </option>
        ))}
      </select>
      {candidates.length === 0 && (
        <p className="text-xs text-slate-500 mt-1">這個 IP 目前沒有等片的小編貼文。</p>
      )}
    </div>
  );
}
