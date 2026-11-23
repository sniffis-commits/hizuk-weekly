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

// Set by `node index.js --dry-run`: all logic runs, no state is written.
let dryRun = false;

// In-memory daily counters for the status/analytics report.
const stats = {};
let statsDateKey = null;

function bumpStat(channelId, field, amount = 1) {
  const key = statsDateKey === todayKey() ? channelId : null;
  if (!key) return;
  stats[key] = stats[key] || { seen: 0, sent: 0, skipped: 0, failed: 0, queued: 0 };
  stats[key][field] = (stats[key][field] || 0) + amount;
}

function ensureStatsDay() {
  const key = todayKey();
  if (statsDateKey !== key) {
    statsDateKey = key;
    for (const k of Object.keys(stats)) delete stats[k];
  }
}

function getStats() {
  ensureStatsDay();
  return stats;
}

const STATUS_PATH = path.join(__dirname, 'status.json');
const STATUS_STATE_PATH = path.join(__dirname, 'status_state.json');

/** Build the snapshot consumed by status messages and dashboard.html. */
function buildStatusReport(config, posted, dailyCounts, now = new Date()) {
  const counters = getStats();
  return {
    generatedAt: now.toISOString(),
    intervalMinutes: config.checkIntervalMinutes,
    channels: config.channels.map((ch) => {
      const id = ch.youtubeChannelId;
      const last = lastCheckAt(id);
      const dueIn = Math.max(0, Math.ceil((intervalFor(ch, config) - (Date.now() - last)) / 60000));
      const c = counters[id] || {};
      return {
        name: ch.channelName || id,
        id,
        enabled: ch.enabled !== false,
        targets: normalizeGroups(ch).map((g) => g.jid),
        posted: (posted[id] || []).length,
        sentToday: sentTodayCount(id, dailyCounts, now),
        seenToday: c.seen || 0,
        skippedToday: c.skipped || 0,
        failedToday: c.failed || 0,
        queuedToday: c.queued || 0,
        quietNow: isQuietTime(ch, config, now),
        dueInMinutes: dueIn,
        digest: ch.digest && ch.digest.enabled ? ch.digest.hour ?? 8 : null,
      };
    }),
  };
}

/** Last-check timestamps are held in a module-level map set by main(). */
let lastCheckProvider = () => 0;
function setLastCheckProvider(fn) { lastCheckProvider = fn; }
function lastCheckAt(id) { return lastCheckProvider(id); }

function writeStatusFile(report, filePath = STATUS_PATH) {
  if (dryRun) return;
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
}

function loadStatusState(filePath = STATUS_STATE_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf-8').trim() || '{}');
  } catch (_) {
    return {};
  }
}

function saveStatusState(state, filePath = STATUS_STATE_PATH) {
  if (dryRun) return;
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

/** Plain-text version of the report for admin/status-group messages. */
function formatStatusReport(report) {
  const lines = [`📊 החיזוק השבועי — ${new Date(report.generatedAt).toLocaleString('he-IL')}`,
    `עדכון: ${new Date().toISOString()}`, ''];
  for (const ch of report.channels) {
    lines.push(
      `${ch.enabled ? '▶' : '⏸'} ${ch.name}`,
      `  נשלחו היום: ${ch.sentToday} | בסה"כ: ${ch.posted} | דילוגים: ${ch.skippedToday}`,
      `  כשלונות: ${ch.failedToday} | בתור: ${ch.queuedToday} | שקט עכשיו: ${ch.quietNow ? 'כן' : 'לא'}`,
      `  בדיקה הבאה בעוד ~${ch.dueInMinutes} דק' | קבוצות: ${ch.targets.length}${ch.digest !== null ? ` | דייג'סט: ${ch.digest}:00` : ''}`,
      ''
    );
  }
  return lines.join('\n');
}

/** Accept a JID string or { jid, language?, messageTemplate?, ... } object. */
function normalizeGroups(channel) {
  const raw = Array.isArray(channel && channel.targetGroupJids)
    ? channel.targetGroupJids
    : [];
  return raw.map((entry, index) => {
    const obj = entry && typeof entry === 'object' ? entry : { jid: entry };
    return { jid: obj.jid, raw: obj, index };
  });
}

/**
 * Effective settings for one group: channel -> language template -> group
 * overrides. Group overrides win so a single group can have its own wording
 * and its own digest schedule while sharing the same channel feed.
 */
function groupSettings(channel, group) {
  const out = { ...(channel || {}) };
  const lang = group && group.raw && group.raw.language;
  if (lang && channel && channel.languageTemplates && channel.languageTemplates[lang]) {
    Object.assign(out, channel.languageTemplates[lang]);
  }
  const keys = [
    'messageTemplate', 'shortsTemplate', 'liveTemplate', 'shortsSuffix',
    'liveSuffix', 'customKeywordRules', 'extendedRules', 'digest', 'humanTiming',
  ];
  if (group && group.raw) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(group.raw, key)) out[key] = group.raw[key];
    }
  }
  return out;
}

