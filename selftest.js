/**
 * Offline self-test for the bot's pure logic — no network, no WhatsApp.
 * Run: npm test   (or: node --test selftest.js)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatMessage, getVideoId, validateConfig, selectVideosToSend,
  typingDelayMs, betweenSendsDelayMs, resolveHumanTiming,
  isQuietTime, parseClock, prunePostedIds, intervalFor,
  canSendToday, recordSend, sentTodayCount, HUMAN_TIMING_DEFAULTS,
  loadDigestQueue, saveDigestQueue,
} = require('./index.js');
const fs = require('node:fs');
const path = require('node:path');

const V = (id, title, desc = '') => ({
  videoData: { id, title, link: `https://www.youtube.com/watch?v=${id}`, pubDate: '', author: '', description: desc, channelName: 'Ch' },
});

test('getVideoId handles RSS, innertube and links', () => {
  assert.equal(getVideoId({ id: 'yt:video:abc12345678' }), 'abc12345678');
  assert.equal(getVideoId({ link: 'https://www.youtube.com/watch?v=xyz12345678' }), 'xyz12345678');
  assert.equal(getVideoId({ link: 'nonsense', title: 'fallback' }), 'nonsense'); // last resort: link as key
});

test('formatMessage: fallback is bare URL, tokens resolve', () => {
  const v = V('abc', 'My Title');
  assert.equal(formatMessage({}, v.videoData), v.videoData.link);
  assert.equal(formatMessage({ messageTemplate: '' }, v.videoData), v.videoData.link);
  const ch = { messageTemplate: '{%VAR_TITLE%} - {%VAR_ID%} {%VAR_URL%}' };
  assert.equal(formatMessage(ch, v.videoData), 'My Title - abc https://www.youtube.com/watch?v=abc');
});

test('formatMessage: live detection does not match deliver/olive', () => {
  const mk = (title) => ({ messageTemplate: '{%VAR_TITLE%}', liveSuffix: ' [LIVE]' });
  const delivered = formatMessage(mk(), V('1', 'Delivering the olive').videoData);
  assert.ok(!delivered.includes('[LIVE]'), delivered);
  const live = formatMessage(mk(), V('2', 'Live now with guests').videoData);
  assert.ok(live.includes('[LIVE]'), live);
});

test('formatMessage: extendedRules with g flag are not stateful', () => {
  const ch = {
    messageTemplate: 'T {%VAR_EXTENDED%}',
    extendedRules: [{ match: 'parsha', flags: 'gi', text: 'PARSHA' }],
  };
  for (let i = 0; i < 10; i++) {
    assert.equal(formatMessage(ch, V(String(i), 'Parsha this week').videoData), 'T PARSHA');
  }
});

test('selectVideosToSend: unsent / latest / preferred', () => {
  const newest = [V('n3', 'third'), V('n2', 'second'), V('n1', 'first')];
  assert.deepEqual(selectVideosToSend(newest, {}).send.map((v) => v.videoData.id), ['n1', 'n2', 'n3']);
  const latest = selectVideosToSend(newest, { sendOrder: 'latest', latestCount: 2 });
  assert.deepEqual(latest.send.map((v) => v.videoData.id), ['n3', 'n2']);
  assert.deepEqual(latest.skip.map((v) => v.videoData.id), ['n1']);
  const pref = selectVideosToSend(newest, { preferredKeywords: ['second'] });
  assert.deepEqual(pref.send.map((v) => v.videoData.id), ['n2']);
  assert.equal(pref.skip.length, 2);
  assert.equal(selectVideosToSend(newest, { preferredKeywords: ['zzz'] }).send.length, 3);
});

test('excludeKeywords blocks videos even when preferred matches', () => {
  const newest = [V('a', 'This week giveaway'), V('b', 'This week shiur')];
  const ch = { preferredKeywords: ['this week'], excludeKeywords: ['giveaway'] };
  const r = selectVideosToSend(newest, ch);
  assert.deepEqual(r.send.map((v) => v.videoData.id), ['b']);
  assert.deepEqual(r.skip.map((v) => v.videoData.id), ['a']);
});

test('digest queue round-trips through a file', () => {
  const file = path.join(__dirname, '_selftest_digest.json');
  try {
    const data = { c: [{ id: 'x', text: 'hello', queuedAt: '2026-01-01T00:00:00.000Z' }] };
    saveDigestQueue(data, file);
    assert.deepEqual(loadDigestQueue(file), data);
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('human timing: bounded, randomized, overridable, disabled', () => {
  for (let i = 0; i < 100; i++) {
    const d = typingDelayMs('b'.repeat(80));
    assert.ok(d >= 400 && d <= 20000, `out of range: ${d}`);
  }
  const distinct = new Set(Array.from({ length: 20 }, () => typingDelayMs('short message')));
  assert.ok(distinct.size > 10, 'delays should be randomized');
  assert.equal(typingDelayMs('long text', { enabled: false }), 0);
  assert.equal(betweenSendsDelayMs({ enabled: false }), 0);
  const t = resolveHumanTiming({ humanTiming: { msPerChar: 5 } }, { humanTiming: { msPerChar: 50 } });
  assert.equal(t.msPerChar, 5);
  assert.equal(t.msPerWord, HUMAN_TIMING_DEFAULTS.msPerWord);
});

test('quiet hours: normal and overnight windows', () => {
  assert.equal(parseClock('22:30'), 1350);
  assert.equal(parseClock('25:00'), null);
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  const night = { start: '22:00', end: '07:00' };
  assert.equal(isQuietTime({ quietHours: night }, {}, at(23, 0)), true);
  assert.equal(isQuietTime({ quietHours: night }, {}, at(3, 0)), true);
  assert.equal(isQuietTime({ quietHours: night }, {}, at(12, 0)), false);
  const day = { quietHours: { start: '09:00', end: '17:00' } };
  assert.equal(isQuietTime({}, day, at(10, 0)), true);
  assert.equal(isQuietTime({}, day, at(20, 0)), false);
  assert.equal(isQuietTime({ quietHours: null }, day, at(10, 0)), false);
});

test('prunePostedIds keeps only the newest IDs', () => {
  const posted = { c: Array.from({ length: 10 }, (_, i) => `id${i}`) };
  prunePostedIds(posted, 'c', 3);
  assert.deepEqual(posted.c, ['id7', 'id8', 'id9']);
  prunePostedIds(posted, 'c', 500);
  assert.equal(posted.c.length, 3);
});

test('daily cap counts and stops', () => {
  const ch = { youtubeChannelId: 'UCtest', maxVideosPerDay: 1 };
  const counts = {};
  assert.equal(canSendToday(ch, counts), true);
  recordSend('UCtest', counts);
  assert.equal(canSendToday(ch, counts), false);
  assert.equal(sentTodayCount('UCtest', counts), 1);
  assert.equal(canSendToday({ youtubeChannelId: 'UCtest' }, counts), true);
});

test('intervalFor: channel override, global fallback, invalid fallback', () => {
  assert.equal(intervalFor({ checkIntervalMinutes: 30 }, { checkIntervalMinutes: 15 }), 1800000);
  assert.equal(intervalFor({}, { checkIntervalMinutes: 15 }), 900000);
  assert.equal(intervalFor({ checkIntervalMinutes: -1 }, { checkIntervalMinutes: 15 }), 900000);
});

test('validateConfig: real config clean; bad fields warned', () => {
  assert.deepEqual(validateConfig(require('./config.json')), []);
  const bad = {
    checkIntervalMinutes: 15,
    feedRetries: -1,
    quietHours: { start: '99:99', end: '10:00' },
    channels: [{
      channelName: 'X', youtubeChannelId: 'bad', targetGroupJids: ['bad@xx'],
      enabled: 'yes', quietHours: { start: 'nope', end: 'noon' },
      preferredKeywords: 'not-an-array', sendOrder: 'random',
      extendedRules: [{ match: '([', text: 'x' }],
    }],
  };
  const warnings = validateConfig(bad);
  assert.ok(warnings.length >= 8, warnings.join('\n'));
});
