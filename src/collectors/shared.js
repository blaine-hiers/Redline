// Bits every a later change collector repeats: the failure result, the 429 → backoff
// translation, the two time/percent coercions, and a read-only "does this file
// exist and parse" helper for credential discovery.
//
// Claude's and Codex's collectors predate this and keep their own copies
// verbatim — rewriting them would be a change to code the screenshots and the
// existing fixtures already pin, for no behaviour difference.
//
// SECURITY: nothing here ever logs, echoes or returns a credential. `fail()`
// messages are written by the caller and must stay generic; a token must never
// be interpolated into one — which is why neither buildHeaders nor
// classifyNetworkError below ever passes an exception's own `message` on.

const fs = require('fs');
const { parseRetryAfter } = require('../backoff');

const EMPTY = { pct5h: null, resets5h: null, pctWeek: null, resetsWeek: null };

const fail = (error) => ({ ok: false, stale: true, ...EMPTY, error });

// A 429 from any of these endpoints is handled the same way Claude's is: the
// server-given Retry-After (when it parses) drives the cooldown, otherwise the
// fixed 2m → 4m → 8m → 15m ladder does.
function rateLimited(res, now = Date.now()) {
  const header = res && res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : null;
  const retryAfterMs = parseRetryAfter(header, now);
  const error = retryAfterMs != null
    ? `rate limited — retrying in ${Math.max(1, Math.ceil(retryAfterMs / 60_000))}m`
    : 'rate limited — retrying';
  return { ok: false, stale: true, ...EMPTY, error, retryAfterMs };
}

// Header values are validated *here*, before the request, and never inside the
// try/catch around the network call — because undici's validation error quotes
// the entire offending value:
//   TypeError: Headers.append: "<the whole cookie>" is an invalid header value
// A pasted cookie or token is exactly the kind of value that can carry an
// interior newline, so letting that TypeError reach `fail('network: ' + msg)`
// would print the credential on the card. Constructing the Headers eagerly
// turns it into a generic "invalid credential" instead.
function buildHeaders(init) {
  try { return new Headers(init); } catch (_) { return null; }
}

// A fetch rejection, reduced to a fixed classification. Never `e.message`: a
// message can quote the URL, the header value, or the credential inside it.
// Only the *kind* of failure is ever shown, which is all the card can act on.
function classifyNetworkError(e) {
  const name = e && e.name;
  const code = (e && e.code) || (e && e.cause && e.cause.code) || null;
  if (name === 'TimeoutError' || name === 'AbortError') return 'network: timeout';
  switch (code) {
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'network: timeout';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'network: dns';
    case 'ECONNREFUSED':
      return 'network: refused';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'network: connection lost';
    default:
      return 'network error';
  }
}

// Last line of defence for the one string that crosses IPC and lands in the
// DOM. Every collector is tested never to put a credential in its `error`, but
// this runs over the message anyway on the way into the snapshot: a value that
// matches a saved token is replaced rather than displayed. Order matters only
// in that longer secrets are removed first, so a secret that contains another
// can't leave a fragment behind.
const REDACTED = '[redacted]';
function scrubSecrets(text, secrets) {
  if (typeof text !== 'string' || !text) return text;
  const list = (Array.isArray(secrets) ? secrets : [])
    .filter((s) => typeof s === 'string' && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of list) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

// ISO string, epoch seconds, or epoch milliseconds → ms, or null.
function toMs(t) {
  if (t == null) return null;
  if (typeof t === 'number') {
    if (!Number.isFinite(t) || t <= 0) return null;
    return t < 1e12 ? t * 1000 : t;
  }
  if (typeof t !== 'string') return null;
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : parsed;
}

// Any finite number → an integer 0-100, or null.
function toPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(100, Math.max(0, v)));
}

// Percent *used* from a "how much is left" pair. Every consumer endpoint in
// this batch reports remaining rather than used (remainingQueries, remaining
// premium requests, remaining balance), and the widget's whole vocabulary —
// bars, warnAt/alertAt, the sparkline, the spoken summary — is percent used
//. So the inversion happens once, here, rather than in each
// collector's own arithmetic.
function pctUsedFromRemaining(remaining, total) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  return toPct(100 * (1 - remaining / total));
}

// Percent used from a used/total pair.
function pctUsedOf(used, total) {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  return toPct((100 * used) / total);
}

// The success result, with the same "a reset already in the past zeroes its
// bar" rule the built-ins apply.
function reading({ pct5h = null, resets5h = null, pctWeek = null, resetsWeek = null }, now = Date.now()) {
  let p5 = toPct(pct5h);
  let pw = toPct(pctWeek);
  const r5 = toMs(resets5h);
  const rw = toMs(resetsWeek);
  if (r5 !== null && r5 < now && p5 !== null) p5 = 0;
  if (rw !== null && rw < now && pw !== null) pw = 0;
  return { ok: true, stale: false, pct5h: p5, resets5h: r5, pctWeek: pw, resetsWeek: rw, error: null };
}

// Read-only, never throws: a missing/unreadable/non-JSON credential file is
// simply "no credential here", which every collector turns into its own
// actionable "not signed in" message rather than a stack trace.
function readJsonFile(file, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

module.exports = {
  EMPTY, REDACTED, fail, rateLimited, buildHeaders, classifyNetworkError, scrubSecrets,
  toMs, toPct, pctUsedFromRemaining, pctUsedOf, reading, readJsonFile,
};
