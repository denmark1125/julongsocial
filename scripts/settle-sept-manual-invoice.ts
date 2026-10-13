/**
 * 一次性：剪輯師「謝謝」2026-09 的剪輯費改用人工請款單（Google 試算表）結算，共 39 支、31,350 元。
 * 把這 39 支標成舊制已結清，系統請款就不會再算一次。
 *
 * 切分規則（老闆 2026-10-13 確認）：這張表上的片走人工；其餘 2026-10-06 起上傳雲端的片走系統請款。
 * 正式資料上，表上最晚一支是 10/5 23:36 上傳，表外最早一支是 10/6 13:54，剛好切開。
 *
 * 另外修正 9 支記錯剪輯師的片（秀姨 5、大發 1、CWORKS 2、杜永霖 1）：表上都是謝謝剪的，
 * 系統卻記在 Peggy／Irene 名下或標成內部剪輯。這 9 支都沒上傳雲端，沒有 billableEditorId 可凍結。
 *
 * ⚠️ 不補 cloudUploadedAt：補了會讓片子變成可請款。
 * ⚠️ 要搭配 isBillable() 的「paid 一律不可請款」：表上有 32 支還沒上傳，沒有那道判斷的話一上傳就會重複付錢。
 *
 * 用法（先 dry-run 看清單，確認後才寫入）：
 *   npx tsx scripts/settle-sept-manual-invoice.ts
 *   npx tsx scripts/settle-sept-manual-invoice.ts --apply
 * 需要環境變數 FIREBASE_SERVICE_ACCOUNT_KEY。寫入前的原值存到 scripts/settle-sept-manual-invoice.<時間>.json，可據以還原。
 */
import { readFileSync, writeFileSync } from 'fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const SOURCE = '2026-09 人工請款單（謝謝）';
const EDITOR_XIEXIE = '7uD0Go7hW8Rw3kyaCMER';

// [IP, 系統片名, 試算表金額, 是否要改回謝謝名下]。片名以系統為準；試算表寫法不同的已逐支跟老闆確認。
const SHEET: [string, string, number, boolean?][] = [
  ['祥濱辦桌', '神明生日工廠開幕自助宴 感謝主家姊姊信賴', 900],
  ['祥濱辦桌', '慈善活動', 900], // 表上：林園在地服務鄉親泰山慈善會 會員大會
  ['祥濱辦桌', '前三名', 900],
  ['祥濱辦桌', '挑戰遶境認識100的新朋友', 750],
  ['祥濱辦桌', '颱風天的普渡宴 突破萬難只為了準時出餐', 750],
  ['祥濱辦桌', '賣貨便', 750],
  ['祥濱辦桌', '干貝泡芙', 750], // 表上：意外的辦桌菜紅牌 奶香焗烤干貝泡芙
  ['祥濱辦桌', '中秋晚會', 750],
  ['廣信旅遊', '冬季滑雪團 你一定要知道的小細節', 900],
  ['廣信旅遊', '只有我知道的各國奇妙購物站分享', 900],
  ['廣信旅遊', '旅平險、旅遊不便險 搞不懂就虧大了', 900],
  ['廣信旅遊', '『泛流量』:用帶團出國宣示 POV:當你帶00後出團', 750],
  ['廣信旅遊', '石垣島 沖繩自駕行程 不用X萬就搞定', 750],
  ['廣信旅遊', '帶團出國遇到不聽話的奧客怎麼辦?直接潛送回台!', 750],
  ['廣信旅遊', '鬼月結束才敢說的事情', 750],
  ['廣信旅遊', '旅平險理賠90%的人都會吃到虧的眉角', 750],
  ['杜永霖', '我用10多年+房地產經驗只為了讓你少走彎路', 900, true], // 表上 IP 寫「業務」
  ['大發超哥', '買二手車必存APP，別被車貸低月付騙了', 900],
  ['大發超哥', '二手車收車倒貼好幾萬?老闆你這樣有賺嗎?', 750, true],
  ['大發超哥', '二手車商辛酸血淚:我的成功也是一路被騙來的!', 750],
  ['自然風', '熱水界的勞濕來濕 徵選3個企業名額 直接成本價給你啦!', 900],
  ['自然風', '熱水器也有分 你選對了嗎?', 900],
  ['自然風', '熱水器壞掉 不能只看機器本身', 900],
  ['自然風', '飯店隱形成本 住房率越高越虧錢', 900],
  ['自然風', 'POV 當你叫剪輯師把廢話剪掉', 750],
  ['芫芫', '展成做公益關懷老人長照', 750], // 表上 IP 寫「磁磚」
  ['秀姨', '業務第10年，我學會了什麼', 900, true],
  ['秀姨', '月薪4萬，怎麼存到100萬', 900, true],
  ['秀姨', '房貸原來有分這兩種', 750, true],
  ['秀姨', '房子為什麼要增貸', 750, true],
  ['秀姨', '300萬擁有退休生活是真的嗎？', 750, true],
  ['康青龍', '中文博大精深', 750], // 表上：你也有遇過國文小老師嗎
  ['康青龍', '當你的常客喝著別人的飲料', 750],
  ['康青龍', '沒耐心的客人', 750],
  ['康青龍', '當員工失戀', 750],
  ['極酵文創', '2026下半年想財源滾滾？測妳自帶哪種『有錢花』體', 750],
  ['極酵文創', '新創路上老闆的一句話', 750],
  ['CWORKS', '15分鐘CWORKS員工替換普立輪', 750, true],
  ['CWORKS', '奧客實測！銷冠凱茜能不能招架住呢？', 750, true],
];

