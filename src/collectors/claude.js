const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseRetryAfter } = require('../backoff');
const { buildHeaders, classifyNetworkError } = require('./shared');

const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'; // probe-confirmed 2026-09-02

function readToken(file = CRED_FILE) {
  const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
  const oauth = creds.claudeAiOauth ?? creds.oauth ?? creds;
  if (!oauth.accessToken) throw new Error('no accessToken in credentials');
  return { token: oauth.accessToken, expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null };
}

function toMs(t) {
  if (t == null) return null;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : parsed;
}

function pctOf(u) {
  if (typeof u !== 'number') return null;
  return Math.round(u); // endpoint uses 0-100 (probe-confirmed); never rescale
}

// Shape confirmed by scripts/probe-claude.mjs (fixture: test/fixtures/claude-usage.json):
// { five_hour: {utilization: 0-100, resets_at: ISO}, seven_day: {utilization, resets_at}, ... }
function normalizeUsage(body, now = Date.now()) {
  const five = body.five_hour ?? body.session ?? null;
  const week = body.seven_day ?? body.week ?? null;
  const conv = (w) => {
    if (!w) return { pct: null, resets: null };
    const resets = toMs(w.resets_at);
    let pct = pctOf(w.utilization);
    if (resets !== null && resets < now) pct = 0;
    return { pct, resets };
  };
  const a = conv(five), b = conv(week);
  return {
    ok: true, stale: false,
    pct5h: a.pct, resets5h: a.resets,
    pctWeek: b.pct, resetsWeek: b.resets,
    error: null,
  };
}

async function collectClaude({ credFile = CRED_FILE, fetchFn = fetch, now = Date.now() } = {}) {
  const fail = (error) => ({ ok: false, stale: true, pct5h: null, resets5h: null, pctWeek: null, resetsWeek: null, error });
  let tok;
  try { tok = readToken(credFile); } catch (e) { return fail('credentials unreadable: ' + e.message); }
  if (tok.expiresAt && tok.expiresAt < now) return fail('token stale — open Claude Code');
  // Built before the try, never inside it: undici's header validation error
  // quotes the whole offending value, so a credential with a stray newline in
  // it would otherwise be printed on the card (see buildHeaders in shared.js).
  const headers = buildHeaders({ Authorization: `Bearer ${tok.token}`, 'anthropic-beta': 'oauth-2025-04-20' });
  if (!headers) return fail('credentials unreadable');
  let res;
  try {
    res = await fetchFn(USAGE_URL, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (e) { return fail(classifyNetworkError(e)); }
  if (res.status === 401 || res.status === 403) return fail('token stale — open Claude Code');
  if (res.status === 429) {
    const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    const retryAfterMs = parseRetryAfter(header, now);
    const message = retryAfterMs != null
      ? `rate limited — retrying in ${Math.max(1, Math.ceil(retryAfterMs / 60_000))}m`
      : 'rate limited — retrying';
    return { ok: false, stale: true, pct5h: null, resets5h: null, pctWeek: null, resetsWeek: null, error: message, retryAfterMs };
  }
  if (!res.ok) return fail('usage endpoint HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (e) { return fail('bad response: ' + e.message); }
  return normalizeUsage(body, now);
}

module.exports = { collectClaude, readToken, normalizeUsage, CRED_FILE, USAGE_URL };
