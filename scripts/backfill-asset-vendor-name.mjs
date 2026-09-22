#!/usr/bin/env node
/**
 * 把 assets 缺少的 vendorName 快照補上（只補這一個欄位，其他一律不碰）。
 *
 * 為什麼需要：逐片指派上線後，被指名到「自己沒負責的 IP」的剪輯師讀不到那家 vendor 文件
 * （規則是逐文件評估的，指名只開那一支片，不開整家 IP），畫面只能靠素材上的名稱快照。
 * 沒有快照的話，他的工作台與請款單都會顯示「未知 IP」，而請款單上的名稱是會被凍進單子裡的。
 *
 * 用法：
 *   node scripts/backfill-asset-vendor-name.mjs           # dry-run，只列出要改什麼
 *   node scripts/backfill-asset-vendor-name.mjs --apply   # 真的寫入
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const dir = join(homedir(), 'Downloads');
const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || join(dir, readdirSync(dir).find(f => /^gen-lang-client-.*firebase-adminsdk-.*\.json$/.test(f)));
initializeApp({ credential: cert(JSON.parse(readFileSync(keyFile, 'utf8'))) });
const db = getFirestore();

const [vendorsSnap, assetsSnap] = await Promise.all([
  db.collection('vendors').get(),
  db.collection('assets').get(),
]);
const vendorName = new Map(vendorsSnap.docs.map(d => [d.id, d.data().name]));

const todo = [];
for (const d of assetsSnap.docs) {
  const a = d.data();
  if (a.vendorName) continue;                 // 已經有快照就不動
  const name = vendorName.get(a.vendorId);
  if (!name) continue;                        // 查不到 IP 就跳過，不要亂寫
  todo.push({ id: d.id, name, title: a.title || '(未命名)', vendorId: a.vendorId });
}

const byVendor = new Map();
for (const t of todo) byVendor.set(t.name, (byVendor.get(t.name) || 0) + 1);
console.log(`素材總數 ${assetsSnap.size}，缺 vendorName 且查得到 IP 的：${todo.length} 筆`);
for (const [n, c] of [...byVendor.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}：${c} 筆`);

if (!APPLY) { console.log('\n(dry-run，沒有寫入任何東西。要寫入請加 --apply)'); process.exit(0); }

// Firestore 一批上限 500
let done = 0;
for (let i = 0; i < todo.length; i += 400) {
  const batch = db.batch();
  for (const t of todo.slice(i, i + 400)) batch.update(db.collection('assets').doc(t.id), { vendorName: t.name });
  await batch.commit();
  done += todo.slice(i, i + 400).length;
  console.log(`已寫入 ${done}/${todo.length}`);
}
console.log('完成');
process.exit(0);
