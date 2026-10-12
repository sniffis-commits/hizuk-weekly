/**
 * WhatsApp YouTube Monitor Bot
 *
 * Monitors YouTube channel RSS feeds and broadcasts new videos
 * to assigned WhatsApp groups.
 *
 * Stack: whatsapp-web.js (LocalAuth) + qrcode-terminal + rss-parser
 *
 * Usage:
 *   npm install
 *   npm start
 *   # Scan the QR code in terminal with WhatsApp > Linked devices on first run.
 */

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const Parser = require('rss-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const POSTED_PATH = path.join(__dirname, 'posted_videos.json');

// Everything stays inside the project directory: browser binary, session,
// state. Never fall back to the global %USERPROFILE%/.cache location.
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer-cache');

/** Locate the project-local Chrome binary (version-agnostic). */
function findLocalChrome() {
  const root = path.join(process.env.PUPPETEER_CACHE_DIR, 'chrome');
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const exe = path.join(root, entry.name, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch (_) {
    // Cache dir missing — run: $env:PUPPETEER_CACHE_DIR="$PWD\.puppeteer-cache"
    //   npx puppeteer browsers install chrome
  }
  return undefined;
}

const parser = new Parser();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);

  if (!config.checkIntervalMinutes || typeof config.checkIntervalMinutes !== 'number') {
    throw new Error('config.json: "checkIntervalMinutes" must be a number.');
  }
  if (!config.messageTemplate || typeof config.messageTemplate !== 'string') {
    throw new Error('config.json: "messageTemplate" must be a string.');
  }
  if (!Array.isArray(config.channels) || config.channels.length === 0) {
    throw new Error('config.json: "channels" must be a non-empty array.');
  }
  for (const ch of config.channels) {
    if (!ch.youtubeChannelId || !Array.isArray(ch.targetGroupJids)) {
      throw new Error(`config.json: invalid channel entry: ${JSON.stringify(ch)}`);
    }
  }
  for (const warning of validateConfig(config)) {
    console.warn(`[config] WARNING: ${warning}`);
  }
  return config;
}

/**
 * Load the posted-video store ({channelId: [videoId, ...]}).
 * Defaults to the bot's posted_videos.json; pass another path (e.g. the
 * PoC's test_posted_videos.json) to reuse the same logic elsewhere.
 */
function loadPosted(filePath = POSTED_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return {};
    const data = JSON.parse(raw);
    // Normalize: ensure every value is an array.
    for (const k of Object.keys(data)) {
      if (!Array.isArray(data[k])) data[k] = [];
    }
    return data;
  } catch (err) {
    console.error(`[posted] Failed to read ${path.basename(filePath)}, starting fresh:`, err.message);
    return {};
  }
}

