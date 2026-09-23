#!/usr/bin/env node
/**
 * 唯讀：確認 Drive 授權這條鏈是通的。不寫入、不建立任何東西。
 *
 * 會回答三件事：
 *   1. refresh token 換得到 access token 嗎（＝授權還有效）
 *   2. 授權的是**哪個 Google 帳號**（必須是公司帳號，不是個人帳號）
 *   3. 那個帳號的 Drive 還剩多少空間
 *
 * 用法：node scripts/drive-check.mjs
 * 讀 .env 的 GOOGLE_OAUTH_CLIENT_ID / _SECRET / GOOGLE_DRIVE_REFRESH_TOKEN。
 *
 * ⚠️ 刻意不印出任何 token —— 這支的輸出可以安全貼給別人看。
 */
import 'dotenv/config';

const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret,
        GOOGLE_DRIVE_REFRESH_TOKEN: refresh } = process.env;

const missing = [
  !id && 'GOOGLE_OAUTH_CLIENT_ID',
  !secret && 'GOOGLE_OAUTH_CLIENT_SECRET',
  !refresh && 'GOOGLE_DRIVE_REFRESH_TOKEN',
].filter(Boolean);
if (missing.length) {
  console.error('❌ .env 缺少：' + missing.join('、'));
  process.exit(1);
}

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: id, client_secret: secret,
    refresh_token: refresh, grant_type: 'refresh_token',
  }),
});
const tok = await tokenRes.json();
if (!tokenRes.ok || !tok.access_token) {
  // 只印 Google 的錯誤代碼與說明，不會帶到任何憑證
  console.error('❌ 換 access token 失敗：', tok.error, '-', tok.error_description || '');
  console.error('   invalid_grant 最常見的原因：同意畫面還停在 Testing（token 7 天失效），');
  console.error('   或這把 refresh token 已經被撤銷。');
  process.exit(1);
}
console.log('✅ refresh token 有效，換到 access token');
console.log('   本次授權範圍：', tok.scope);

const aboutRes = await fetch(
  'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota',
  { headers: { Authorization: `Bearer ${tok.access_token}` } }
);
const about = await aboutRes.json();
if (!aboutRes.ok) {
  console.error('❌ 讀 Drive 資訊失敗：', JSON.stringify(about?.error ?? about));
  process.exit(1);
}

const GB = n => (Number(n) / 1024 ** 3).toFixed(1) + ' GB';
const q = about.storageQuota || {};
const free = Number(q.limit || 0) - Number(q.usage || 0);

console.log('\n授權的帳號：', about.user?.emailAddress, `(${about.user?.displayName || ''})`);
console.log('  總容量：', GB(q.limit));
console.log('  已使用：', GB(q.usage));
console.log('  剩餘  ：', GB(free));
if (q.usageInDriveTrash) console.log('  垃圾桶：', GB(q.usageInDriveTrash), '（清空才會真的釋放）');

if (about.user?.emailAddress !== 'julang.tw2025@gmail.com') {
  console.error('\n⚠️⚠️ 授權的不是公司帳號！檔案會傳到上面那個帳號的 Drive，不是公司那 1.9TB。');
  console.error('   要重來：去 https://myaccount.google.com/permissions 移除這個 app，');
  console.error('   再跑一次 get-drive-refresh-token.mjs，登入時選公司帳號。');
  process.exit(1);
}
console.log('\n✅ 是公司帳號，整條鏈通了。');
process.exit(0);
