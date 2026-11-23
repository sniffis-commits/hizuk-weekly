"""PoC: YouTube channel monitor with DEBUG send (no WhatsApp involved).

Reads the channel list from config.json, fetches each channel's YouTube RSS
feed, wraps the newest video(s) in the configured message template, and
"delivers" them via debug_send(), which only prints to the terminal.

Stdlib only — no pip installs, no WhatsApp, nothing outside this directory.

Usage:
    python Python/testYoutube.py [max_videos_per_channel] [--reset]

Sent (pretend-sent) video IDs are recorded per channel in
test_posted_videos.json — a separate cache file from the bot's
posted_videos.json, so resetting the PoC is just deleting that file
(or pass --reset). Re-runs print NOTICE when the latest videos were
already sent.
"""

import datetime
import json
import random
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # project root (scripts live in Python/)
TEST_POSTED_PATH = BASE / "test_posted_videos.json"  # PoC-only cache, safe to delete
TEST_DAILY_PATH = BASE / "test_daily_counts.json"  # PoC-only daily counts, safe to delete

HUMAN_TIMING_DEFAULTS = {
    "enabled": True,
    "msPerChar": 50,
    "msPerWord": 40,
    "jitterMs": 700,
    "minTypingMs": 400,
    "maxTypingMs": 20000,
    "betweenSendsMinMs": 3000,
    "betweenSendsMaxMs": 8000,
    "pauseChance": 0.12,
    "pauseMinMs": 5000,
    "pauseMaxMs": 20000,
}

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


def load_config():
    with open(BASE / "config.json", encoding="utf-8") as f:
        return json.load(f)


def load_test_posted():
    """Load pretend-sent video IDs ({channelId: [videoId, ...]})."""
    try:
        if not TEST_POSTED_PATH.exists():
            return {}
        data = json.loads(TEST_POSTED_PATH.read_text(encoding="utf-8").strip() or "{}")
        return {k: v for k, v in data.items() if isinstance(v, list)}
    except (json.JSONDecodeError, OSError) as exc:
        print(f"!! could not read {TEST_POSTED_PATH.name}, starting fresh: {exc}")
        return {}


def save_test_posted(posted):
    TEST_POSTED_PATH.write_text(json.dumps(posted, indent=2, ensure_ascii=False), encoding="utf-8")


def load_test_daily():
    """Load PoC daily send counts ({channelId: {date: n}})."""
    try:
        if not TEST_DAILY_PATH.exists():
            return {}
        data = json.loads(TEST_DAILY_PATH.read_text(encoding="utf-8").strip() or "{}")
        return {k: v for k, v in data.items() if isinstance(v, dict)}
    except (json.JSONDecodeError, OSError) as exc:
        print(f"!! could not read {TEST_DAILY_PATH.name}, starting fresh: {exc}")
        return {}


def save_test_daily(daily):
    TEST_DAILY_PATH.write_text(json.dumps(daily, indent=2, ensure_ascii=False), encoding="utf-8")


def today_key(day=None):
    day = day or datetime.date.today()
    return day.isoformat()


def parse_clock(value):
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(value or "").strip())
    if not m:
        return None
    h, minute = int(m.group(1)), int(m.group(2))
    return h * 60 + minute if h <= 23 and minute <= 59 else None


def is_quiet_time(channel, config, now=None):
    """Mirror of isQuietTime() in index.js (supports overnight windows)."""
    now = now or datetime.datetime.now()
    window = channel["quietHours"] if "quietHours" in channel else config.get("quietHours")
    if not window:
        return False
    start, end = parse_clock(window.get("start")), parse_clock(window.get("end"))
    if start is None or end is None or start == end:
        return False
    current = now.hour * 60 + now.minute
    return (current >= start and current < end) if start < end else (current >= start or current < end)


def can_send_today(channel, daily):
    """Mirror of canSendToday() in index.js (None cap = unlimited)."""
    max_n = channel.get("maxVideosPerDay")
    if max_n is None:
        return True
    return daily.get(channel["youtubeChannelId"], {}).get(today_key(), 0) < max_n


