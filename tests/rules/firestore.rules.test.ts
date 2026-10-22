import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField } from 'firebase/firestore';

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
    await setDoc(doc(db, 'assets', 'paidOutside'), asset({ stage: 'finished', cloudUploadedAt: NOW, legacySettlementStatus: 'paid' }));
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

describe('剪輯順序：公司排、剪輯師不能改', () => {
  it('員工可以排剪輯順序，剪輯師不行（同一支片、同一個欄位）', async () => {
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'a1'), { editOrder: 1 }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { editOrder: 2 }));
    // 對照組：剪輯師對這支片本來就有權限，被擋的是 editOrder 這個欄位
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), {
      stage: 'finished', flowStage: 'client_review', submittedAt: NOW, submittedBy: 'ed',
    }));
  });

  it('順序要是整數', async () => {
    await assertFails(updateDoc(doc(as('staff'), 'assets', 'a1'), { editOrder: '1' }));
    await assertFails(updateDoc(doc(as('staff'), 'assets', 'a1'), { batchIndex: 1.5 }));
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'a1'), { batchIndex: 2 }));
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

  it('人工請款單已付過的片，誰都不能再放進系統請款單（沒標已付的可以）', async () => {
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'paidOutside'), { editorFee: 750, editorInvoiceId: 'inv9' }));
    await assertFails(updateDoc(doc(as('boss'), 'assets', 'paidOutside'), { editorInvoiceId: 'inv9' }));
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorFee: 750, editorInvoiceId: 'inv9' }));
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

describe('手動加的發片日 extraSlots（2026-10-20）', () => {
  const slot = (extra: Record<string, unknown> = {}) => ({
    vendorId: 'v1', date: '2026-10-28', time: '19:00', contentType: 'video', createdBy: 'staff', createdAt: NOW, ...extra,
  });

  it('員工可以加、改、刪；剪輯師同一筆都不行', async () => {
    await assertSucceeds(setDoc(doc(as('staff'), 'extraSlots', 's1'), slot()));
    await assertFails(setDoc(doc(as('ed'), 'extraSlots', 's2'), slot()));
    await assertFails(updateDoc(doc(as('ed'), 'extraSlots', 's1'), { date: '2026-10-29' }));
    await assertSucceeds(updateDoc(doc(as('staff'), 'extraSlots', 's1'), { date: '2026-10-29' }));
    await assertFails(deleteDoc(doc(as('ed'), 'extraSlots', 's1')));
    await assertSucceeds(deleteDoc(doc(as('staff'), 'extraSlots', 's1')));
  });

  it('日期、時間格式錯或多帶欄位就擋（格式對的同一筆可以）', async () => {
    await assertFails(setDoc(doc(as('staff'), 'extraSlots', 'bad1'), slot({ date: '10/28' })));
    await assertFails(setDoc(doc(as('staff'), 'extraSlots', 'bad2'), slot({ time: '7pm' })));
    await assertFails(setDoc(doc(as('staff'), 'extraSlots', 'bad3'), slot({ assetId: 'a1' })));
    await assertSucceeds(setDoc(doc(as('staff'), 'extraSlots', 'ok'), slot()));
  });

  it('剪輯師讀得到負責 IP 的，讀不到別家的', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'extraSlots', 'mine'), slot());
      await setDoc(doc(ctx.firestore(), 'extraSlots', 'other'), slot({ vendorId: 'v2' }));
    });
    await assertSucceeds(getDoc(doc(as('ed'), 'extraSlots', 'mine')));
    await assertFails(getDoc(doc(as('ed'), 'extraSlots', 'other')));
  });
});

describe('毛片綁小編貼文 plannedPostId（2026-10-20）', () => {
  it('員工可以寫字串，寫成非字串就擋', async () => {
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'a1'), { plannedPostId: 'p1' }));
    await assertFails(updateDoc(doc(as('staff'), 'assets', 'a1'), { plannedPostId: 123 }));
  });
});

describe('剪輯師回報素材問題 editorReport（2026-10-20）', () => {
  const report = (extra: Record<string, unknown> = {}) => ({ reason: 'missing', at: NOW, byName: '謝謝', ...extra });

  it('剪輯師可以回報自己的片、可以撤回；別家的片不行', async () => {
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: report({ note: '只有一支 5 秒' }) }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a2'), { editorReport: report() }));
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: deleteField() }));
  });

  it('剪輯師不能自己標「已處理」，員工可以（同一個欄位）', async () => {
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: report() }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: report({ resolvedAt: NOW }) }));
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'a1'), { editorReport: report({ resolvedAt: NOW }) }));
  });

  it('原因不在四種裡、備註太長、多帶欄位都擋（格式對的同一筆可以）', async () => {
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: report({ reason: 'lazy' }) }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: report({ note: 'x'.repeat(501) }) }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: report({ editorFee: 1 }) }));
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { editorReport: report() }));
  });

  it('剪輯師仍然不能改 rawCheck（後端寫的）', async () => {
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { rawCheck: { videoCount: 9, fileCount: 9, checkedAt: NOW } }));
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'a1'), { rawCheck: { videoCount: 9, fileCount: 9, checkedAt: NOW } }));
  });
});

