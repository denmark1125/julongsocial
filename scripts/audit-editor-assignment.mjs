#!/usr/bin/env node
/**
 * 唯讀稽核：找出 Asset.editorId 與該 IP 現在的 Vendor.editorId 對不起來的素材。
 *
 * 為什麼要查：Asset.editorId 是「建檔當下 vendor.editorId 的快照」，
 * 換掉廠商的負責剪輯師不會回頭改舊素材 → 換過人的 IP，舊片會永遠掛在舊人身上，
 * 新剪輯師在自己的工作台看不到（EditorAssetQueue 是用 editorId 訂閱的）。
 * 逐片指派上線前必須先知道線上有幾支是這種狀況，否則會把既有 bug 當成新功能的災情。
 *
 * 用法（只讀，不寫入任何東西）：
 *   node scripts/audit-editor-assignment.mjs
 *   node scripts/audit-editor-assignment.mjs --json    # 給後續腳本吃
 *
 * 金鑰：預設讀 GOOGLE_APPLICATION_CREDENTIALS，沒設就找 Downloads 那把
 * gen-lang-client-*-firebase-adminsdk-*.json（走 cert()，這台機器 ADC 不通）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const AS_JSON = process.argv.includes('--json');

function findKeyPath() {
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fromEnv) return fromEnv;
  const dir = join(homedir(), 'Downloads');
  const hit = readdirSync(dir).find(f => /^gen-lang-client-.*firebase-adminsdk-.*\.json$/.test(f));
  if (!hit) throw new Error('找不到 service account key，請設 GOOGLE_APPLICATION_CREDENTIALS');
  return join(dir, hit);
}

initializeApp({ credential: cert(JSON.parse(readFileSync(findKeyPath(), 'utf8'))) });
const db = getFirestore();

const [vendorsSnap, assetsSnap, editorsSnap] = await Promise.all([
  db.collection('vendors').get(),
  db.collection('assets').get(),
  db.collection('editors').get(),
]);

const vendorById = new Map(vendorsSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
const editorName = new Map(editorsSnap.docs.map(d => [d.id, d.data().name || d.id]));
const nameOf = id => (id ? (editorName.get(id) || `(未知剪輯師 ${id})`) : '(未指派)');

const rows = [];
for (const d of assetsSnap.docs) {
  const a = { id: d.id, ...d.data() };
  if (a.type !== 'video') continue;
  const vendor = vendorById.get(a.vendorId);
  if (!vendor) continue;

  const assetEditor = a.editorId || '';
  const vendorEditor = vendor.editorId || '';
  if (assetEditor === vendorEditor) continue;

  rows.push({
    assetId: a.id,
    vendorName: vendor.name || a.vendorName || '(未知IP)',
    title: a.title || '(未命名素材)',
    assetEditorId: assetEditor,
    assetEditor: nameOf(assetEditor),
    vendorEditorId: vendorEditor,
    vendorEditor: nameOf(vendorEditor),
    // 已經交掉的片對不上沒差，還在流程裡的才會真的有人看不到
    stillInFlow: !a.usedInPostId && !a.voidedAt && a.status !== 'archived',
    voided: !!a.voidedAt,
    archived: a.status === 'archived',
    invoiced: !!a.editorInvoiceId,
  });
}

if (AS_JSON) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const videoTotal = assetsSnap.docs.filter(d => d.data().type === 'video').length;
  const live = rows.filter(r => r.stillInFlow);
  console.log(`影片素材總數：${videoTotal}`);
  console.log(`editorId 與所屬 IP 現任剪輯師不一致：${rows.length} 支（其中還在流程裡、會真的有人看不到的：${live.length} 支）\n`);

  const byVendor = new Map();
  for (const r of rows) {
    const k = `${r.vendorName}｜現任 ${r.vendorEditor}`;
    if (!byVendor.has(k)) byVendor.set(k, []);
    byVendor.get(k).push(r);
  }
  for (const [k, list] of [...byVendor.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const liveN = list.filter(r => r.stillInFlow).length;
    console.log(`■ ${k}　共 ${list.length} 支（在流程中 ${liveN} 支）`);
    const grouped = new Map();
    for (const r of list) grouped.set(r.assetEditor, (grouped.get(r.assetEditor) || 0) + 1);
    for (const [who, n] of grouped) console.log(`    掛在「${who}」：${n} 支`);
    for (const r of list.filter(r => r.stillInFlow).slice(0, 5)) console.log(`      - ${r.title}（${r.assetId}）`);
    console.log('');
  }
}
process.exit(0);