function digestKey(channelId, jid) {
  return `${channelId}::${jid}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);

  if (!config.checkIntervalMinutes || typeof config.checkIntervalMinutes !== 'number') {
    throw new Error('config.json: "checkIntervalMinutes" must be a number.');
  }
  if (!Array.isArray(config.channels) || config.channels.length === 0) {
    throw new Error('config.json: "channels" must be a non-empty array.');
  }
  for (const ch of config.channels) {
    if (!ch.youtubeChannelId || !Array.isArray(ch.targetGroupJids)) {
      throw new Error(`config.json: invalid channel entry: ${JSON.stringify(ch)}`);
    }
    if (ch.messageTemplate !== undefined && typeof ch.messageTemplate !== 'string') {
      throw new Error(`config.json: "messageTemplate" must be a string when present: ${JSON.stringify(ch)}`);
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
  if (dryRun) return;
  fs.writeFileSync(filePath, JSON.stringify(posted, null, 2), 'utf-8');
}

const DIGEST_PATH = path.join(__dirname, 'digest_queue.json');

/** Load queued digest entries: { channelId: [{ id, text, queuedAt }] }. */
function loadDigestQueue(filePath = DIGEST_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return {};
    const data = JSON.parse(raw);
    for (const k of Object.keys(data)) if (!Array.isArray(data[k])) data[k] = [];
    return data;
  } catch (err) {
    console.error(`[digest] Failed to read ${path.basename(filePath)}, starting fresh:`, err.message);
    return {};
  }
}

function saveDigestQueue(queue, filePath = DIGEST_PATH) {
  if (dryRun) return;
  fs.writeFileSync(filePath, JSON.stringify(queue, null, 2), 'utf-8');
}

const DAILY_PATH = path.join(__dirname, 'daily_counts.json');

/** Load per-channel daily send counts: { channelId: { 'YYYY-MM-DD': n } }. */
function loadDailyCounts(filePath = DAILY_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return {};
    const data = JSON.parse(raw);
    for (const k of Object.keys(data)) {
      if (typeof data[k] !== 'object' || data[k] === null) data[k] = {};
    }
    return data;
  } catch (err) {
    console.error(`[daily] Failed to read ${path.basename(filePath)}, starting fresh:`, err.message);
    return {};
  }
}

function saveDailyCounts(counts, filePath = DAILY_PATH) {
  if (dryRun) return;
  fs.writeFileSync(filePath, JSON.stringify(counts, null, 2), 'utf-8');
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sentTodayCount(channelId, counts, now = new Date()) {
  const perDay = (counts && counts[channelId]) || {};
  return perDay[todayKey(now)] || 0;
}

/** True when the channel may send another video (no cap configured = unlimited). */
function canSendToday(channel, counts, now = new Date()) {
  const max = channel && channel.maxVideosPerDay;
  if (max === undefined || max === null) return true;
  return sentTodayCount(channel.youtubeChannelId, counts, now) < max;
}

/** Record one sent video for the channel today; prunes entries older than 7 days. */
function recordSend(channelId, counts, now = new Date()) {
  const key = todayKey(now);
  counts[channelId] = counts[channelId] || {};
  counts[channelId][key] = (counts[channelId][key] || 0) + 1;
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const cutoffKey = todayKey(cutoff);
  for (const cid of Object.keys(counts)) {
    for (const day of Object.keys(counts[cid])) {
      if (day < cutoffKey) delete counts[cid][day];
    }
    if (Object.keys(counts[cid]).length === 0) delete counts[cid];
  }
  return counts;
}

/**
 * Parse an "HH:MM" time into minutes since midnight. Returns null if invalid.
 */
function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * True when the current local time falls inside a quiet window.
 * Settings: { start: "HH:MM", end: "HH:MM" } — supports overnight windows
 * (start > end, e.g. 22:00 -> 07:00). Channel setting overrides global;
 * `quietHours: null` disables it.
 */
function isQuietTime(channel, config, now = new Date()) {
  // An explicit null on the channel disables a global window — only fall
  // back to the global setting when the channel has no quietHours key.
  const ownWindow = channel && Object.prototype.hasOwnProperty.call(channel, 'quietHours');
  const window = ownWindow ? channel.quietHours : (config && config.quietHours);
  if (!window || !window.start || !window.end) return false;
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === null || end === null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end; // overnight
}

/** Keep the newest N posted IDs per channel so the state file can't grow forever. */
function prunePostedIds(posted, channelId, keepLast = 500) {
  const ids = posted && posted[channelId];
  if (!Array.isArray(ids) || ids.length <= keepLast) return posted || {};
  posted[channelId] = ids.slice(-Math.max(1, Math.floor(keepLast)));
  return posted;
}

/** Retry an async function a few times with a short escalating delay. */
async function withRetry(fn, { attempts = 2, baseDelayMs = 1000, label = 'operation' } = {}) {
  let lastErr;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) {
        console.warn(`[retry] ${label} failed (${err.message}) — attempt ${i + 2}/${attempts}`);
        await sleep(baseDelayMs * (i + 1));
      }
    }
  }
  throw lastErr;
}

/** Effective check interval for a channel in ms (per-channel override, else global). */
function intervalFor(channel, config) {
  const raw = channel && channel.checkIntervalMinutes != null
    ? channel.checkIntervalMinutes
    : config.checkIntervalMinutes;
  const minutes = typeof raw === 'number' && raw > 0 ? raw : 15;
  return minutes * 60 * 1000;
}

function matchesKeyword(text, keywords) {
  const hay = String(text || '').toLowerCase();
  return (keywords || []).some((k) => k && hay.includes(String(k).toLowerCase()));
}

/**
 * Choose which fresh videos to send.
 * @param {Array<{videoData}>} freshNewestFirst fresh videos, newest first
 * @param {object} channel channel entry (preferredKeywords, sendOrder, latestCount)
 * @returns {{send: Array, skip: Array}} `send` in send order; `skip` is dropped
 *   (preferred filter: when a preferred video exists, the rest are skipped).
 *   Modes: "unsent" (default) = everything oldest-first; "latest" = newest N
 *   (latestCount, default 3) newest-first.
 */
function selectVideosToSend(freshNewestFirst, channel) {
  const list = Array.isArray(freshNewestFirst) ? [...freshNewestFirst] : [];
  const settings = channel || {};
  let candidates = list;
  let skipped = [];

  const preferred = (settings.preferredKeywords || []).filter(
    (k) => typeof k === 'string' && k
  );
  if (preferred.length > 0) {
    const hits = candidates.filter(({ videoData }) =>
      matchesKeyword(`${videoData.title}\n${videoData.description}`, preferred)
    );
    if (hits.length > 0) {
      skipped = candidates.filter((v) => !hits.includes(v));
      candidates = hits;
    }
  }

  // Blocklist wins over everything: excluded videos are recorded as skipped.
  const excluded = (settings.excludeKeywords || []).filter(
    (k) => typeof k === 'string' && k
  );
  if (excluded.length > 0) {
    const blocked = candidates.filter(({ videoData }) =>
      matchesKeyword(`${videoData.title}\n${videoData.description}`, excluded)
    );
    if (blocked.length > 0) {
      skipped.push(...blocked);
      const blockedSet = new Set(blocked);
      candidates = candidates.filter((v) => !blockedSet.has(v));
    }
  }

  if ((settings.sendOrder || 'unsent') === 'latest') {
    const n = Number.isInteger(settings.latestCount) && settings.latestCount > 0
      ? settings.latestCount
      : 3;
    return { send: candidates.slice(0, n), skip: [...candidates.slice(n), ...skipped] };
  }
  return { send: [...candidates].reverse(), skip: skipped };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(minMs = 3000, maxMs = 8000) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// ---------------------------------------------------------------------------
// Human-like timing
// ---------------------------------------------------------------------------

/**
 * Default human-like send timing. Overridable globally via
 * config.humanTiming and per channel via channel.humanTiming
 * (channel wins, key by key).
 */
const HUMAN_TIMING_DEFAULTS = {
  enabled: true,
  msPerChar: 50,        // base typing speed (~50ms per character)
  msPerWord: 40,        // extra pause per word break
  jitterMs: 700,        // random spread added to the typing time
  minTypingMs: 400,     // floor for the typing delay
  maxTypingMs: 20000,   // ceiling for the typing delay
  betweenSendsMinMs: 3000, // gap between two group sends
  betweenSendsMaxMs: 8000, // gap between two group sends
  pauseChance: 0.12,    // chance of a longer "distraction" pause
  pauseMinMs: 5000,
  pauseMaxMs: 20000,
};

/** Merge global + per-channel human timing over the defaults. */
function resolveHumanTiming(channel, config) {
  const out = { ...HUMAN_TIMING_DEFAULTS };
  const apply = (src) => {
    if (!src || typeof src !== 'object') return;
    for (const key of Object.keys(HUMAN_TIMING_DEFAULTS)) {
      if (src[key] !== undefined) out[key] = src[key];
    }
  };
  apply(config && config.humanTiming);
  apply(channel && channel.humanTiming);
  return out;
}

/**
 * How long a human would take to type this message.
 * Length-proportional, with per-word pauses, a randomized typing speed,
 * jitter, and an occasional longer hesitation.
 */
function typingDelayMs(message, timing = HUMAN_TIMING_DEFAULTS) {
  const t = { ...HUMAN_TIMING_DEFAULTS, ...(timing || {}) };
  if (!t.enabled) return 0;

  const text = String(message || '');
  const words = text.split(/\s+/).filter(Boolean).length;
  const base = text.length * t.msPerChar + words * t.msPerWord;

  // Humans do not type at a constant speed — vary it per message.
  const speed = 0.85 + Math.random() * 0.3;
  let delay = base * speed + Math.random() * t.jitterMs;

  // Occasional hesitation before hitting send.
  if (Math.random() < t.pauseChance) {
    delay += t.pauseMinMs + Math.random() * (t.pauseMaxMs - t.pauseMinMs);
  }
  return Math.round(Math.min(t.maxTypingMs, Math.max(t.minTypingMs, delay)));
}

/** Randomized pause between two consecutive sends (anti-ban + human pacing). */
function betweenSendsDelayMs(timing = HUMAN_TIMING_DEFAULTS) {
  const t = { ...HUMAN_TIMING_DEFAULTS, ...(timing || {}) };
  if (!t.enabled) return 0;

  let delay =
    t.betweenSendsMinMs + Math.random() * (t.betweenSendsMaxMs - t.betweenSendsMinMs);
  if (Math.random() < t.pauseChance) {
    // Rare "distraction" pause, added on top of the normal gap.
    delay += t.pauseMinMs + Math.random() * (t.pauseMaxMs - t.pauseMinMs);
  }
  // Hard ceiling so a misconfigured pause can't stall the bot for hours.
  const ceiling = t.betweenSendsMaxMs + t.pauseMaxMs;
  return Math.round(Math.min(ceiling, delay));
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

// ---------------------------------------------------------------------------
// Feed fetching: RSS first, innertube fallback
//
// YouTube retired the public RSS endpoint (it now answers 404 for every
// channel). The bot therefore tries RSS and, when that fails, falls back to
// YouTube's own innertube browse API, which returns the same video list.
// ---------------------------------------------------------------------------

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';
const INNERTUBE_CLIENT = { clientName: 'WEB', clientVersion: '2.20241010.01.00', hl: 'en' };
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** POST JSON to the innertube API and return the parsed response. */
function innertubePost(body, timeoutMs = 20000) {
  const https = require('https');
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      INNERTUBE_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': BROWSER_UA,
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://www.youtube.com',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`innertube HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`innertube bad JSON: ${err.message}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('innertube timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Walk a JSON tree collecting video "lockup"/"video" renderers. */
function collectVideoRenders(node, out = [], depth = 0) {
  if (!node || depth > 14) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectVideoRenders(child, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'lockupViewModel' || key === 'videoRenderer' || key === 'gridVideoRenderer') {
      const id = value.contentId || value.videoId;
      if (id) {
        const meta = value.metadata?.lockupMetadataViewModel;
        const title =
          meta?.title?.content ||
          value.title?.runs?.[0]?.text ||
          value.title?.simpleText ||
          value.headline?.simpleText ||
          '';
        // metadataRows -> ["12K views", "3 days ago"] / [channel]
        const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const parts = [];
        for (const row of rows) {
          for (const p of row.metadataParts || []) {
            if (p.text?.content) parts.push(p.text.content);
          }
        }
        const published = parts.find((p) => /ago|streamed|scheduled|premiere/i.test(p)) || '';
        out.push({ id, title, published, parts });
      }
      continue; // don't descend into a renderer we already handled
    }
    collectVideoRenders(value, out, depth + 1);
  }
  return out;
}

/**
 * Fetch a channel's (or playlist's) videos via the innertube API.
 * Returns items shaped like RSS entries (id/title/link/pubDate/author).
 */
async function innertubeItems(browseId, { tabTitle = 'Videos', author = '' } = {}) {
  const json = await innertubePost({
    context: { client: { ...INNERTUBE_CLIENT } },
    browseId,
    // Server-side filter: "videos" tab of the browse response.
    params: 'EgZ2aWRlb3PyBgQKAjoA',
  });

  const tabs = json.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const tab = tabs.find((t) => t.tabRenderer?.title === tabTitle) || tabs[0];
  const renders = collectVideoRenders(tab?.tabRenderer?.content || {});

  const seen = new Set();
  const items = [];
  for (const r of renders) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    items.push({
      id: `yt:video:${r.id}`,
      title: r.title,
      link: `https://www.youtube.com/watch?v=${r.id}`,
      pubDate: r.published,
      author,
      contentSnippet: r.title,
    });
  }
  return items;
}

