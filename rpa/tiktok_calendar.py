"""
TikTok 排程／發布檢查機器人（2026-11-05）：打開 TikTok Business Suite 每個 IP 帳號的首頁週曆，
把這週的卡片（哪天、幾點、封面、已排好還是已發布）抄進 Firestore publishPrechecks/{日期}.tiktok。

為什麼要用瀏覽器：TikTok 沒有給我們用的官方讀取管道。
所有代操 IP 的 TikTok 都在 Business Center「Julang」底下，一個登入就能切換（網址換 bs_id）。

分工：只抄，不判斷。比對規則在 src/lib/publishPrecheck.ts（發布前）與 publishAudit.ts（發布後），由剪輯系統做、推 LINE。

週曆卡片（11-05 實測 DOM）：
- 表頭「Thu 05」、卡片時間「8:00 PM」、封面 <img>
- 綠色（class 含 bg-success）＝已排好還沒發；灰色（bg-gray）＝已發布

用法：
  第一次（要登入）：py -3.14 rpa/tiktok_calendar.py --login
  平常（排程跑）：  py -3.14 rpa/tiktok_calendar.py --headless
  只看不寫：        py -3.14 rpa/tiktok_calendar.py --dry-run
⚠️ 帳密／驗證碼只有人自己在跳出來的視窗處理，程式不碰；只讀畫面，不按任何發布／刪除。
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
PROFILE = Path(os.environ.get("RPA_TIKTOK_PROFILE", r"C:\Users\Administrator\Desktop\David\8.claude code\rpa-profiles\tiktok"))
SA_KEY = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS",
                        r"C:\Users\Administrator\Downloads\gen-lang-client-0997769067-firebase-adminsdk-fbsvc-a17640d70e.json")
ORG_ID = "7637354356928692241"  # Business Center「Julang」
TPE = timezone(timedelta(hours=8))

EXTRACT_JS = r"""
() => {
  const heads = [...document.querySelectorAll('*')]
    .filter(e => e.childElementCount === 0 && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{1,2}$/.test((e.textContent || '').trim()))
    .map(e => { const r = e.getBoundingClientRect(); return { day: +e.textContent.trim().split(/\s+/)[1], cx: (r.left + r.right) / 2 }; });
  const times = [...document.querySelectorAll('*')]
    .filter(e => e.childElementCount === 0 && /^\d{1,2}:\d{2}\s*(AM|PM)$/.test((e.textContent || '').trim()));
  const month = (document.body.innerText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/) || []);
  return {
    month: month[1] || null, year: month[2] ? +month[2] : null, heads,
    cards: times.map(e => {
      let c = e;
      for (let i = 0; i < 6 && c.parentElement; i++) { c = c.parentElement; if (c.querySelector('img')) break; }
      const r = c.getBoundingClientRect(); const cx = (r.left + r.right) / 2;
      const head = heads.reduce((b, h) => (!b || Math.abs(h.cx - cx) < Math.abs(b.cx - cx)) ? h : b, null);
      const cls = (c.className || '').toString();
      return {
        time: e.textContent.trim(), day: head ? head.day : null,
        cover: (c.querySelector('img') || {}).src || '',
        scheduled: /bg-success/.test(cls),
      };
    }),
  };
}
"""

MONTHS = {m: i for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}

# 「Posts」頁（已發布清單）：每列有完整文案、發布時間「2026-10-31 20:00」、封面。
# 不管用 Business Suite 還是手機發的都列在這裡，比週曆完整，而且有文案可以比（11-05 實測）。
POSTS_JS = r"""
() => [...document.querySelectorAll('tr')]
  .filter(r => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.innerText))
  .map(r => {
    const t = r.innerText;
    const at = t.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    return { date: at[1], time: at[2], caption: t.split('\n')[0].slice(0, 300), cover: (r.querySelector('img') || {}).src || '' };
  })
