// Cursor — monthly premium ("gpt-4") request quota.
//
// SOURCE (no first-party docs exist; this is what the established community
// extension does): Dwtexe/cursor-stats
//   src/services/api.ts        — GET https://cursor.com/api/usage?user=<id>,
//                                the browser headers, and the userId split
//   src/services/database.ts   — SELECT value FROM ItemTable
//                                WHERE key = 'cursorAuth/accessToken', and the
//                                `<userId>%3A%3A<jwt>` session-cookie format
//   src/interfaces/types.ts    — CursorUsageResponse
//   https://github.com/Dwtexe/cursor-stats
//
// NOT VERIFIED LIVE: no Cursor account exists on this machine, so
// every field below is exercised only against test/fixtures/cursor-usage.json,
// which reproduces the shape those type definitions declare.
//
// SECURITY: the JWT is read from Cursor's own SQLite store, sent only to
// cursor.com, and never logged. No error message here interpolates it.

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  fail, rateLimited, reading, pctUsedOf, toMs, buildHeaders, classifyNetworkError,
} = require('./shared');

const USAGE_URL = 'https://cursor.com/api/usage';
// %APPDATA%\Cursor\... on Windows; the XDG/Library equivalents elsewhere.
function stateDbPath(home = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

const DB_KEY = 'cursorAuth/accessToken';
// A JWT's alphabet: base64url plus the two dots. Anything outside it ends the
// value — which is what makes the byte scan below terminate correctly.
const JWT_BYTE = /[A-Za-z0-9_.-]/;
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const MAX_DB_BYTES = 64 * 1024 * 1024; // state.vscdb is a few MB; refuse to slurp anything absurd

// Best-effort SQLite read with no dependency and no SQL engine: in an
// ItemTable row the TEXT value is stored immediately after the TEXT key in the
// same record payload, so finding the key string and reading the JWT-shaped
// run of bytes that follows it recovers the token. This is deliberately
// conservative — it returns null rather than a guess unless what it found
// actually looks like a three-segment JWT. Documented as best-effort in the
// README; the pasted-token option is the fallback when it misses.
function tokenFromStateDb(file, fsImpl = fs) {
  let buf;
  try {
    if (fsImpl.statSync(file).size > MAX_DB_BYTES) return null;
    buf = fsImpl.readFileSync(file);
  } catch (_) { return null; }
  const at = buf.lastIndexOf(DB_KEY); // ASCII key, so the default utf8 match is exact
  if (at === -1) return null;
  let i = at + DB_KEY.length;
  let out = '';
  while (i < buf.length && out.length < 4096) {
    const ch = String.fromCharCode(buf[i]);
    if (!JWT_BYTE.test(ch)) break;
    out += ch;
    i += 1;
  }
  return JWT_RE.test(out) ? out : null;
}

// The dashboard identifies the account by the id inside the JWT, not by the
// JWT itself: payload.sub is "<issuer>|<userId>" and both the `?user=` query
// and the session cookie want that second half (cursor-stats database.ts).
function userIdFromJwt(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (_) { return null; }
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (!sub) return null;
  const id = sub.includes('|') ? sub.split('|')[1] : sub;
  return id || null;
}

// A pasted credential may be either the raw JWT out of the dev tools or the
// whole `WorkosCursorSessionToken` cookie value (`<userId>%3A%3A<jwt>`), so
// both are accepted and reduced to the same pair.
function splitPasted(token) {
  const sep = token.indexOf('%3A%3A');
  if (sep === -1) return { userId: userIdFromJwt(token), jwt: token };
  return { userId: token.slice(0, sep), jwt: token.slice(sep + 6) };
}

// The premium-request bucket is the one that runs out; Cursor reports it under
// the legacy "gpt-4" key. A plan with no cap there (maxRequestUsage null) has
// nothing to draw a bar from, which is an "unlimited", not a failure.
function normalizeUsage(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return fail('unexpected response from Cursor');
  const premium = body['gpt-4'];
  if (!premium || typeof premium !== 'object') return fail('unexpected response from Cursor');
  const pct = pctUsedOf(premium.numRequests, premium.maxRequestUsage);
  if (pct === null) return fail('no request quota on this Cursor plan');
  return reading({ pct5h: pct, resets5h: nextMonth(toMs(body.startOfMonth)) }, now);
}

// Cursor's quota window is a calendar month that starts on the account's own
// billing day (`startOfMonth`), so the reset is that same day next month —
// clamped to the length of that month. Date.UTC(y, m, 31) silently rolls over
// (Jan 31 → Mar 3), which would put the countdown a month and a bit out for
// every account whose billing day is the 29th, 30th or 31st.
function nextMonth(ms) {
  if (ms === null) return null;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  // Day 0 of the month *after* the target is the target month's last day.
  const lastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return Date.UTC(year, month + 1, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

async function collectCursor({
  token = null, dbFile = null, fetchFn = fetch, now = Date.now(), fsImpl = fs, env = process.env,
  home = os.homedir(), platform = process.platform,
} = {}) {
  const raw = token || tokenFromStateDb(dbFile || stateDbPath(home, platform, env), fsImpl);
  // No credential found: this must never reach the network.
  if (!raw) return fail('Cursor: paste your session token in Meters');
  const { userId, jwt } = splitPasted(raw);
  if (!userId || !jwt) return fail('Cursor: session token not readable — paste it again');
  // Built before the try, never inside it: undici's header validation error
  // quotes the whole offending value, so a credential with a stray newline in
  // it would otherwise be printed on the card (see buildHeaders in shared.js).
  const headers = buildHeaders({
    Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`,
    Accept: 'application/json',
    Origin: 'https://cursor.com',
    Referer: 'https://cursor.com/dashboard',
  });
  if (!headers) return fail('Cursor: invalid credential');
  let res;
  try {
    res = await fetchFn(`${USAGE_URL}?user=${encodeURIComponent(userId)}`, {
      headers, signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { return fail(classifyNetworkError(e)); }
  if (res.status === 401 || res.status === 403) return fail('Cursor: session expired — paste a new token');
  if (res.status === 429) return rateLimited(res, now);
  if (!res.ok) return fail('Cursor usage endpoint HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (e) { return fail('bad response: ' + e.message); }
  return normalizeUsage(body, now);
}

module.exports = {
  collectCursor, normalizeUsage, tokenFromStateDb, userIdFromJwt, splitPasted, stateDbPath,
  nextMonth, USAGE_URL, DB_KEY,
};
