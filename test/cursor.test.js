const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  collectCursor, normalizeUsage, tokenFromStateDb, userIdFromJwt, splitPasted, stateDbPath, nextMonth,
} = require('../src/collectors/cursor');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cursor-usage.json'), 'utf8'));
const NOW = Date.parse('2026-08-20T12:00:00Z');

// An invented JWT — no real credential exists on this machine, and none is needed:
// only the base64url payload's `sub` is ever read.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `hdr.${b64({ sub: 'auth0|user_01ABCDEF', time: 1 })}.sig`;

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

test('normalizeUsage turns premium requests into percent used', () => {
  const out = normalizeUsage(FIXTURE, NOW);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 62); // 312 of 500
  assert.strictEqual(out.pctWeek, null); // Cursor has one window, not two
  assert.strictEqual(out.resets5h, Date.parse('2026-09-14T00:00:00Z')); // startOfMonth + a month
});

test('normalizeUsage reports a plan with no request cap rather than pretending', () => {
  const out = normalizeUsage({ ...FIXTURE, 'gpt-4': { numRequests: 10, maxRequestUsage: null } }, NOW);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /no request quota/);
});

test('normalizeUsage rejects an unexpected body without throwing', () => {
  for (const junk of [null, 'nope', {}, { 'gpt-4': 7 }]) {
    const out = normalizeUsage(junk, NOW);
    assert.strictEqual(out.ok, false, JSON.stringify(junk));
    assert.match(out.error, /unexpected response/);
  }
});

test('nextMonth keeps the billing day and rolls the month', () => {
  assert.strictEqual(nextMonth(Date.parse('2026-12-14T00:00:00Z')), Date.parse('2027-01-14T00:00:00Z'));
  assert.strictEqual(nextMonth(null), null);
});

// PR #20 finding 4: Date.UTC(y, m, 31) silently rolls over, so a billing day
// past the 28th used to land a month and a bit out (Jan 31 -> Mar 3).
test('nextMonth clamps a billing day the next month does not have', () => {
  assert.strictEqual(nextMonth(Date.parse('2026-01-31T00:00:00Z')), Date.parse('2026-02-28T00:00:00Z'));
  assert.strictEqual(nextMonth(Date.parse('2026-03-31T00:00:00Z')), Date.parse('2026-04-30T00:00:00Z'));
  assert.strictEqual(nextMonth(Date.parse('2026-05-31T00:00:00Z')), Date.parse('2026-06-30T00:00:00Z'));
  // a leap year gives February the 29th to land on
  assert.strictEqual(nextMonth(Date.parse('2028-01-31T00:00:00Z')), Date.parse('2028-02-29T00:00:00Z'));
  assert.strictEqual(nextMonth(Date.parse('2028-02-28T00:00:00Z')), Date.parse('2028-03-28T00:00:00Z'));
  assert.strictEqual(nextMonth(Date.parse('2028-02-29T00:00:00Z')), Date.parse('2028-03-29T00:00:00Z'));
  // the time of day survives the clamp
  assert.strictEqual(nextMonth(Date.parse('2026-01-31T09:30:15Z')), Date.parse('2026-02-28T09:30:15Z'));
});

test('userIdFromJwt takes the half after the pipe in sub', () => {
  assert.strictEqual(userIdFromJwt(JWT), 'user_01ABCDEF');
  assert.strictEqual(userIdFromJwt(`hdr.${b64({ sub: 'user_plain' })}.sig`), 'user_plain');
  assert.strictEqual(userIdFromJwt('not-a-jwt'), null);
  assert.strictEqual(userIdFromJwt(`hdr.${b64({ nope: 1 })}.sig`), null);
});

test('splitPasted accepts a raw JWT or a whole session cookie value', () => {
  assert.deepStrictEqual(splitPasted(JWT), { userId: 'user_01ABCDEF', jwt: JWT });
  assert.deepStrictEqual(splitPasted(`user_9%3A%3A${JWT}`), { userId: 'user_9', jwt: JWT });
});

// ---------- credential discovery ----------
// A real state.vscdb is a SQLite file; what the scan actually needs is only
// that the key string is followed by the value's bytes, which this reproduces.
const fakeDb = (jwt) => Buffer.concat([
  Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0xff]),
  Buffer.from('cursorAuth/accessToken'), Buffer.from(jwt),
  Buffer.from([0x00, 0x01]), Buffer.from('someOtherKey'),
]);

