# RESUME — 腳本生成系統（julongsocial × julang-company）
> 最後更新：2026-07-06（週一收工）。下次開工直接從「下週待辦」開始。

---

## 一句話現況
腳本生成系統已能跑通全流程（ERP 開關 → 會攝攝產腳本 → 網站審核 → 回饋學習）。今天完成「手動指定對標實測通過＋會攝攝掛每日排程＋班表補跑漏洞修復＋IG 斷路器」，但發現本機對外 IP 被 IG API 級限流（非帳號問題），卡在等使用者重開數據機換 IP。

## ✅ 今天（2026-07-06）完成
1. **手動指定對標 UI 實測通過**：julongsocial「對標名單」分頁的老闆手動指定表單全流程驗證（送出→卡片出現⭐→DB 正確寫入 `status=promoted, source=老闆手動指定`），測試資料已清除。
2. **會攝攝掛每日排程**：`daily-scout.py` 新增 `script` 模式（先跑 `ip_bridge.py` 同步 ERP 開關→跑 `videographer_engine.py`→LINE 回報），`install.ps1` 同步加入 `Make-Job "script" "script" 11`，Windows 工作排程器已註冊 `Julang_script`（每天 11:00，雨傘標 10:00 之後、很會編 12:00 之前）。改前備份於 `daily-scout.py.bak-20260706` / `install.ps1.bak-20260706`。
3. **修好「排程補跑」誤觸發全部班別的漏洞**：起因是使用者發現週一早上一開機，LINE 一次噴出 audit/patrol/produce 三份報告（`StartWhenAvailable` 把週末沒開機欠的班全部在開機瞬間補跑，workday_gate 只看「今天是不是上班日」不看「現在是不是這一班的時段」）。修法：`daily-scout.py` 新增 `SLOTS` 班表字典＋`on_shift()` 檢查，每個模式執行前先比對現在時刻是否已到自己的時段，沒到就跳過（log 說明「這是補昨天的班，今天到點會照常跑」）。手動測試想跳過此守則可帶 `JULANG_ANYTIME=1`。已備份原檔。
4. **IG 429 診斷＋斷路器**：原本誤判是「每天測試造成 IP 一直重新被鎖」，經使用者質疑（週末零流量也還是 429）後重新對照實驗，證實是 **7/3 測試太兇時 429 重試風暴把本機對外 IP 打進 IG 的 API 濫用名單**（IP 級、非帳號/鑰匙問題——匿名請求跟帶 sessionid 請求同樣 429，但 instagram.com 網頁瀏覽完全正常 200）。已查出對外 IP 為中華電信 HiNet **浮動 IP**（`dynamic-ip.hinet.net` 反查證實），使用者本人不是路由器管理者、拿不到 `cusadmin` 密碼，最終方案＝**直接重開數據機斷電重撥**換新 IP（比進路由器頁面簡單）。`verify.py` 新增斷路器機制：偵測全鑰匙 429 → 寫 `ig_cooldown.json` 進入 48 小時冷卻，期間所有 IG 呼叫（`verify_handle`/`verify_many`/`ig_search`）直接跳過不打，自動退回 Firecrawl，不再重試轟炸。已手動點燃一次（冷卻至 07-08 10:25，之後會依實際狀況重算）。已備份 `verify.py.bak-20260706`。

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
| **IG 內部 API** | `scout/verify.py`（web_profile_info）＋`ig_search()`（topsearch 站內搜尋） | vault `IG_SESSIONID`、`IG_SESSIONID_2`（_3/_4 預留） | **IP 級限流中**（7/3 測試風暴打進 IG API 濫用名單，非鑰匙問題）；07-06 加了斷路器：偵測全鑰匙 429 自動寫 `scout/ig_cooldown.json` 冷卻 48hr，期間 IG 呼叫全跳過退回 Firecrawl；解法＝使用者換浮動 IP（重開數據機）後手動刪 cooldown 檔復活 |
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
1. **【使用者行動】重開數據機換 IP**（RTF8207W 斷電拔插即可，不用進管理頁）→ 換到新 IP 後跟 Claude 說一聲，會依序：打一發 IG 測試確認解封 → 確認後刪 `scout/ig_cooldown.json` 解除斷路器 → 跑 `python scout_engine.py --ip dafa` 驗證 IG 站內搜尋是否生效、能否找到真的中古車帳號並驗證晉升
2. 觀察 `Julang_script` 排程首跑（07-06 11:00）是否正常產出、班表守則（`SLOTS`/`on_shift()`）連跑幾天有沒有誤判
3. **Vercel 上線**：老闆去 Vercel 加 SUPABASE_URL + SUPABASE_SERVICE_KEY 兩個 env → merge feature/script-board → 正式網址可用
4. 秀姨（xiuyi）在 ERP 補人物設定 → 產首批腳本
5. 聚浪本體 candidates.md 有 10 個未驗證舊 handle（同一套舊邏輯抓的），要不要逐一查證由老闆決定
6. Phase 0 golden set（自然風 3 份 PPTX 回填＋食品 IP 蒸餾）＋監工 Firebase 每日備份

## ⚠️ 已知地雷（下週別踩）
- **IG 429 是 IP 級（不是鑰匙/帳號級）且可能持續數天**：對本機 IP 大量測試會把它打進 IG 的 API 濫用名單，跟平常滑 IG 網頁完全無關（網頁照樣 200）。`verify.py` 已裝斷路器自動擋，但仍要**節制手動測試次數**，尤其換到新 IP 後的頭幾次驗證別連續猛打。
- 使用者是浮動 IP、非路由器管理者，換 IP 的正規做法＝重開數據機（不是進 192.168.1.1 改設定，那個要 `cusadmin` 密碼且要走 https）
- Supabase/Notion MCP 會偶發斷線：**都有 REST 備援路徑**（見上表），不是公司系統壞掉
- julang-company **不是 git repo**，改引擎直接生效、無版本控制——大改前先手動備份（今天改的三個檔都已備份 `.bak-20260706`）
- 正式介面**絕不放墊檔/測試資料**（老闆鐵則）；測試資料用完即刪
- 中文檔名操作用 Python，別用 PowerShell/bash 管道
