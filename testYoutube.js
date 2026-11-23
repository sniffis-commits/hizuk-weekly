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
const { formatMessage, getVideoId, buildVideoData, loadPosted, savePosted, selectVideosToSend, loadDailyCounts, saveDailyCounts, canSendToday, recordSend, typingDelayMs, resolveHumanTiming, fetchChannelItems, isQuietTime } = require('./index.js');

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, 'config.json');
const TEST_POSTED_PATH = path.join(BASE, 'test_posted_videos.json'); // PoC-only cache, safe to delete
const TEST_DAILY_PATH = path.join(BASE, 'test_daily_counts.json'); // PoC-only daily counts, safe to delete

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

/** DEBUG stand-in for client.sendMessage() — prints, sends nothing. */
function debugSend(targetJid, message, timing) {
  const wait = timing ? typingDelayMs(message, timing) : 0;
  console.log(`[DEBUG SEND -> ${targetJid}]${wait ? ` (human typing delay ${(wait / 1000).toFixed(1)}s)` : ''}`);
  console.log(message);
  console.log('-'.repeat(60));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--reset')) {
    for (const f of [TEST_POSTED_PATH, TEST_DAILY_PATH]) {
      try {
        fs.unlinkSync(f);
        console.log(`(cache ${path.basename(f)} deleted — next run sends everything again)`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        console.log(`(no cache ${path.basename(f)} to delete)`);
      }
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
  const daily = loadDailyCounts(TEST_DAILY_PATH);

  for (const channel of config.channels) {
    const cid = channel.youtubeChannelId;
    const name = channel.channelName || cid;
    console.log(`=== ${name} (${cid}) ===`);

    if (isQuietTime(channel, config)) {
      console.log(`[${name}] Quiet hours — skipping (PoC simulation).`);
      continue;
    }

    let feed;
    let videos;
    try {
      const res = await fetchChannelItems(channel, { author: name });
      feed = res.feed || { title: name };
      videos = res.items.slice(0, limit);
      if (res.source !== 'rss') console.log(`[${name}] Feed source: ${res.source}.`);
    } catch (err) {
      // One channel failing must not stop the rest.
      console.log(`!! feed fetch failed: ${err.message}`);
      continue;
    }
    if (videos.length === 0) {
      console.log('(feed empty)');
      continue;
    }

    if (!Array.isArray(posted[cid])) posted[cid] = [];
    const seen = new Set(posted[cid]);
    const freshNewestFirst = videos
      .filter((item) => !seen.has(getVideoId(item)))
      .map((item) => ({ item, videoData: buildVideoData(item, feed, channel) }));
    if (freshNewestFirst.length === 0) {
      console.log(`NOTICE: latest ${videos.length} video(s) already sent — nothing new.`);
      continue;
    }

    const { send, skip } = selectVideosToSend(freshNewestFirst, channel);
    if (skip.length > 0) {
      for (const entry of skip) seen.add(entry.videoData.id);
      posted[cid] = [...seen];
      savePosted(posted, TEST_POSTED_PATH);
      console.log(`[${name}] Skipped ${skip.length} non-preferred video(s).`);
    }
    console.log(`[${name}] Sending ${send.length} of ${freshNewestFirst.length} new video(s) (order: ${channel.sendOrder || 'unsent'}).`);

    for (const { videoData } of send) {
      if (!canSendToday(channel, daily)) {
        console.log(`[${name}] Daily cap reached (${channel.maxVideosPerDay}/day) — stopping.`);
        break;
      }
      const message = formatMessage(channel, videoData);
      const timing = resolveHumanTiming(channel, config);
      for (const jid of channel.targetGroupJids) {
        debugSend(jid, message, timing);
      }
      // Record even though the send was only pretend (bot's own savers).
      posted[cid].push(videoData.id);
      savePosted(posted, TEST_POSTED_PATH);
      recordSend(cid, daily);
      saveDailyCounts(daily, TEST_DAILY_PATH);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
