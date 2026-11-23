# החיזוק השבועי (hizuk-weekly)

Monitors YouTube Torah channels and broadcasts new videos to WhatsApp groups.
Includes a promotional, frontend-only homepage: open **`index.html`** (or
enable GitHub Pages on this repo to publish it).

> The homepage is static HTML/CSS with no external assets. The WhatsApp invite
> link in it is a placeholder — replace `REPLACE_WITH_GROUP_INVITE` with your
> real group invite URL.

## Setup

```bash
npm install
npm start
npm test          # offline self-test of the pure logic (no network/WhatsApp)
npm run dry-run   # full bot logic with fake sender, no WhatsApp, no state writes
```

On first run, scan the QR code printed in the terminal via
WhatsApp > Settings > Linked devices > Link a device.
Session persists in `.wwebjs_auth/` via `LocalAuth` — you only scan once.

The Chrome binary used by `whatsapp-web.js` also lives inside the project
(`.puppeteer-cache/`, selected via `PUPPETEER_CACHE_DIR` + explicit
`executablePath` in `index.js`). To (re)install it locally:

```powershell
$env:PUPPETEER_CACHE_DIR="$PWD\.puppeteer-cache"
npx puppeteer browsers install chrome
```

Nothing is read from or written to `%USERPROFILE%\.cache`.

## Config (`config.json`)

```json
{
  "checkIntervalMinutes": 15,
  "sendHistoryOnFirstRun": false,
  "feedRetries": 2,
  "maxPostedIdsPerChannel": 500,
  "quietHours": null,
  "humanTiming": { "enabled": true, "msPerChar": 50 },
  "channels": [
    {
      "channelName": "Example Channel",
      "youtubeChannelId": "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      "targetGroupJids": ["120363000000000000@g.us"],
      "enabled": true,
      "checkIntervalMinutes": 15,
      "maxVideosPerDay": null,
      "preferredKeywords": [],
      "sendOrder": "unsent",
      "latestCount": 3,
      "quietHours": { "start": "22:00", "end": "07:00" },
      "messageTemplate": "MSG MSG MSG MSG {%VAR_URL%}{%VAR_EXTENDED%}",
      "shortsTemplate": null,
      "liveTemplate": null,
      "shortsSuffix": " ⚡ (#Shorts)",
      "liveSuffix": " 🔴 (Live/Premiere)",
      "customKeywordRules": [
        { "keyword": "giveaway", "suffix": " 🎁 Don't miss the giveaway!" }
      ],
      "extendedRules": [
        { "match": "this week", "text": "\n📚 This week's playlist: {%VAR_PLAYLIST_URL%}", "playlistId": "PLxxxx" }
      ]
    }
  ]
}
```

Global-only keys: `sendHistoryOnFirstRun`, `feedRetries`,
`maxPostedIdsPerChannel`, `humanTiming` (all overridable per channel except
the first two).

All messaging settings live **on each channel only** — there are no
top-level template fields (leftovers there warn and are ignored).
A channel with no `messageTemplate` (missing or empty) falls back to
sending just the bare video URL.

Optional per-channel fields: `shortsTemplate`, `liveTemplate`,
`shortsSuffix`, `liveSuffix`, `customKeywordRules`, `extendedRules`,
plus global-only `sendHistoryOnFirstRun`.

