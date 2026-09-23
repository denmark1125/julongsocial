#!/usr/bin/env node
/**
 * 一次性：換一把公司 Google 帳號的 Drive refresh token。
 *
 * 為什麼需要：系統要能替同事把毛片歸檔到公司 Drive，而檔案必須由**公司帳號**擁有
 *（服務帳戶不行 —— 個人 Gmail 沒有共用雲端硬碟，SA 上傳的檔案吃它自己那 15GB，
 *  而且那個配額買不到）。所以後端需要一把長期有效的 refresh token。
 *
 * 用法（在這個資料夾下）：
 *   node scripts/get-drive-refresh-token.mjs
 * 或先設好環境變數再跑：
 *   GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy node scripts/get-drive-refresh-token.mjs
 *
 * 前置作業（GCP Console，只做一次）：
 *   1. 啟用 Google Drive API 與 Google Picker API
 *   2. Google Auth Platform → Branding：填應用程式名稱與支援信箱
 *   3. Google Auth Platform → Audience：User type = External，然後**按「發布應用程式」**
 *      ⚠️ 留在 Testing 的 refresh token 7 天就失效。drive.file 是非敏感範圍，發布不需要送審。
 *   4. Google Auth Platform → Data access：加入範圍 .../auth/drive.file
 *   5. Google Auth Platform → Clients：建立 OAuth client ID（Web application），
 *      授權重新導向 URI 填 http://localhost:5555/oauth2callback
 *
 * ⚠️ 拿到的 refresh token 三個值進 Vercel 環境變數，**絕對不要加 VITE_ 前綴**
 *    （Vite 會把 VITE_* 直接內嵌進前端 bundle，等於公開給每一個瀏覽器）。
 */
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { exec } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 5555;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
// 只要 drive.file：非敏感範圍，不需要 Google 審核，也不需要每年數千美金的 CASA 安全評估。
// 代價是「只看得到這個 app 自己建立的檔案」—— 所以根資料夾必須由 API 自己建。
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

async function ask(rl, label, envValue) {
  if (envValue) return envValue;
  let v = '';
  while (!v) v = (await rl.question(label)).trim();
  return v;
}

/**
 * 從 GCP 下載的 client_secret_*.json 讀出兩個值。
 * 這樣 Client Secret 從頭到尾都不用複製貼上，也不會出現在任何對話紀錄裡。
 */
function readClientJson() {
  const argPath = process.argv.find(a => a.endsWith('.json'));
  let file = argPath;
  if (!file) {
    const dir = join(homedir(), 'Downloads');
    const hit = readdirSync(dir)
      .filter(f => /^client_secret.*\.json$/i.test(f))
      // 取最新下載的那一份（以前可能也下載過別的 client_secret）
      .map(f => { try { return { f, t: statSync(join(dir, f)).mtimeMs }; } catch { return { f, t: 0 }; } })
      .sort((a, b) => b.t - a.t)[0];
    if (hit) file = join(dir, hit.f);
  }
  if (!file) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const c = j.web || j.installed;
    if (c?.client_id && c?.client_secret) {
      console.log(`已讀取：${file}`);
      return { id: c.client_id, secret: c.client_secret };
    }
  } catch (e) {
    console.warn(`讀不懂 ${file}，改成手動輸入：`, e.message);
  }
  return null;
}

const fromJson = readClientJson();
const rl = createInterface({ input: stdin, output: stdout });
const clientId = fromJson?.id || await ask(rl, 'OAuth Client ID：', process.env.GOOGLE_OAUTH_CLIENT_ID);
const clientSecret = fromJson?.secret || await ask(rl, 'OAuth Client Secret：', process.env.GOOGLE_OAUTH_CLIENT_SECRET);
rl.close();

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  // offline 才會給 refresh token；prompt=consent 強制重新同意，
  // 否則同一個帳號第二次授權 Google 不會再發 refresh token（只給 access token）。
  access_type: 'offline',
  prompt: 'consent',
});

console.log('\n請用**公司帳號 julang.tw2025@gmail.com** 登入並同意。');
console.log('如果瀏覽器沒有自動打開，手動複製下面這串：\n');
console.log(authUrl + '\n');

// ⚠️ Windows 的 start 會把網址裡的 & 當成命令分隔符號，網址會從第一個 & 被切斷。
//    症狀是 Google 回「Required parameter is missing: response_type」—— 因為只剩下 client_id。
//    所以網址一定要整個用雙引號包起來。開不起來也沒關係，上面已經印出網址。
exec(`start "" "${authUrl}"`, { shell: 'cmd.exe' }, () => {});

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/oauth2callback') { res.writeHead(404).end(); return; }
    const err = url.searchParams.get('error');
    const c = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<meta charset="utf-8"><h2 style="font-family:system-ui">${err ? '授權失敗：' + err : '完成了，可以關掉這個分頁回終端機看。'}</h2>`);
    server.close();
    err ? reject(new Error(err)) : resolve(c);
  });
  // 上一次執行若還卡在等授權（有 5 分鐘逾時），這裡會 EADDRINUSE。
  // 預設的錯誤是一整頁堆疊，根本看不出要怎麼辦，所以改成講人話。
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      reject(new Error(
        `本機 ${PORT} 埠被占用了——最常見的原因是「上一次跑這支腳本時沒授權成功，它還在等」。
` +
        `  處理：把上一個終端機的腳本按 Ctrl+C 結束，或等 5 分鐘它自己逾時，再跑一次。`
      ));
    } else reject(e);
  });
  server.listen(PORT, () => console.log(`等待授權中…（本機 ${PORT} 埠）`));
  setTimeout(() => { server.close(); reject(new Error('等了 5 分鐘沒有收到授權，已放棄')); }, 5 * 60 * 1000);
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  }),
});
const data = await res.json();

if (!res.ok || !data.refresh_token) {
  console.error('\n❌ 換 token 失敗：', JSON.stringify(data, null, 2));
  console.error('\n最常見的兩個原因：');
  console.error('  1. 重新導向 URI 沒有一字不差地填成 ' + REDIRECT_URI);
  console.error('  2. 這個帳號先前已經同意過 → Google 不再發 refresh token。');
  console.error('     去 https://myaccount.google.com/permissions 移除這個 app 再跑一次。');
  process.exit(1);
}

console.log('\n✅ 拿到了。把這三個值加進 Vercel 的環境變數（Production）：\n');
console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${data.refresh_token}`);
console.log('\n⚠️ 三個都不要加 VITE_ 前綴，也不要貼進任何會進版控的檔案。');
console.log('⚠️ 如果同意畫面還停在 Testing，這把 token 7 天後會失效 —— 記得去 Audience 按發布。');
process.exit(0);
