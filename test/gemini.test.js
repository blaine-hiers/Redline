const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  collectGemini, normalizeQuota, tightestBucket, readCreds, QUOTA_URL, LOAD_URL,
} = require('../src/collectors/gemini');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gemini-quota.json'), 'utf8'));
const NOW = Date.parse('2026-08-20T12:00:00Z');
const TOKEN = 'ya29.invented-not-a-real-token';

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
// A fs stand-in serving one credentials file; anything else is "missing".
const fsWith = (contents) => ({
  readFileSync: (f) => { if (contents[f] === undefined) throw new Error('ENOENT'); return contents[f]; },
});
const CREDS = '/home/u/.gemini/oauth_creds.json';

test('normalizeQuota inverts the tightest bucket remaining fraction', () => {
  const out = normalizeQuota(FIXTURE, NOW);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 64); // flash is the tightest: 36% left
  assert.strictEqual(out.pctWeek, null); // Gemini's quota is daily, one window
  assert.strictEqual(out.resets5h, Date.parse('2026-08-21T07:00:00Z'));
});

test('normalizeQuota refuses a body with no usable bucket', () => {
  for (const junk of [null, {}, { buckets: [] }, { buckets: [{ modelId: 'x' }] }, { buckets: 'nope' }]) {
    const out = normalizeQuota(junk, NOW);
    assert.strictEqual(out.ok, false, JSON.stringify(junk));
    assert.match(out.error, /unexpected response/);
  }
});

test('tightestBucket picks the lowest remaining fraction and skips junk', () => {
  const b = tightestBucket([null, { remainingFraction: 0.9 }, 'x', { remainingFraction: 0.1 }, { }]);
  assert.strictEqual(b.remainingFraction, 0.1);
  assert.strictEqual(tightestBucket([]), null);
});

test('readCreds takes google-auth-library shape and nothing else', () => {
  const good = readCreds(CREDS, fsWith({ [CREDS]: JSON.stringify({ access_token: TOKEN, expiry_date: 123 }) }));
  assert.deepStrictEqual(good, { token: TOKEN, expiresAt: 123 });
  assert.strictEqual(readCreds(CREDS, fsWith({ [CREDS]: '{not json' })), null);
  assert.strictEqual(readCreds(CREDS, fsWith({ [CREDS]: '{"refresh_token":"r"}' })), null);
  assert.strictEqual(readCreds(CREDS, fsWith({})), null); // keychain-only install
});

test('with no credentials file, collectGemini makes no network call', async () => {
  let called = 0;
  const out = await collectGemini({
    credsFile: CREDS, fsImpl: fsWith({}), env: {}, now: NOW,
    fetchFn: () => { called += 1; throw new Error('must not be called'); },
  });
  assert.strictEqual(called, 0);
  assert.match(out.error, /not signed in — run `gemini` once/);
});

test('an expired saved token is reported without a network call', async () => {
  let called = 0;
  const out = await collectGemini({
    credsFile: CREDS, env: {}, now: NOW,
    fsImpl: fsWith({ [CREDS]: JSON.stringify({ access_token: TOKEN, expiry_date: NOW - 1 }) }),
    fetchFn: () => { called += 1; throw new Error('must not be called'); },
  });
  assert.strictEqual(called, 0);
  assert.match(out.error, /token expired/);
});

test('GOOGLE_CLOUD_PROJECT skips the loadCodeAssist round-trip', async () => {
  const calls = [];
  const out = await collectGemini({
    token: TOKEN, env: { GOOGLE_CLOUD_PROJECT: 'proj-1' }, now: NOW,
    fetchFn: (url, opts) => { calls.push({ url, opts }); return Promise.resolve(res(200, FIXTURE)); },
  });
  assert.strictEqual(out.pct5h, 64);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, QUOTA_URL);
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { project: 'proj-1' });
  assert.strictEqual(calls[0].opts.headers.get('Authorization'), `Bearer ${TOKEN}`);
});

test('without a project in the environment it is resolved from loadCodeAssist', async () => {
  const urls = [];
  const out = await collectGemini({
    token: TOKEN, env: {}, now: NOW,
    fetchFn: (url) => {
      urls.push(url);
      return Promise.resolve(url === LOAD_URL ? res(200, { cloudaicompanionProject: 'proj-2' }) : res(200, FIXTURE));
    },
  });
  assert.deepStrictEqual(urls, [LOAD_URL, QUOTA_URL]);
  assert.strictEqual(out.pct5h, 64);
});

test('an unresolvable project is a configuration message, not a crash', async () => {
  const out = await collectGemini({
    token: TOKEN, env: {}, now: NOW, fetchFn: () => Promise.resolve(res(200, {})),
  });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /GOOGLE_CLOUD_PROJECT/);
});

test('collectGemini maps 401 to a re-auth message and 429 to a backoff', async () => {
  const stale = await collectGemini({
    token: TOKEN, env: { GOOGLE_CLOUD_PROJECT: 'p' }, now: NOW, fetchFn: () => Promise.resolve(res(401, {})),
  });
  assert.match(stale.error, /token stale/);
  const limited = await collectGemini({
    token: TOKEN, env: { GOOGLE_CLOUD_PROJECT: 'p' }, now: NOW,
    fetchFn: () => Promise.resolve(res(429, {}, { 'retry-after': '60' })),
  });
  assert.strictEqual(limited.retryAfterMs, 60_000);
});

test('collectGemini never puts the token in an error message', async () => {
  const outs = await Promise.all([
    collectGemini({ token: TOKEN, env: { GOOGLE_CLOUD_PROJECT: 'p' }, now: NOW, fetchFn: () => Promise.resolve(res(500, {})) }),
    collectGemini({ token: TOKEN, env: { GOOGLE_CLOUD_PROJECT: 'p' }, now: NOW, fetchFn: () => Promise.reject(new Error('boom')) }),
  ]);
  for (const o of outs) assert.ok(!String(o.error).includes(TOKEN), o.error);
});