/**
 * Get the newest videos for a channel.
 * Tries the RSS feed first; falls back to the innertube API when RSS is
 * unavailable (YouTube retired the public feeds endpoint).
 * @returns {Promise<{items: Array, source: 'rss'|'innertube'}>}
 */
async function fetchChannelItems(channel, { author = '', retries = 2 } = {}) {
  const channelId = channel.youtubeChannelId;
  try {
    const feed = await withRetry(() => parser.parseURL(feedUrlFor(channelId)), {
      attempts: retries,
      label: `RSS ${channelId}`,
    });
    if (feed.items && feed.items.length) {
      return { items: feed.items, source: 'rss', feed };
    }
    return { items: [], source: 'rss', feed };
  } catch (err) {
    console.warn(`[feed] RSS unavailable (${err.message}) — using innertube fallback.`);
  }

  try {
    const items = await withRetry(
      () => innertubeItems(channelId, { author: author || channel.channelName || '' }),
      { attempts: retries, label: `innertube ${channelId}` }
    );
    return { items, source: 'innertube' };
  } catch (err) {
    throw new Error(`all feed sources failed: ${err.message}`);
  }
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
 * Resolve the {%VAR_EXTENDED%} slot from channel.extendedRules.
 * Each rule: { match (regex), text, playlistId? } — first match wins,
 * no match renders as ''. Invalid regexes are logged and skipped, never throw.
 */
function resolveExtended(videoData, haystack, settings) {
  if (!settings || !Array.isArray(settings.extendedRules)) return '';
  for (const rule of settings.extendedRules) {
    if (!rule || !rule.match) continue;
    let re;
    try {
      // Ignore g/y flags here: RegExp.test() with a global/sticky regex is
      // stateful (lastIndex advances between videos), so the same rule would
      // match different videos from run to run.
      const flags = String(rule.flags || 'i').replace(/[gy]/g, '');
      re = new RegExp(rule.match, flags);
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
 * Format a message from a channel's messaging settings and video metadata.
 * All messaging settings (messageTemplate, shorts/live templates + suffixes,
 * customKeywordRules, extendedRules) live on the channel object only.
 * When the channel has no messageTemplate (missing or empty string),
 * the fallback is the bare YouTube video URL.
 *
 * Supported variables: {%VAR_URL%}, {%VAR_TITLE%}, {%VAR_CHANNEL%},
 *   {%VAR_DATE%}, {%VAR_ID%}, {%VAR_EXTENDED%} (extendedRules slot),
 *   {%VAR_PLAYLIST_URL%} (inside a rule tied to a playlistId).
 *
 * Precedence:
 *   1. base template (shorts/live override when matched)
 *   2. {%VAR_EXTENDED%} resolved from channel extendedRules (first match wins)
 *   3. all variables replaced
 *   4. shorts/live suffix appended (when no dedicated template)
 *   5. legacy channel customKeywordRules applied last: [{ keyword, suffix, template? }]
 *
 * @param {object} channel channel entry from config.json (messaging source)
 * @param {object} videoData { id, title, link, pubDate, author, description, channelName }
 * @returns {string}
 */
function formatMessage(channel, videoData) {
  const {
    title = '',
    link = '',
    description = '',
  } = videoData;
  const settings = channel || {};

  // Fallback: URL only.
  if (!settings.messageTemplate) {
    return link;
  }

  let base = settings.messageTemplate;

  const haystack = `${title}\n${description}`.toLowerCase();
  const isShort =
    haystack.includes('#shorts') || (typeof link === 'string' && link.includes('/shorts/'));
  // Word boundaries prevent false positives like "deliver", "olive", "arrive".
  const isLive =
    /\b(live|premiere|livestream)\b/i.test(haystack) || haystack.includes('🔴');

  // Channel-type conditional templates.
  if (isShort && typeof settings.shortsTemplate === 'string' && settings.shortsTemplate) {
    base = settings.shortsTemplate;
  } else if (isLive && typeof settings.liveTemplate === 'string' && settings.liveTemplate) {
    base = settings.liveTemplate;
  }

  const extended = resolveExtended(videoData, haystack, settings);
  let message = fillTemplate(base, videoData, { extended });

  // Default suffixes when no dedicated template was used.
  if (isShort && !(settings.shortsTemplate && base === settings.shortsTemplate)) {
    message += settings.shortsSuffix ?? ' ⚡ (#Shorts)';
  } else if (isLive && !(settings.liveTemplate && base === settings.liveTemplate)) {
    message += settings.liveSuffix ?? ' 🔴 (Live/Premiere)';
  }

  // Custom keyword rules from the channel.
  if (Array.isArray(settings.customKeywordRules)) {
    for (const rule of settings.customKeywordRules) {
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

  // Messaging lives on channels[] now — top-level leftovers are ignored.
  for (const key of ['messageTemplate', 'shortsTemplate', 'liveTemplate', 'shortsSuffix', 'liveSuffix', 'customKeywordRules', 'extendedRules']) {
    if (config[key] !== undefined) {
      warnings.push(`top-level "${key}" is ignored — move messaging settings into each channels[] entry`);
    }
  }
  const checkDigest = (where, digest) => {
    if (digest === undefined || digest === null) return;
    if (typeof digest !== 'object' || Array.isArray(digest)) {
      warnings.push(`${where}: digest must be an object { enabled, hour, separator? }`);
      return;
    }
    if (digest.enabled !== undefined && typeof digest.enabled !== 'boolean') {
      warnings.push(`${where}: digest.enabled must be true/false`);
    }
    if (digest.hour !== undefined && !(Number.isInteger(digest.hour) && digest.hour >= 0 && digest.hour <= 23)) {
      warnings.push(`${where}: digest.hour must be 0-23 (default 8)`);
    }
    if (digest.separator !== undefined && typeof digest.separator !== 'string') {
      warnings.push(`${where}: digest.separator must be a string`);
    }
  };

  // Human timing: global block, then per-channel overrides.
  const checkTiming = (where, timing) => {
    if (!timing || typeof timing !== 'object') return;
    for (const [key, value] of Object.entries(timing)) {
      if (!(key in HUMAN_TIMING_DEFAULTS)) {
        warnings.push(`${where}: unknown humanTiming setting "${key}" (ignored)`);
        continue;
      }
      if (key === 'enabled') {
        if (typeof value !== 'boolean') {
          warnings.push(`${where}: humanTiming.enabled must be true/false`);
        }
        continue;
      }
      if (typeof value !== 'number' || value < 0) {
        warnings.push(`${where}: humanTiming.${key} must be a non-negative number`);
      }
    }
  };
  checkTiming('humanTiming', config.humanTiming);
  const checkQuiet = (where, window) => {
    if (!window) return;
    if (!window.start || !window.end || parseClock(window.start) === null || parseClock(window.end) === null) {
      warnings.push(`${where}: quietHours must use "HH:MM" start/end (e.g. "22:00" -> "07:00")`);
    }
  };
  checkQuiet('quietHours', config.quietHours);
  if (config.feedRetries !== undefined && !(Number.isInteger(config.feedRetries) && config.feedRetries > 0)) {
    warnings.push('feedRetries must be a positive integer (default 2)');
  }
  if (config.maxPostedIdsPerChannel !== undefined && !(Number.isInteger(config.maxPostedIdsPerChannel) && config.maxPostedIdsPerChannel > 0)) {
    warnings.push('maxPostedIdsPerChannel must be a positive integer (default 500)');
  }
  if (config.adminJids !== undefined && !(Array.isArray(config.adminJids) && config.adminJids.every((j) => typeof j === 'string'))) {
    warnings.push('adminJids must be an array of WhatsApp JIDs (strings)');
  }
  if (config.statusGroupJids !== undefined && !(Array.isArray(config.statusGroupJids) && config.statusGroupJids.every((j) => typeof j === 'string'))) {
    warnings.push('statusGroupJids must be an array of WhatsApp JIDs (strings)');
  }
  if (config.statusHour !== undefined && !(Number.isInteger(config.statusHour) && config.statusHour >= 0 && config.statusHour <= 23)) {
    warnings.push('statusHour must be 0-23 (default 21)');
  }
  if (config.watchdog !== undefined && config.watchdog !== null) {
    const w = config.watchdog;
    if (typeof w !== 'object' || Array.isArray(w)) {
      warnings.push('watchdog must be an object { enabled, restartDelayMs, maxRestarts, alertOnEvents }');
    } else {
      if (w.enabled !== undefined && typeof w.enabled !== 'boolean') warnings.push('watchdog.enabled must be true/false');
      if (w.alertOnEvents !== undefined && typeof w.alertOnEvents !== 'boolean') warnings.push('watchdog.alertOnEvents must be true/false');
      if (w.restartDelayMs !== undefined && !(typeof w.restartDelayMs === 'number' && w.restartDelayMs >= 0)) warnings.push('watchdog.restartDelayMs must be a non-negative number');
      if (w.maxRestarts !== undefined && !(Number.isInteger(w.maxRestarts) && w.maxRestarts >= 0)) warnings.push('watchdog.maxRestarts must be a non-negative integer');
    }
  }
  (config.channels || []).forEach((ch, i) => {
    if (!ch) return;
    checkTiming(`channels[${i}].humanTiming`, ch.humanTiming);
    checkQuiet(`channels[${i}].quietHours`, ch.quietHours);
    if (ch.enabled !== undefined && typeof ch.enabled !== 'boolean') {
      warnings.push(`channels[${i}]: enabled must be true/false`);
    }
  });

  (config.channels || []).forEach((ch, i) => {
    const label = `channels[${i}]${ch && ch.channelName ? ` (${ch.channelName})` : ''}`;
    if (!ch || !ch.youtubeChannelId) {
      warnings.push(`${label}: missing youtubeChannelId`);
    } else if (!/^UC[\w-]{16,}$/.test(ch.youtubeChannelId)) {
      warnings.push(`${label}: youtubeChannelId looks invalid: ${ch.youtubeChannelId}`);
    }
    for (const entry of (ch && ch.targetGroupJids) || []) {
      const group = entry && typeof entry === 'object' ? entry : { jid: entry };
      if (!group.jid || !/@(g|c)\.us$/.test(group.jid)) {
        warnings.push(`${label}: target JID looks invalid: ${JSON.stringify(entry)}`);
      }
      if (group.language !== undefined && typeof group.language !== 'string') {
        warnings.push(`${label}: group language must be a string (e.g. "he" / "en")`);
      }
      if (group.language && ch.languageTemplates && !ch.languageTemplates[group.language]) {
        warnings.push(`${label}: no languageTemplates entry for "${group.language}"`);
      }
      checkDigest(`${label} target ${group.jid}`, group.digest);
    }
    if (ch.languageTemplates !== undefined) {
      if (!ch.languageTemplates || typeof ch.languageTemplates !== 'object' || Array.isArray(ch.languageTemplates)) {
        warnings.push(`${label}: languageTemplates must be an object keyed by language code`);
      } else {
        for (const [lang, tpl] of Object.entries(ch.languageTemplates)) {
          if (!tpl || typeof tpl !== 'object') {
            warnings.push(`${label}: languageTemplates.${lang} must be an object`);
            continue;
          }
          for (const key of ['messageTemplate', 'shortsTemplate', 'liveTemplate', 'shortsSuffix', 'liveSuffix']) {
            checkTokens(`${label}.languageTemplates.${lang}.${key}`, tpl[key]);
          }
        }
      }
    }
    if (!ch) return;
    if (!ch.messageTemplate) {
      warnings.push(`${label}: no messageTemplate — messages fall back to the bare video URL`);
    }
    if (ch.checkIntervalMinutes !== undefined && !(typeof ch.checkIntervalMinutes === 'number' && ch.checkIntervalMinutes > 0)) {
      warnings.push(`${label}: checkIntervalMinutes must be a positive number (global used instead)`);
    }
    if (ch.maxVideosPerDay !== undefined && ch.maxVideosPerDay !== null && !(Number.isInteger(ch.maxVideosPerDay) && ch.maxVideosPerDay > 0)) {
      warnings.push(`${label}: maxVideosPerDay must be a positive integer or omitted (unlimited)`);
    }
    if (ch.preferredKeywords !== undefined && !(Array.isArray(ch.preferredKeywords) && ch.preferredKeywords.every((k) => typeof k === 'string'))) {
      warnings.push(`${label}: preferredKeywords must be an array of strings`);
    }
    if (ch.excludeKeywords !== undefined && !(Array.isArray(ch.excludeKeywords) && ch.excludeKeywords.every((k) => typeof k === 'string'))) {
      warnings.push(`${label}: excludeKeywords must be an array of strings`);
    }
    checkDigest(`${label}.digest`, ch.digest);
    if (ch.sendOrder !== undefined && ch.sendOrder !== 'latest' && ch.sendOrder !== 'unsent') {
      warnings.push(`${label}: sendOrder must be "latest" or "unsent" (default "unsent")`);
    }
    if (ch.latestCount !== undefined && !(Number.isInteger(ch.latestCount) && ch.latestCount > 0)) {
      warnings.push(`${label}: latestCount must be a positive integer (default 3)`);
    }
    checkTokens(`${label}.messageTemplate`, ch.messageTemplate);
    checkTokens(`${label}.shortsTemplate`, ch.shortsTemplate);
    checkTokens(`${label}.liveTemplate`, ch.liveTemplate);
    checkTokens(`${label}.shortsSuffix`, ch.shortsSuffix);
    checkTokens(`${label}.liveSuffix`, ch.liveSuffix);
    (ch.customKeywordRules || []).forEach((r, j) => {
      checkTokens(`${label}.customKeywordRules[${j}].template`, r && r.template);
      checkTokens(`${label}.customKeywordRules[${j}].suffix`, r && r.suffix);
    });
    (ch.extendedRules || []).forEach((r, j) => {
      if (!r || !r.match) {
        warnings.push(`${label}.extendedRules[${j}]: missing "match" regex (rule ignored)`);
        return;
      }
      try {
        new RegExp(r.match, r.flags || 'i');
      } catch (err) {
        warnings.push(`${label}.extendedRules[${j}]: invalid regex ${JSON.stringify(r.match)}: ${err.message} (rule skipped at runtime)`);
      }
      checkTokens(`${label}.extendedRules[${j}].text`, r.text);
    });
  });
  return warnings;
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

/**
 * Digest delivery: queue formatted videos and flush once at digest.hour.
 * State lives in digest_queue.json so restarts don't lose pending videos.
 */
/** Send one message to one target with human-like typing delay. */
async function sendToTarget(client, jid, message, timing, label) {
  const wait = typingDelayMs(message, timing);
  if (wait > 0) {
    console.log(`[${label}] Typing delay ${(wait / 1000).toFixed(1)}s before ${jid}...`);
    await sleep(wait);
  }
  try {
    await client.sendMessage(jid, message);
    console.log(`[${label}] Sent -> ${jid}`);
    return true;
  } catch (err) {
    console.error(`[${label}] Send failed -> ${jid}:`, err.message);
    return false;
  }
}

/** Add one formatted video to a group's digest queue. */
async function queueDigestEntry(channel, group, settings, videoData, label) {
  const key = digestKey(channel.youtubeChannelId, group.jid);
  const queue = loadDigestQueue();
  if (!Array.isArray(queue[key])) queue[key] = [];
  if (queue[key].some((e) => e.id === videoData.id)) return;
  let text;
  try {
    text = formatMessage(settings, videoData);
  } catch (err) {
    console.error(`[${label}] digest format failed for ${videoData.id}:`, err.message);
    return;
  }
  queue[key].push({ id: videoData.id, text, queuedAt: new Date().toISOString() });
  if (queue[key].length > 100) queue[key] = queue[key].slice(-100);
  saveDigestQueue(queue);
  bumpStat(channel.youtubeChannelId, 'queued');
  console.log(`[${label}] Digest queued ${videoData.id} for ${group.jid} (${queue[key].length} pending).`);
}

/** Flush one group's digest when its hour has arrived. */
async function flushGroupDigest(client, channel, group, settings, config, posted, dailyCounts, label) {
  const digest = settings.digest;
  const key = digestKey(channel.youtubeChannelId, group.jid);
  const queue = loadDigestQueue();
  const items = queue[key] || [];
  if (items.length === 0) return;

  const hour = Number.isInteger(digest.hour) ? digest.hour : 8;
  if (new Date().getHours() < hour) return;

  const max = channel.maxVideosPerDay;
  const remaining = max
    ? Math.max(0, max - sentTodayCount(channel.youtubeChannelId, dailyCounts))
    : items.length;
  if (remaining === 0) {
    console.log(`[${label}] Digest for ${group.jid}: daily cap (${max}) reached — deferring ${items.length} queued.`);
    return;
  }
  // Send only what the cap allows; keep the rest queued for the next window.
  const toSend = items.slice(0, remaining);
  const count = toSend.length;

  const combined = toSend.map((e) => e.text).join(digest.separator || '\n\n');
  const ok = await sendToTarget(client, group.jid, combined, resolveHumanTiming(settings, config), label);

  if (ok) {
    const seen = new Set(posted[channel.youtubeChannelId] || []);
    for (const entry of toSend) seen.add(entry.id);
    posted[channel.youtubeChannelId] = [...seen];
    prunePostedIds(posted, channel.youtubeChannelId, config.maxPostedIdsPerChannel);
    savePosted(posted);
    const sentIds = new Set(toSend.map((e) => e.id));
    queue[key] = items.filter((e) => !sentIds.has(e.id));
    saveDigestQueue(queue);
    for (let i = 0; i < count; i++) recordSend(channel.youtubeChannelId, dailyCounts);
    saveDailyCounts(dailyCounts);
    bumpStat(channel.youtubeChannelId, 'sent', count);
    console.log(`[${label}] Digest flushed ${count} video(s) -> ${group.jid} (${queue[key].length} left queued)`);
  } else {
    bumpStat(channel.youtubeChannelId, 'failed', count);
  }
}

async function checkChannel(client, channel, config, posted, dailyCounts) {
  const channelKey = channel.youtubeChannelId;
  const channelLabel = channel.channelName || channelKey;

  // Quiet hours: defer sending (state stays untouched, retried on next tick).
  if (isQuietTime(channel, config)) {
    console.log(`[${channelLabel}] Quiet hours — skipping check.`);
    return;
  }

  try {
    const { items, source, feed } = await fetchChannelItems(channel, {
      author: channel.channelName || '',
      retries: Number.isInteger(config.feedRetries) && config.feedRetries > 0
        ? config.feedRetries
        : 2,
    });
    const feedMeta = feed || { title: channel.channelName || '' };

    if (items.length === 0) {
      console.log(`[${channelLabel}] Feed empty, nothing to do.`);
      return;
    }
    if (source !== 'rss') {
      console.log(`[${channelLabel}] Feed source: ${source}.`);
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

    const freshNewestFirst = ordered
      .filter((item) => !seen.has(getVideoId(item)))
      .reverse()
      .map((item) => ({ item, videoData: buildVideoData(item, feedMeta, channel) }));

    if (freshNewestFirst.length === 0) {
      console.log(`[${channelLabel}] No new videos.`);
      return;
    }

    const { send, skip } = selectVideosToSend(freshNewestFirst, channel);

    // Preferred-filter skips are intentionally dropped (recorded, never sent).
    if (skip.length > 0) {
      for (const entry of skip) seen.add(entry.videoData.id);
      posted[channelKey] = [...seen];
      prunePostedIds(posted, channelKey, config.maxPostedIdsPerChannel);
      savePosted(posted);
      console.log(`[${channelLabel}] Skipped ${skip.length} filtered video(s).`);
    }

    const groups = normalizeGroups(channel);
    ensureStatsDay();
    bumpStat(channelKey, 'seen', freshNewestFirst.length);
    if (skip.length > 0) bumpStat(channelKey, 'skipped', skip.length);

    console.log(
      `[${channelLabel}] Found ${freshNewestFirst.length} new video(s), delivering ${send.length} ` +
        `to ${groups.length} target(s) (order: ${channel.sendOrder || 'unsent'}).`
    );

    for (const { videoData } of send) {
      const videoId = videoData.id;
      let handled = false;

      for (const group of groups) {
        const settings = groupSettings(channel, group);
        const groupTiming = resolveHumanTiming(settings, config);

        // Per-group digest: queue here, flush later at this group's hour.
        if (settings.digest && settings.digest.enabled) {
          await queueDigestEntry(channel, group, settings, videoData, channelLabel);
          handled = true;
          continue;
        }

        if (!canSendToday(channel, dailyCounts)) {
          console.log(`[${channelLabel}] Daily cap reached (${channel.maxVideosPerDay}/day) — skipping ${group.jid}.`);
          continue;
        }

        let message;
        try {
          message = formatMessage(settings, videoData);
        } catch (err) {
          console.error(`[${channelLabel}] formatMessage failed for ${videoId}:`, err.message);
          continue;
        }

        const ok = await sendToTarget(client, group.jid, message, groupTiming, channelLabel);
        if (ok) {
          recordSend(channelKey, dailyCounts);
          saveDailyCounts(dailyCounts);
          bumpStat(channelKey, 'sent');
        } else {
          bumpStat(channelKey, 'failed');
        }
        const gap = betweenSendsDelayMs(groupTiming);
        if (gap > 0) await sleep(gap);
        handled = true;
      }

      // Persist immediately so a crash doesn't re-send.
      if (handled) {
        seen.add(videoId);
        posted[channelKey] = [...seen];
        prunePostedIds(posted, channelKey, config.maxPostedIdsPerChannel);
        try {
          savePosted(posted);
        } catch (err) {
          console.error('[posted] Failed to save posted_videos.json:', err.message);
        }
      }
    }

    // Digest groups may have different hours — flush each due queue.
    for (const group of groups) {
      const settings = groupSettings(channel, group);
      if (settings.digest && settings.digest.enabled) {
        await flushGroupDigest(client, channel, group, settings, config, posted, dailyCounts, channelLabel);
      }
    }
  } catch (err) {
    // Single channel/network failure must not crash the bot.
    console.error(`[${channelLabel}] Feed check failed:`, err.message);
  }
}

/**
 * Check every channel whose per-channel interval has elapsed.
 * With { force: true } all channels are checked regardless (used at startup).
 */
let isChecking = false; // prevents overlapping ticker runs from double-sending

async function checkDueChannels(client, config, posted, dailyCounts, lastCheck, { force = false } = {}) {
  if (isChecking) {
    console.log('[check] Previous check still running — skipping this tick.');
    return;
  }
  isChecking = true;
  const started = Date.now();
  console.log(`[check] Ticker at ${new Date().toISOString()} ...`);
  try {
    // Sequential per channel = gentler on rate limits than Promise.all.
    let anyDue = false;
    for (const channel of config.channels) {
      if (channel.enabled === false) {
        console.log(`[${channel.channelName || channel.youtubeChannelId}] Disabled — skipping.`);
        continue;
      }
      const last = lastCheck[channel.youtubeChannelId] || 0;
      if (!force && Date.now() - last < intervalFor(channel, config)) {
        continue;
      }
      anyDue = true;
      // Mark before the (potentially slow) check so a long run can't be
      // re-triggered by the ticker; the guard above is the real protection.
      lastCheck[channel.youtubeChannelId] = Date.now();
      await checkChannel(client, channel, config, posted, dailyCounts);
      // Small gap between channels (skip after the last one).
      if (config.channels.indexOf(channel) < config.channels.length - 1) {
        await sleep(randomDelayMs(1500, 3000));
      }
    }
    console.log(anyDue
      ? `[check] Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`
      : '[check] Nothing due.');
  } finally {
    isChecking = false;
  }
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
  const dailyCounts = loadDailyCounts();
  const lastCheck = {};
  setLastCheckProvider((id) => lastCheck[id] || 0);
  const statusState = loadStatusState();
  let restartCount = 0;
  let restartTimer = null;

  // Dry run: exercise the REAL bot logic with a fake sender, no WhatsApp
  // client at all. Safe for QA — nothing is actually delivered.
  if (process.argv.includes('--dry-run')) {
    dryRun = true;
    console.log('[dry-run] No WhatsApp connection — messages printed, state files untouched.');
    const dryClient = {
      sendMessage: async (jid, message) => {
        console.log(`[DRY-RUN SEND -> ${jid}]\n${message}\n${'-'.repeat(60)}`);
      },
    };
    checkDueChannels(dryClient, config, posted, dailyCounts, {}, { force: true })
      .catch((err) => console.error('[dry-run] Failed:', err.message))
      .finally(() => process.exit(0));
    return;
  }

  const chromePath = findLocalChrome();
  const client = new Client({
    authStrategy: new LocalAuth(), // persists session to .wwebjs_auth/
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(chromePath ? { executablePath: chromePath } : {}),
    },
  });

  const alertAdmins = async (text) => {
    const watchdog = config.watchdog || {};
    if (watchdog.alertOnEvents === false) return;
    for (const jid of (config.adminJids || [])) {
      try {
        await client.sendMessage(jid, text);
      } catch (err) {
        console.error(`[alert] Failed to notify ${jid}:`, err.message);
      }
    }
  };

  const publishStatus = () => {
    try {
      const report = buildStatusReport(config, posted, dailyCounts);
      writeStatusFile(report);
      return report;
    } catch (err) {
      console.error('[status] Failed to write status.json:', err.message);
      return null;
    }
  };

  const maybeSendScheduledStatus = () => {
    const hour = Number.isInteger(config.statusHour) ? config.statusHour : 21;
    const now = new Date();
    if (now.getHours() < hour) return;
    const key = todayKey(now);
    if (statusState.date === key) return;
    const report = publishStatus();
    if (!report) return;
    const message = formatStatusReport(report);
    for (const jid of (config.statusGroupJids || [])) {
      client.sendMessage(jid, message)
        .then(() => console.log(`[status] Report sent -> ${jid}`))
        .catch((err) => console.error(`[status] Report failed -> ${jid}:`, err.message));
    }
    statusState.date = key;
    try { saveStatusState(statusState); } catch (err) { console.error('[status] Failed to save state:', err.message); }
  };

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

  // Admin commands, from config.adminJids only. Pause/resume/reload are
  // in-memory (reset on restart); state files are never touched here.
  client.on('message', async (msg) => {
    try {
      const admins = Array.isArray(config.adminJids) ? config.adminJids : [];
      if (!admins.includes(msg.from)) return;
      const text = String(msg.body || '').trim();
      if (!text.startsWith('/')) return;
      const [cmd, ...args] = text.split(/\s+/);
      const term = args.join(' ').trim().toLowerCase();

      if (cmd === '/help') {
        await msg.reply('Commands:\n/status\n/pause [channel]\n/resume [channel]\n/reload\n/help');
        return;
      }
      if (cmd === '/reload') {
        config = loadConfig();
        await msg.reply(`[admin] Config reloaded: ${config.channels.length} channel(s).`);
        console.log('[admin] Config reloaded via WhatsApp command.');
        return;
      }
      if (cmd === '/status') {
        const report = buildStatusReport(config, posted, dailyCounts);
        await msg.reply(formatStatusReport(report));
        return;
      }
      if (cmd === '/pause' || cmd === '/resume') {
        const target = config.channels.find((ch) =>
          !term || (ch.channelName || '').toLowerCase().includes(term) || ch.youtubeChannelId.toLowerCase().includes(term)
        );
        if (!target) {
          await msg.reply(`[admin] No channel matching "${term}".`);
          return;
        }
        target.enabled = cmd === '/resume';
        await msg.reply(`[admin] ${target.channelName || target.youtubeChannelId} ${target.enabled ? 'resumed' : 'paused'} (in-memory until restart).`);
        console.log(`[admin] Channel ${target.youtubeChannelId} ${target.enabled ? 'resumed' : 'paused'}.`);
        return;
      }
    } catch (err) {
      console.error('[admin] Command failed:', err.message);
    }
  });

  client.on('ready', async () => {
    restartCount = 0;
    console.log('[ready] WhatsApp client is ready.');
    for (const channel of config.channels) {
      const groups = normalizeGroups(channel);
      const everyMin = (channel.checkIntervalMinutes ?? config.checkIntervalMinutes);
      console.log(
        `[ready] Watching ${channel.channelName || channel.youtubeChannelId}: every ${everyMin} minute(s), ` +
          `${groups.length} target(s).`
      );
    }

    // Immediate full check, then a 1-minute ticker that checks due channels,
    // refreshes status.json and sends the scheduled status report.
    await checkDueChannels(client, config, posted, dailyCounts, lastCheck, { force: true });
    publishStatus();
    maybeSendScheduledStatus();

    setInterval(() => {
      checkDueChannels(client, config, posted, dailyCounts, lastCheck)
        .catch((err) => console.error('[check] Unexpected error:', err.message))
        .finally(() => {
          publishStatus();
          maybeSendScheduledStatus();
        });
    }, 60 * 1000);
  });

  client.on('disconnected', (reason) => {
    console.error('[client] Disconnected:', reason);
    alertAdmins(`⚠️ החיזוק השבועי: התנתקות מהוואטסאפ — ${reason}`);

    const watchdog = config.watchdog || {};
    if (watchdog.enabled === false) return;
    const maxRestarts = Number.isInteger(watchdog.maxRestarts) ? watchdog.maxRestarts : 5;
    const delay = typeof watchdog.restartDelayMs === 'number' && watchdog.restartDelayMs >= 0
      ? watchdog.restartDelayMs
      : 5000;

    if (restartCount >= maxRestarts) {
      console.error('[watchdog] Restart limit reached — manual intervention needed.');
      alertAdmins('🚨 החיזוק השבועי: מיצינו את ניסיונות החיבור מחדש — נדרשת התערבות.');
      return;
    }
    clearTimeout(restartTimer);
    restartTimer = setTimeout(async () => {
      restartCount++;
      console.log(`[watchdog] Reinitializing client (attempt ${restartCount}/${maxRestarts})...`);
      try {
        await client.initialize();
      } catch (err) {
        console.error('[watchdog] Reinit failed:', err.message);
      }
    }, delay);
  });

  client.initialize().catch((err) => {
    console.error('Failed to initialize WhatsApp client:', err);
    process.exit(1);
  });
}

// Export for testing and for the PoC scripts.
module.exports = {
  formatMessage, getVideoId, feedUrlFor, randomDelayMs, buildVideoData,
  loadPosted, savePosted, validateConfig, playlistUrlFor, KNOWN_TOKENS,
  intervalFor, selectVideosToSend, loadDailyCounts, saveDailyCounts,
  canSendToday, recordSend, todayKey, sentTodayCount, checkChannel,
  typingDelayMs, betweenSendsDelayMs, resolveHumanTiming, HUMAN_TIMING_DEFAULTS,
  fetchChannelItems, innertubeItems,
  isQuietTime, parseClock, prunePostedIds, withRetry, checkDueChannels,
  loadDigestQueue, saveDigestQueue, digestKey, normalizeGroups, groupSettings,
  getStats, bumpStat, ensureStatsDay, buildStatusReport, formatStatusReport,
  writeStatusFile, loadStatusState, saveStatusState, setLastCheckProvider,
  STATUS_PATH, STATUS_STATE_PATH,
};

if (require.main === module) {
  // Mirror console output to bot.log (1 MB rotation) for unattended runs.
  const LOG_PATH = path.join(__dirname, 'bot.log');
  const appendLog = (level, parts) => {
    try {
      if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 1024 * 1024) {
        try { fs.renameSync(LOG_PATH, path.join(__dirname, 'bot.log.1')); } catch (_) {}
      }
      const stamp = new Date().toISOString();
      const line = `[${stamp}] [${level}] ${parts.map((p) => (p && p.stack) || String(p)).join(' ')}\n`;
      fs.appendFileSync(LOG_PATH, line, 'utf-8');
    } catch (_) {
      // Logging must never break the bot.
    }
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...parts) => {
      original(...parts);
      appendLog(level, parts);
    };
  }

  // Never die silently from an unhandled async error.
  process.on('unhandledRejection', (err) => {
    console.error('[fatal] Unhandled promise rejection:', err && err.message ? err.message : err);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] Uncaught exception:', err && err.message ? err.message : err);
  });
  main();
}