"""


def to_hhmm(t: str) -> str:
    m = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", t)
    if not m:
        return ""
    h = int(m.group(1)) % 12 + (12 if m.group(3) == "PM" else 0)
    return f"{h:02d}:{m.group(2)}"


def card_date(day: int, today: datetime) -> str:
    """週曆只有「日」：離今天最近的那個日期（處理跨月的週）"""
    best = None
    for delta in range(-10, 11):
        d = today + timedelta(days=delta)
        if d.day == day and (best is None or abs(delta) < abs(best[0])):
            best = (delta, d)
    return best[1].strftime("%Y-%m-%d") if best else ""


def target_days(now: datetime) -> list[datetime]:
    """跟 meta_calendar 一樣：下班前（17:00 後）順便抄明天，週五再抄週末（週末電腦沒開）"""
    days = [now]
    if now.hour >= 17:
        days += [now + timedelta(days=i) for i in range(1, (2 if now.weekday() == 4 else 1) + 1)]
    return days


def read_account(page, bs_id: str, today: datetime) -> tuple[list[dict], set[str]]:
    """回傳（卡片, 週曆上看得到的日期）。TikTok 週曆是週日～週六、沒有翻頁鈕，週五看不到下週日"""
    cards: list[dict] = []
    # ① 排好還沒發的：首頁週曆的綠色卡片。這週什麼都沒排時週曆是空白（「Schedule your post」），不是錯誤
    page.goto(f"https://business-suite.tiktok.com/?org_id={ORG_ID}&bs_id={bs_id}")
    page.wait_for_function(
        r"() => /Schedule your post/.test(document.body.innerText) || [...document.querySelectorAll('*')].some(e => e.childElementCount===0 && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{1,2}$/.test((e.textContent||'').trim()))",
        timeout=40_000)
    page.wait_for_timeout(2500)
    if "login" in page.url:
        raise RuntimeError("TikTok 登入過期")
    data = page.evaluate(EXTRACT_JS)
    visible = {card_date(h["day"], today) for h in data["heads"]}
    for c in data["cards"]:
        if c["day"] and c["scheduled"]:
            cards.append({"date": card_date(c["day"], today), "time": to_hhmm(c["time"]), "platform": "TikTok",
                          "cover": c["cover"][:600], "status": "scheduled"})
    # ② 已經發出去的：Posts 頁的清單（有文案），只留最近 3 天
    page.goto(f"https://business-suite.tiktok.com/posts/publisher?org_id={ORG_ID}&bs_id={bs_id}")
    page.wait_for_function(
        r"() => [...document.querySelectorAll('tr')].some(r => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.innerText)) || /No (posts|data)|暫無/.test(document.body.innerText)",
        timeout=40_000)
    page.wait_for_timeout(1500)
    since = (today - timedelta(days=3)).strftime("%Y-%m-%d")
    for r in page.evaluate(POSTS_JS):
        if r["date"] < since:
            continue
        cards.append({"date": r["date"], "time": r["time"], "platform": "TikTok", "cover": r["cover"][:600],
                      "status": "published", "caption": r["caption"]})
    uniq = {(c["date"], c["time"], c["status"], c["cover"][:120]): c for c in cards}
    return list(uniq.values()), visible


def main() -> None:
    login = "--login" in sys.argv
    dry = "--dry-run" in sys.argv
    headless = "--headless" in sys.argv and not login
    # RPA_NOW＝測試用（例：2026-11-06T17:30+08:00）
    now = datetime.fromisoformat(os.environ["RPA_NOW"]) if os.environ.get("RPA_NOW") else datetime.now(TPE)
    today_key = now.strftime("%Y-%m-%d")
    extra_keys = [d.strftime("%Y-%m-%d") for d in target_days(now)[1:]]
    extra: dict = {k: {} for k in extra_keys}  # 明天／週末：只放排好還沒發的卡片

    import firebase_admin
    from firebase_admin import credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(SA_KEY))
    cfg = json.loads((ROOT / "firebase-applet-config.json").read_text(encoding="utf-8"))
    db = firestore.client(database_id=cfg.get("firestoreDatabaseId") or "(default)")

    vendors = []
    for d in db.collection("vendors").stream():
        v = d.to_dict() or {}
        if v.get("tiktokBsId") and v.get("status") != "ended":
            vendors.append({"id": d.id, "name": v.get("name", d.id), "bs": str(v["tiktokBsId"])})

    PROFILE.mkdir(parents=True, exist_ok=True)
    result: dict = {}
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            str(PROFILE), headless=headless, locale="en-US", timezone_id="Asia/Taipei",
            viewport={"width": 1800, "height": 1000},
        )
        page = browser.pages[0] if browser.pages else browser.new_page()
        if login:
            page.goto(f"https://business-suite.tiktok.com/?org_id={ORG_ID}")
            print("👉 請在跳出來的瀏覽器裡自己登入 TikTok（驗證碼也請自己處理，最多等 5 分鐘）")
            page.wait_for_url(re.compile(r"business-suite\.tiktok\.com/(\?|posts|$)"), timeout=5 * 60_000)
            page.wait_for_timeout(3000)
            print("✅ 登入完成")
        for v in vendors:
            try:
                cards, visible = read_account(page, v["bs"], now)
                result[v["id"]] = {"ok": True, "name": v["name"], "cards": cards}
                for k in extra_keys:
                    if k in visible:  # 週曆上看不到的那天不寫，免得畫面誤以為「沒排」
                        extra[k][v["id"]] = {"ok": True, "name": v["name"], "cards": [c for c in cards if c["date"] == k and c["status"] == "scheduled"]}
                show = "、".join(f"{c['date'][5:]} {c['time']}{'(排)' if c['status'] == 'scheduled' else ''}" for c in sorted(cards, key=lambda c: (c['date'], c['time'])))
                print(f"✅ {v['name']}：{len(cards)} 則 {show}")
            except Exception as e:
                result[v["id"]] = {"ok": False, "name": v["name"], "error": str(e)[:300]}
                print(f"❌ {v['name']}：{e}")
        browser.close()

    if dry:
        print("（--dry-run：沒有寫入）", {k: {x["name"]: len(y["cards"]) for x, y in ((e, e) for e in extra[k].values())} for k in extra_keys})
        return
    db.collection("publishPrechecks").document(today_key).set({
        "day": today_key,
        "tiktokFetchedAt": datetime.now(timezone.utc).isoformat(),
        "tiktok": result,
    }, merge=True)
    print(f"已寫入 publishPrechecks/{today_key}.tiktok")
    for k in extra_keys:
        if extra[k]:
            db.collection("publishPrechecks").document(k).set({"day": k, "tiktokFetchedAt": datetime.now(timezone.utc).isoformat(), "tiktok": extra[k]}, merge=True)
            print(f"已寫入 publishPrechecks/{k}.tiktok（{len(extra[k])} 家）")


if __name__ == "__main__":
    main()
