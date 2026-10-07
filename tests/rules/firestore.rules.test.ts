import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

// firestore.rules 的行為測試，跑在 Firestore 模擬器上（npm run test:rules）。
// 專案 id 用 demo- 開頭＝模擬器保證不會連到任何真的 Firebase 專案。
//
// 這份測試鎖住「現在已經是對的」行為：users 不能自建、經理不能升級、剪輯師欄位白名單、請款鎖。
// 規則改動之前先在這裡寫下預期，部署前 CI 會擋住改壞的規則。

let env: RulesTestEnvironment;

const NOW = '2026-10-05T10:00:00+08:00';

const users = {
  boss: { uid: 'boss', role: 'engineer' },
  manager: { uid: 'mgr', role: 'manager' },
  staff: { uid: 'staff', role: 'employee' },
  editor: { uid: 'ed', role: 'editor', linkedEditorId: 'E1', assignedVendorIds: ['v1'] },
};

const as = (uid: string) => env.authenticatedContext(uid, { email: `${uid}@forest.system` }).firestore();
/** 有 Firebase 帳號、但不是系統建立的人（例如隨便一個 Google 帳號登入） */
const outsider = () => env.authenticatedContext('outsider', { email: 'someone@gmail.com' }).firestore();

const asset = (extra: Record<string, unknown> = {}) => ({
  vendorId: 'v1', title: '測試素材', type: 'video', status: 'available', stage: 'raw',
  approved: false, createdBy: 'staff', createdAt: NOW, ...extra,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-julongsocial',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const u of Object.values(users)) await setDoc(doc(db, 'users', u.uid), u);
    await setDoc(doc(db, 'vendors', 'v1'), { name: '祥濱', createdBy: 'boss' });
    await setDoc(doc(db, 'vendors', 'v2'), { name: '自然風', createdBy: 'boss' });
    await setDoc(doc(db, 'assets', 'a1'), asset());
    await setDoc(doc(db, 'assets', 'a2'), asset({ vendorId: 'v2' }));
    await setDoc(doc(db, 'assets', 'a3'), asset({ vendorId: 'v2', editorId: 'E1' }));
    await setDoc(doc(db, 'assets', 'invoiced'), asset({ stage: 'finished', editorFee: 900, editorInvoiceId: 'inv1', cloudUploadedAt: NOW }));
    await setDoc(doc(db, 'vendorSecrets', 'v1'), { passwords: { 'IG␟xb': 'secret' } });
  });
});

describe('users：帳號只能由管理者建立（2026-09-30 的洞）', () => {
  it('任何 Google 帳號都不能幫自己建 engineer', async () => {
    await assertFails(setDoc(doc(outsider(), 'users', 'outsider'), { role: 'engineer' }));
  });

  it('一般員工不能建帳號', async () => {
    await assertFails(setDoc(doc(as('staff'), 'users', 'new1'), { role: 'employee' }));
  });

  it('經理可以建員工，但不能建 engineer', async () => {
    await assertSucceeds(setDoc(doc(as('mgr'), 'users', 'new1'), { role: 'employee' }));
    await assertFails(setDoc(doc(as('mgr'), 'users', 'new2'), { role: 'engineer' }));
  });

  it('經理不能把自己升成 engineer，也不能改 engineer 的文件', async () => {
    await assertFails(updateDoc(doc(as('mgr'), 'users', 'mgr'), { role: 'engineer' }));
    await assertFails(updateDoc(doc(as('mgr'), 'users', 'boss'), { displayName: 'x' }));
  });

  it('engineer 可以調整角色', async () => {
    await assertSucceeds(updateDoc(doc(as('boss'), 'users', 'mgr'), { role: 'engineer' }));
  });

  it('只讀得到自己的文件，經理以上才讀得到別人', async () => {
    await assertSucceeds(getDoc(doc(as('staff'), 'users', 'staff')));
    await assertFails(getDoc(doc(as('staff'), 'users', 'boss')));
    await assertSucceeds(getDoc(doc(as('mgr'), 'users', 'staff')));
  });
});

