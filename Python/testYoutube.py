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

import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent  # project root (scripts live in Python/)
TEST_POSTED_PATH = BASE / "test_posted_videos.json"  # PoC-only cache, safe to delete

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


def fetch_feed(channel_id, timeout=20):
    """Return the parsed RSS root element for a YouTube channel."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return ET.fromstring(resp.read())


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


def resolve_extended(video, hay, config):
    """Mirror of resolveExtended() in index.js: first matching rule wins."""
    for rule in config.get("extendedRules") or []:
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


def format_message(template, video, channel_name, config):
    """Mirror of formatMessage() in index.js (subset incl. extendedRules)."""
    hay = f"{video['title']}\n{video['description']}".lower()
    is_short = "#shorts" in hay or "/shorts/" in video["url"]
    is_live = "live" in hay or "premiere" in hay or "\U0001f534" in hay

    base = template
    if is_short and config.get("shortsTemplate"):
        base = config["shortsTemplate"]
    elif is_live and config.get("liveTemplate"):
        base = config["liveTemplate"]

    extended = resolve_extended(video, hay, config)

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
        msg += config.get("shortsSuffix", " \u26a1 (#Shorts)")
    elif is_live and base == template:
        msg += config.get("liveSuffix", " \U0001f534 (Live/Premiere)")

    for rule in config.get("customKeywordRules") or []:
        keyword = (rule or {}).get("keyword", "")
        if keyword and keyword.lower() in hay:
            if rule.get("template"):
                msg = rule["template"].replace("{%VAR_URL%}", video["url"])
            elif rule.get("suffix"):
                msg += rule["suffix"]
            break
    return msg


def debug_send(target_jid, message):
    """DEBUG stand-in for client.sendMessage() — prints, sends nothing."""
    print(f"[DEBUG SEND -> {target_jid}]")
    print(message)
    print("-" * 60)


def main():
    positional = [a for a in sys.argv[1:] if a != "--reset"]
    if "--reset" in sys.argv[1:]:
        try:
            TEST_POSTED_PATH.unlink()
            print(f"(cache {TEST_POSTED_PATH.name} deleted — next run sends everything again)")
        except FileNotFoundError:
            print(f"(no cache {TEST_POSTED_PATH.name} to delete)")
        if not positional:
            return
    try:
        limit = int(positional[0]) if positional else 2
    except ValueError:
        print("Usage: python testYoutube.py [max_videos_per_channel] [--reset]", file=sys.stderr)
        sys.exit(2)

    config = load_config()
    template = config["messageTemplate"]
    posted = load_test_posted()

    for channel in config["channels"]:
        cid = channel["youtubeChannelId"]
        name = channel.get("channelName", cid)
        print(f"=== {name} ({cid}) ===")
        try:
            root = fetch_feed(cid)
            videos = parse_entries(root, limit=limit)
        except Exception as exc:  # one channel failing must not stop the rest
            print(f"!! feed fetch failed: {exc}")
            continue
        if not videos:
            print("(feed empty)")
            continue

        seen = set(posted.setdefault(cid, []))
        fresh = [v for v in videos if v["id"] not in seen]
        if not fresh:
            print(f"NOTICE: latest {len(videos)} video(s) already sent — nothing new.")
            continue

        for video in reversed(fresh):  # oldest-first, like the bot
            message = format_message(template, video, name, config)
            for jid in channel["targetGroupJids"]:
                debug_send(jid, message)
            # Record even though the send was only pretend.
            posted[cid].append(video["id"])
            save_test_posted(posted)


if __name__ == "__main__":
    main()
