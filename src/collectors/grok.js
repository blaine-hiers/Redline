// Grok (grok.com consumer account) — remaining queries in the rolling window.
//
// SOURCE (no first-party API; this is the endpoint the community tooling
// calls): POST https://grok.com/rest/rate-limits with
// {"requestKind":"DEFAULT","modelName":"<model>"} and the browser's `sso` /
// `sso-rw` cookies.
//   rob-stout/Tokenomics      — extension/src/grok.ts (carries a captured
//                               response verbatim: windowSizeSeconds,
//                               remainingQueries, totalQueries,
//                               low/highEffortRateLimits)
//   TQZHR/grok2api            — src/grok/rateLimits.ts (same body, cookie header)
//   Cunninger/grok-remain-count
//
// NOT VERIFIED LIVE: no Grok account exists on this machine. The
// shape below is exercised only against test/fixtures/grok-rate-limits.json.
//
// The xAI *developer* API (api.x.ai) deliberately has no collector: it
// publishes rate-limit state only as response headers on a completions call
// (docs.x.ai/developers/rate-limits), so reading it would mean spending the
// user's tokens on a request whose only purpose is to be measured.
//
// CREDENTIAL: grok.com keeps its session in a browser cookie, which no local
// file this app may read exposes — so this meter is pasted-token only.
//
// SECURITY: the cookie is sent to grok.com and nowhere else, and is never
// logged or included in an error message.

const {
  fail, rateLimited, reading, pctUsedFromRemaining, buildHeaders, classifyNetworkError,
} = require('./shared');

const RATE_LIMITS_URL = 'https://grok.com/rest/rate-limits';
const DEFAULT_MODEL = 'grok-4';

// The window is rolling — the response carries its *size*, never an absolute
// reset time — so the countdown is the best available approximation: a full
// window from now. Named so the next reader doesn't mistake it for a real
// server-provided reset.
function approximateReset(windowSizeSeconds, now) {
  if (typeof windowSizeSeconds !== 'number' || !Number.isFinite(windowSizeSeconds) || windowSizeSeconds <= 0) return null;
  return now + windowSizeSeconds * 1000;
}

// "day" for the usual 24h window, otherwise the window's own length, so the
// card never claims a 5h window Grok doesn't have.
function windowLabel(windowSizeSeconds) {
  if (typeof windowSizeSeconds !== 'number' || !Number.isFinite(windowSizeSeconds) || windowSizeSeconds <= 0) return 'window';
  if (windowSizeSeconds === 86400) return 'day';
  if (windowSizeSeconds % 3600 === 0) return `${windowSizeSeconds / 3600}h`;
  return `${Math.max(1, Math.round(windowSizeSeconds / 60))}m`;
}

// Grok reports what is *left*; every bar in this widget is percent used
//, so the inversion happens here.
function normalizeRateLimits(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return fail('unexpected response from Grok');
  const pct = pctUsedFromRemaining(body.remainingQueries, body.totalQueries);
  if (pct === null) return fail('unexpected response from Grok');
  return {
    ...reading({ pct5h: pct, resets5h: approximateReset(body.windowSizeSeconds, now) }, now),
    windowLabel: windowLabel(body.windowSizeSeconds),
  };
}

async function collectGrok({ token = null, model = DEFAULT_MODEL, fetchFn = fetch, now = Date.now() } = {}) {
  // grok.com has no readable on-disk credential, so with nothing pasted there
  // is nothing to try — and no request is made.
  if (!token) return fail('Grok: paste your grok.com sso cookie in Meters');
  // Either the bare `sso` value or a whole cookie string (`sso=…; sso-rw=…`)
  // copied out of the browser. Community tooling reports that `sso` alone is
  // rejected, so a bare value is sent as both.
  const cookie = token.includes('=') ? token : `sso=${token}; sso-rw=${token}`;
  // Built before the try, never inside it: undici's header validation error
  // quotes the whole offending value, so a credential with a stray newline in
  // it would otherwise be printed on the card (see buildHeaders in shared.js).
  const headers = buildHeaders({
    'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie,
  });
  if (!headers) return fail('Grok: invalid cookie — paste it again');
  let res;
  try {
    res = await fetchFn(RATE_LIMITS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestKind: 'DEFAULT', modelName: model }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { return fail(classifyNetworkError(e)); }
  if (res.status === 401 || res.status === 403) return fail('Grok: cookie expired — paste a new one');
  if (res.status === 429) return rateLimited(res, now);
  if (!res.ok) return fail('Grok rate-limits endpoint HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (e) { return fail('bad response: ' + e.message); }
  return normalizeRateLimits(body, now);
}

module.exports = {
  collectGrok, normalizeRateLimits, windowLabel, approximateReset, RATE_LIMITS_URL, DEFAULT_MODEL,
};
