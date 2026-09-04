// Generic "any lab" collectors: the two flavours a user can configure from
// the settings panel without a code change. Both produce the same result
// shape every built-in collector does, so main.js/alerts/history/renderer
// treat a custom meter exactly like Claude or Codex.
//
// Expected JSON (from the file, or from the command's stdout):
//   { pct5h, resetsAt5h, pctWeek, resetsAtWeek }
// Percentages are 0-100; the two reset fields accept an ISO string, epoch
// seconds, or epoch milliseconds. Every field is optional — a meter that only
// knows its 5h window is fine.
//
// SECURITY: the command flavour runs an executable the *user* named in their
// own config.json (or the panel's "Add custom meter" form). It is spawned
// with execFile — an argv array, never a shell string — so nothing in a path
// or argument can be interpreted as shell syntax. Nothing from stdout is
// logged or surfaced beyond the parsed numeric fields and a truncated,
// generic parse error.

const fs = require('fs');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10_000;
// A command meter must always run under *some* timeout. These bounds are
// enforced here, at the spawn, as well as in the settings sanitizer — a
// hand-edited config.json reaches this function without passing through the
// panel, and `timeoutMs: 0` would otherwise mean "no timeout at all".
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // a usage blob is a few hundred bytes; anything larger is a mistake

// Anything that isn't a usable positive duration becomes the default; a
// usable one is clamped into range. Never returns 0/Infinity/NaN.
function clampTimeout(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.round(Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, ms)));
}

const fail = (error) => ({
  ok: false, stale: true, pct5h: null, resets5h: null, pctWeek: null, resetsWeek: null,
  error,
  // Non-zero exit / unreadable file / bad JSON all back off up the fixed
  // ladder (2m → 4m → 8m → 15m). `null` rather than a number: a custom source
  // has no Retry-After to offer, so there is never a server-given wait.
  retryAfterMs: null,
});

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

function toPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(100, Math.max(0, v)));
}

// Turns a parsed JSON object into the standard result. A reset that has
// already passed zeroes its percentage, matching the built-in collectors.
function normalizeCustom(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('bad shape — expected a JSON object');
  }
  const r5 = toMs(body.resetsAt5h ?? body.resets5h);
  const rw = toMs(body.resetsAtWeek ?? body.resetsWeek);
  let p5 = toPct(body.pct5h);
  let pw = toPct(body.pctWeek);
  if (p5 === null && pw === null) return fail('bad shape — no pct5h or pctWeek');
  if (r5 !== null && r5 < now) p5 = 0;
  if (rw !== null && rw < now) pw = 0;
  return { ok: true, stale: false, pct5h: p5, resets5h: r5, pctWeek: pw, resetsWeek: rw, error: null };
}

function parseJson(text, now) {
  let body;
  try { body = JSON.parse(text); } catch (_) { return fail('bad JSON from meter source'); }
  return normalizeCustom(body, now);
}

// ---------- JSON file ----------
// mtime-aware: an unchanged file is served from the last parse instead of
// being re-read and re-parsed every pulse. `cache` is per collector instance
// (createCustomCollector below hands each provider its own).
function collectJsonFile(opts, cache = {}) {
  const { filePath, now = Date.now(), fsImpl = fs } = opts;
  if (typeof filePath !== 'string' || filePath === '') return fail('no file path configured');
  let stat;
  try { stat = fsImpl.statSync(filePath); } catch (_) { return fail('meter file unreadable'); }
  if (stat.size > MAX_OUTPUT_BYTES) return fail('meter file too large');
  if (cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && cache.text !== undefined) {
    return parseJson(cache.text, now);
  }
  let text;
  try { text = fsImpl.readFileSync(filePath, 'utf8'); } catch (_) { return fail('meter file unreadable'); }
  cache.mtimeMs = stat.mtimeMs;
  cache.size = stat.size;
  cache.text = text;
  return parseJson(text, now);
}

// ---------- command ----------
// execFile, never exec/shell: `command` is an executable path or name and
// `args` an argv array, so a semicolon or backtick in either is inert.
function collectCommand(opts) {
  const { command, args = [], timeoutMs, now = Date.now(), run = execFile } = opts;
  const timeout = clampTimeout(timeoutMs);
  if (typeof command !== 'string' || command === '') {
    return Promise.resolve(fail('no command configured'));
  }
  const argv = Array.isArray(args) ? args.filter((a) => typeof a === 'string') : [];
  return new Promise((resolve) => {
    run(command, argv, {
      timeout,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
    }, (err, stdout) => {
      // Deliberately terse: the child's own stderr/stdout is never surfaced
      // (it can carry tokens the user's script fetched) — only that it failed.
      if (err) {
        resolve(fail(err.killed ? 'meter command timed out' : 'meter command failed'));
        return;
      }
      resolve(parseJson(String(stdout ?? ''), now));
    });
  });
}

// The collect() a provider registry entry gets: closes over the provider's
// own options and (for the file flavour) its own mtime cache.
function createCustomCollector(spec) {
  if (spec.type === 'command') {
    return () => collectCommand({ command: spec.command, args: spec.args, timeoutMs: spec.timeoutMs });
  }
  const cache = {};
  return () => Promise.resolve(collectJsonFile({ filePath: spec.path }, cache));
}

module.exports = {
  DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES,
  clampTimeout, normalizeCustom, collectJsonFile, collectCommand, createCustomCollector,
};