describe('沒有系統帳號的人什麼都讀不到', () => {
  it('廠商、素材、客戶密碼都讀不到', async () => {
    await assertFails(getDoc(doc(outsider(), 'vendors', 'v1')));
    await assertFails(getDoc(doc(outsider(), 'assets', 'a1')));
    await assertFails(getDoc(doc(outsider(), 'vendorSecrets', 'v1')));
  });
});

describe('剪輯師', () => {
  it('讀得到被指派 IP 的素材、以及逐片指名給他的素材；其他 IP 讀不到', async () => {
    await assertSucceeds(getDoc(doc(as('ed'), 'assets', 'a1')));
    await assertSucceeds(getDoc(doc(as('ed'), 'assets', 'a3')));
    await assertFails(getDoc(doc(as('ed'), 'assets', 'a2')));
  });

  it('只能改白名單欄位：交片送審可以，改片名不行', async () => {
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), {
      stage: 'finished', flowStage: 'client_review', submittedAt: NOW, submittedBy: 'ed',
    }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { title: '改名' }));
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'a1'), { title: '改名' }));
  });

  it('不能建素材、讀不到客戶密碼', async () => {
    await assertFails(setDoc(doc(as('ed'), 'assets', 'new'), asset()));
    await assertFails(getDoc(doc(as('ed'), 'vendorSecrets', 'v1')));
  });

  it('計費歸屬只能寫成自己', async () => {
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { billableEditorId: 'E1' }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { billableEditorId: 'E2' }));
  });

  it('請款單只能開給自己、只能從「已送出」開始', async () => {
    const invoice = {
      editorId: 'E1', editorName: '謝謝', submittedByUid: 'ed', billingMonth: '2026-10',
      items: [{ assetId: 'a1', amount: 900 }], itemCount: 1, totalAmount: 900,
      status: 'submitted', submittedAt: NOW, createdAt: NOW,
    };
    await assertSucceeds(setDoc(doc(as('ed'), 'editorInvoices', 'i1'), invoice));
    await assertFails(setDoc(doc(as('ed'), 'editorInvoices', 'i2'), { ...invoice, editorId: 'E2' }));
    await assertFails(setDoc(doc(as('ed'), 'editorInvoices', 'i3'), { ...invoice, status: 'paid', paidAt: NOW, paidByUid: 'ed' }));
  });
});

describe('請款鎖：已入單的片金額凍結', () => {
  // 每條「應該被拒絕」都配一個只差一點、應該通過的對照組：
  // 被拒絕的原因可能是別條規則（例如運算式上限），對照組通過才證明擋下的是這條鎖。
  it('連老闆都不能改已入單片的剪輯費（沒入單的可以）', async () => {
    await assertSucceeds(updateDoc(doc(as('boss'), 'assets', 'a1'), { editorFee: 1000 }));
    await assertFails(updateDoc(doc(as('boss'), 'assets', 'invoiced'), { editorFee: 1000 }));
  });

  it('經理可以把請款單號清空（作廢重開），員工不行', async () => {
    await assertFails(updateDoc(doc(as('staff'), 'assets', 'invoiced'), { editorInvoiceId: '' }));
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'invoiced'), { isUrgent: true }));
    await assertSucceeds(updateDoc(doc(as('mgr'), 'assets', 'invoiced'), { editorInvoiceId: '' }));
  });

  it('已上傳雲端或已入單的片不能刪', async () => {
    await assertFails(deleteDoc(doc(as('boss'), 'assets', 'invoiced')));
    await assertSucceeds(deleteDoc(doc(as('mgr'), 'assets', 'a2')));
  });

  it('剪輯費上限 100000', async () => {
    await assertSucceeds(updateDoc(doc(as('boss'), 'assets', 'a1'), { editorFee: 100000 }));
    await assertFails(updateDoc(doc(as('boss'), 'assets', 'a2'), { editorFee: 100001 }));
  });
});

describe('只能由後端寫入的表', () => {
  it('上傳紀錄、Drive 對照表、系統設定：前端誰都寫不進去', async () => {
    await assertFails(setDoc(doc(as('boss'), 'assetUploads', 'x'), { a: 1 }));
    await assertFails(setDoc(doc(as('boss'), 'driveFolders', 'x'), { a: 1 }));
    await assertFails(setDoc(doc(as('boss'), 'appConfig', 'drive'), { a: 1 }));
  });
});
