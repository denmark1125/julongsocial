"""
發布前檢查機器人（RPA，2026-11-05）：打開每個「準時 IP」的 Meta Business Suite 排程日曆，
把**今天**排了什麼（幾點、FB 還是 IG、封面縮圖）抄進 Firestore 的 publishPrechecks/{日期}。

為什麼要用瀏覽器：Meta 官方 API **讀不到** Business Suite「排好還沒發」的內容
（11-05 實測：又生 20:00 已排好，API 回 0 筆；日曆畫面看得到）。

分工：這支只負責「抄」，不判斷對錯、不推 LINE。
比對規則在 src/lib/publishPrecheck.ts，由剪輯系統每分鐘的稽核工作讀這份資料去比、去推 LINE。

用法：
  第一次（要登入）：py -3.14 rpa/meta_calendar.py --login
  平常（排程跑）：  py -3.14 rpa/meta_calendar.py --headless
  只看不寫：        py -3.14 rpa/meta_calendar.py --dry-run

⚠️ 帳號密碼只有人自己在跳出來的視窗輸入，程式不碰。
⚠️ 只讀畫面，不點「發布」「刪除」任何按鈕。
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

# Windows 中文命令列預設 cp950，印 emoji（👉✅）會直接當掉 → 一律改用 UTF-8 輸出
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
# 機器人專用的登入資料夾，放在專案外面（裡面是登入狀態，不能進 git）
PROFILE = Path(os.environ.get("RPA_META_PROFILE", r"C:\Users\Administrator\Desktop\David\8.claude code\rpa-profiles\meta"))
SA_KEY = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS",
                        r"C:\Users\Administrator\Downloads\gen-lang-client-0997769067-firebase-adminsdk-fbsvc-a17640d70e.json")
TPE = timezone(timedelta(hours=8))
GRAPH = "https://graph.facebook.com/v21.0"


def env_value(key: str) -> str:
    """從專案 .env 讀（不印出來）"""
    if os.environ.get(key):
        return os.environ[key]
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"找不到 {key}")


def business_id_of(page_id: str, token: str) -> str | None:
    """粉專屬於哪個商家帳號（日曆網址要用）。用 API 查，不用人一個一個抄"""
    try:
        with urllib.request.urlopen(f"{GRAPH}/{page_id}?fields=business&access_token={token}", timeout=20) as r:
            return (json.load(r).get("business") or {}).get("id")
    except Exception:
        return None


# 在日曆頁面裡跑的 JS：找出每張排程卡片的 時間／平台／封面／狀態／在第幾欄（哪一天）
EXTRACT_JS = r"""
() => {
  const heads = [...document.querySelectorAll('*')]
    .filter(e => e.childElementCount === 0 && /^週.\s*\d{1,2}日$/.test((e.textContent || '').trim()))
    .map(e => { const r = e.getBoundingClientRect(); return { day: +e.textContent.match(/(\d{1,2})日/)[1], cx: (r.left + r.right) / 2 }; });
  const links = [...document.querySelectorAll('[role=link]')].filter(c => /[上下]午\d{1,2}:\d{2}/.test(c.innerText || ''));
  // 卡片會一層包一層，只留最裡面那層（不然同一張會算三次）
  const cards = links.filter(c => !links.some(o => o !== c && c.contains(o)));
  const month = ([...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && /^\d{1,2}\s*月$/.test((e.textContent || '').trim())) || {}).textContent || '';
  return {
    month: parseInt(month, 10) || null,
    heads,
    cards: cards.map(c => {
      const r = c.getBoundingClientRect(); const cx = (r.left + r.right) / 2;
      const head = heads.reduce((best, h) => (!best || Math.abs(h.cx - cx) < Math.abs(best.cx - cx)) ? h : best, null);
      const imgs = [...c.querySelectorAll('img')];
      return {
        time: (c.innerText.match(/[上下]午\d{1,2}:\d{2}/) || [''])[0],
        day: head ? head.day : null,
        platforms: imgs.map(i => i.alt).filter(a => a === 'Facebook' || a === 'Instagram'),
        cover: (imgs.find(i => !i.alt && /^https:/.test(i.src)) || {}).src || '',
        status: (c.innerText.split('\n')[1] || '').trim(),
      };
    }),
  };
}
"""


def to_hhmm(t: str) -> str:
    """「下午8:00」→「20:00」；上午12:xx＝00:xx、下午12:xx＝12:xx"""
    m = re.match(r"([上下])午(\d{1,2}):(\d{2})", t)
    if not m:
        return ""
    h = int(m.group(2)) % 12 + (12 if m.group(1) == "下" else 0)
    return f"{h:02d}:{m.group(3)}"


def read_calendar(page, business_id: str, asset_id: str, today: datetime) -> list[dict]:
    page.goto(f"https://business.facebook.com/latest/content_calendar/?business_id={business_id}&asset_id={asset_id}")
    # 等日曆的「週X N日」表頭出現，比等固定秒數穩
    page.wait_for_function("() => [...document.querySelectorAll('*')].some(e => e.childElementCount===0 && /^週.\\s*\\d{1,2}日$/.test((e.textContent||'').trim()))", timeout=30_000)
    page.wait_for_timeout(2500)  # 表頭出來後卡片還會再補幾張
    if "login" in page.url:
        raise RuntimeError("Meta 登入過期")
    data = page.evaluate(EXTRACT_JS)
    if data.get("month") and data["month"] != today.month and today.day > 7:
        raise RuntimeError(f"日曆停在 {data['month']} 月，不是這個月")
    out = []
    for c in data["cards"]:
        if c["day"] != today.day:
            continue  # 只要今天（週曆上其他天的卡片不管）
        for pf in c["platforms"] or [""]:
            out.append({
                "date": today.strftime("%Y-%m-%d"),
                "time": to_hhmm(c["time"]),
                "platform": {"Facebook": "FB", "Instagram": "IG"}.get(pf, ""),
                "cover": c["cover"][:600],
                "status": c["status"],
                "assetId": asset_id,
            })
    return out


def main() -> None:
    login = "--login" in sys.argv
    dry = "--dry-run" in sys.argv
    headless = "--headless" in sys.argv and not login
    now = datetime.now(TPE)
    today_key = now.strftime("%Y-%m-%d")

    import firebase_admin
    from firebase_admin import credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(SA_KEY))
    cfg = json.loads((ROOT / "firebase-applet-config.json").read_text(encoding="utf-8"))
    db = firestore.client(database_id=cfg.get("firestoreDatabaseId") or "(default)")
    token = env_value("META_PUBLISH_AUDIT_TOKEN")

    vendors = []
    for d in db.collection("vendors").stream():
        v = d.to_dict() or {}
        if v.get("strictTiming") and v.get("metaFbPageId") and v.get("status") not in ("ended",):
            assets = list(dict.fromkeys([v["metaFbPageId"], v.get("metaIgPageId") or v["metaFbPageId"]]))
            vendors.append({"id": d.id, "name": v.get("name", d.id), "assets": assets})

    PROFILE.mkdir(parents=True, exist_ok=True)
    result: dict = {}
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            str(PROFILE), headless=headless, locale="zh-TW", timezone_id="Asia/Taipei",
            viewport={"width": 1600, "height": 1000},
        )
        page = browser.pages[0] if browser.pages else browser.new_page()
        if login:
            page.goto("https://business.facebook.com/")
            print("👉 請在跳出來的瀏覽器裡自己登入 Facebook（最多等 5 分鐘）")
            page.wait_for_url("**/latest/**", timeout=5 * 60_000)
            print("✅ 登入完成")

        for v in vendors:
            cards: list[dict] = []
            try:
                for asset in v["assets"]:
                    biz = business_id_of(asset, token)
                    if not biz:
                        raise RuntimeError(f"查不到粉專 {asset} 的商家帳號")
                    cards += read_calendar(page, biz, asset, now)
                # 同一個商家底下 FB 粉專與 IG 在兩個日曆都會出現 → 去重
                uniq = {(c["time"], c["platform"], c["cover"][:120]): c for c in cards}
                result[v["id"]] = {"ok": True, "name": v["name"], "cards": list(uniq.values())}
                print(f"✅ {v['name']}：今天 {len(uniq)} 則", "、".join(f"{c['time']} {c['platform']}" for c in uniq.values()))
            except Exception as e:  # 一家讀不到不影響其他家；讀不到要回報，不能當成「沒排」
                result[v["id"]] = {"ok": False, "name": v["name"], "error": str(e)[:300]}
                print(f"❌ {v['name']}：{e}")
        browser.close()

    if dry:
        print("（--dry-run：沒有寫入）")
        return
    db.collection("publishPrechecks").document(today_key).set({
        "day": today_key,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "vendors": result,
    }, merge=True)
    print(f"已寫入 publishPrechecks/{today_key}")


if __name__ == "__main__":
    main()
