# 聚浪短影音製作管理系統（julongsocial）

聚浪行銷內部使用的短影音代操後台，用來管理從「拍攝 → 剪輯 → 上片 → 請款」的整條流程。

**正式站：** https://julongsocial.vercel.app

---

## 系統功能

| 模組 | 用途 |
|------|------|
| 客戶（廠商）管理 | 每位客戶的合約片數、發布平台、負責剪輯師、雲端資料夾 |
| 素材庫存 | 毛片／B-roll 上傳到 Google Drive，追蹤每支素材的製作狀態 |
| 製作進度看板 | 待剪、剪輯中、待審、已完成，一眼看出卡在哪一關 |
| 上片排程 | 貼文日曆、預約拍攝、庫存不足警示 |
| 剪輯師工作台 | 剪輯師只看得到指派給自己的素材，可上傳成片、查看排程 |
| 請款對帳 | 剪輯師請款單：公司核准 → 付款處理 → 已付款 |
| LINE 推播 | 每日庫存警示、製作進度摘要（Vercel Cron 定時觸發） |

### 帳號角色

| 角色 | 權限 |
|------|------|
| `engineer` | 系統管理，全部權限 |
| `manager` | 主管，可核准請款、管理客戶與帳號 |
| `employee` | 一般同事，日常排程與素材管理 |
| `editor` | 外包／內部剪輯師，只能存取被指派的客戶與素材 |

---

## 技術架構

- **前端：** React 19 + Vite + Tailwind CSS
- **後端：** Express（`server.ts` 本機開發用；`api/index.ts` 部署在 Vercel Serverless）
- **資料庫與登入：** Firebase Authentication + Cloud Firestore
- **權限控管：** `firestore.rules`（前端擋不住的都要靠這支規則檔）
- **檔案儲存：** Google Drive API
- **通知：** LINE Messaging API
- **部署：** Vercel（推上 `main` 就自動部署）

```
src/
├── components/   各畫面元件（Dashboard、PostManagement、EditorAssetQueue…）
├── lib/          商業邏輯（欠片計算、素材流程、請款、Drive 命名規則）
├── types.ts      資料型別
└── firebase.ts   Firebase 初始化
api/              Vercel Serverless 進入點（含 cron 推播）
scripts/          維運腳本（部署規則、資料稽核、Drive 權杖）
firestore.rules   Firestore 權限規則
```

---

## 本機開發

**需求：** Node.js 20 以上

```bash
npm install
npm run dev        # http://localhost:3000
```

### 環境變數

在專案根目錄建立 `.env`（**不要 commit**，已列在 `.gitignore`）。
實際的值請**私下**跟專案負責人拿，不要貼在群組或 issue 裡。

| 變數 | 用途 |
|------|------|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | 後端存取 Firestore 的服務帳號 |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_DRIVE_REFRESH_TOKEN` | 上傳到 Google Drive |
| `VITE_GOOGLE_PICKER_API_KEY` | 前端選取 Drive 檔案 |
| `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` | LINE 推播 |
| `CRON_SECRET` | 保護定時推播 API，避免被外部呼叫 |
| `MAKE_WEBHOOK_URL` | Make 自動化串接 |

> ⚠️ 本機連的是**正式資料庫**，沒有測試環境。在本機操作新增、刪除、改狀態，都會直接影響正式資料。

### 檢查指令

```bash
npm run lint       # TypeScript 型別檢查
npm run build      # 確認可以正常打包
```

---

## 部署流程

### 前端與 API

`main` 分支 = 正式站。推上 `main` 後，Vercel 會自動建置並上線，大約 1–2 分鐘。

1. 從最新的 `main` 開新分支開發
2. 本機跑過 `npm run lint` 和 `npm run build`
3. 開 Pull Request，**經負責人確認後才合併進 `main`**
4. 新畫面或流程有改動，上線前先給主管看過

請不要直接 push 到 `main`。

### Firestore 權限規則

`firestore.rules` **不會**跟著 Vercel 自動部署，改了要另外發佈：

```bash
# 需先設定有 Firebase 權限的服務帳號
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

node scripts/deploy-firestore-rules.mjs          # 預覽差異，不會寫入
node scripts/deploy-firestore-rules.mjs --apply  # 正式部署，並讀回比對
```

> 前端和規則要一起上線。前端新增欄位但規則沒更新，寫入會被正式規則擋掉。

---

## 聯絡窗口

- 專案負責人：David Xue（[@denmark1125](https://github.com/denmark1125)）
- 系統問題或功能需求：請在 GitHub 開 [Issue](https://github.com/denmark1125/julongsocial/issues)，附上畫面截圖和操作步驟
