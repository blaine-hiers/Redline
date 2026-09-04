const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  collectCopilot, normalizeUser, usableSnapshot, tokenFromEntries, tokenFromFiles, tokenFromGhCli,
  configDir, USER_URL,
} = require('../src/collectors/copilot');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'copilot-user.json'), 'utf8'));
const NOW = Date.parse('2026-08-20T12:00:00Z');
const TOKEN = 'ghu_invented0000000000000000000000000000';

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
const fsWith = (contents) => ({
  readFileSync: (f) => { if (contents[f] === undefined) throw new Error('ENOENT'); return contents[f]; },
});
const noGh = (_cmd, _args, _opts, cb) => cb(new Error('not found'));

test('normalizeUser inverts percent_remaining for the metered snapshot', () => {
  const out = normalizeUser(FIXTURE, NOW);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 71); // 29.17% of 300 premium requests left
  assert.strictEqual(out.pctWeek, null); // one monthly window
  assert.strictEqual(out.resets5h, Date.parse('2026-09-01T00:00:00Z'));
  assert.strictEqual(out.windowLabel, 'premium');
});

test('an unlimited snapshot is skipped in favour of one with a real quota', () => {
  const free = {
    quota_reset_date: '2026-09-01',
    quota_snapshots: {
      premium_interactions: { unlimited: true, percent_remaining: 100 },
      chat: { unlimited: false, percent_remaining: 40 },
      completions: { unlimited: false, percent_remaining: 90 },
    },
  };
  const out = normalizeUser(free, NOW);
  assert.strictEqual(out.pct5h, 60);
  assert.strictEqual(out.windowLabel, 'chat');
});

test('a plan where nothing is metered says so rather than showing a fake bar', () => {
  const unlimited = { quota_snapshots: { chat: { unlimited: true }, completions: { unlimited: true } } };
  assert.match(normalizeUser(unlimited, NOW).error, /no metered quota/);
  assert.strictEqual(usableSnapshot(null), null);
});

test('normalizeUser refuses a body it cannot read', () => {
  for (const junk of [null, 'nope', {}, { quota_snapshots: 7 }]) {
    assert.strictEqual(normalizeUser(junk, NOW).ok, false, JSON.stringify(junk));
  }
});

// The quota endpoint is hardcoded to api.github.com, so a GitHub Enterprise
// token in the same file must never be picked up — it would be sent to a host
// it was not issued for.
test('tokenFromEntries uses a github.com key and ignores an enterprise one', () => {
  assert.strictEqual(tokenFromEntries({
    'ghe.example.com': { oauth_token: 'ghes-token' },
    'github.com:Iv1.abc': { user: 'u', oauth_token: TOKEN },
  }), TOKEN);
  assert.strictEqual(tokenFromEntries({ 'ghe.example.com': { oauth_token: 'ghes-token' } }), null);
  assert.strictEqual(tokenFromEntries({ 'github.com.evil.example': { oauth_token: 'spoof' } }), null);
  assert.strictEqual(tokenFromEntries({ 'github.com': { user: 'u' } }), null);
  assert.strictEqual(tokenFromEntries(null), null);
});

test('a machine with only an enterprise entry has no credential for this endpoint', async () => {
  const dir = configDir('/home/u', 'linux', {});
  let called = 0;
  const out = await collectCopilot({
    dir,
    fsImpl: fsWith({ [path.join(dir, 'apps.json')]: '{"ghe.example.com:Iv1.x":{"oauth_token":"ghes-token"}}' }),
    run: noGh, now: NOW,
    fetchFn: () => { called += 1; throw new Error('must not be called'); },
  });
  assert.strictEqual(called, 0);
  assert.match(out.error, /not signed in/);
});

