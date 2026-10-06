/**
 * 一次性：把「流程早就走完、剪輯費在系統外付過，但從沒按上傳雲端」的片標成舊制已結清。
 *
 * 為什麼：2026-10-06 盤點，貼文早已發布或已手動標完成的片，還卡在「待上傳雲端／業主審核中」，
 * 剪輯師工作台、製作進度、素材資料庫的待審核都看得到。老闆確認這批剪輯費都在系統外付過。
 *
 * ⚠️ 不補 cloudUploadedAt：補了會讓這批變成可請款，等於重複付錢。
 * ⚠️ 不改 flowStage／approved：畫面靠 isClosedOutsideSystem() 判斷，不竄改流程紀錄。
 *
 * 用法（先 dry-run 看清單，確認後才寫入）：
 *   npx tsx scripts/close-finished-legacy.ts
 *   npx tsx scripts/close-finished-legacy.ts --apply
 * 需要環境變數 FIREBASE_SERVICE_ACCOUNT_KEY。寫入的 id 存到 scripts/close-finished-legacy.<時間>.json，可據以還原。
 */
import { readFileSync, writeFileSync } from 'fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { deriveFlowStage, EDITOR_BILLING_CUTOVER_AT } from '../src/types';

const APPLY = process.argv.includes('--apply');
const SOURCE = '2026-10 批次結案：系統外已付';

const cfg = JSON.parse(readFileSync(new URL('../firebase-applet-config.json', import.meta.url), 'utf8'));
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)), projectId: cfg.projectId });
const db = getFirestore(cfg.firestoreDatabaseId);

const [assetSnap, vendorSnap, postSnap] = await Promise.all([
  db.collection('assets').get(), db.collection('vendors').get(), db.collection('posts').get(),
]);
const vendorName: Record<string, string> = {};
vendorSnap.docs.forEach(d => { vendorName[d.id] = d.data().name; });
const postStatus: Record<string, string> = {};
postSnap.docs.forEach(d => { postStatus[d.id] = d.data().status; });
const cutover = Date.parse(EDITOR_BILLING_CUTOVER_AT);

const targets = assetSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter(a => {
  if (a.type !== 'video' || a.voidedAt || a.status === 'archived') return false;
  if (a.cloudUploadedAt || a.editorInvoiceId || a.legacySettlementStatus) return false;
  const stage = deriveFlowStage(a);
  if (stage !== 'client_review' && stage !== 'to_upload') return false;
  // 「已走完」的證據，三選一。「可使用」且切帳後建檔的片是真的還在流程中，不碰。
  const onSettledPost = a.usedInPostId && ['scheduled', 'published'].includes(postStatus[a.usedInPostId]);
  const beforeCutover = Date.parse(a.createdAt || '') < cutover;
  return onSettledPost || a.status === 'used' || beforeCutover;
});

const byVendor: Record<string, any[]> = {};
targets.forEach(a => { (byVendor[vendorName[a.vendorId] || a.vendorName || a.vendorId] ||= []).push(a); });
console.log(`${APPLY ? '寫入' : '預覽（dry-run）'}：共 ${targets.length} 支\n`);
for (const [vn, list] of Object.entries(byVendor).sort((x, y) => y[1].length - x[1].length)) {
  console.log(`【${vn}】${list.length} 支`);
  list.forEach(a => {
    const why = a.usedInPostId && postStatus[a.usedInPostId] ? `貼文${postStatus[a.usedInPostId] === 'published' ? '已發布' : '已排程'}`
      : a.status === 'used' ? '已標完成' : '切帳前建檔';
    console.log(`  - ${a.title}（${why}）`);
  });
}

if (!APPLY) {
  console.log('\n沒有寫入任何資料。確認清單無誤後加 --apply 執行。');
  process.exit(0);
}

const now = new Date().toISOString();
for (let i = 0; i < targets.length; i += 400) {
  const batch = db.batch();
  targets.slice(i, i + 400).forEach(a => batch.update(db.collection('assets').doc(a.id), {
    legacySettlementStatus: 'paid',
    legacySettlementSource: SOURCE,
    legacyReviewedAt: now,
    legacyReviewedByUid: 'script:close-finished-legacy',
    legacySettledAt: now,
    legacySettledAmount: 0,
  }));
  await batch.commit();
}
const log = new URL(`./close-finished-legacy.${now.replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(log, JSON.stringify({ appliedAt: now, ids: targets.map(a => a.id) }, null, 2));
console.log(`\n已寫入 ${targets.length} 支。id 清單：${log.pathname}`);
console.log('還原：把這些 id 的 legacySettlementStatus 等六個欄位刪掉即可。');
