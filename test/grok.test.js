const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { collectGrok, normalizeRateLimits, windowLabel, RATE_LIMITS_URL } = require('../src/collectors/grok');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'grok-rate-limits.json'), 'utf8'));
const NOW = Date.parse('2026-08-20T12:00:00Z');
const COOKIE = 'invented-sso-value-not-a-real-credential';

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

test('normalizeRateLimits inverts remaining into percent used', () => {
  const out = normalizeRateLimits(FIXTURE, NOW);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 30); // 14 of 20 left = 30% used
  assert.strictEqual(out.pctWeek, null);
  assert.strictEqual(out.resets5h, NOW + 86400_000); // rolling window, approximated forward
  assert.strictEqual(out.windowLabel, 'day');
});

test('normalizeRateLimits refuses a body it cannot read', () => {
  for (const junk of [null, 'nope', {}, { remainingQueries: 5 }, { remainingQueries: 5, totalQueries: 0 }]) {
    const out = normalizeRateLimits(junk, NOW);
    assert.strictEqual(out.ok, false, JSON.stringify(junk));
    assert.match(out.error, /unexpected response/);
  }
});

test('an exhausted window is 100%, an untouched one 0%', () => {
  assert.strictEqual(normalizeRateLimits({ ...FIXTURE, remainingQueries: 0 }, NOW).pct5h, 100);
  assert.strictEqual(normalizeRateLimits({ ...FIXTURE, remainingQueries: 20 }, NOW).pct5h, 0);
});

test('windowLabel names the window rather than claiming a 5h one', () => {
  assert.strictEqual(windowLabel(86400), 'day');
  assert.strictEqual(windowLabel(7200), '2h');
  assert.strictEqual(windowLabel(900), '15m');
  assert.strictEqual(windowLabel(undefined), 'window');
});

test('with no pasted cookie, collectGrok makes no network call', async () => {
  let called = 0;
  const out = await collectGrok({ fetchFn: () => { called += 1; throw new Error('must not be called'); }, now: NOW });
  assert.strictEqual(called, 0);
  assert.match(out.error, /paste your grok\.com sso cookie in Meters/);
});

test('collectGrok posts the documented body and sends both cookies', async () => {
  let seen = null;
  const out = await collectGrok({
    token: COOKIE,
    fetchFn: (url, opts) => { seen = { url, opts }; return Promise.resolve(res(200, FIXTURE)); },
    now: NOW,
  });
  assert.strictEqual(out.pct5h, 30);
  assert.strictEqual(seen.url, RATE_LIMITS_URL);
  assert.strictEqual(seen.opts.method, 'POST');
  assert.deepStrictEqual(JSON.parse(seen.opts.body), { requestKind: 'DEFAULT', modelName: 'grok-4' });
  assert.strictEqual(seen.opts.headers.get('Cookie'), `sso=${COOKIE}; sso-rw=${COOKIE}`);
});

test('a pasted whole cookie string is sent verbatim', async () => {
  let seen = null;
  await collectGrok({
    token: 'sso=a; sso-rw=b',
    fetchFn: (_u, opts) => { seen = opts; return Promise.resolve(res(200, FIXTURE)); },
    now: NOW,
  });
  assert.strictEqual(seen.headers.get('Cookie'), 'sso=a; sso-rw=b');
});

test('collectGrok maps 403 to a re-paste message and 429 to a backoff', async () => {
  const dead = await collectGrok({ token: COOKIE, fetchFn: () => Promise.resolve(res(403, {})), now: NOW });
  assert.match(dead.error, /cookie expired/);
  const limited = await collectGrok({
    token: COOKIE, fetchFn: () => Promise.resolve(res(429, {}, { 'retry-after': '90' })), now: NOW,
  });
  assert.strictEqual(limited.retryAfterMs, 90_000);
});

test('collectGrok never puts the cookie in an error message', async () => {
  const outs = await Promise.all([
    collectGrok({ token: COOKIE, fetchFn: () => Promise.resolve(res(500, {})), now: NOW }),
    collectGrok({ token: COOKIE, fetchFn: () => Promise.reject(new Error('boom')), now: NOW }),
  ]);
  for (const o of outs) assert.ok(!String(o.error).includes(COOKIE), o.error);
});
