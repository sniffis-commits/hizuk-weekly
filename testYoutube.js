/**
 * PoC: YouTube channel monitor with DEBUG send (no WhatsApp involved).
 *
 * Same behavior as Python/testYoutube.py; both share test_posted_videos.json.
 * All YouTube/message/state logic is imported from the real bot (index.js) —
 * no duplicated feed, formatting, or save-sent code here.
 *
 * Usage: node testYoutube.js [max_videos_per_channel] [--reset]
 */

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const { formatMessage, getVideoId, feedUrlFor, buildVideoData, loadPosted, savePosted } = require('./index.js');

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, 'config.json');
const TEST_POSTED_PATH = path.join(BASE, 'test_posted_videos.json'); // PoC-only cache, safe to delete

const parser = new Parser();

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

/** DEBUG stand-in for client.sendMessage() — prints, sends nothing. */
function debugSend(targetJid, message) {
  console.log(`[DEBUG SEND -> ${targetJid}]`);
  console.log(message);
  console.log('-'.repeat(60));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--reset')) {
    try {
      fs.unlinkSync(TEST_POSTED_PATH);
      console.log('(cache test_posted_videos.json deleted — next run sends everything again)');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.log('(no cache test_posted_videos.json to delete)');
    }
    if (argv.filter((a) => a !== '--reset').length === 0) return;
  }

  const positional = argv.filter((a) => a !== '--reset');
  const limit = positional.length > 0 ? parseInt(positional[0], 10) : 2;
  if (!Number.isInteger(limit)) {
    console.error('Usage: node testYoutube.js [max_videos_per_channel] [--reset]');
    process.exit(2);
  }

  const config = loadConfig();
  const posted = loadPosted(TEST_POSTED_PATH);

  for (const channel of config.channels) {
    const cid = channel.youtubeChannelId;
    const name = channel.channelName || cid;
    console.log(`=== ${name} (${cid}) ===`);

    let feed;
    try {
      feed = await parser.parseURL(feedUrlFor(cid));
    } catch (err) {
      // One channel failing must not stop the rest.
      console.log(`!! feed fetch failed: ${err.message}`);
      continue;
    }

    const videos = (feed.items || []).slice(0, limit);
    if (videos.length === 0) {
      console.log('(feed empty)');
      continue;
    }

    if (!Array.isArray(posted[cid])) posted[cid] = [];
    const seen = new Set(posted[cid]);
    const fresh = videos.filter((item) => !seen.has(getVideoId(item)));
    if (fresh.length === 0) {
      console.log(`NOTICE: latest ${videos.length} video(s) already sent — nothing new.`);
      continue;
    }

    for (const item of [...fresh].reverse()) { // oldest-first, like the bot
      const videoData = buildVideoData(item, feed, channel);
      const message = formatMessage(config.messageTemplate, videoData, config);
      for (const jid of channel.targetGroupJids) {
        debugSend(jid, message);
      }
      // Record even though the send was only pretend (bot's own saver).
      posted[cid].push(videoData.id);
      savePosted(posted, TEST_POSTED_PATH);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