function savePosted(posted, filePath = POSTED_PATH) {
  fs.writeFileSync(filePath, JSON.stringify(posted, null, 2), 'utf-8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(minMs = 3000, maxMs = 8000) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/** Extract the 11-char YouTube video ID from an RSS item. */
function getVideoId(item) {
  // YouTube RSS uses id like "yt:video:VIDEOID"
  if (item.id && typeof item.id === 'string' && item.id.includes(':')) {
    const parts = item.id.split(':');
    const candidate = parts[parts.length - 1];
    if (candidate) return candidate;
  }
  // Fallback: parse v= param from link.
  try {
    const url = new URL(item.link);
    const v = url.searchParams.get('v');
    if (v) return v;
  } catch (_) {
    // ignore, fall through
  }
  // Last resort: use the link itself as unique key.
  return item.link || item.guid || item.title;
}

function feedUrlFor(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

/** Build the videoData object formatMessage() expects from an RSS item. */
function buildVideoData(item, feed, channel) {
  const videoId = getVideoId(item);
  return {
    id: videoId,
    title: item.title || '',
    link: item.link || `https://www.youtube.com/watch?v=${videoId}`,
    pubDate: item.pubDate || item.isoDate || '',
    author: item.author || (feed && feed.title) || '',
    description: item.contentSnippet || item.content || '',
    channelName: (channel && channel.channelName) || item.author || (feed && feed.title) || '',
  };
}

// ---------------------------------------------------------------------------
// Message formatting + conditional logic
// ---------------------------------------------------------------------------

/**
 * All supported {%VAR_*%} template tokens.
 */
const KNOWN_TOKENS = [
  'VAR_URL',
  'VAR_TITLE',
  'VAR_CHANNEL',
  'VAR_DATE',
  'VAR_ID',
  'VAR_EXTENDED',
  'VAR_PLAYLIST_URL',
];

function playlistUrlFor(playlistId) {
  return playlistId ? `https://www.youtube.com/playlist?list=${playlistId}` : '';
}

/**
 * Replace every {%VAR_*%} token. extra carries computed slots:
 *   { extended }    - resolved {%VAR_EXTENDED%} text ('' when no rule matched)
 *   { playlistUrl } - {%VAR_PLAYLIST_URL%} (only meaningful inside a rule tied
 *                     to a playlistId, otherwise '')
 */
function fillTemplate(text, videoData, extra = {}) {
  const {
    id = '',
    title = '',
    link = '',
    pubDate = '',
    author = '',
    description = '',
    channelName = '',
  } = videoData;
  return String(text)
    .split('{%VAR_URL%}').join(link)
    .split('{%VAR_TITLE%}').join(title)
    .split('{%VAR_CHANNEL%}').join(channelName || author || '')
    .split('{%VAR_DATE%}').join(pubDate || '')
    .split('{%VAR_ID%}').join(id)
    .split('{%VAR_EXTENDED%}').join(extra.extended || '')
    .split('{%VAR_PLAYLIST_URL%}').join(extra.playlistUrl || '');
}

/**
 * Resolve the {%VAR_EXTENDED%} slot from config.extendedRules.
 * Each rule: { match (regex), text, playlistId? } — first match wins,
 * no match renders as ''. Invalid regexes are logged and skipped, never throw.
 */
function resolveExtended(videoData, haystack, config) {
  if (!Array.isArray(config.extendedRules)) return '';
  for (const rule of config.extendedRules) {
    if (!rule || !rule.match) continue;
    let re;
    try {
      re = new RegExp(rule.match, rule.flags || 'i');
    } catch (err) {
      console.error(`[format] invalid extendedRules regex ${JSON.stringify(rule.match)}: ${err.message} (rule skipped)`);
      continue;
    }
    if (re.test(haystack)) {
      return fillTemplate(rule.text || '', videoData, {
        extended: '',
        playlistUrl: playlistUrlFor(rule.playlistId),
      });
    }
  }
  return '';
}

/**
 * Format a message from a template and video metadata.
 *
 * Supported variables: {%VAR_URL%}, {%VAR_TITLE%}, {%VAR_CHANNEL%},
 *   {%VAR_DATE%}, {%VAR_ID%}, {%VAR_EXTENDED%} (extendedRules slot),
 *   {%VAR_PLAYLIST_URL%} (inside a rule tied to a playlistId).
 *
 * Precedence:
 *   1. base template (shorts/live override when matched)
 *   2. {%VAR_EXTENDED%} resolved from extendedRules (first match wins)
 *   3. all variables replaced
 *   4. shorts/live suffix appended (when no dedicated template)
 *   5. legacy customKeywordRules applied last: [{ keyword, suffix, template? }]
 *
 * @param {string} template base template from config.messageTemplate
 * @param {object} videoData { id, title, link, pubDate, author, description, channelName }
 * @param {object} config full config (for conditional templates/suffixes)
 * @returns {string}
 */
function formatMessage(template, videoData, config = {}) {
  const {
    title = '',
    link = '',
    description = '',
  } = videoData;

  let base = template;

  const haystack = `${title}\n${description}`.toLowerCase();
  const isShort =
    haystack.includes('#shorts') || (typeof link === 'string' && link.includes('/shorts/'));
  const isLive =
    haystack.includes('live') || haystack.includes('premiere') || haystack.includes('🔴');

  // Channel-type conditional templates.
  if (isShort && typeof config.shortsTemplate === 'string' && config.shortsTemplate) {
    base = config.shortsTemplate;
  } else if (isLive && typeof config.liveTemplate === 'string' && config.liveTemplate) {
    base = config.liveTemplate;
  }

  const extended = resolveExtended(videoData, haystack, config);
  let message = fillTemplate(base, videoData, { extended });

  // Default suffixes when no dedicated template was used.
  if (isShort && !(config.shortsTemplate && base === config.shortsTemplate)) {
    message += config.shortsSuffix ?? ' ⚡ (#Shorts)';
  } else if (isLive && !(config.liveTemplate && base === config.liveTemplate)) {
    message += config.liveSuffix ?? ' 🔴 (Live/Premiere)';
  }

  // Custom keyword rules from config.
  if (Array.isArray(config.customKeywordRules)) {
    for (const rule of config.customKeywordRules) {
      if (!rule || !rule.keyword) continue;
      if (haystack.includes(String(rule.keyword).toLowerCase())) {
        if (rule.template) {
          message = fillTemplate(rule.template, videoData, { extended });
        } else if (rule.suffix) {
          message += rule.suffix;
        }
        break; // first matching rule wins
      }
    }
  }

  return message;
}

/**
 * Soft-validate a config object. Returns an array of warning strings
 * (empty = clean). Structural errors still throw from loadConfig();
 * everything here only warns so a typo can't prevent boot.
 */
function validateConfig(config) {
  const warnings = [];
  const tokenRe = /\{%([A-Z0-9_]+)%\}/g;
  const checkTokens = (where, text) => {
    if (typeof text !== 'string' || !text) return;
    for (const m of text.matchAll(tokenRe)) {
      if (!KNOWN_TOKENS.includes(m[1])) {
        warnings.push(`${where}: unknown token {%${m[1]}%} (known: ${KNOWN_TOKENS.map((t) => `{%${t}%}`).join(', ')})`);
      }
    }
  };

  checkTokens('messageTemplate', config.messageTemplate);
  checkTokens('shortsTemplate', config.shortsTemplate);
  checkTokens('liveTemplate', config.liveTemplate);
  checkTokens('shortsSuffix', config.shortsSuffix);
  checkTokens('liveSuffix', config.liveSuffix);
  (config.customKeywordRules || []).forEach((r, i) => {
    checkTokens(`customKeywordRules[${i}].template`, r && r.template);
    checkTokens(`customKeywordRules[${i}].suffix`, r && r.suffix);
  });
  (config.extendedRules || []).forEach((r, i) => {
    if (!r || !r.match) {
      warnings.push(`extendedRules[${i}]: missing "match" regex (rule ignored)`);
      return;
    }
    try {
      new RegExp(r.match, r.flags || 'i');
    } catch (err) {
      warnings.push(`extendedRules[${i}]: invalid regex ${JSON.stringify(r.match)}: ${err.message} (rule skipped at runtime)`);
    }
    checkTokens(`extendedRules[${i}].text`, r.text);
  });
  (config.channels || []).forEach((ch, i) => {
    const label = `channels[${i}]${ch && ch.channelName ? ` (${ch.channelName})` : ''}`;
    if (!ch || !ch.youtubeChannelId) {
      warnings.push(`${label}: missing youtubeChannelId`);
    } else if (!/^UC[\w-]{16,}$/.test(ch.youtubeChannelId)) {
      warnings.push(`${label}: youtubeChannelId looks invalid: ${ch.youtubeChannelId}`);
    }
    for (const jid of (ch && ch.targetGroupJids) || []) {
      if (!/@(g|c)\.us$/.test(jid)) {
        warnings.push(`${label}: target JID looks invalid: ${jid}`);
      }
    }
  });
  return warnings;
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

async function checkChannel(client, channel, config, posted) {
  const channelKey = channel.youtubeChannelId;
  const channelLabel = channel.channelName || channelKey;

  try {
    const feed = await parser.parseURL(feedUrlFor(channelKey));
    const items = feed.items || [];

    if (items.length === 0) {
      console.log(`[${channelLabel}] Feed empty, nothing to do.`);
      return;
    }

    if (!Array.isArray(posted[channelKey])) {
      posted[channelKey] = [];
    }
    const seen = new Set(posted[channelKey]);

    // RSS returns newest first. Reverse so we post oldest-first (chronological).
    const ordered = [...items].reverse();

    // First run: seed history without spamming all old videos.
    // Set "sendHistoryOnFirstRun": true in config.json to disable seeding.
    if (seen.size === 0 && !config.sendHistoryOnFirstRun) {
      for (const item of ordered) {
        seen.add(getVideoId(item));
      }
      posted[channelKey] = [...seen];
      savePosted(posted);
      console.log(
        `[${channelLabel}] First run: seeded ${ordered.length} existing video(s), no messages sent. ` +
          `Set "sendHistoryOnFirstRun": true to broadcast history.`
      );
      return;
    }

    const fresh = ordered.filter((item) => !seen.has(getVideoId(item)));

    if (fresh.length === 0) {
      console.log(`[${channelLabel}] No new videos.`);
      return;
    }

    console.log(`[${channelLabel}] Found ${fresh.length} new video(s).`);

    for (const item of fresh) {
      const videoData = buildVideoData(item, feed, channel);
      const videoId = videoData.id;

      let message;
      try {
        message = formatMessage(config.messageTemplate, videoData, config);
      } catch (err) {
        console.error(`[${channelLabel}] formatMessage failed for ${videoId}:`, err.message);
        continue;
      }

      for (const jid of channel.targetGroupJids) {
        try {
          await client.sendMessage(jid, message);
          console.log(`[${channelLabel}] Sent ${videoId} -> ${jid}`);
        } catch (err) {
          // One group failing must not stop the rest.
          console.error(`[${channelLabel}] Failed to send ${videoId} -> ${jid}:`, err.message);
        }
        // Anti-ban: random delay between sends (skip after last group is fine too,
        // keeps timing human-like when multiple videos/groups queue up).
        await sleep(randomDelayMs(3000, 8000));
      }

      // Persist immediately so a crash doesn't re-send.
      seen.add(videoId);
      posted[channelKey] = [...seen];
      try {
        savePosted(posted);
      } catch (err) {
        console.error('[posted] Failed to save posted_videos.json:', err.message);
      }
    }
  } catch (err) {
    // Single channel/network failure must not crash the bot.
    console.error(`[${channelLabel}] Feed check failed:`, err.message);
  }
}

async function checkAllChannels(client, config, posted) {
  console.log(`[check] Running check at ${new Date().toISOString()} ...`);
  // Sequential per channel = gentler on rate limits than Promise.all.
  for (const channel of config.channels) {
    await checkChannel(client, channel, config, posted);
    // Small gap between channels.
    await sleep(randomDelayMs(1500, 3000));
  }
  console.log('[check] Done.');
}

// ---------------------------------------------------------------------------
// WhatsApp client bootstrap
// ---------------------------------------------------------------------------

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Failed to load config.json:', err.message);
    process.exit(1);
  }
  const posted = loadPosted();

  const chromePath = findLocalChrome();
  const client = new Client({
    authStrategy: new LocalAuth(), // persists session to .wwebjs_auth/
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(chromePath ? { executablePath: chromePath } : {}),
    },
  });

  client.on('qr', (qr) => {
    console.log('Scan this QR code with WhatsApp > Linked devices:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('[auth] Authenticated, session saved via LocalAuth.');
  });

  client.on('auth_failure', (msg) => {
    console.error('[auth] Authentication failure:', msg);
  });

  client.on('ready', async () => {
    console.log('[ready] WhatsApp client is ready.');
    console.log(
      `[ready] Watching ${config.channels.length} channel(s), checking every ${config.checkIntervalMinutes} minute(s).`
    );

    // Immediate check, then recurring execution.
    await checkAllChannels(client, config, posted);

    const intervalMs = config.checkIntervalMinutes * 60 * 1000;
    setInterval(() => {
      checkAllChannels(client, config, posted).catch((err) =>
        console.error('[check] Unexpected error:', err.message)
      );
    }, intervalMs);
  });

  client.on('disconnected', (reason) => {
    console.error('[client] Disconnected:', reason);
  });

  client.initialize().catch((err) => {
    console.error('Failed to initialize WhatsApp client:', err);
    process.exit(1);
  });
}

// Export for testing.
module.exports = { formatMessage, getVideoId, feedUrlFor, randomDelayMs, buildVideoData, loadPosted, savePosted, validateConfig, playlistUrlFor, KNOWN_TOKENS };

if (require.main === module) {
  main();
}