const cfg = JSON.parse(readFileSync(new URL('../firebase-applet-config.json', import.meta.url), 'utf8'));
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!)), projectId: cfg.projectId });
const db = getFirestore(cfg.firestoreDatabaseId);

const [assetSnap, vendorSnap, editorSnap] = await Promise.all([
  db.collection('assets').get(), db.collection('vendors').get(), db.collection('editors').get(),
]);
const vendors: Record<string, { name?: string; editorId?: string }> = {};
vendorSnap.docs.forEach(d => { vendors[d.id] = d.data(); });
const editorName: Record<string, string> = {};
editorSnap.docs.forEach(d => { editorName[d.id] = d.data().name; });
const videos = assetSnap.docs
  .map(d => ({ id: d.id, ...(d.data() as any) }))
  .filter(a => a.type === 'video' && !a.voidedAt);
const ipOf = (a: any) => vendors[a.vendorId]?.name || a.vendorName || '';

const problems: string[] = [];
const targets = SHEET.map(([ip, title, amount, fixEditor]) => {
  const hits = videos.filter(a => ipOf(a) === ip && String(a.title || '').trim() === title);
  if (hits.length !== 1) problems.push(`【${ip}】${title}：找到 ${hits.length} 支`);
  return { ip, title, amount, fixEditor: !!fixEditor, asset: hits[0] };
});
if (problems.length) {
  console.error('片名對不上，停止：\n' + problems.join('\n'));
  process.exit(1);
}

let total = 0;
console.log(`${APPLY ? '寫入' : '預覽（dry-run）'}：共 ${targets.length} 支\n`);
for (const t of targets) {
  const a = t.asset;
  total += t.amount;
  const owner = a.internalEdit ? '內部剪輯' : editorName[a.editorId || vendors[a.vendorId]?.editorId] || '?';
  const upload = a.cloudUploadedAt ? `已上傳 ${new Date(a.cloudUploadedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}` : '未上傳';
  const notes = [
    a.editorInvoiceId ? '⚠已入系統請款單' : '',
    a.legacySettlementStatus ? `原本已標 ${a.legacySettlementStatus}` : '原本沒標',
    t.fixEditor ? `剪輯師 ${owner} → 謝謝` : '',
  ].filter(Boolean).join('、');
  console.log(`  ${t.amount}｜【${t.ip}】${t.title}｜${upload}｜${notes}`);
}
console.log(`\n合計 ${total.toLocaleString()} 元（試算表 31,350）`);
const invoiced = targets.filter(t => t.asset.editorInvoiceId);
if (invoiced.length) {
  console.error(`\n有 ${invoiced.length} 支已經進了系統請款單，要先作廢那張單再跑。`);
  process.exit(1);
}

if (!APPLY) {
  console.log('\n沒有寫入任何資料。確認清單無誤後加 --apply 執行。');
  process.exit(0);
}

const now = new Date().toISOString();
const before = targets.map(({ asset: a }) => ({
  id: a.id, title: a.title,
  editorId: a.editorId ?? null, internalEdit: a.internalEdit ?? null,
  legacySettlementStatus: a.legacySettlementStatus ?? null, legacySettlementSource: a.legacySettlementSource ?? null,
  legacySettledAmount: a.legacySettledAmount ?? null, legacySettledAt: a.legacySettledAt ?? null,
  legacyReviewedAt: a.legacyReviewedAt ?? null, legacyReviewedByUid: a.legacyReviewedByUid ?? null,
}));
const log = new URL(`./settle-sept-manual-invoice.${now.replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(log, JSON.stringify({ appliedAt: now, before }, null, 2));

const batch = db.batch();
targets.forEach(t => batch.update(db.collection('assets').doc(t.asset.id), {
  legacySettlementStatus: 'paid',
  legacySettlementSource: SOURCE,
  legacySettledAmount: t.amount,
  legacySettledAt: now,
  legacyReviewedAt: now,
  legacyReviewedByUid: 'script:settle-sept-manual-invoice',
  ...(t.fixEditor ? { editorId: EDITOR_XIEXIE, internalEdit: false } : {}),
}));
await batch.commit();
console.log(`\n已寫入 ${targets.length} 支。寫入前的原值：${log.pathname}`);
