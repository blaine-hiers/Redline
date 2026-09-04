const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectClaude, normalizeUsage } = require('../src/collectors/claude');

const headerRes = (status, headers = {}) => ({
  ok: false, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => ({}),
});

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage.json'), 'utf8'));
const CAPTURED_AT = Date.parse('2026-09-02T20:00:00Z'); // fixture capture time, before both resets_at values

function fakeCreds(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-claude-'));
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken: 'tok_test', expiresAt: Date.now() + 3600_000, ...overrides },
  }));
  return file;
}

test('normalizeUsage maps fixture to snapshot shape', () => {
  const snap = normalizeUsage(FIXTURE, 0);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.pct5h, 69); // captured fixture value
  assert.strictEqual(snap.pctWeek, 30);
  assert.ok(snap.resets5h > 1e12); // ms epoch
  assert.ok(snap.resetsWeek > snap.resets5h);
});

test('normalizeUsage never rescales small utilizations (1 means 1%)', () => {
  const snap = normalizeUsage({ five_hour: { utilization: 1, resets_at: '2099-01-01T00:00:00Z' } }, 0);
  assert.strictEqual(snap.pct5h, 1);
});

test('normalizeUsage zeroes windows whose reset has passed', () => {
  const snap = normalizeUsage(FIXTURE, Date.parse('2027-01-01T00:00:00Z'));
  assert.strictEqual(snap.pct5h, 0);
  assert.strictEqual(snap.pctWeek, 0);
});

test('collectClaude success path uses injected fetch', async () => {
  const snap = await collectClaude({
    credFile: fakeCreds(),
    fetchFn: async () => ({ ok: true, status: 200, json: async () => FIXTURE }),
    now: CAPTURED_AT,
  });
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.pct5h, 69);
});

test('collectClaude expired token -> stale message, no fetch', async () => {
  const snap = await collectClaude({
    credFile: fakeCreds({ expiresAt: 1 }),
    fetchFn: async () => { throw new Error('should not be called'); },
  });
  assert.strictEqual(snap.ok, false);
  assert.match(snap.error, /token stale/i);
});

test('collectClaude 401 -> stale message', async () => {
  const snap = await collectClaude({
    credFile: fakeCreds(),
    fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.match(snap.error, /token stale/i);
});

test('collectClaude missing credentials file', async () => {
  const snap = await collectClaude({ credFile: path.join(os.tmpdir(), 'nope-xyz.json') });
  assert.strictEqual(snap.ok, false);
});

test('collectClaude 429 with numeric Retry-After -> retryAfterMs and minute-scale message', async () => {
  const snap = await collectClaude({
    credFile: fakeCreds(),
    fetchFn: async () => headerRes(429, { 'retry-after': '120' }),
  });
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.retryAfterMs, 120_000);
  assert.match(snap.error, /rate limited.*retrying in 2m/i);
});

test('collectClaude 429 with HTTP-date Retry-After -> retryAfterMs from now', async () => {
  const now = Date.parse('2026-09-03T00:00:00Z');
  const snap = await collectClaude({
    credFile: fakeCreds(),
    fetchFn: async () => headerRes(429, { 'retry-after': 'Thu, 03 Sep 2026 00:05:00 GMT' }),
    now,
  });
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.retryAfterMs, 5 * 60_000);
  assert.match(snap.error, /rate limited.*retrying in 5m/i);
});

test('collectClaude 429 without Retry-After -> retryAfterMs null', async () => {
  const snap = await collectClaude({
    credFile: fakeCreds(),
    fetchFn: async () => headerRes(429),
  });
  assert.strictEqual(snap.ok, false);
  assert.strictEqual(snap.retryAfterMs, null);
  assert.match(snap.error, /rate limited/i);
});

test('non-429 failures do not carry a retryAfterMs field', async () => {
  const snap = await collectClaude({
    credFile: fakeCreds(),
    fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.strictEqual(snap.ok, false);
  assert.strictEqual('retryAfterMs' in snap, false);
});
