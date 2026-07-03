# RESUME — 腳本生成系統（julongsocial × julang-company）
> 最後更新：2026-07-03（週五收工）。下次開工直接從「下週待辦」開始。

---

## 一句話現況
腳本生成系統已能跑通全流程（ERP 開關 → 會攝攝產腳本 → 網站審核 → 回饋學習），今天完成「對標名單透明化＋防同質化改造＋對標來源升級」，剩 IG 限流冷卻後的實測與 Vercel 上線。

---

## 系統全貌（兩個資料夾、一個網站）
- **前端網站**：`8.claude code\julongsocial`（React+Express，`npm run dev` 開 localhost:3000）— ERP 排程系統＋腳本審核＋對標名單
- **AI 員工引擎**：`8.claude code\julang-company\ig-ai-automation\scout\` — 雨傘標(找對標)、會攝攝(產腳本)、很會編、造浪等
- **金鑰保險箱**：`julang-company\company\assets\vault.env`（所有帳密鑰匙都在這，見下方串接清單）

---

## 🔌 所有串接（MCP / API / 金鑰）備忘
| 服務 | 怎麼連 | 鑰匙在哪 | 備註 |
|---|---|---|---|
| **Supabase「Julangmeta」** | MCP `claude_ai_Supabase`；斷線時用 REST | vault `JULANGMETA_URL` + `JULANGMETA_SERVICE_KEY` | 專案 ref `iucrdbughtuhxpcdfwve`；studio schema 要帶 header `Accept-Profile`/`Content-Profile: studio`；**本 session MCP 斷過一次，REST 備援全程可用**；建新表要去 SQL Editor（service key 不能 DDL），建完記得 `grant all ... to service_role` |
| **Firebase ERP（排程庫）** | Firestore REST（`scout/erp.py`） | vault `ERP_EMAIL` / `ERP_PASSWORD=1125_forest_safe` | 密碼機關：前端自動加 `_forest_safe` 後綴；唯讀對帳＋讀廠商 AI 開關 |
| **Notion** | MCP `claude_ai_Notion`；斷線時直打 REST | vault `NOTION_TOKEN` | REST 要 header `Notion-Version: 2026-03-11`（2026-05-13 會被拒）；**本 session MCP 斷過，REST 備援成功寫入 58 blocks** |
| **IG 內部 API** | `scout/verify.py`（web_profile_info）＋新增 `ig_search()`（topsearch 站內搜尋） | vault `IG_SESSIONID`、`IG_SESSIONID_2`（_3/_4 預留） | 429 自動輪替鑰匙；**目前 IP 級限流冷卻中**（今天測太兇），topsearch 回 302 也是同因，冷卻後自癒 |
| **Firecrawl** | `asset_broker.py checkout firecrawl` | 資產室管理 | 500 次/月，雨傘標搜尋用 |
| **LLM 大腦** | `scout/llm.py`（Gemini 2.5 Flash 主、Claude 備） | 資產室管理 | Gemini 必帶 `thinkingConfig:{thinkingBudget:0}` 否則 thinking 吃光 output tokens |
| **GitHub** | git push（GCM 雙帳號） | Windows 認證管理員 | denmark1125：julongsocial、ip-nexus-dashboard；julangtw2025：meta_API-sync（3 條 Actions 健康：每日 08:00 Meta 同步／每日 YT 趨勢／週一 08:20 Apify 對標） |
| **gbrain 公司大腦** | `scout/brain.py` → Supabase 直連 | `~/.gbrain/config.json` | 另一個 Supabase 專案 `zvjvdvirrnygaymigazc`；必開 `GBRAIN_DISABLE_DIRECT_POOL=1` |
| **LINE 推播** | `scout/notify_line.py` | 資產室 | 每日排程報告用 |
| **Vercel** | julongsocial.vercel.app | 老闆的 Vercel 帳號 | ⚠️ **還沒加 env（SUPABASE_URL/SUPABASE_SERVICE_KEY）**，加了才能 merge feature/script-board 上線 |
| **Playwright MCP** | UI 實測用 | 無需鑰匙 | 測 localhost:3000 |

---

## ✅ 今天（2026-07-03）完成
1. **對標名單透明化**：新表 `studio.benchmark_accounts`＋`scout/benchmark_sync.py`（雨傘標找到→自動同步）＋網站「腳本審核→對標名單」分頁（🟡候選/🟢已驗證/⚫失效/⭐老闆指定）
2. **雨傘標記過一次**（`company/roster.md` 有案底）：大發抓到人像攝影師/追星帳號當中古車對標 → 三個已標 dead → 加**語意過濾層**（scout_engine，實測正確分辨）
3. **防同質化改造**（videographer_engine，4 個 bug 全修）：
   - 對標素材改即時讀 Supabase verified/promoted＋隨機抽 5 家（Supabase 通就絕不退本機檔案）
   - 角度池 5→10 種；修好 detail 漏存 angle 的斷鏈（跨天角度記憶生效）
   - 新增主題防重複（最近 12 個主題進 prompt「絕對不可重複」）
   - 修本機 fallback 過濾條件誤殺 bug
4. **對標來源升級**：`verify.py` 新增 `ig_search()`（IG 官方站內搜尋，比網頁文字撈準一個量級），scout_engine 改「IG 搜尋為第一來源＋Firecrawl 為第二來源」——**因限流未實測，冷卻後自動生效（fail-soft）**
5. **手動指定對標**：POST `/api/studio/benchmarks`＋對標名單分頁頂部表單（選 IP→打 @帳號→加入名單，標⭐老闆指定，直接進 AI 取材）——**型別檢查過，UI 未實測**
6. 修「就地改稿存了但畫面沒變」bug（detail.scenes 蓋過 content，改稿後清 scenes）
7. Notion 專案頁已同步今日全記錄（58 blocks，頁 3883cc56927080878e6fc84b89fbde2b）

## 📋 下週待辦（優先序）
1. **實測手動指定對標**（UI 表單送出→卡片出現⭐）＋ commit julongsocial 未推的改動（已 commit 到本機了就 push）
2. **IG 冷卻驗證**：跑 `python scout_engine.py --ip dafa` 看 IG 站內搜尋是否生效、能否找到真的中古車帳號並驗證晉升
3. **Vercel 上線**：老闆去 Vercel 加 SUPABASE_URL + SUPABASE_SERVICE_KEY 兩個 env → merge feature/script-board → 正式網址可用
4. **會攝攝掛每日排程**（目前手動觸發，要加進 daily-scout.py＋install.ps1 排程）
5. 秀姨（xiuyi）在 ERP 補人物設定 → 產首批腳本
6. 聚浪本體 candidates.md 有 10 個未驗證舊 handle（同一套舊邏輯抓的），要不要逐一查證由老闆決定
7. Phase 0 golden set（自然風 3 份 PPTX 回填＋食品 IP 蒸餾）＋監工 Firebase 每日備份

## ⚠️ 已知地雷（下週別踩）
- IG 大量測試會觸發 **IP 級限流**（不只鑰匙級），兩把鑰匙一起死——測試要節制
- Supabase/Notion MCP 會偶發斷線：**都有 REST 備援路徑**（見上表），不是公司系統壞掉
- julang-company **不是 git repo**，改引擎直接生效、無版本控制——大改前先手動備份
- 正式介面**絕不放墊檔/測試資料**（老闆鐵則）；測試資料用完即刪
- 中文檔名操作用 Python，別用 PowerShell/bash 管道
