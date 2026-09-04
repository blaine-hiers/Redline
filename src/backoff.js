// Per-service 429 backoff: pure functions, no Electron/network. main.js owns
// the mutable { claude, codex } state and calls these to advance it.

const LADDER_MS = [2, 4, 8, 15].map((m) => m * 60_000); // 2m -> 4m -> 8m -> 15m (cap)

// Retry-After per RFC 9110: either a whole number of (non-negative, integer)
// seconds, or an HTTP-date. Returns milliseconds to wait from `now`, or null
// when absent/unparseable/implausible.
//
// Deliberately strict: only a bare non-negative integer is treated as
// delta-seconds ("-5" and "3.5" are rejected, not leniently coerced), and a
// string is only handed to Date.parse when it plausibly looks like an
// HTTP-date (contains a letter) — Date.parse otherwise parses garbage like
// "-5" into a bogus date decades out. Any parsed result beyond
// RETRY_AFTER_ACCEPT_CAP_MS is also rejected so one malformed/hostile header
// can't stall a service far past what a real server would ever ask for; the
// caller falls back to the fixed backoff ladder instead.
const RETRY_AFTER_ACCEPT_CAP_MS = 24 * 3600_000; // 24h: beyond this a header is treated as implausible, not trusted

function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue == null) return null;
  const trimmed = String(headerValue).trim();
  if (trimmed === '') return null;
  let ms;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else if (/[A-Za-z]/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return null;
    ms = Math.max(0, parsed - now);
  } else {
    return null; // negative, fractional, or other garbage that isn't a plausible HTTP-date
  }
  if (!Number.isFinite(ms) || ms < 0 || ms > RETRY_AFTER_ACCEPT_CAP_MS) return null;
  return ms;
}

// Advances the fallback ladder by one step from a previous step duration
// (0/undefined starts it). Unrecognized input restarts at the first rung
// rather than throwing, since a stale/foreign value should never wedge a
// service's backoff at the cap.
function nextCooldown(prevMs) {
  if (!prevMs) return LADDER_MS[0];
  const idx = LADDER_MS.indexOf(prevMs);
  if (idx === -1) return LADDER_MS[0];
  return LADDER_MS[Math.min(idx + 1, LADDER_MS.length - 1)];
}

function resetBackoff() {
  return { stepMs: 0, cooldownUntil: 0 };
}

// A server-given Retry-After is clamped to this range before it's applied to
// cooldownUntil: 30s floor so a header can't force an immediate re-hit, 1h
// cap so a single (even RFC-valid) header can't out-stall the fallback
// ladder's own 15m cap by more than 4x. parseRetryAfter already rejects
// anything past 24h as implausible; this is the second, tighter line of
// defense against a header value being taken at face value.
const RETRY_AFTER_MIN_MS = 30_000; // 30s
const RETRY_AFTER_MAX_MS = 3600_000; // 1h

// Called once per service on a 429. `retryAfterMs` (server-given, or null)
// sets the actual wait (clamped, see above); `stepMs` tracks the fallback
// ladder position so a run of 429s with no Retry-After still climbs
// 2m -> 4m -> 8m -> 15m even if a Retry-After header shows up on some of them.
//
// A `retryAfterMs` of exactly 0 is treated the same as "absent" (null), not
// as "retry immediately": a persistently rate-limited server that always
// answers `retry-after: 0` would otherwise get re-hit every 30s (the floor)
// instead of backing off up the ladder. Any positive value, even one below
// the floor, is still a real signal from the server and gets clamped up to
// the floor rather than discarded.
function onRateLimited(state, retryAfterMs, now = Date.now()) {
  const stepMs = nextCooldown(state && state.stepMs);
  const hasSignal = retryAfterMs != null && retryAfterMs !== 0;
  const waitMs = hasSignal
    ? Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, retryAfterMs))
    : stepMs;
  return { stepMs, cooldownUntil: now + waitMs };
}

function onCooldown(state, now = Date.now()) {
  return !!(state && now < state.cooldownUntil);
}

// Builds the display object for a service whose live collection failed but
// has a good previous reading: copies lastGood (never mutates it), forces
// ok/stale, and swaps in the short reason.
function staleMerge(lastGood, reason) {
  if (!lastGood) return null;
  return { ...lastGood, ok: true, stale: true, error: reason };
}

// Short meta-line text for a service currently cooling down. Null once the
// cooldown has elapsed (caller falls back to the raw failure's own message).
function retryNote(cooldownUntil, now = Date.now()) {
  const remainMs = cooldownUntil - now;
  if (remainMs <= 0) return null;
  const mins = Math.max(1, Math.ceil(remainMs / 60_000));
  return `rate limited · retrying in ${mins}m`;
}

// The Claude usage endpoint is undocumented, publishes no limit, and
// empirically can't take much more than one poll a minute per account
// — and usage barely moves inside a minute anyway. Independent of
// the general pulse cadence (which still drives Codex, a local file read),
// the Claude collector is called at most once per this interval.
//
// A later change fixed the pulse itself at 6 minutes (PULSE_MS in main.js) and
// removed the user-configurable interval, so a scheduled tick can no longer
// arrive sooner than this floor anyway — shouldPollClaude's floor branch is
// now unreachable outside "Refresh now" (which bypasses it regardless). The
// constant is bumped to match rather than deleted: it's cheap to keep as a
// safety net if the pulse cadence ever changes again, and deleting it would
// mean re-deriving this reasoning from scratch next time.
const CLAUDE_MIN_INTERVAL_MS = 6 * 60_000; // 6m — matches the fixed pulse

// Whether main.js's pulse() should call a provider's collector this tick.
// `lastAttemptAt` is 0 before the first-ever attempt (so startup always
// polls immediately); `force` is the "Refresh now" bypass, which skips the
// floor exactly like it skips the 429 cooldown. Otherwise the floor must
// have fully elapsed since the last attempt (successful or not — this
// tracks attempts, not successes).
//
// A later change made the floor a per-provider option (`minIntervalMs`) rather than
// a Claude-only constant, so a user-added meter that polls something
// expensive can declare its own. A falsy floor means "no floor".
function shouldPoll(lastAttemptAt, now, force, minIntervalMs) {
  if (force || lastAttemptAt === 0 || !minIntervalMs) return true;
  return now - lastAttemptAt >= minIntervalMs;
}

module.exports = {
  LADDER_MS, RETRY_AFTER_ACCEPT_CAP_MS, RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS, CLAUDE_MIN_INTERVAL_MS,
  parseRetryAfter, nextCooldown, resetBackoff, onRateLimited, onCooldown, staleMerge, retryNote, shouldPoll,
};
