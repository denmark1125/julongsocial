import { describe, expect, it } from 'vitest';
import { dismissUpload, getUploads, startUpload } from '../uploadQueue';

// 剪輯師同時傳好幾支：每支各自一筆，互不覆蓋（2026-10-21 以前共用 busyId，第一支傳完會清掉第二支的狀態）。

describe('uploadQueue', () => {
  it('兩支同時傳：各自的進度分開記，一支傳完不影響另一支', async () => {
    let finishA!: () => void;
    let progressB!: (p: number) => void;
    const a = startUpload('a', 'A 片', async onProgress => { onProgress(10); await new Promise<void>(r => { finishA = r; }); return true; });
    const b = startUpload('b', 'B 片', async onProgress => { progressB = onProgress; onProgress(5); await new Promise(() => {}); return true; });
    progressB(40);
    expect(getUploads().find(u => u.assetId === 'b')).toMatchObject({ percent: 40, status: 'uploading' });
    finishA();
    await a;
    expect(getUploads().find(u => u.assetId === 'a')).toMatchObject({ percent: 100, status: 'done' });
    expect(getUploads().find(u => u.assetId === 'b')).toMatchObject({ percent: 40, status: 'uploading' });
    void b;
    dismissUpload('b');
  });

  it('選檔時取消（run 回傳 false）：不留任何一列', async () => {
    const ok = await startUpload('c', 'C 片', async () => false);
    expect(ok).toBe(false);
    expect(getUploads().some(u => u.assetId === 'c')).toBe(false);
  });

  it('同一支在傳時再按一次不會重複開始', async () => {
    let calls = 0;
    void startUpload('d', 'D 片', async onProgress => { calls++; onProgress(1); await new Promise(() => {}); return true; });
    await new Promise(r => setTimeout(r, 0));
    const again = await startUpload('d', 'D 片', async () => { calls++; return true; });
    expect(again).toBe(false);
    expect(calls).toBe(1);
    dismissUpload('d');
  });

  it('失敗會丟出錯誤讓卡片講原因', async () => {
    await expect(startUpload('e', 'E 片', async onProgress => { onProgress(3); throw new Error('上傳被雲端拒絕（403）'); }))
      .rejects.toThrow('403');
    expect(getUploads().find(u => u.assetId === 'e')).toMatchObject({ status: 'failed' });
  });
});
