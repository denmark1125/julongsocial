#!/usr/bin/env node
/**
 * 部署 firestore.rules 到正式環境（走 Firebase Rules REST API）。
 *
 * 為什麼不用別的方式：
 * - `firebase deploy --only firestore:rules` ── 這台機器沒有安裝 firebase CLI（全域與 node_modules 都沒有）。
 * - firebase MCP 的 deploy ── **會回傳 {status:"success"} 但線上 ruleset 完全沒變**（2026-08-25 實測兩次）。
 *   原因是它不在這個工作樹跑，讀不到本專案的 firebase.json。不要相信它的回報。
 * - Firebase Console 的畫面與 MCP 的 get_security_rules 都會顯示舊快取，
 *   **唯一可信的驗證是打 API 把內容讀回來逐字比對**（這支最後就是這麼做的）。
 *
 * 用法：
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   node scripts/deploy-firestore-rules.mjs            # dry-run，只讀不寫
 *   node scripts/deploy-firestore-rules.mjs --apply    # 真的部署
 *
 * service account 需要 scope https://www.googleapis.com/auth/firebase。
 * 專案 id 預設讀 .firebaserc 的 projects.default，可用 --project=<id> 覆寫。
 */
import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const APPLY = process.argv.includes('--apply');
const projectArg = process.argv.find(a => a.startsWith('--project='));

/**
 * 這些關鍵字缺任何一個，代表要送上去的是舊版檔案。
 * 少了它們不會有任何錯誤訊息，只會靜靜地把逐片指派、客戶密碼隔離、請款解鎖限制
 * 這些權限判斷刪掉 —— 曾經發生過，所以在這裡硬擋。
 */
const MUST_CONTAIN = [
  'assetAssignedToMe',
  'touchesEditorAssignment',
  'vendorSecrets',
  'internalUnlockingInvoice',
  // 2026-09-23 加入：Drive 上傳的三個 collection。這三個都是 allow write: if false，
  // 舊檔裡沒有它們 —— 不小心送舊檔上去的話，這三張表就變成「沒有規則」而全面拒絕，
  // 畫面會突然讀不到上傳紀錄，而且不會有任何錯誤訊息。
  'assetUploads',
  'driveFolders',
  'appConfig',
  // 2026-09-24 加入：素材的剪輯需求。少了這行型別檢查，寫得進去但規則等於沒把關，
  // 而且代表送上去的是不含這次改動的舊檔。
  'editingBrief',
];

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  fail('請先設定 GOOGLE_APPLICATION_CREDENTIALS 指向 service account 金鑰（本腳本刻意不硬編路徑）');
}

const projectId = projectArg
  ? projectArg.split('=')[1]
  : JSON.parse(readFileSync('.firebaserc', 'utf8')).projects?.default;
if (!projectId) fail('找不到專案 id：.firebaserc 沒有 projects.default，請用 --project=<id>');

// (default) database 的 release 名稱固定是 cloud.firestore；具名資料庫是 cloud.firestore/<db>
const RELEASE = `projects/${projectId}/releases/cloud.firestore`;

const local = readFileSync('firestore.rules', 'utf8');
const missingLocal = MUST_CONTAIN.filter(k => !local.includes(k));
if (missingLocal.length) fail(`本機 firestore.rules 缺少關鍵字，中止：${missingLocal.join(', ')}`);
console.log(`本機 firestore.rules：${local.length} 字元，關鍵字齊全 ✅`);

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase'] });
const client = await auth.getClient();
const api = async (path, method = 'GET', data) =>
  (await client.request({ url: `https://firebaserules.googleapis.com/v1/${path}`, method, data })).data;

// 1. 先記下目前線上是哪一份 —— 沒有這個就沒辦法指名回滾
const before = await api(RELEASE);
console.log(`\n目前線上 ruleset：${before.rulesetName}`);
console.log(`回滾方式：PATCH ${RELEASE}  body {"release":{"name":"${RELEASE}","rulesetName":"${before.rulesetName}"}}`);

const onlineContent = (await api(before.rulesetName)).source.files[0].content;
if (onlineContent === local) {
  console.log('\n✅ 線上內容與本機逐字相同，不需要部署。');
  process.exit(0);
}

// 2. 逐行 diff。
//    ⚠️ 不要用「哪些行只在本機有」這種集合比對：同一行文字常常在別的 collection 也出現
//    （例如 `allow read: ... editorCanAccessVendor(...)` 在好幾個 match 區塊裡一模一樣），
//    真正被改掉的那一行會完全看不出來。
const diff = lineDiff(onlineContent, local);
console.log(`\n=== 與線上的差異（${diff.length} 個區塊）===`);
for (const hunk of diff) {
  console.log(`@@ 第 ${hunk.line} 行附近`);
  hunk.removed.forEach(l => console.log(`  - ${l}`));
  hunk.added.forEach(l => console.log(`  + ${l}`));
}

if (!APPLY) {
  console.log('\n(dry-run，未寫入任何東西。確認上面的差異無誤後加 --apply)');
  process.exit(0);
}

// 3. 建立新 ruleset 並讓 release 指向它
const ruleset = await api(`projects/${projectId}/rulesets`, 'POST', {
  source: { files: [{ name: 'firestore.rules', content: local }] },
});
console.log(`\n新 ruleset：${ruleset.name}`);
await api(RELEASE, 'PATCH', { release: { name: RELEASE, rulesetName: ruleset.name } });
console.log('release 已更新');

// 4. 回讀驗證（唯一可信的驗證方式）
const after = await api(RELEASE);
const afterContent = (await api(after.rulesetName)).source.files[0].content;
const missingAfter = MUST_CONTAIN.filter(k => !afterContent.includes(k));

const checks = [
  ['release 指向新 ruleset', after.rulesetName === ruleset.name],
  ['線上內容與本機逐字相同', afterContent === local],
  ['關鍵字齊全', missingAfter.length === 0],
];
console.log('\n=== 部署後回讀驗證 ===');
checks.forEach(([name, ok]) => console.log(`${ok ? '✅' : '❌'} ${name}`));
if (!checks.every(([, ok]) => ok)) {
  fail(`驗證未全過，請考慮回滾到 ${before.rulesetName}`);
}
console.log('\n部署完成。');

/** 極簡逐行 diff，只為了讓人在部署前看清楚到底改了什麼 */
function lineDiff(a, b) {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  const hunks = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (A[i] === B[j]) { i++; j++; continue; }
    const removed = [], added = [];
    const line = j + 1;
    // 往前找下一個對得上的錨點，中間的算成一個區塊
    let k = 1;
    for (; k < 200; k++) {
      if (A[i + k] !== undefined && A[i + k] === B[j]) { removed.push(...A.slice(i, i + k)); i += k; break; }
      if (B[j + k] !== undefined && B[j + k] === A[i]) { added.push(...B.slice(j, j + k)); j += k; break; }
      if (A[i + k] !== undefined && A[i + k] === B[j + k]) {
        removed.push(...A.slice(i, i + k));
        added.push(...B.slice(j, j + k));
        i += k; j += k;
        break;
      }
    }
    if (k >= 200) { removed.push(...A.slice(i)); added.push(...B.slice(j)); i = A.length; j = B.length; }
    hunks.push({ line, removed: removed.filter(l => l.trim()), added: added.filter(l => l.trim()) });
  }
  return hunks;
}
