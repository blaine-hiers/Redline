// GitHub Copilot — the monthly premium-request quota its own clients read.
//
// SOURCE: microsoft/vscode (the Copilot Chat extension was merged into it on
// 2026-05-20; the standalone microsoft/vscode-copilot-chat repo is archived)
//   extensions/copilot/src/platform/chat/common/chatQuotaService.ts
//       — CopilotUserQuotaInfo: { quota_reset_date?, quota_snapshots?: {
//           chat, completions, premium_interactions } } and QuotaSnapshot:
//         { quota_id, entitlement, remaining, unlimited, overage_count,
//           overage_permitted, percent_remaining, has_quota? }
//   extensions/copilot/src/platform/authentication/node/copilotTokenManager.ts
//       — GET https://api.github.com/copilot_internal/user with
//         `Authorization: token <oauth>` and `X-GitHub-Api-Version: 2025-04-01`
// Corroborating third-party clients using the same endpoint and headers:
//   Jer-y/copilot-proxy — src/services/github/get-copilot-usage.ts
//   charmbracelet/catwalk — cmd/copilot/main.go (Windows apps.json path)
//   robinebers/openusage — Providers/Copilot/CopilotAuthStore.swift (cred chain)
//
// NOT VERIFIED LIVE: no Copilot subscription exists on this machine
//; the response handling is exercised only against
// test/fixtures/copilot-user.json.
//
// CREDENTIAL, in the order the clients above use: Copilot's own
// apps.json → hosts.json (%LOCALAPPDATA%\github-copilot on Windows,
// ~/.config/github-copilot elsewhere), then the `gh` CLI's
// `gh auth token --hostname github.com`. All three are read-only; nothing is
// written back, and every one of them is scoped to github.com — a GitHub
// Enterprise credential is never sent to this endpoint.
//
// SECURITY: the OAuth token is sent only to api.github.com and is never
// logged, echoed into an error, or copied into this app's config.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const {
  fail, rateLimited, reading, toMs, readJsonFile, buildHeaders, classifyNetworkError,
} = require('./shared');

const USER_URL = 'https://api.github.com/copilot_internal/user';
const API_VERSION = '2025-04-01';
const GH_TOKEN_TIMEOUT_MS = 4_000;

function configDir(home = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'github-copilot');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'github-copilot');
}

// Both files map a host key to { user, oauth_token }; apps.json keys are
// "<host>:<oauth app client id>", hosts.json keys are the bare host.
//
// Only a github.com entry is ever used. These files routinely also hold a
// GitHub Enterprise token, and USER_URL is hardcoded to api.github.com — so
// taking "the first entry with a token" would send an enterprise credential to
// a host it was never issued for. A machine with only a GHES entry has no
// credential for *this* endpoint, and says so.
function tokenFromEntries(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const entry = Object.entries(obj).find(([k, v]) => ((k === 'github.com' || k.startsWith('github.com:'))
    && v && typeof v.oauth_token === 'string' && v.oauth_token
  ));
  return entry ? entry[1].oauth_token : null;
}

function tokenFromFiles(dir, fsImpl = fs) {
  for (const name of ['apps.json', 'hosts.json']) {
    const t = tokenFromEntries(readJsonFile(path.join(dir, name), fsImpl));
    if (t) return t;
  }
  return null;
}

// `gh auth token` prints the token on stdout and nothing else. Run with an
// argv array (never a shell string) and a short timeout, exactly like the
// custom command meter does; a missing gh, a signed-out gh, or a slow one all
// come back as "no token" rather than an error.
//
// `--hostname github.com` is not optional: without it `gh` hands back whatever
// host it considers current, which on a machine configured for GitHub
// Enterprise is an enterprise token — and USER_URL is api.github.com. A
// non-zero exit here means "not signed in to github.com", which is exactly the
// answer wanted.
const GH_TOKEN_ARGS = ['auth', 'token', '--hostname', 'github.com'];
function tokenFromGhCli(run = execFile, timeout = GH_TOKEN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      run('gh', GH_TOKEN_ARGS, { timeout, windowsHide: true, shell: false, maxBuffer: 64 * 1024 },
        (err, stdout) => finish(err ? null : (String(stdout ?? '').trim() || null)));
    } catch (_) { finish(null); }
  });
}

async function findToken({ dir, fsImpl, run }) {
  return tokenFromFiles(dir, fsImpl) ?? await tokenFromGhCli(run);
}

// The snapshot that can actually run out. On a paid plan chat and completions
// are `unlimited`, and premium_interactions is the meter people watch; on the
// free tier it is the other way round. So: the first snapshot with a real
// quota wins, in the order below, and its own name becomes the window label.
const SNAPSHOT_ORDER = [
  ['premium_interactions', 'premium'],
  ['chat', 'chat'],
  ['completions', 'completions'],
];

function usableSnapshot(snapshots) {
  if (!snapshots || typeof snapshots !== 'object') return null;
  for (const [key, label] of SNAPSHOT_ORDER) {
    const s = snapshots[key];
    if (!s || typeof s !== 'object' || s.unlimited === true) continue;
    if (typeof s.percent_remaining !== 'number' || !Number.isFinite(s.percent_remaining)) continue;
    return { snapshot: s, label };
  }
  return null;
}

// percent_remaining is what is left; the widget speaks percent used.
// quota_reset_date is a bare "YYYY-MM-DD", which Date.parse reads as midnight
// UTC — the same instant GitHub rolls the monthly allowance over.
function normalizeUser(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return fail('unexpected response from Copilot');
  const found = usableSnapshot(body.quota_snapshots);
  if (!found) return fail('Copilot: no metered quota on this plan');
  const out = reading({
    pct5h: 100 - found.snapshot.percent_remaining,
    resets5h: toMs(body.quota_reset_date),
  }, now);
  return { ...out, windowLabel: found.label };
}

async function collectCopilot({
  token = null, fetchFn = fetch, now = Date.now(), fsImpl = fs, run = execFile,
  env = process.env, home = os.homedir(), platform = process.platform, dir = null,
} = {}) {
  const oauth = token || await findToken({ dir: dir || configDir(home, platform, env), fsImpl, run });
  // No credential discovered: never reach the network.
  if (!oauth) return fail('Copilot: not signed in — run `gh auth login`');
  // Built before the try, never inside it: undici's header validation error
  // quotes the whole offending value, so a credential with a stray newline in
  // it would otherwise be printed on the card (see buildHeaders in shared.js).
  const headers = buildHeaders({
    Authorization: `token ${oauth}`,
    Accept: 'application/json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'gauge',
  });
  if (!headers) return fail('Copilot: invalid credential');
  let res;
  try {
    res = await fetchFn(USER_URL, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (e) { return fail(classifyNetworkError(e)); }
  if (res.status === 401 || res.status === 403) return fail('Copilot: token rejected — run `gh auth login`');
  if (res.status === 404) return fail('Copilot: no subscription on this account');
  if (res.status === 429) return rateLimited(res, now);
  if (!res.ok) return fail('Copilot quota endpoint HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (e) { return fail('bad response: ' + e.message); }
  return normalizeUser(body, now);
}

module.exports = {
  collectCopilot, normalizeUser, usableSnapshot, tokenFromEntries, tokenFromFiles, tokenFromGhCli,
  configDir, USER_URL, API_VERSION, GH_TOKEN_ARGS,
};