describe('送審歷程 submissions（2026-10-21）', () => {
  const s1 = { version: 1, submittedAt: NOW, byName: '謝謝' };
  const s2 = { version: 2, submittedAt: NOW, byName: '謝謝' };

  it('剪輯師可以往後附加一筆；不能刪掉或改掉以前的', async () => {
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { submissions: [s1] }));
    await assertSucceeds(updateDoc(doc(as('ed'), 'assets', 'a1'), { submissions: [s1, s2] }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { submissions: [s2] }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { submissions: [{ ...s1, submittedAt: '2020-01-01' }, s2] }));
  });

  it('剪輯師不能寫 reviewFiles／durationMismatch（後端才能寫）；員工可以', async () => {
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { reviewFiles: [] }));
    await assertFails(updateDoc(doc(as('ed'), 'assets', 'a1'), { durationMismatch: false }));
    await assertSucceeds(updateDoc(doc(as('staff'), 'assets', 'a1'), { durationMismatch: false }));
  });

  it('前端讀不到 previewLinks', async () => {
    await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'previewLinks', 't1'), { assetId: 'a1' }); });
    await assertFails(getDoc(doc(as('boss'), 'previewLinks', 't1')));
  });
});

describe('editors 名冊：外包／內部、離職', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await setDoc(doc(ctx.firestore(), 'editors', 'E1'), { name: '謝謝', kind: 'external', createdAt: NOW });
    });
  });
  it('主管可以改外包／內部', async () => {
    await assertSucceeds(updateDoc(doc(as('mgr'), 'editors', 'E1'), { kind: 'internal' }));
  });
  it('一般員工不能改外包／內部（會影響請款）', async () => {
    await assertFails(updateDoc(doc(as('staff'), 'editors', 'E1'), { kind: 'internal' }));
  });
  it('主管可以設通知群組，一般員工不行', async () => {
    await assertSucceeds(updateDoc(doc(as('mgr'), 'editors', 'E1'), { lineGroupId: 'C1' }));
    await assertFails(updateDoc(doc(as('staff'), 'editors', 'E1'), { lineGroupId: 'C2' }));
  });
  it('LINE 群組清單：主管讀得到、一般員工讀不到、誰都不能寫', async () => {
    await env.withSecurityRulesDisabled(async ctx => { await setDoc(doc(ctx.firestore(), 'line_groups', 'C1'), { groupName: 'g' }); });
    await assertSucceeds(getDoc(doc(as('mgr'), 'line_groups', 'C1')));
    await assertFails(getDoc(doc(as('staff'), 'line_groups', 'C1')));
    await assertFails(setDoc(doc(as('mgr'), 'line_groups', 'C9'), { groupName: 'x' }));
  });
  it('一般員工改名字照樣可以（對照組）', async () => {
    await assertSucceeds(updateDoc(doc(as('staff'), 'editors', 'E1'), { name: '謝謝2' }));
  });
  it('連主管都不能從前端直接標離職', async () => {
    await assertFails(updateDoc(doc(as('mgr'), 'editors', 'E1'), { leftAt: NOW }));
  });
  it('新增時不能直接帶離職；正常新增可以（對照組）', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'editors', 'E9'), { name: 'x', createdAt: NOW, leftAt: NOW }));
    await assertSucceeds(setDoc(doc(as('staff'), 'editors', 'E8'), { name: 'x', kind: 'external', createdAt: NOW }));
  });
  it('剪輯師本人不能改名冊', async () => {
    await assertFails(updateDoc(doc(as('ed'), 'editors', 'E1'), { name: 'x' }));
  });
});

describe('posts：排上片日自動建的待補中貼文', () => {
  const auto = (extra: Record<string, unknown> = {}) => ({
    vendorId: 'v1', title: '熱泵', autoTitle: '熱泵', content: '', status: 'pending', assetId: 'to_be_added',
    createdFrom: 'airDateBoard', createdBy: 'staff', createdAt: NOW, ...extra,
  });
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'posts', 'auto'), auto());
      await setDoc(doc(db, 'posts', 'renamed'), auto({ title: '小編改過' }));
      await setDoc(doc(db, 'posts', 'withCopy'), auto({ content: '文案' }));
      await setDoc(doc(db, 'posts', 'manual'), auto({ createdFrom: null, autoTitle: null }));
    });
  });
  it('一般員工可以刪沒人動過的自動貼文', async () => {
    await assertSucceeds(deleteDoc(doc(as('staff'), 'posts', 'auto')));
  });
  it('小編改過標題的不能刪', async () => {
    await assertFails(deleteDoc(doc(as('staff'), 'posts', 'renamed')));
  });
  it('寫了文案的不能刪', async () => {
    await assertFails(deleteDoc(doc(as('staff'), 'posts', 'withCopy')));
  });
  it('小編自己建的待補中不能刪（對照組）', async () => {
    await assertFails(deleteDoc(doc(as('staff'), 'posts', 'manual')));
  });
  it('主管照舊什麼都能刪（對照組）', async () => {
    await assertSucceeds(deleteDoc(doc(as('mgr'), 'posts', 'manual')));
  });
  it('剪輯師不能刪', async () => {
    await assertFails(deleteDoc(doc(as('ed'), 'posts', 'auto')));
  });
});
