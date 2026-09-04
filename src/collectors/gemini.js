// Gemini CLI — the Code Assist daily quota the CLI's own `/stats` shows.
//
// SOURCE: google-gemini/gemini-cli @ 86b461ea2cdb1c847775433b820ce6b6ada0e63c
//   packages/core/src/code_assist/server.ts  — endpoint construction:
//       POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
//       (CODE_ASSIST_ENDPOINT + '/' + CODE_ASSIST_API_VERSION + ':<method>')
//   packages/core/src/code_assist/types.ts   — RetrieveUserQuotaResponse:
//       { buckets?: [{ remainingAmount?: string, remainingFraction?: number,
//                      resetTime?: string, tokenType?: string, modelId?: string }] }
//   packages/core/src/config/config.ts       — refreshUserQuota() call site
//   packages/cli/src/ui/commands/statsCommand.ts — how /stats renders it
//   packages/core/src/config/storage.ts      — ~/.gemini/oauth_creds.json
//   https://github.com/google-gemini/gemini-cli
//
// NOT VERIFIED LIVE: there is no Gemini account on this machine, so
// the response handling is exercised only against test/fixtures/gemini-quota.json.
// The *request* body is the least certain part: `retrieveUserQuota` takes the
// Code Assist project id, which the CLI already holds from an earlier
// `:loadCodeAssist`. This collector gets it from GOOGLE_CLOUD_PROJECT, or from
// its own `:loadCodeAssist` call, and treats a missing one as a configuration
// problem rather than guessing — see the README's "shape-unconfirmed" row.
//
// CREDENTIAL: read-only from ~/.gemini/oauth_creds.json (google-auth-library's
// own Credentials shape: access_token / refresh_token / expiry_date). Recent
// Gemini CLI versions move this into the OS keychain instead, which this app
// deliberately does not touch — in that case the meter says so and the pasted
// access token is the fallback.
//
// SECURITY: the access token is sent only to cloudcode-pa.googleapis.com. This
// collector never refreshes it (that would need Google's client secret and a
// write back to the user's credential file), never writes to ~/.gemini, and
// never logs or echoes it.

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  fail, rateLimited, reading, toMs, readJsonFile, buildHeaders, classifyNetworkError,
} = require('./shared');

const BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const QUOTA_URL = `${BASE}:retrieveUserQuota`;
const LOAD_URL = `${BASE}:loadCodeAssist`;

const credFile = (home = os.homedir()) => path.join(home, '.gemini', 'oauth_creds.json');

// google-auth-library's Credentials shape, written verbatim by the CLI.
function readCreds(file, fsImpl = fs) {
  const creds = readJsonFile(file, fsImpl);
  if (!creds || typeof creds !== 'object') return null;
  const token = typeof creds.access_token === 'string' && creds.access_token ? creds.access_token : null;
  if (!token) return null;
  return { token, expiresAt: typeof creds.expiry_date === 'number' ? creds.expiry_date : null };
}

// The bucket that matters is the one closest to running out — a user with two
// models left at 74% and 36% is 64% of the way through the tighter limit, and
// that is the number a "how much have I got left" widget must show.
function tightestBucket(buckets) {
  let worst = null;
  for (const b of buckets) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.remainingFraction !== 'number' || !Number.isFinite(b.remainingFraction)) continue;
    if (worst === null || b.remainingFraction < worst.remainingFraction) worst = b;
  }
  return worst;
}

// remainingFraction is 0..1 of what is *left*; the widget speaks percent used
//, so it is inverted here.
function normalizeQuota(body, now = Date.now()) {
  const buckets = body && Array.isArray(body.buckets) ? body.buckets : null;
  if (!buckets || !buckets.length) return fail('unexpected response from Gemini');
  const b = tightestBucket(buckets);
  if (!b) return fail('unexpected response from Gemini');
  return reading({ pct5h: 100 * (1 - b.remainingFraction), resets5h: toMs(b.resetTime) }, now);
}

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

// The project id `retrieveUserQuota` wants. The CLI keeps it after onboarding;
// here it comes from the environment the CLI itself reads, or from a
// loadCodeAssist round-trip. Returns null rather than throwing.
async function resolveProject(headers, fetchFn, env) {
  const fromEnv = env.GOOGLE_CLOUD_PROJECT || env.GEMINI_PROJECT_ID;
  if (fromEnv) return fromEnv;
  let res;
  try {
    res = await fetchFn(LOAD_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ metadata: { pluginType: 'GEMINI' } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (_) { return null; }
  if (!res || !res.ok) return null;
  let body;
  try { body = await res.json(); } catch (_) { return null; }
  const p = body && typeof body.cloudaicompanionProject === 'string' ? body.cloudaicompanionProject : null;
  return p || null;
}

async function collectGemini({
  token = null, credsFile = null, fetchFn = fetch, now = Date.now(), fsImpl = fs,
  env = process.env, home = os.homedir(),
} = {}) {
  let access = token;
  if (!access) {
    const creds = readCreds(credsFile || credFile(home), fsImpl);
    // Nothing on disk: never reach the network, and say what would fix it.
    if (!creds) return fail('Gemini: not signed in — run `gemini` once');
    if (creds.expiresAt && creds.expiresAt < now) return fail('Gemini: token expired — run `gemini` once');
    access = creds.token;
  }
  // Built before either request, never inside a try: undici's header
  // validation error quotes the whole offending value, so a credential with a
  // stray newline in it would otherwise be printed on the card (see
  // buildHeaders in shared.js).
  const headers = buildHeaders(authHeaders(access));
  if (!headers) return fail('Gemini: invalid credential');
  const project = await resolveProject(headers, fetchFn, env);
  if (!project) return fail('Gemini: no Code Assist project — set GOOGLE_CLOUD_PROJECT');
  let res;
  try {
    res = await fetchFn(QUOTA_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { return fail(classifyNetworkError(e)); }
  if (res.status === 401 || res.status === 403) return fail('Gemini: token stale — run `gemini` once');
  if (res.status === 429) return rateLimited(res, now);
  if (!res.ok) return fail('Gemini quota endpoint HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (e) { return fail('bad response: ' + e.message); }
  return normalizeQuota(body, now);
}

module.exports = {
  collectGemini, normalizeQuota, tightestBucket, readCreds, credFile, QUOTA_URL, LOAD_URL,
};