Per-channel delivery control:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` pauses the channel without deleting its config |
| `checkIntervalMinutes` | global value | Own check interval; a 1-minute ticker checks due channels |
| `maxVideosPerDay` | `null` = unlimited | Cap on videos sent per calendar day (tracked in `daily_counts.json`); when hit, remaining videos stay unposted and retry later |
| `preferredKeywords` | `[]` | If any fresh video's title/description contains one (case-insensitive), **only** those are sent; the rest are recorded as skipped |
| `sendOrder` | `"unsent"` | `"unsent"` = send every unsent video oldest-first (stay fully caught up); `"latest"` = send only the newest `latestCount`, newest-first (engagement mode) |
| `latestCount` | `3` | How many newest videos `"latest"` mode sends |
| `quietHours` | global / `null` | `{ "start": "HH:MM", "end": "HH:MM" }` — no sends inside the window (state untouched, retried next tick). Overnight windows like `22:00`→`07:00` work; `null` disables a global window for that channel |
| `humanTiming` | global | Per-channel typing/gap overrides (see "Human-like timing") |

Global resilience keys: `feedRetries` (default `2`) retries RSS and the
innertube fallback with a short escalating delay before giving up;
`maxPostedIdsPerChannel` (default `500`) prunes old IDs so
`posted_videos.json` cannot grow forever.

The ticker has a re-entrancy guard: if a check takes longer than a minute
(e.g. many videos × typing delays), the next tick is skipped instead of
sending duplicates.

Template variables (`{%VAR_*%}` prefix):

| Token | Value |
|---|---|
| `{%VAR_URL%}` | YouTube watch URL |
| `{%VAR_TITLE%}` | Video title (from RSS, no extra fetch) |
| `{%VAR_CHANNEL%}` | Channel name (config, fallback: feed author) |
| `{%VAR_DATE%}` | Publish date |
| `{%VAR_ID%}` | YouTube video ID |
| `{%VAR_EXTENDED%}` | Extended-conditional slot (see below; empty when no rule matches) |
| `{%VAR_PLAYLIST_URL%}` | Playlist URL built from the matching rule's `playlistId` (empty elsewhere) |

## Extended conditional templates (`extendedRules`)

Regex-keyword → appended message. `extendedRules` live on the channel;
each rule is `{ "match", "text", "playlistId"? }`, matched case-insensitively against
title + description (Unicode-safe, Hebrew works). **First match wins**;
no match renders `{%VAR_EXTENDED%}` as empty, so keep the slot at the end
of your template and start rule `text` with `\n`. Invalid regexes are
logged and skipped — they never crash the bot.

```json
"messageTemplate": "{%VAR_TITLE%} {%VAR_URL%}{%VAR_EXTENDED%} join us on blahblah.com",
"extendedRules": [
  { "match": "this week", "text": "\n📚 This week's playlist: {%VAR_PLAYLIST_URL%}", "playlistId": "PLxxxx" },
  { "match": "new stuff", "text": "\n✨ New stuff playlist: {%VAR_PLAYLIST_URL%}", "playlistId": "PLyyyy" }
]
```

Formatting precedence: base template (shorts/live override) →
`{%VAR_EXTENDED%}` resolved → all variables replaced → shorts/live
suffix → legacy `customKeywordRules` last.

`validateConfig()` runs at startup and prints `[config] WARNING:` for
unknown `{%...%}` tokens, uncompilable regexes, malformed channel IDs,
bad JIDs, invalid per-channel delivery settings, channels without a
template (URL fallback), and ignored top-level messaging leftovers —
warnings only, the bot still boots.

## Human-like timing

Before every send the bot "types" the message, waiting a time that scales
with its length — so it never looks like an instant bot. The model:

- base = `length × msPerChar` + `words × msPerWord` (a human's ~50ms/char)
- randomized typing speed per message (0.85–1.15×)
- random jitter added on top
- rare "distraction" pause (`pauseChance`) before hitting send
- plus a randomized gap between two group sends (anti-ban)

Configurable globally (`humanTiming`) and per channel
(`channel.humanTiming` — channel wins key by key):

```json
"humanTiming": {
  "enabled": true,
  "msPerChar": 50,
  "msPerWord": 40,
  "jitterMs": 700,
  "minTypingMs": 400,
  "maxTypingMs": 20000,
  "betweenSendsMinMs": 3000,
  "betweenSendsMaxMs": 8000,
  "pauseChance": 0.12,
  "pauseMinMs": 5000,
  "pauseMaxMs": 20000
}
```

Set `"enabled": false` to send instantly (no typing pause, no gap).

## Feed sources (RSS → innertube fallback)

YouTube **retired the public RSS endpoint** — `feeds/videos.xml` now
answers `404` for every channel. The bot therefore tries RSS first and,
when it fails, automatically falls back to YouTube's own innertube browse
API, which yields the same video list. Logs show which source was used:

```
[feed] RSS unavailable (Status code 404) — using innertube fallback.
[Rabbi Uri Hanania Elnekave] Feed source: innertube.
```

Both sources produce identical item shape, so titles, links and IDs (and
therefore your `posted_videos.json` state) stay consistent. The fallback
returns up to ~30 newest videos per channel — plenty for a monitoring bot.

## How it works

Per check, per channel:

1. Fetch the channel's videos — RSS feed, or the innertube fallback when
   RSS is unavailable (see "Feed sources" above).
2. Drop videos already in `posted_videos.json` → fresh set (newest-first).
3. `selectVideosToSend`: preferred-keyword filter first (matches suppress
   the rest, recorded as skipped), then `sendOrder` — `unsent` sends all
   oldest-first, `latest` sends newest `latestCount` newest-first.
4. Per video: stop if the daily cap (`maxVideosPerDay`) is reached
   (remainder stays unposted for later checks); format via the channel
   template + rules; wait a human-like typing delay; send to each
   `targetGroupJids` with randomized gaps between sends.
5. Persist immediately: video ID → `posted_videos.json`, count →
   `daily_counts.json` — a crash never re-sends, a cap-block never loses.

## Files

| File | Purpose |
|---|---|
| `index.js` | The bot: feed monitoring + WhatsApp broadcast loop |
| `config.json` | Interval, message template, channel list |
| `posted_videos.json` | Runtime state: already-posted video IDs per channel |
| `daily_counts.json` | Runtime state: per-channel sends per day (`{channelId: {date: n}}`, 7-day window) |
| `test_posted_videos.json` | Runtime state for the YouTube PoC (separate file, safe to delete) |
| `test_daily_counts.json` | Runtime daily counts for the PoC (separate file, safe to delete) |
| `selftest.js` | Offline `node:test` suite for the pure bot logic (`npm test`) |
| `waSend.js` | One-shot WhatsApp sender (used by both `testWhatsapp` flavors) |
| `testYoutube.js` | PoC: YouTube check with DEBUG send (imports bot functions from `index.js`) |
| `testWhatsapp.js` | PoC: real test message via the same WhatsApp client |
| `Python/` | Original Python mirrors: `testYoutube.py`, `testWhatsapp.py` (stdlib-only) |

## PoC scripts

JS versions are primary — `testYoutube.js` imports `formatMessage`,
`getVideoId`, `feedUrlFor`, `buildVideoData`, `loadPosted`, `savePosted`,
`selectVideosToSend`, `loadDailyCounts`, `saveDailyCounts`, `canSendToday`,
and `recordSend` directly from `index.js`, so the tryouts always exercise
the real bot code.
The save-sent logic lives only in `index.js` (`loadPosted`/`savePosted`
take an optional file path; the bot uses the default `posted_videos.json`,
the PoC passes `test_posted_videos.json`). `Python/` holds the original
stdlib-only mirrors (no installs, Python 3.8+). Both flavors share
`test_posted_videos.json` and `test_daily_counts.json`, so state carries
across them. Unlike the bot, the PoCs do **not** seed on first run — a
fresh PoC pretend-sends everything it finds, which is what makes the
second run print NOTICE.

**YouTube only, no WhatsApp** — fetches each channel's RSS feed, formats
the newest videos with the template, prints instead of sending:

```bash
node testYoutube.js [max_videos_per_channel] [--reset]
python Python/testYoutube.py [max_videos_per_channel] [--reset]
```

Step-by-step:

1. `node testYoutube.js 1` — first run pretend-sends the newest video per
   channel (`[DEBUG SEND -> ...]`) and records the IDs.
2. Run the same command again → `NOTICE: latest 1 video(s) already sent`.
3. `node testYoutube.js --reset` — wipes the PoC caches; next run sends
   everything again.
4. To experiment with `preferredKeywords`, `sendOrder`, or `maxVideosPerDay`:
   back up `config.json` first, tweak one channel, run the PoC, restore.

Pretend-sends are recorded per channel in `test_posted_videos.json`
(separate from the bot's `posted_videos.json`). Re-runs print
`NOTICE: latest N video(s) already sent — nothing new.` To start over,
delete the `test_*.json` files or pass `--reset` (clears both). If you get NOTICE but expected sends,
the video IDs are already in the cache — reset it.

**WhatsApp only, no YouTube** — sends one real message to a group or
contact JID through the same `Client`/`LocalAuth`/local-Chrome setup as
the bot (QR scan on first run):

```bash
node testWhatsapp.js <target-jid> [message]
node testWhatsapp.js 120363000000000000@g.us "hello from PoC"
python Python/testWhatsapp.py 120363000000000000@g.us "hello from PoC"
```

Baby steps (first time):

1. Pick a target. Easiest: **message yourself** — your own phone number in
   international format without `+`, plus `@c.us`
   (e.g. number `15551234567` → `15551234567@c.us`). No group needed.
2. Sanity-check validation: `node testWhatsapp.js hello` → clean
   `error: target must end with @g.us ...` and exit code 2.
3. Send it: `node testWhatsapp.js 15551234567@c.us "hi from the bot"`
   (use your real number). A QR code prints in the terminal.
4. On your phone: WhatsApp > Settings > Linked devices > Link a device,
   scan the QR (you have ~3 minutes before it times out).
5. Expect `[waSend] Sent to ...` then `[testWhatsapp] OK — message
   delivered`. Check your phone — the message should be there.
6. Run the same command again → no QR this time (session is saved in
   `.wwebjs_auth/`), straight to OK.
7. Graduate to a group: same command with the group JID
   (`...@g.us` — see "How to find a WhatsApp Group JID" below; the bot
   number must be a group member).
8. If it fails, see Troubleshooting (timeout, auth failure, bad JID).

## How to find a YouTube Channel ID

1. Open the channel page on YouTube.
2. If the URL is `youtube.com/channel/UCxxxx` — that `UCxxxx` part IS the ID.
3. If the URL is `youtube.com/@handle` or `/c/Name`:
   - Right-click > View page source, search for `"browseId":"UC..."`
     (the old `"channelId"` pattern no longer appears in YouTube's markup;
     `externalId` and `youtube.com/channel/UC...` links also work).
   - Or use `https://www.youtube.com/@handle` > About tab > Share > Copy channel ID (mobile/desktop app shows it).
