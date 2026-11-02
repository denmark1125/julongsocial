import { describe, it, expect } from 'vitest';
import { faststartMp4 } from '../mp4Faststart';

// 手工拼最小的 MP4：box(type, payload)
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type: string, payload: number[]) => [...u32(8 + payload.length), ...[...type].map(c => c.charCodeAt(0)), ...payload];
const stco = (offsets: number[]) => box('stco', [0, 0, 0, 0, ...u32(offsets.length), ...offsets.flatMap(u32)]);
const moovWith = (offsets: number[]) => box('moov', box('trak', box('mdia', box('minf', box('stbl', stco(offsets))))));

const readTop = (b: Uint8Array) => {
  const out: string[] = [];
  for (let p = 0; p < b.length;) {
    const size = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
    out.push(String.fromCharCode(...b.slice(p + 4, p + 8)));
    p += size;
  }
  return out;
};
const stcoOffsets = (b: Uint8Array) => {
  const i = b.findIndex((_, k) => String.fromCharCode(...b.slice(k, k + 4)) === 'stco');
  const v = new DataView(b.buffer, b.byteOffset);
  const n = v.getUint32(i + 8);
  return Array.from({ length: n }, (_, k) => v.getUint32(i + 12 + k * 4));
};
const asFile = (bytes: number[]) => new File([new Uint8Array(bytes)], 'a.mp4', { type: 'video/mp4' });

describe('faststartMp4（目錄搬到檔頭）', () => {
  const ftyp = box('ftyp', [...'isom'].map(c => c.charCodeAt(0)), );
  const mdat = box('mdat', Array.from({ length: 40 }, (_, i) => i));
  const mdatStart = ftyp.length;

  it('moov 在檔尾：搬到 mdat 前面，位置表往後移 moov 的大小，總大小不變', async () => {
    const offsets = [mdatStart + 8, mdatStart + 28];
    const moov = moovWith(offsets);
    const src = asFile([...ftyp, ...mdat, ...moov]);
    const out = await faststartMp4(src);
    const b = new Uint8Array(await out.arrayBuffer());
    expect(readTop(b)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(b.length).toBe(src.size);
    expect(stcoOffsets(b)).toEqual(offsets.map(o => o + moov.length));
    // 畫面資料原封不動，只是位置變了
    expect(Array.from(b.slice(ftyp.length + moov.length + 8, ftyp.length + moov.length + 48))).toEqual(mdat.slice(8));
  });

  it('目錄已經在前面：回傳同一個檔，不重拼', async () => {
    const src = asFile([...ftyp, ...moovWith([100]), ...mdat]);
    expect(await faststartMp4(src)).toBe(src);
  });

  it('看不懂的檔（不是 MP4、長度亂掉）：回傳原檔，不讓上傳失敗', async () => {
    const junk = asFile(Array.from({ length: 100 }, (_, i) => (i * 37) & 255));
    expect(await faststartMp4(junk)).toBe(junk);
    const truncated = asFile([...ftyp, ...mdat, ...moovWith([10]).slice(0, 20)]);
    expect(await faststartMp4(truncated)).toBe(truncated);
  });

  it('分段式 MP4（有 moof）：不動', async () => {
    const src = asFile([...ftyp, ...mdat, ...box('moof', [0, 0, 0, 0]), ...moovWith([10])]);
    expect(await faststartMp4(src)).toBe(src);
  });
});
