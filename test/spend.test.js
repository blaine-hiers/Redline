// The two dollar-denominated meters: OpenAI's monthly costs and
// DeepSeek's prepaid balance. Neither source publishes a percentage, so both
// need `budgetUsd` to have anything to draw — and both must say so instead of
// picking a ceiling of their own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { collectOpenai, normalizeCosts, totalUsd, monthEnd, COSTS_URL } = require('../src/collectors/openai');
const { collectDeepseek, normalizeBalance, balanceUsd } = require('../src/collectors/deepseek');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const COSTS = fixture('openai-costs.json');
const BALANCE = fixture('deepseek-balance.json');
const NOW = Date.parse('2026-08-20T12:00:00Z');
const KEY = 'sk-admin-invented-not-a-real-key';

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

// ---------- OpenAI ----------
test('totalUsd sums every result in every bucket, empty ones included', () => {
  assert.strictEqual(totalUsd(COSTS), 12.5);
  assert.strictEqual(totalUsd({ data: [] }), 0);
  assert.strictEqual(totalUsd({}), null);
  assert.strictEqual(totalUsd(null), null);
});

test('normalizeCosts expresses the month spend as a percentage of the budget', () => {
  const out = normalizeCosts(COSTS, 50, NOW);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 25); // $12.50 of $50
  assert.strictEqual(out.pctWeek, null);
  assert.strictEqual(out.resets5h, monthEnd(NOW));
  assert.strictEqual(out.resets5h, Date.parse('2026-09-01T00:00:00Z'));
});

test('spending past the budget clamps at 100 rather than overflowing the bar', () => {
  assert.strictEqual(normalizeCosts(COSTS, 5, NOW).pct5h, 100);
});

test('collectOpenai refuses to guess a budget, and makes no call without a key', async () => {
  let called = 0;
  const fetchFn = () => { called += 1; throw new Error('must not be called'); };
  assert.match((await collectOpenai({ budgetUsd: 50, env: {}, fetchFn, now: NOW })).error, /paste an admin key/);
  assert.match((await collectOpenai({ token: KEY, env: {}, fetchFn, now: NOW })).error, /set budgetUsd/);
  assert.strictEqual(called, 0);
});

test('collectOpenai asks for this month bucketed by day, with the key in the header', async () => {
  let seen = null;
  const out = await collectOpenai({
    token: KEY, budgetUsd: 50, env: {}, now: NOW,
    fetchFn: (url, opts) => { seen = { url, opts }; return Promise.resolve(res(200, COSTS)); },
  });
  assert.strictEqual(out.pct5h, 25);
  assert.ok(seen.url.startsWith(COSTS_URL));
  assert.match(seen.url, /bucket_width=1d/);
  assert.match(seen.url, new RegExp(`start_time=${Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000)}`));
  assert.strictEqual(seen.opts.headers.get('Authorization'), `Bearer ${KEY}`);
});

test('OPENAI_ADMIN_KEY is the environment fallback', async () => {
  let seen = null;
  await collectOpenai({
    budgetUsd: 50, env: { OPENAI_ADMIN_KEY: KEY }, now: NOW,
    fetchFn: (_u, opts) => { seen = opts; return Promise.resolve(res(200, COSTS)); },
  });
  assert.strictEqual(seen.headers.get('Authorization'), `Bearer ${KEY}`);
});

test('collectOpenai maps 401 and 429, and never echoes the key', async () => {
  const call = (status, headers) => collectOpenai({
    token: KEY, budgetUsd: 50, env: {}, now: NOW, fetchFn: () => Promise.resolve(res(status, {}, headers)),
  });
  assert.match((await call(401)).error, /admin key rejected/);
  assert.strictEqual((await call(429, { 'retry-after': '45' })).retryAfterMs, 45_000);
  for (const o of [await call(500), await call(401)]) assert.ok(!String(o.error).includes(KEY));
});

// ---------- DeepSeek ----------
test('balanceUsd parses the string amount and prefers the USD row', () => {
  assert.strictEqual(balanceUsd(BALANCE), 3.6);
  assert.strictEqual(balanceUsd({ balance_infos: [{ currency: 'CNY', total_balance: '9' }] }), 9);
  assert.strictEqual(balanceUsd({ balance_infos: [] }), null);
  assert.strictEqual(balanceUsd({ balance_infos: [{ currency: 'USD', total_balance: 'nope' }] }), null);
});

test('normalizeBalance shows how much of the top-up has been spent', () => {
  const out = normalizeBalance(BALANCE, 10, NOW);
  assert.strictEqual(out.pct5h, 64); // $3.60 left of a $10 top-up
  assert.strictEqual(out.resets5h, null); // a balance has no window to reset
  assert.strictEqual(normalizeBalance(BALANCE, 2, NOW).pct5h, 0); // topped up past the budget
  assert.match(normalizeBalance({}, 10, NOW).error, /unexpected response/);
});

test('collectDeepseek needs both a key and a budget before it calls anything', async () => {
  let called = 0;
  const fetchFn = () => { called += 1; throw new Error('must not be called'); };
  assert.match((await collectDeepseek({ budgetUsd: 10, env: {}, fetchFn, now: NOW })).error, /paste an API key/);
  assert.match((await collectDeepseek({ token: KEY, env: {}, fetchFn, now: NOW })).error, /set budgetUsd/);
  assert.strictEqual(called, 0);
});

test('collectDeepseek reads the balance and maps its failures', async () => {
  const ok = await collectDeepseek({
    token: KEY, budgetUsd: 10, env: {}, now: NOW, fetchFn: () => Promise.resolve(res(200, BALANCE)),
  });
  assert.strictEqual(ok.pct5h, 64);
  const bad = await collectDeepseek({
    token: KEY, budgetUsd: 10, env: {}, now: NOW, fetchFn: () => Promise.resolve(res(401, {})),
  });
  assert.match(bad.error, /API key rejected/);
  assert.ok(!String(bad.error).includes(KEY));
});
