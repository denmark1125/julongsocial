import type { Editor } from '../types';
import { assignableEditors, editorLabel } from '../lib/editorRoster';

/**
 * 剪輯師下拉的選項：分「外包」「內部」兩組，離職的不列（目前選中的例外）。2026-10-21。
 * `includeLeft`：查歷史用（例如匯出某人的紀錄），離職的也列。
 */
export default function EditorOptions({ editors, currentId, exclude, includeLeft }: {
  editors: Editor[];
  currentId?: string;
  exclude?: string;
  includeLeft?: boolean;
}) {
  const list = includeLeft ? editors.map(e => ({ ...e, leftAt: undefined, _left: !!e.leftAt })) : editors;
  const { external, internal } = assignableEditors(list as Editor[], currentId);
  const label = (e: Editor & { _left?: boolean }) => e._left ? `${e.name}（已離職）` : editorLabel(e);
  const opts = (xs: Editor[]) => xs.filter(e => e.id !== exclude).map(e => <option key={e.id} value={e.id}>{label(e)}</option>);
  return (
    <>
      {external.length > 0 && <optgroup label="外包">{opts(external)}</optgroup>}
      {internal.length > 0 && <optgroup label="內部">{opts(internal)}</optgroup>}
    </>
  );
}