def record_send(cid, daily):
    """Mirror of recordSend() in index.js; prunes entries older than 7 days."""
    key = today_key()
    daily.setdefault(cid, {})[key] = daily.get(cid, {}).get(key, 0) + 1
    cutoff = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
    for c in list(daily):
        for day in list(daily[c]):
            if day < cutoff:
                del daily[c][day]
        if not daily[c]:
            del daily[c]
    return daily


def select_videos_to_send(fresh_newest_first, channel):
    """Mirror of selectVideosToSend() in index.js. Returns (send, skip)."""
    candidates = list(fresh_newest_first or [])
    skipped = []
    preferred = [k for k in channel.get("preferredKeywords") or [] if isinstance(k, str) and k]
    if preferred:
        def _hit(video):
            hay = f"{video['title']}\n{video['description']}".lower()
            return any(k.lower() in hay for k in preferred)
        hits = [v for v in candidates if _hit(v)]
        if hits:
            skipped = [v for v in candidates if v not in hits]
            candidates = hits
    if (channel.get("sendOrder") or "unsent") == "latest":
        n = channel.get("latestCount")
        n = n if isinstance(n, int) and n > 0 else 3
        return candidates[:n], candidates[n:] + skipped
    return list(reversed(candidates)), skipped


def fetch_feed(channel_id, timeout=20):
    """Return the parsed RSS root element for a YouTube channel."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return ET.fromstring(resp.read())


def innertube_items(browse_id, author="", timeout=25):
    """Fallback source: YouTube innertube browse API (RSS endpoint is 404 now).

    Mirrors innertubeItems() in index.js — returns items shaped like RSS entries.
    """
    url = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false"
    body = {
        "context": {"client": {"clientName": "WEB", "clientVersion": "2.20241010.01.00", "hl": "en"}},
        "browseId": browse_id,
        "params": "EgZ2aWRlb3PyBgQKAjoA",
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://www.youtube.com",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    tabs = (data.get("contents", {}).get("twoColumnBrowseResultsRenderer", {}).get("tabs") or [])
    tab = next((t for t in tabs if t.get("tabRenderer", {}).get("title") == "Videos"), None)
    if tab is None and tabs:
        tab = tabs[0]

    found = []
    seen = set()

    def walk(node, depth=0):
        if depth > 14 or not isinstance(node, (dict, list)):
            return
        if isinstance(node, list):
            for child in node:
                walk(child, depth + 1)
            return
        for key, value in node.items():
            if key in ("lockupViewModel", "videoRenderer", "gridVideoRenderer"):
                vid = value.get("contentId") or value.get("videoId")
                if vid and vid not in seen:
                    seen.add(vid)
                    meta = (value.get("metadata") or {}).get("lockupMetadataViewModel") or {}
                    title = (meta.get("title") or {}).get("content") or ""
                    if not title:
                        runs = (value.get("title") or {}).get("runs") or []
                        title = runs[0].get("text", "") if runs else ""
                    parts = []
                    rows = ((meta.get("metadata") or {}).get("contentMetadataViewModel") or {}).get("metadataRows") or []
                    for row in rows:
                        for p in row.get("metadataParts") or []:
                            text = (p.get("text") or {}).get("content")
                            if text:
                                parts.append(text)
                    published = next((p for p in parts if re.search(r"ago|streamed|scheduled|premiere", p, re.I)), "")
                    found.append(
                        {
                            "id": f"yt:video:{vid}",
                            "title": title,
                            "url": f"https://www.youtube.com/watch?v={vid}",
                            "pubDate": published,
                            "author": author,
                            "description": title,
                        }
                    )
                continue
            walk(value, depth + 1)

    walk((tab or {}).get("tabRenderer", {}).get("content", {}))
    return found


def fetch_channel_videos(channel, author="", limit=15):
    """Return (videos, source) — RSS first, innertube fallback."""
    channel_id = channel["youtubeChannelId"]
    try:
        root = fetch_feed(channel_id)
        videos = parse_entries(root, limit=limit)
        if videos:
            return videos, "rss"
        return [], "rss"
    except Exception as exc:
        print(f"[feed] RSS unavailable ({exc}) — using innertube fallback.")
    try:
        return innertube_items(channel_id, author=author)[:limit], "innertube"
    except Exception as exc:
        raise RuntimeError(f"all feed sources failed: {exc}") from exc


def parse_entries(root, limit=3):
    """Extract newest-first video dicts from a feed (mirrors rss-parser items)."""
    videos = []
    for entry in root.findall("atom:entry", NS)[:limit]:
        video_id = entry.findtext("yt:videoId", default="", namespaces=NS)
        title = entry.findtext("atom:title", default="", namespaces=NS) or ""
        link_el = entry.find("atom:link[@rel='alternate']", NS)
        link = link_el.get("href") if link_el is not None else ""
        if not link and video_id:
            link = f"https://www.youtube.com/watch?v={video_id}"
        published = entry.findtext("atom:published", default="", namespaces=NS) or ""
        author = entry.findtext("atom:author/atom:name", default="", namespaces=NS) or ""
        desc_el = entry.find("media:group/media:description", NS)
        description = desc_el.text if desc_el is not None and desc_el.text else ""
        videos.append(
            {
                "id": video_id,
                "title": title,
                "url": link,
                "pubDate": published,
                "author": author,
                "description": description,
            }
        )
    return videos


def resolve_extended(video, hay, channel):
    """Mirror of resolveExtended() in index.js: first matching rule wins."""
    for rule in channel.get("extendedRules") or []:
        pattern = (rule or {}).get("match", "")
        if not pattern:
            continue
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            print(f"!! invalid extendedRules regex {pattern!r}: {exc} (rule skipped)")
            continue
        if rx.search(hay):
            pid = rule.get("playlistId") or ""
            playlist_url = f"https://www.youtube.com/playlist?list={pid}" if pid else ""
            return (rule.get("text") or "").replace("{%VAR_PLAYLIST_URL%}", playlist_url)
    return ""


def format_message(channel, video):
    """Mirror of formatMessage() in index.js (subset incl. extendedRules).

    Messaging settings come from the channel dict only; missing/empty
    messageTemplate falls back to the bare video URL.
    """
    channel_name = channel.get("channelName", "")
    template = channel.get("messageTemplate") or ""
    if not template:
        return video["url"]

    hay = f"{video['title']}\n{video['description']}".lower()
    is_short = "#shorts" in hay or "/shorts/" in video["url"]
    is_live = "live" in hay or "premiere" in hay or "\U0001f534" in hay

    base = template
    if is_short and channel.get("shortsTemplate"):
        base = channel["shortsTemplate"]
    elif is_live and channel.get("liveTemplate"):
        base = channel["liveTemplate"]

    extended = resolve_extended(video, hay, channel)

    msg = (
        base.replace("{%VAR_URL%}", video["url"])
        .replace("{%VAR_TITLE%}", video["title"])
        .replace("{%VAR_CHANNEL%}", channel_name or video["author"])
        .replace("{%VAR_DATE%}", video["pubDate"])
        .replace("{%VAR_ID%}", video["id"])
        .replace("{%VAR_EXTENDED%}", extended)
        .replace("{%VAR_PLAYLIST_URL%}", "")
    )

    if is_short and base == template:
        msg += channel.get("shortsSuffix", " \u26a1 (#Shorts)")
    elif is_live and base == template:
        msg += channel.get("liveSuffix", " \U0001f534 (Live/Premiere)")

    for rule in channel.get("customKeywordRules") or []:
        keyword = (rule or {}).get("keyword", "")
        if keyword and keyword.lower() in hay:
            if rule.get("template"):
                msg = rule["template"].replace("{%VAR_URL%}", video["url"])
            elif rule.get("suffix"):
                msg += rule["suffix"]
            break
    return msg


def typing_delay_ms(message, timing):
    """Mirror of typingDelayMs() in index.js (length-proportional + jitter)."""
    t = dict(HUMAN_TIMING_DEFAULTS)
    t.update(timing or {})
    if not t.get("enabled", True):
        return 0
    text = str(message or "")
    words = len([w for w in text.split() if w])
    base = len(text) * t["msPerChar"] + words * t["msPerWord"]
    speed = 0.85 + random.random() * 0.3
    delay = base * speed + random.random() * t["jitterMs"]
    if random.random() < t["pauseChance"]:
        delay += t["pauseMinMs"] + random.random() * (t["pauseMaxMs"] - t["pauseMinMs"])
    return int(min(t["maxTypingMs"], max(t["minTypingMs"], delay)))


def debug_send(target_jid, message, timing=None):
    """DEBUG stand-in for client.sendMessage() — prints, sends nothing."""
    wait = typing_delay_ms(message, timing) if timing else 0
    extra = f" (human typing delay {wait / 1000:.1f}s)" if wait else ""
    print(f"[DEBUG SEND -> {target_jid}]{extra}")
    print(message)
    print("-" * 60)


def main():
    positional = [a for a in sys.argv[1:] if a != "--reset"]
    if "--reset" in sys.argv[1:]:
        for cache in (TEST_POSTED_PATH, TEST_DAILY_PATH):
            try:
                cache.unlink()
                print(f"(cache {cache.name} deleted — next run sends everything again)")
            except FileNotFoundError:
                print(f"(no cache {cache.name} to delete)")
        if not positional:
            return
    try:
        limit = int(positional[0]) if positional else 2
    except ValueError:
        print("Usage: python testYoutube.py [max_videos_per_channel] [--reset]", file=sys.stderr)
        sys.exit(2)

    config = load_config()
    posted = load_test_posted()
    daily = load_test_daily()

    for channel in config["channels"]:
        if channel.get("enabled") is False:
            print(f"=== {channel.get('channelName', channel['youtubeChannelId'])} (disabled) ===")
            continue
        cid = channel["youtubeChannelId"]
        name = channel.get("channelName", cid)
        print(f"=== {name} ({cid}) ===")
        if is_quiet_time(channel, config):
            print(f"[{name}] Quiet hours — skipping.")
            continue
        try:
            videos, source = fetch_channel_videos(channel, author=name, limit=limit)
            if source != "rss":
                print(f"[{name}] Feed source: {source}.")
        except Exception as exc:  # one channel failing must not stop the rest
            print(f"!! feed fetch failed: {exc}")
            continue
        if not videos:
            print("(feed empty)")
            continue

        seen = set(posted.setdefault(cid, []))
        fresh = [v for v in videos if v["id"] not in seen]  # newest-first
        if not fresh:
            print(f"NOTICE: latest {len(videos)} video(s) already sent — nothing new.")
            continue

        send, skip = select_videos_to_send(fresh, channel)
        if skip:
            for video in skip:
                seen.add(video["id"])
            posted[cid] = sorted(seen)
            save_test_posted(posted)
            print(f"[{name}] Skipped {len(skip)} non-preferred video(s).")
        print(f"[{name}] Sending {len(send)} of {len(fresh)} new video(s) (order: {channel.get('sendOrder') or 'unsent'}).")

        for video in send:
            if not can_send_today(channel, daily):
                print(f"[{name}] Daily cap reached ({channel.get('maxVideosPerDay')}/day) — stopping.")
                break
            message = format_message(channel, video)
            timing = dict(HUMAN_TIMING_DEFAULTS)
            timing.update(config.get("humanTiming") or {})
            timing.update(channel.get("humanTiming") or {})
            for jid in channel["targetGroupJids"]:
                debug_send(jid, message, timing)
            # Record even though the send was only pretend.
            posted[cid].append(video["id"])
            save_test_posted(posted)
            record_send(cid, daily)
            save_test_daily(daily)


if __name__ == "__main__":
    main()
