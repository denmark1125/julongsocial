// 一次性：排上片日「只排了日子、沒有貼文」的毛片，補建待補中貼文並綁上（2026-10-21 使用者確認全部補建）。
// 規則同 src/lib/boardPosts.ts buildAutoPost（用 esbuild 打包真程式碼，不另寫一份）。
// 用法：node scripts/backfill-board-posts.mjs          → 只列清單
//       node scripts/backfill-board-posts.mjs --apply  → 寫入
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const out = join(tmpdir(), 'boardPosts.cjs');
execSync(`npx esbuild src/lib/boardPosts.ts --bundle --platform=node --format=cjs --outfile="${out}" --log-level=error`);
const { buildAutoPost } = require(out);
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
initializeApp({ credential: cert(require(process.env.GOOGLE_APPLICATION_CREDENTIALS)) });
const db = getFirestore();
const apply = process.argv.includes('--apply');
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const vendors = new Map((await db.collection('vendors').get()).docs.map(d => [d.id, { id: d.id, ...d.data() }]));
const assets = (await db.collection('assets').where('type', '==', 'video').get()).docs.map(d => ({ id: d.id, ...d.data() }));
const targets = assets.filter(a => a.plannedAirDate && !a.plannedPostId && !a.voidedAt && !a.usedInPostId && a.plannedAirDate >= today)
  .sort((a, b) => a.plannedAirDate.localeCompare(b.plannedAirDate));
for (const a of targets) console.log(`${a.plannedAirDate}  ${vendors.get(a.vendorId)?.name || a.vendorName}｜${a.title}`);
const skipped = assets.filter(a => a.plannedAirDate && !a.plannedPostId && !a.voidedAt && !a.usedInPostId && a.plannedAirDate < today);
console.log(`\n要補建 ${targets.length} 篇；日期已過不補 ${skipped.length} 支`);
if (!apply) process.exit(0);

const now = new Date().toISOString();
const batch = db.batch();
for (const a of targets) {
  const [y, m, d] = a.plannedAirDate.split('-').map(Number);
  const ref = db.collection('posts').doc();
  batch.set(ref, buildAutoPost(a, vendors.get(a.vendorId), new Date(y, m - 1, d), 'script:backfill-board-posts', now));
  batch.update(db.collection('assets').doc(a.id), { plannedPostId: ref.id });
}
await batch.commit();
console.log('已寫入');