test('tokenFromStateDb recovers the JWT that follows the key', () => {
  const buf = fakeDb(JWT);
  const fsImpl = { statSync: () => ({ size: buf.length }), readFileSync: () => buf };
  assert.strictEqual(tokenFromStateDb('x.vscdb', fsImpl), JWT);
});

test('tokenFromStateDb returns null rather than a guess', () => {
  const cases = [
    Buffer.from('no key here at all'),
    fakeDb('not-a-jwt'),
  ];
  for (const buf of cases) {
    const fsImpl = { statSync: () => ({ size: buf.length }), readFileSync: () => buf };
    assert.strictEqual(tokenFromStateDb('x.vscdb', fsImpl), null);
  }
  const throwing = { statSync: () => { throw new Error('nope'); }, readFileSync: () => { throw new Error('nope'); } };
  assert.strictEqual(tokenFromStateDb('missing.vscdb', throwing), null);
});

test('stateDbPath points at each platform own store', () => {
  assert.match(stateDbPath('C:/Users/x', 'win32', { APPDATA: 'C:/Users/x/AppData/Roaming' }), /Cursor.User.globalStorage.state\.vscdb$/);
  assert.match(stateDbPath('/home/x', 'linux', {}), /\.config.Cursor.User.globalStorage.state\.vscdb$/);
  assert.match(stateDbPath('/Users/x', 'darwin', {}), /Application Support.Cursor/);
});

// ---------- collect() ----------
test('with no credential anywhere, collectCursor makes no network call', async () => {
  let called = 0;
  const out = await collectCursor({
    fetchFn: () => { called += 1; throw new Error('must not be called'); },
    fsImpl: { statSync: () => { throw new Error('missing'); }, readFileSync: () => { throw new Error('missing'); } },
    now: NOW,
  });
  assert.strictEqual(called, 0);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /paste your session token in Meters/);
});

test('collectCursor sends the session cookie and returns the reading', async () => {
  let seen = null;
  const out = await collectCursor({
    token: JWT,
    fetchFn: (url, opts) => { seen = { url, opts }; return Promise.resolve(res(200, FIXTURE)); },
    now: NOW,
  });
  assert.strictEqual(out.pct5h, 62);
  assert.match(seen.url, /\?user=user_01ABCDEF$/);
  assert.strictEqual(seen.opts.headers.get('Cookie'), `WorkosCursorSessionToken=user_01ABCDEF%3A%3A${JWT}`);
});

test('collectCursor maps 401 to a re-paste message and 429 to a backoff', async () => {
  const expired = await collectCursor({ token: JWT, fetchFn: () => Promise.resolve(res(401, {})), now: NOW });
  assert.match(expired.error, /session expired/);
  const limited = await collectCursor({
    token: JWT, fetchFn: () => Promise.resolve(res(429, {}, { 'retry-after': '120' })), now: NOW,
  });
  assert.strictEqual(limited.retryAfterMs, 120_000);
  assert.match(limited.error, /rate limited/);
});

test('collectCursor survives a network failure and a non-JSON body', async () => {
  const netErr = await collectCursor({ token: JWT, fetchFn: () => Promise.reject(new Error('ENOTFOUND')), now: NOW });
  assert.match(netErr.error, /network/);
  const bad = await collectCursor({
    token: JWT, fetchFn: () => Promise.resolve({ ...res(200, null), json: () => Promise.reject(new Error('bad json')) }), now: NOW,
  });
  assert.match(bad.error, /bad response/);
});

test('collectCursor never puts the token in an error message', async () => {
  const outs = await Promise.all([
    collectCursor({ token: JWT, fetchFn: () => Promise.resolve(res(500, {})), now: NOW }),
    collectCursor({ token: JWT, fetchFn: () => Promise.reject(new Error('boom')), now: NOW }),
    collectCursor({ token: 'garbage', fetchFn: () => Promise.resolve(res(200, FIXTURE)), now: NOW }),
  ]);
  for (const o of outs) assert.ok(!String(o.error).includes(JWT), o.error);
});
