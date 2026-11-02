/**
 * 審片檔上傳前，把 MP4 的「目錄」（moov）搬到檔案最前面（2026-11-02）。
 *
 * 為什麼：剪輯軟體匯出的 MP4 常把 moov 放在檔尾（實測 10-30 在審 4 支全是），手機播放器要先跳到檔尾讀目錄
 * 再跳回來讀畫面，客戶按播放會頓一下。搬到前面＝ ffmpeg 的 -movflags +faststart，畫面一個位元都不重壓。
 *
 * 做法：只讀檔頭和 moov（通常 1MB 以內），改 moov 裡每個區塊的位置表（stco／co64），
 * 再用 Blob 把「原檔切片＋改好的 moov」拼起來——不複製影片本體，80MB 的片也只多花幾十毫秒。
 * 看不懂的檔（分段式 MP4、目錄已經在前面、太大、格式怪）一律回傳原檔：寧可沒加速，也不能讓上傳失敗。
 */

type Box = { type: string; start: number; size: number };

const MAX_MOOV = 64 * 1024 * 1024;
// 要往下找位置表的容器：moov → trak → mdia → minf → stbl → stco/co64
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

async function readBytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** 頂層 box 清單；看不懂就回 null */
async function topBoxes(file: Blob): Promise<Box[] | null> {
  const boxes: Box[] = [];
  let off = 0;
  while (off < file.size) {
    if (file.size - off < 8 || boxes.length > 64) return null;
    const h = new DataView((await readBytes(file, off, Math.min(off + 16, file.size))).buffer);
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1) {
      if (h.byteLength < 16) return null;
      size = Number(h.getBigUint64(8));
    } else if (size === 0) {
      size = file.size - off; // 一路到檔尾
    }
    if (size < 8 || off + size > file.size) return null;
    boxes.push({ type, start: off, size });
    off += size;
  }
  return boxes;
}

/** 把 moov 裡所有位置表中落在 [from, to) 的位置加上 shift；位置表放不下（32 位元溢位）就回 false */
function patchOffsets(moov: Uint8Array, from: number, to: number, shift: number): boolean {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const walk = (start: number, end: number): boolean => {
    let p = start;
    while (p + 8 <= end) {
      let size = view.getUint32(p);
      const type = String.fromCharCode(moov[p + 4], moov[p + 5], moov[p + 6], moov[p + 7]);
      let header = 8;
      if (size === 1) { size = Number(view.getBigUint64(p + 8)); header = 16; }
      else if (size === 0) size = end - p;
      if (size < header || p + size > end) return false;
      if (CONTAINERS.has(type)) {
        if (!walk(p + header, p + size)) return false;
      } else if (type === 'stco' || type === 'co64') {
        const wide = type === 'co64';
        const count = view.getUint32(p + header + 4);
        let q = p + header + 8;
        if (q + count * (wide ? 8 : 4) > p + size) return false;
        for (let i = 0; i < count; i++, q += wide ? 8 : 4) {
          const v = wide ? Number(view.getBigUint64(q)) : view.getUint32(q);
          if (v < from || v >= to) continue;
          const nv = v + shift;
          if (wide) view.setBigUint64(q, BigInt(nv));
          else if (nv > 0xffffffff) return false;
          else view.setUint32(q, nv);
        }
      }
      p += size;
    }
    return true;
  };
  return walk(8, moov.byteLength);
}

export async function faststartMp4(file: File): Promise<File> {
  try {
    const boxes = await topBoxes(file);
    if (!boxes) return file;
    const moovIdx = boxes.findIndex(b => b.type === 'moov');
    const mdatIdx = boxes.findIndex(b => b.type === 'mdat');
    // 沒有目錄／沒有畫面／目錄已經在前面／分段式 MP4（moof）：不動
    if (moovIdx < 0 || mdatIdx < 0 || moovIdx < mdatIdx || boxes.some(b => b.type === 'moof')) return file;
    const moovBox = boxes[moovIdx];
    if (moovBox.size > MAX_MOOV) return file;
    const moov = await readBytes(file, moovBox.start, moovBox.start + moovBox.size);
    // moov 一般是 32 位元長度；64 位元長度的不常見，不處理
    if (new DataView(moov.buffer).getUint32(0) !== moovBox.size) return file;
    const insertAt = boxes[mdatIdx].start;
    // 原本在 [第一個 mdat, moov) 之間的資料會往後移 moov 那麼多；moov 之後的資料位置不變（拿走又插回前面，淨值為 0）
    if (!patchOffsets(moov, insertAt, moovBox.start, moovBox.size)) return file;
    const parts: BlobPart[] = [
      file.slice(0, insertAt),
      moov,
      file.slice(insertAt, moovBox.start),
      file.slice(moovBox.start + moovBox.size),
    ];
    return new File(parts, file.name, { type: file.type || 'video/mp4', lastModified: file.lastModified });
  } catch {
    return file;
  }
}
