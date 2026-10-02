#!/usr/bin/env node
/**
 * 剪輯費 950 → 900 更正。
 *
 * 為什麼要有這支：2026-09-11（commit 3890a90）分級上線時，EDITOR_FEE_BY_TIER.over60 寫成 950，
 * 但公司定價是 60 秒以上 900（註解一直寫 900，程式碼寫錯）。這段期間送出的請款單，
 * 60 秒以上的片都用 950 凍結進了 items.amount 與 asset.editorFee。
 *
 * 老闆定案的處理方式：
 *   - 未付款（submitted / approved）→ 整張作廢，那批片回到可請款清單，
 *     並把凍結的 editorFee: 950 清掉，讓它重新走分級價（900），剪輯師重送一次。
 *   - 付款處理中（payment_processing）→ 錢可能已經在路上，**不自動動**，只列出來。
 *   - 已付款（paid）→ 只列出來，由老闆決定要不要找剪輯師處理差額。
 *
 * ⚠️ 只清「金額剛好 950 且分級是 over60」的 editorFee。管帳手動調過的其他金額不碰。
 *
 * 用法：
 *   node scripts/fix-fee-950.mjs            # 預覽：只讀，列出受影響的單與片（預設）
 *   node scripts/fix-fee-950.mjs --apply    # 真的寫入
 *
 * 金鑰：優先讀環境變數 FIREBASE_SERVICE_ACCOUNT_KEY（JSON 字串，GitHub Actions 用），
 * 其次 GOOGLE_APPLICATION_CREDENTIALS（檔案路徑），最後找 Downloads 的
 * gen-lang-client-*-firebase-adminsdk-*.json（同 audit-editor-assignment.mjs）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const WRONG_FEE = 950;
const UNPAID = ['submitted', 'approved'];

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fromEnv) return JSON.parse(readFileSync(fromEnv, 'utf8'));
  const dir = join(homedir(), 'Downloads');
  const hit = readdirSync(dir).find(f => /^gen-lang-client-.*firebase-adminsdk-.*\.json$/.test(f));
  if (!hit) throw new Error('找不到 service account key，請設 FIREBASE_SERVICE_ACCOUNT_KEY 或 GOOGLE_APPLICATION_CREDENTIALS');
  return JSON.parse(readFileSync(join(dir, hit), 'utf8'));
}

initializeApp({ credential: cert(loadServiceAccount()) });
const db = getFirestore();

const [invoicesSnap, assetsSnap] = await Promise.all([
  db.collection('editorInvoices').get(),
  db.collection('assets').get(),
]);
const assetById = new Map(assetsSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));

/** 這一筆明細是不是被錯價害到的：凍結金額 950，而且素材的分級是 over60 */
const isWrongItem = it => it.amount === WRONG_FEE && assetById.get(it.assetId)?.durationTier === 'over60';

const affected = invoicesSnap.docs
  .map(d => ({ id: d.id, ...d.data() }))
  .filter(inv => inv.status !== 'void')
  .map(inv => ({ inv, wrong: (inv.items || []).filter(isWrongItem) }))
  .filter(x => x.wrong.length > 0);

const fixable = affected.filter(x => UNPAID.includes(x.inv.status));
const processing = affected.filter(x => x.inv.status === 'payment_processing');
const paid = affected.filter(x => x.inv.status === 'paid');

// 不在任何有效請款單上、但 editorFee 被凍結成 950 的片（例如之前作廢過的單留下來的）。
// 不清掉的話，下次請款仍會用 950 算。
const invoicedIds = new Set(
  invoicesSnap.docs.filter(d => d.data().status !== 'void').flatMap(d => (d.data().items || []).map(it => it.assetId))
);
const strayAssets = [...assetById.values()].filter(a =>
  a.editorFee === WRONG_FEE && a.durationTier === 'over60' && !a.editorInvoiceId && !invoicedIds.has(a.id)
);

const money = n => `NT$ ${n.toLocaleString()}`;
function printGroup(title, list) {
  console.log(`\n■ ${title}：${list.length} 張`);
  for (const { inv, wrong } of list) {
    const diff = wrong.length * (WRONG_FEE - 900);
    console.log(`  - ${inv.editorName || inv.editorId}｜${inv.billingMonth}｜單號 ${inv.id}｜總額 ${money(inv.totalAmount)}｜950 的片 ${wrong.length} 支，多算 ${money(diff)}`);
    for (const it of wrong) console.log(`      · ${it.vendorName}｜${it.title}`);
  }
}

console.log(APPLY ? '模式：寫入（--apply）' : '模式：預覽（只讀，不會寫入任何東西）');
printGroup('未付款，會作廢重開', fixable);
printGroup('付款處理中，不自動動，請人工確認', processing);
printGroup('已付款，只列出來給老闆決定', paid);
console.log(`\n■ 不在請款單上、但金額卡在 950 的片：${strayAssets.length} 支${strayAssets.length ? '（會清掉，改回分級價 900）' : ''}`);
for (const a of strayAssets) console.log(`      · ${a.vendorName || a.vendorId}｜${a.title}`);

if (!APPLY) {
  console.log('\n這是預覽。確認無誤後用 --apply 執行。');
  process.exit(0);
}

const nowIso = new Date().toISOString();
for (const { inv } of fixable) {
  const batch = db.batch();
  batch.update(db.collection('editorInvoices').doc(inv.id), {
    status: 'void',
    voidedAt: nowIso,
    voidReason: '剪輯費 950→900 更正，請重新送單',
  });
  // 跟後台「作廢」按鈕（EditorPayables.voidInvoice）一樣：整張單的片都放回可請款清單
  for (const it of inv.items || []) {
    const patch = { editorInvoiceId: '' };
    if (isWrongItem(it)) patch.editorFee = FieldValue.delete();
    batch.update(db.collection('assets').doc(it.assetId), patch);
  }
  await batch.commit();
  console.log(`已作廢 ${inv.id}（${inv.editorName || inv.editorId}）`);
}
for (const a of strayAssets) {
  await db.collection('assets').doc(a.id).update({ editorFee: FieldValue.delete() });
  console.log(`已清除凍結金額：${a.title}（${a.id}）`);
}
console.log('\n完成。請通知相關剪輯師重新送請款單。');
process.exit(0);
