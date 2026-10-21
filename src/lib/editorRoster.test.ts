import { describe, expect, it } from 'vitest';
import { assignableEditors, editorKind, isInternalWork } from './editorRoster';
import type { Editor } from '../types';

const ed = (id: string, name: string, extra: Partial<Editor> = {}): Editor => ({ id, name, createdAt: '', ...extra });
const xie = ed('x', '謝謝');
const irene = ed('i', 'Irene', { kind: 'internal' });
const peggy = ed('p', 'Peggy', { kind: 'internal', leftAt: '2026-10-21' });

describe('editorKind', () => {
  it('沒填＝外包', () => expect(editorKind(xie)).toBe('external'));
  it('內部', () => expect(editorKind(irene)).toBe('internal'));
});

describe('assignableEditors', () => {
  it('離職的不列、外包內部分開', () => {
    const r = assignableEditors([peggy, irene, xie]);
    expect(r.external.map(e => e.id)).toEqual(['x']);
    expect(r.internal.map(e => e.id)).toEqual(['i']);
  });
  it('目前選中的離職者仍保留', () => {
    expect(assignableEditors([peggy, irene], 'p').internal.map(e => e.id)).toEqual(['i', 'p']);
  });
});

describe('isInternalWork', () => {
  const vendors = [{ id: 'v1', editorId: 'x' }, { id: 'v2', editorId: 'i' }];
  const editors = [xie, irene, peggy];
  it('勾內部剪輯', () => expect(isInternalWork({ internalEdit: true, vendorId: 'v1' }, vendors, editors)).toBe(true));
  it('IP 預設是外包', () => expect(isInternalWork({ vendorId: 'v1' }, vendors, editors)).toBe(false));
  it('IP 預設是內部', () => expect(isInternalWork({ vendorId: 'v2' }, vendors, editors)).toBe(true));
  it('片上指定內部的人蓋過 IP 預設', () => expect(isInternalWork({ vendorId: 'v1', editorId: 'p' }, vendors, editors)).toBe(true));
  it('請款歸屬凍結在外包，事後改派內部也照外包算', () =>
    expect(isInternalWork({ vendorId: 'v1', editorId: 'i', billableEditorId: 'x' }, vendors, editors)).toBe(false));
});
