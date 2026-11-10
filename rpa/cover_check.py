"""
封面檢查機器人（2026-11-05）：發出去的 IG／FB 影片，封面是不是影片第一幀。

為什麼要在這台電腦跑：要用 ffmpeg 從影片截第一幀，正式站（Vercel）沒有 ffmpeg。
排程：工作排程器 09:35、11:55、17:30、18:00（跟 Meta 排程檢查同一支 .cmd），電腦關機就跳過。

規則（11-05 使用者確認＋回測）：
- 九成的片，剪輯師會把「後面截的畫面＋標題」放在影片最前面當第一幀 → 封面要＝第一幀
- 回測 38 支：正常的差 0～6 分，不是第一幀的差 24 分以上，中間沒有灰色地帶 → 門檻 12
- IP 設定「封面自己挑」（好正點）：電腦分不出「影片裡挑的畫面」和「另外設計的封面」
  （回測差 10～19 都有）→ 不判對錯，只標「請目視確認」
- 貼文標「自訂封面」（例如另外設計的封面圖）→ 不檢查

只讀 IG／FB，結果寫回 posts.coverCheck.<平台>；推 LINE 由剪輯系統做（09:40、12:00、17:34、18:04）。

用法：
  py -3.14 rpa/cover_check.py            # 檢查最近 48 小時發出去、還沒檢查過的
  py -3.14 rpa/cover_check.py --dry-run  # 只看不寫
  py -3.14 rpa/cover_check.py --hours 400 --dry-run   # 回測
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
SA_KEY = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS",
                        r"C:\Users\Administrator\Downloads\gen-lang-client-0997769067-firebase-adminsdk-fbsvc-a17640d70e.json")
GRAPH = "https://graph.facebook.com/v21.0"
TPE = timezone(timedelta(hours=8))
THRESHOLD = 12          # 差幾分以內算「同一張」（回測：正常 0～6、不是 24+）
HEAD_BYTES = 4_000_000  # 第一幀只要影片開頭幾 MB


def env_value(key: str) -> str:
    if os.environ.get(key):
        return os.environ[key]
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"找不到 {key}")


def gjson(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def dhash(args: list[str]) -> int | None:
    """ffmpeg 把一張圖／影片第一幀縮成 9x8 灰階，算 64 位元的差異雜湊"""
    r = subprocess.run(["ffmpeg", "-loglevel", "error", *args, "-frames:v", "1",
                        "-vf", "scale=9:8:flags=area,format=gray", "-f", "rawvideo", "-"], capture_output=True)
    b = r.stdout
    if len(b) < 72:
        return None
    bits = 0
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | (1 if b[y * 9 + x] > b[y * 9 + x + 1] else 0)
    return bits


def distance(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def fetch(url: str, path: str, head: bool = False) -> None:
    req = urllib.request.Request(url, headers={"Range": f"bytes=0-{HEAD_BYTES}"} if head else {})
    with urllib.request.urlopen(req, timeout=90) as r:
        Path(path).write_bytes(r.read())


def media_urls(platform: str, live_id: str, token: str) -> tuple[str | None, str | None]:
    """（影片檔網址, 封面網址）。IG 用 media_url/thumbnail_url；FB Reels 用 source/偏好縮圖"""
    if platform == "IG":
        m = gjson(f"{GRAPH}/{live_id}?fields=media_type,media_url,thumbnail_url&access_token={token}")
        if m.get("media_type") != "VIDEO":
            return None, None
        return m.get("media_url"), m.get("thumbnail_url")
    vid = live_id[5:] if live_id.startswith("reel_") else None
    if not vid:
        return None, None  # FB 一般貼文（圖片）不檢查
    m = gjson(f"{GRAPH}/{vid}?fields=source,picture,thumbnails{{uri,is_preferred}}&access_token={token}")
    thumbs = (m.get("thumbnails") or {}).get("data") or []
    cover = next((t["uri"] for t in thumbs if t.get("is_preferred")), None) or (thumbs[0]["uri"] if thumbs else m.get("picture"))
    return m.get("source"), cover


def main() -> None:
    dry = "--dry-run" in sys.argv
    hours = int(sys.argv[sys.argv.index("--hours") + 1]) if "--hours" in sys.argv else 48
    import firebase_admin
    from firebase_admin import credentials, firestore
    firebase_admin.initialize_app(credentials.Certificate(SA_KEY))
    cfg = json.loads((ROOT / "firebase-applet-config.json").read_text(encoding="utf-8"))
    db = firestore.client(database_id=cfg.get("firestoreDatabaseId") or "(default)")

    user_token = env_value("META_PUBLISH_AUDIT_TOKEN")
    pages = {p["id"]: p for p in gjson(f"{GRAPH}/me/accounts?fields=id,access_token&limit=100&access_token={user_token}")["data"]}
    vendors = {d.id: (d.to_dict() or {}) for d in db.collection("vendors").stream()}

    now = datetime.now(TPE)
    since = (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M")
    until = now.strftime("%Y-%m-%dT%H:%M")
    posts = db.collection("posts").where(filter=firestore.FieldFilter("scheduledAt", ">=", since)).where(filter=firestore.FieldFilter("scheduledAt", "<=", until)).stream()

    tmp = tempfile.mkdtemp()
    checked = 0
    for d in posts:
        p = d.to_dict() or {}
        v = vendors.get(p.get("vendorId")) or {}
        if not v.get("metaFbPageId") or p.get("contentType") == "post":
            continue
        updates = {}
        for pf, audit in (p.get("publishAudit") or {}).items():
            if pf not in ("IG", "FB") or not audit or not audit.get("livePostId"):
                continue
            if audit.get("forScheduledAt") != p.get("scheduledAt") or audit.get("status") == "wrong_account":
                continue
            prev = (p.get("coverCheck") or {}).get(pf) or {}
            if prev.get("livePostId") == audit["livePostId"] and not dry:
                continue  # 這則已經檢查過
            page_id = (v.get("metaIgPageId") or v["metaFbPageId"]) if pf == "IG" else v["metaFbPageId"]
            page = pages.get(page_id)
            if not page:
                continue
            res = {"livePostId": audit["livePostId"], "checkedAt": datetime.now(timezone.utc).isoformat()}
            if p.get("customCover"):
                res.update(status="skipped", note="這支標了自訂封面")
            else:
                try:
                    video, cover = media_urls(pf, audit["livePostId"], page["access_token"])
                    if not video or not cover:
                        res.update(status="skipped", note="不是影片或拿不到封面")
                    else:
                        fetch(video, f"{tmp}/v.mp4", head=True)
                        fetch(cover, f"{tmp}/c.jpg")
                        hv, hc = dhash(["-i", f"{tmp}/v.mp4"]), dhash(["-i", f"{tmp}/c.jpg"])
                        if hv is None or hc is None:
                            res.update(status="error", note="截圖失敗")
                        else:
                            dist = distance(hv, hc)
                            custom_ip = v.get("coverMode") == "custom"
                            status = "ok" if dist <= THRESHOLD else ("review" if custom_ip else "mismatch")
                            res.update(status=status, distance=dist, coverUrl=cover[:900])
                except Exception as e:  # 一則失敗不影響其他
                    res.update(status="error", note=str(e)[:200])
            updates[f"coverCheck.{pf}"] = res
            checked += 1
            print(f"{'✅' if res['status'] == 'ok' else '❓' if res['status'] in ('review', 'skipped') else '❌'} "
                  f"{v.get('name')} {pf} {p.get('scheduledAt')}「{(p.get('title') or '')[:16]}」"
                  f"{res['status']} 差 {res.get('distance', '-')} {res.get('note', '')}")
        if updates and not dry:
            d.reference.update(updates)
    print(f"檢查 {checked} 則{'（--dry-run 沒寫入）' if dry else ''}")


if __name__ == "__main__":
    main()
