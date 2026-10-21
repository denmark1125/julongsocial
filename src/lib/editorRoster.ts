import type { Asset, Editor, EditorKind, Vendor } from '../types';

/**
 * 剪輯師名冊的共用判斷（2026-10-21）。
 * 剪輯師只有兩種：外包（要請款）、內部（自己員工，不請款）。另外有在職／離職。
 * 所有「選剪輯師」的下拉、請款、工作台都走這裡，別在元件裡各寫一份。
 */

export const editorKind = (e: Pick<Editor, 'kind'> | undefined): EditorKind => e?.kind === 'internal' ? 'internal' : 'external';
export const isEditorActive = (e: Pick<Editor, 'leftAt'> | undefined): boolean => !!e && !e.leftAt;

/**
 * 指派選單要列的剪輯師：在職的，外包在前、內部在後，各自照名字排。
 * 目前選中的那位就算已離職也留著（不然下拉會顯示空白，看起來像沒指派）。
 */
export function assignableEditors(editors: Editor[], currentId?: string): { external: Editor[]; internal: Editor[] } {
  const keep = editors
    .filter(e => isEditorActive(e) || (currentId && e.id === currentId))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return {
    external: keep.filter(e => editorKind(e) === 'external'),
    internal: keep.filter(e => editorKind(e) === 'internal'),
  };
}

export const editorLabel = (e: Editor): string => `${e.name}${e.leftAt ? '（已離職）' : ''}`;

/**
 * 這支片是不是內部剪的：勾了「內部剪輯」，或負責的剪輯師是內部的人。內部的片不請款。
 * 負責人照請款歸屬（billableEditorId 凍結值）→ 片上指定 → IP 預設。
 */
export function isInternalWork(
  asset: Pick<Asset, 'internalEdit' | 'billableEditorId' | 'editorId' | 'vendorId'>,
  vendors: Pick<Vendor, 'id' | 'editorId'>[],
  editors: Pick<Editor, 'id' | 'kind'>[],
): boolean {
  if (asset.internalEdit) return true;
  const id = asset.billableEditorId || asset.editorId || vendors.find(v => v.id === asset.vendorId)?.editorId;
  if (!id) return false;
  return editorKind(editors.find(e => e.id === id)) === 'internal';
}
