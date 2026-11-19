/**
 * 文案前後比對（11-19 使用者：修改紀錄要看得出業主改了哪裡；通知小編的那句也直接講改了什麼）。
 * 逐字比對（中文沒有空白分詞，逐字最準）：先去掉頭尾相同的部分，中間再做最長共同子序列。
 * 文案最多 2,200 字，中間段太長（整篇重寫）就直接當「整段換掉」，不硬算。
 */
export type DiffPart = { type: 'same' | 'add' | 'del'; text: string };

const MAX_CELLS = 1_500_000;

export function diffText(before: string, after: string): DiffPart[] {
  const a = [...String(before || '')];
  const b = [...String(after || '')];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const out: DiffPart[] = [];
  const push = (type: DiffPart['type'], ch: string) => {
    if (!ch) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += ch; else out.push({ type, text: ch });
  };
  push('same', a.slice(0, pre).join(''));

  if (am.length * bm.length > MAX_CELLS) {
    push('del', am.join(''));
    push('add', bm.join(''));
  } else {
    // LCS 表（倒著填，方便正著走）
    const n = am.length, m = bm.length, w = m + 1;
    const t = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { push('same', am[i]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { push('del', am[i]); i++; }
      else { push('add', bm[j]); j++; }
    }
    while (i < n) push('del', am[i++]);
    while (j < m) push('add', bm[j++]);
  }
  push('same', a.slice(a.length - suf).join(''));
  return tidy(out);
}

/**
 * 逐字比對常把「39,800→39,900」切成「39,」「8→9」「00」這種碎片，人看很累：
 * 兩個改動中間只隔 1～2 個沒變的字，就把那幾個字併進改動裡（刪的、加的各補一份）。
 */
function tidy(parts: DiffPart[]): DiffPart[] {
  // 先把相鄰的改動整理成「一組刪＋一組加」
  type Chunk = { same?: string; del: string; add: string };
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const p of parts) {
    if (p.type === 'same') { if (cur) chunks.push(cur); cur = null; chunks.push({ same: p.text, del: '', add: '' }); }
    else { cur = cur || { del: '', add: '' }; cur[p.type] += p.text; }
  }
  if (cur) chunks.push(cur);
  // 夾在兩個改動中間、很短的相同段 → 併進去
  const merged: Chunk[] = [];
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    const prev = merged[merged.length - 1];
    const next = chunks[k + 1];
    if (c.same !== undefined && prev && prev.same === undefined && next && next.same === undefined && [...c.same].length <= 2 && !c.same.includes('\n')) {
      prev.del += c.same + next.del;
      prev.add += c.same + next.add;
      k++;
      continue;
    }
    if (c.same === undefined && prev && prev.same === undefined) { prev.del += c.del; prev.add += c.add; continue; }
    merged.push({ ...c });
  }
  const out: DiffPart[] = [];
  for (const c of merged) {
    if (c.same !== undefined) { if (c.same) out.push({ type: 'same', text: c.same }); continue; }
    if (c.del) out.push({ type: 'del', text: c.del });
    if (c.add) out.push({ type: 'add', text: c.add });
  }
  return out;
}

export type DiffChange = { del: string; add: string };

/** 只取改動的地方（一組＝刪掉什麼、換成什麼） */
export function diffChanges(before: string, after: string): DiffChange[] {
  const out: DiffChange[] = [];
  let cur: DiffChange | null = null;
  for (const p of diffText(before, after)) {
    if (p.type === 'same') { if (cur) out.push(cur); cur = null; continue; }
    cur = cur || { del: '', add: '' };
    cur[p.type] += p.text;
  }
  if (cur) out.push(cur);
  return out;
}

const clipOne = (s: string, n: number) => {
  const t = s.replace(/\s*\n\s*/g, ' ').trim();
  return [...t].length > n ? `${[...t].slice(0, n).join('')}…` : t;
};

export type ContextChange = { pre: string; del: string; add: string; post: string };

/**
 * 每一處改動，連同前後各 ctx 個沒變的字（不跨行），才知道改在哪裡：
 * 只看「8 → 9」看不懂，要「價格 39,[8→9]00 元」。改動頭尾的換行拿掉（只是多空一行，不算改字）。
 */
export function diffChangesInContext(before: string, after: string, ctx = 6): ContextChange[] {
  const parts = diffText(before, after);
  const out: ContextChange[] = [];
  for (let k = 0; k < parts.length; k++) {
    if (parts[k].type === 'same') continue;
    let del = '', add = '';
    const start = k;
    while (k < parts.length && parts[k].type !== 'same') { if (parts[k].type === 'del') del += parts[k].text; else add += parts[k].text; k++; }
    const NL = String.fromCharCode(10);
    const prevSame = start > 0 ? parts[start - 1].text.split(NL).pop() || '' : '';
    const nextSame = k < parts.length ? parts[k].text.split(NL)[0] : '';
    const trimNl = (s: string) => s.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');
    del = trimNl(del); add = trimNl(add);
    if (!del.trim() && !add.trim()) continue; // 只差空行
    out.push({ pre: [...prevSame].slice(-ctx).join(''), del, add, post: [...nextSame].slice(0, ctx).join('') });
  }
  return out;
}

/**
 * 給 LINE 通知的短句：最多列 3 處，其餘寫「還有 N 處」。
 * 改動太短（少於 4 個字，例如只改一個數字）就前後各帶幾個沒變的字，才看得懂：「39,800 元」改成「39,900 元」。
 */
export function diffSummaryLines(before: string, after: string, max = 3, clip = 24): string[] {
  const ch = diffChangesInContext(before, after, 4).map(c => {
    if (Math.max([...c.del].length, [...c.add].length) >= 4) return c;
    // 只加或只刪幾個字也寫成「原句」改成「新句」，才知道加在哪
    return { ...c, del: c.pre + c.del + c.post, add: c.pre + c.add + c.post };
  });
  const lines = ch.slice(0, max).map(c => {
    if (c.del && c.add) return `「${clipOne(c.del, clip)}」改成「${clipOne(c.add, clip)}」`;
    if (c.del) return `刪掉「${clipOne(c.del, clip)}」`;
    return `加上「${clipOne(c.add, clip)}」`;
  });
  if (ch.length > max) lines.push(`…還有 ${ch.length - max} 處`);
  return lines;
}