4. Test the feed in a browser:
   `https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx`

## How to find a WhatsApp Group JID

1. Join the group with the number the bot will use (bot must be a group member).
2. Easiest: temporarily add to `index.js`:
   ```js
   client.on('message', async (msg) => {
     const chat = await msg.getChat();
     if (chat.isGroup) console.log(chat.name, '->', chat.id._serialized);
   });
   ```
   Send any message in the group and read the terminal output.
   It looks like `120363000000000000@g.us` — paste that into `targetGroupJids`.
3. Alternative: use `client.getChats()` and filter `chat.isGroup`.

## Troubleshooting

- `npm test` / `npm start` says "node is not recognized" → Node.js is not on
  this machine's PATH anymore (it was removed from `C:\Program Files\nodejs`
  during this session). Reinstall Node from nodejs.org, or temporarily point
  PATH at any `node.exe` you trust. All code here was verified with a
  bundled Node v22.14.0.
- `NOTICE: latest N video(s) already sent` but you expected sends → the IDs
  are already cached: `node testYoutube.js --reset` (bot: delete
  `posted_videos.json` — next start re-seeds and sends nothing, or set
  `"sendHistoryOnFirstRun": true` to broadcast).
- `[config] WARNING:` at startup → fix the named field; warnings never
  block boot, but ignored top-level messaging keys mean that channel runs
  on fallback behavior.
