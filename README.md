# WhatsApp YouTube Monitor Bot

Monitors YouTube channels via RSS and broadcasts new videos to WhatsApp groups.

## Setup

```bash
npm install
npm start
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
  "messageTemplate": "MSG MSG MSG MSG {%VAR_URL%}{%VAR_EXTENDED%}",
  "customKeywordRules": [
    { "keyword": "giveaway", "suffix": " 🎁 Don't miss the giveaway!" }
  ],
  "extendedRules": [
    {
      "match": "this week",
      "text": "\n📚 This week's playlist: {%VAR_PLAYLIST_URL%}",
      "playlistId": "PLxxxxxxxxxxxxxxxxxxxxxx"
    },
    {
      "match": "new stuff",
      "text": "\n✨ New stuff playlist: {%VAR_PLAYLIST_URL%}",
      "playlistId": "PLyyyyyyyyyyyyyyyyyyyyyy"
    }
  ],
  "channels": [
    {
      "channelName": "Example Channel",
      "youtubeChannelId": "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      "targetGroupJids": ["120363000000000000@g.us"]
    },
    {
      "channelName": "Rabbi Uri Hanania Elnekave",
      "youtubeChannelId": "UC2s4RBog6eLOstA_GIMOQrg",
      "targetGroupJids": ["120363000000000000@g.us"]
    },
    {
      "channelName": "Rabbi Ovadya Yosef",
      "youtubeChannelId": "UCp1qY8aM7kY9bOlJ70eEArg",
      "targetGroupJids": ["120363000000000000@g.us"]
    }
  ]
}
```

Optional fields: `shortsTemplate`, `liveTemplate`, `shortsSuffix`,
`liveSuffix`, `customKeywordRules`, `extendedRules`, `sendHistoryOnFirstRun`.

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

Regex-keyword → appended message. Each rule is
`{ "match", "text", "playlistId"? }`, matched case-insensitively against
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
and bad JIDs — warnings only, the bot still boots.

## Files

| File | Purpose |
|---|---|
| `index.js` | The bot: RSS monitor + WhatsApp broadcast loop |
| `config.json` | Interval, message template, channel list |
| `posted_videos.json` | Runtime state: already-posted video IDs per channel |
| `test_posted_videos.json` | Runtime state for the YouTube PoC (separate file, safe to delete) |
| `waSend.js` | One-shot WhatsApp sender (used by both `testWhatsapp` flavors) |
| `testYoutube.js` | PoC: YouTube check with DEBUG send (imports bot functions from `index.js`) |
| `testWhatsapp.js` | PoC: real test message via the same WhatsApp client |
| `Python/` | Original Python mirrors: `testYoutube.py`, `testWhatsapp.py` (stdlib-only) |

## PoC scripts

JS versions are primary — `testYoutube.js` imports `formatMessage`,
`getVideoId`, `feedUrlFor`, `buildVideoData`, `loadPosted`, and `savePosted`
directly from `index.js`, so the tryouts always exercise the real bot code.
The save-sent logic lives only in `index.js` (`loadPosted`/`savePosted`
take an optional file path; the bot uses the default `posted_videos.json`,
the PoC passes `test_posted_videos.json`). `Python/` holds the original
stdlib-only mirrors (no installs, Python 3.8+). Both flavors share
`test_posted_videos.json`, so state carries across them.

**YouTube only, no WhatsApp** — fetches each channel's RSS feed, formats
the newest videos with the template, prints instead of sending:

```bash
node testYoutube.js [max_videos_per_channel] [--reset]
python Python/testYoutube.py [max_videos_per_channel] [--reset]
```

Pretend-sends are recorded per channel in `test_posted_videos.json`
(separate from the bot's `posted_videos.json`). Re-runs print
`NOTICE: latest N video(s) already sent — nothing new.` To start over,
delete that file or pass `--reset`. If you get NOTICE but expected sends,
the video IDs are already in the cache — reset it.

**WhatsApp only, no YouTube** — sends one real message to a group or
contact JID through the same `Client`/`LocalAuth`/local-Chrome setup as
the bot (QR scan on first run):

```bash
node testWhatsapp.js <target-jid> [message]
node testWhatsapp.js 120363000000000000@g.us "hello from PoC"
python Python/testWhatsapp.py 120363000000000000@g.us "hello from PoC"
```

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

## Notes

- State is stored in `posted_videos.json` as `{ "<channelId>": ["<videoId>", ...] }`.
- First run seeds history without sending (avoids spamming 15 old videos).
  Set `"sendHistoryOnFirstRun": true` to broadcast history instead.
- Anti-ban: 3–8s random delay between group sends, 1.5–3s between channels,
  sequential sends, per-channel/per-group `try/catch`.