test('tokenFromFiles reads apps.json first, then hosts.json', () => {
  const dir = configDir('/home/u', 'linux', {});
  const apps = path.join(dir, 'apps.json');
  const hosts = path.join(dir, 'hosts.json');
  assert.strictEqual(tokenFromFiles(dir, fsWith({ [apps]: `{"github.com:Iv1.x":{"oauth_token":"${TOKEN}"}}` })), TOKEN);
  assert.strictEqual(tokenFromFiles(dir, fsWith({ [hosts]: `{"github.com":{"oauth_token":"${TOKEN}"}}` })), TOKEN);
  assert.strictEqual(tokenFromFiles(dir, fsWith({ [apps]: '{broken' })), null);
  assert.strictEqual(tokenFromFiles(dir, fsWith({})), null);
});

test('configDir follows the platform each client uses', () => {
  assert.strictEqual(configDir('C:/u', 'win32', { LOCALAPPDATA: 'C:/u/AppData/Local' }),
    path.join('C:/u/AppData/Local', 'github-copilot'));
  assert.strictEqual(configDir('/home/u', 'linux', {}), path.join('/home/u/.config', 'github-copilot'));
});

test('tokenFromGhCli returns the trimmed token, or null on any failure', async () => {
  assert.strictEqual(await tokenFromGhCli((_c, _a, _o, cb) => cb(null, `${TOKEN}\n`)), TOKEN);
  assert.strictEqual(await tokenFromGhCli(noGh), null);
  assert.strictEqual(await tokenFromGhCli((_c, _a, _o, cb) => cb(null, '  ')), null);
  assert.strictEqual(await tokenFromGhCli(() => { throw new Error('spawn failed'); }), null);
});

test('tokenFromGhCli runs an argv array, never a shell string, pinned to github.com', async () => {
  let seen = null;
  await tokenFromGhCli((cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(null, TOKEN); });
  assert.strictEqual(seen.cmd, 'gh');
  // --hostname is what keeps `gh` from handing back an enterprise token on a
  // machine whose current host is a GHES instance.
  assert.deepStrictEqual(seen.args, ['auth', 'token', '--hostname', 'github.com']);
  assert.strictEqual(seen.opts.shell, false);
  assert.ok(seen.opts.timeout > 0);
});

test('with no credential anywhere, collectCopilot makes no network call', async () => {
  let called = 0;
  const out = await collectCopilot({
    dir: '/nope', fsImpl: fsWith({}), run: noGh, now: NOW,
    fetchFn: () => { called += 1; throw new Error('must not be called'); },
  });
  assert.strictEqual(called, 0);
  assert.match(out.error, /not signed in — run `gh auth login`/);
});

test('the gh CLI is the fallback when Copilot own files are absent', async () => {
  let seen = null;
  const out = await collectCopilot({
    dir: '/nope', fsImpl: fsWith({}), run: (_c, _a, _o, cb) => cb(null, TOKEN), now: NOW,
    fetchFn: (url, opts) => { seen = { url, opts }; return Promise.resolve(res(200, FIXTURE)); },
  });
  assert.strictEqual(out.pct5h, 71);
  assert.strictEqual(seen.url, USER_URL);
  assert.strictEqual(seen.opts.headers.get('Authorization'), `token ${TOKEN}`);
  assert.strictEqual(seen.opts.headers.get('X-GitHub-Api-Version'), '2025-04-01');
});

test('collectCopilot maps 401/404 to their own messages and 429 to a backoff', async () => {
  const call = (status, headers) => collectCopilot({
    token: TOKEN, now: NOW, fetchFn: () => Promise.resolve(res(status, {}, headers)),
  });
  assert.match((await call(401)).error, /token rejected/);
  assert.match((await call(404)).error, /no subscription/);
  const limited = await call(429, { 'retry-after': '30' });
  assert.strictEqual(limited.retryAfterMs, 30_000);
});

test('collectCopilot never puts the token in an error message', async () => {
  const outs = await Promise.all([
    collectCopilot({ token: TOKEN, now: NOW, fetchFn: () => Promise.resolve(res(500, {})) }),
    collectCopilot({ token: TOKEN, now: NOW, fetchFn: () => Promise.reject(new Error('boom')) }),
  ]);
  for (const o of outs) assert.ok(!String(o.error).includes(TOKEN), o.error);
});