- `Daily cap reached` in logs → `maxVideosPerDay` hit; remainder retries
  automatically on later checks / next day.
- QR won't scan / session expired → stop the bot, delete `.wwebjs_auth/`,
  restart, scan again.
- Suspect a feed → the bot falls back to innertube automatically; to check
  the raw RSS: open
  `https://www.youtube.com/feeds/videos.xml?channel_id=UC...` in a browser
  (it currently returns 404 — that is YouTube-side, not a bot bug).

## Feature run 2 (2026-11)

New in this round:

- **`excludeKeywords`** (per channel) — blocklist; a blocked video is
  recorded as skipped even if a `preferredKeywords` rule matched it.
- **Digest mode** — `channel.digest: { enabled, hour, separator }` queues
  new videos in `digest_queue.json` and sends one combined message at
  `hour` (default 8) instead of one message per video. Daily caps still
  apply; restarts preserve pending items.
- **Admin commands** — add your JID(s) to global `adminJids`, then send the
  bot: `/status`, `/pause [channel]`, `/resume [channel]`, `/reload`, `/help`.
  Pause/resume and reload are in-memory only (reset on restart).
- **File logging** — console output is mirrored to `bot.log` (rotates at
  1 MB to `bot.log.1`) when running as the main process.

## QA notes (2026-11 review)

Bugs found and fixed:

- **Overlapping checks**: with long typing delays a check could still be
  running when the next 1-minute tick fired, double-sending videos. Added
  a re-entrancy guard around `checkDueChannels`.
- **Stateful regex**: `extendedRules` with a `g`/`y` flag matched different
  videos on successive calls (`RegExp.test` advances `lastIndex`). Flags are
  now stripped before matching.
- **False "live" detection**: words like "deliver" or "olive" triggered live
  templates. Now uses word boundaries.
- **`quietHours: null` on a channel** failed to disable a global window.
  Fixed by checking key ownership rather than truthiness.
- **`--dry-run` wrote state**: it now runs the full real logic with no
  persistence and no WhatsApp connection.

Also added: `npm test` (11 offline assertions), feed retries, posted-ID
pruning, `enabled` toggle, quiet hours, and unhandled-error logging. All 11
self-tests pass; live PoC + dry-run verified end-to-end.

## Notes

- State is stored in `posted_videos.json` as `{ "<channelId>": ["<videoId>", ...] }`,
  plus `daily_counts.json` for per-channel daily send counts.
- Checks run on a 1-minute ticker; each channel is checked when its own
  `checkIntervalMinutes` (or the global one) has elapsed since its last check.
- First run seeds history without sending (avoids spamming 15 old videos).
  Set `"sendHistoryOnFirstRun": true` to broadcast history instead.
- Anti-ban: 3–8s random delay between group sends, 1.5–3s between channels,
  sequential sends, per-channel/per-group `try/catch`.
