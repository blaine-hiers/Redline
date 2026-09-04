const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseRetryAfter, nextCooldown, onRateLimited, resetBackoff, onCooldown, staleMerge, retryNote,
  RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS, CLAUDE_MIN_INTERVAL_MS, shouldPoll,
} = require('../src/backoff');

// ---------- parseRetryAfter ----------
test('parseRetryAfter reads a numeric seconds header', () => {
  assert.strictEqual(parseRetryAfter('120', 0), 120_000);
});

test('parseRetryAfter reads an HTTP-date header relative to now', () => {
  const now = Date.parse('2026-09-03T00:00:00Z');
  const ms = parseRetryAfter('Thu, 03 Sep 2026 00:05:00 GMT', now);
  assert.strictEqual(ms, 5 * 60_000);
});

test('parseRetryAfter returns null when the header is absent', () => {
  assert.strictEqual(parseRetryAfter(null, 0), null);
  assert.strictEqual(parseRetryAfter(undefined, 0), null);
});

test('parseRetryAfter returns null for garbage values', () => {
  assert.strictEqual(parseRetryAfter('not-a-date-or-number', 0), null);
});

test('parseRetryAfter clamps a past HTTP-date to zero, not negative', () => {
  const now = Date.parse('2026-09-03T00:05:00Z');
  const ms = parseRetryAfter('Thu, 03 Sep 2026 00:00:00 GMT', now);
  assert.strictEqual(ms, 0);
});

test('parseRetryAfter rejects a negative seconds string (does not fall through to Date.parse)', () => {
  assert.strictEqual(parseRetryAfter('-5', Date.now()), null);
});

test('parseRetryAfter rejects a fractional seconds string', () => {
  assert.strictEqual(parseRetryAfter('3.5', Date.now()), null);
});

test('parseRetryAfter rejects an empty string', () => {
  assert.strictEqual(parseRetryAfter('', Date.now()), null);
});

test('parseRetryAfter accepts "0" as an immediate retry', () => {
  assert.strictEqual(parseRetryAfter('0', Date.now()), 0);
});

test('parseRetryAfter rejects an HTTP-date beyond the 24h plausibility cap', () => {
  const now = Date.parse('2026-09-03T00:00:00Z');
  const ms = parseRetryAfter('Fri, 04 Sep 2026 01:00:00 GMT', now); // 25h ahead
  assert.strictEqual(ms, null);
});

test('parseRetryAfter accepts an HTTP-date just under the 24h cap', () => {
  const now = Date.parse('2026-09-03T00:00:00Z');
  const ms = parseRetryAfter('Thu, 03 Sep 2026 23:00:00 GMT', now); // 23h ahead
  assert.strictEqual(ms, 23 * 3600_000);
});

// ---------- nextCooldown ladder ----------
test('nextCooldown starts the ladder at 2m', () => {
  assert.strictEqual(nextCooldown(0), 2 * 60_000);
  assert.strictEqual(nextCooldown(undefined), 2 * 60_000);
});

test('nextCooldown climbs 2m -> 4m -> 8m -> 15m', () => {
  let step = nextCooldown(0);
  assert.strictEqual(step, 2 * 60_000);
  step = nextCooldown(step);
  assert.strictEqual(step, 4 * 60_000);
  step = nextCooldown(step);
  assert.strictEqual(step, 8 * 60_000);
  step = nextCooldown(step);
  assert.strictEqual(step, 15 * 60_000);
});

test('nextCooldown caps at 15m', () => {
  assert.strictEqual(nextCooldown(15 * 60_000), 15 * 60_000);
});

// ---------- onRateLimited / resetBackoff / onCooldown ----------
test('onRateLimited uses the server Retry-After when given', () => {
  const state = onRateLimited(resetBackoff(), 30_000, 1_000);
  assert.strictEqual(state.cooldownUntil, 31_000);
});

test('onRateLimited clamps a too-short Retry-After up to the 30s floor', () => {
  const state = onRateLimited(resetBackoff(), 5_000, 1_000);
  assert.strictEqual(state.cooldownUntil, 1_000 + RETRY_AFTER_MIN_MS);
});

test('onRateLimited clamps a too-long Retry-After down to the 1h cap', () => {
  const state = onRateLimited(resetBackoff(), 7_200_000, 1_000); // 2h
  assert.strictEqual(state.cooldownUntil, 1_000 + RETRY_AFTER_MAX_MS);
});

test('onRateLimited falls back to the ladder when Retry-After is null', () => {
  const state = onRateLimited(resetBackoff(), null, 1_000);
  assert.strictEqual(state.cooldownUntil, 1_000 + 2 * 60_000);
  assert.strictEqual(state.stepMs, 2 * 60_000);
});

test('onRateLimited treats a Retry-After of exactly 0 as no information (falls back to the ladder)', () => {
  const state = onRateLimited(resetBackoff(), 0, 1_000);
  assert.strictEqual(state.cooldownUntil, 1_000 + 2 * 60_000);
  assert.strictEqual(state.stepMs, 2 * 60_000);
});

test('onRateLimited still climbs the ladder across repeated retry-after: 0 responses', () => {
  let state = resetBackoff();
  state = onRateLimited(state, 0, 0);
  assert.strictEqual(state.stepMs, 2 * 60_000);
  state = onRateLimited(state, 0, 0);
  assert.strictEqual(state.stepMs, 4 * 60_000);
});

test('onRateLimited honours a positive Retry-After under the floor by clamping up to it, not discarding it', () => {
  const state = onRateLimited(resetBackoff(), 5_000, 1_000); // '5' seconds
  assert.strictEqual(state.cooldownUntil, 1_000 + RETRY_AFTER_MIN_MS);
});

test('onRateLimited honours a Retry-After within range as-is', () => {
  const state = onRateLimited(resetBackoff(), 120_000, 1_000); // '120' seconds
  assert.strictEqual(state.cooldownUntil, 1_000 + 120_000);
});

test('onRateLimited advances the ladder across repeated fallback failures', () => {
  let state = resetBackoff();
  state = onRateLimited(state, null, 0);
  assert.strictEqual(state.stepMs, 2 * 60_000);
  state = onRateLimited(state, null, 0);
  assert.strictEqual(state.stepMs, 4 * 60_000);
  state = onRateLimited(state, null, 0);
  assert.strictEqual(state.stepMs, 8 * 60_000);
});

test('resetBackoff clears cooldown and ladder position', () => {
  assert.deepStrictEqual(resetBackoff(), { stepMs: 0, cooldownUntil: 0 });
});

test('onCooldown is true only while now is before cooldownUntil', () => {
  assert.strictEqual(onCooldown({ cooldownUntil: 1000 }, 500), true);
  assert.strictEqual(onCooldown({ cooldownUntil: 1000 }, 1000), false);
  assert.strictEqual(onCooldown({ cooldownUntil: 1000 }, 1500), false);
  assert.strictEqual(onCooldown(null, 500), false);
});

// ---------- staleMerge ----------
test('staleMerge copies lastGood, forces ok/stale, and sets the reason', () => {
  const good = { ok: true, stale: false, pct5h: 42, resets5h: 999, pctWeek: 10, resetsWeek: 111, error: null };
  const merged = staleMerge(good, 'retrying in 8m');
  assert.deepStrictEqual(merged, { ok: true, stale: true, pct5h: 42, resets5h: 999, pctWeek: 10, resetsWeek: 111, error: 'retrying in 8m' });
});

test('staleMerge never mutates the lastGood object it is given', () => {
  const good = { ok: true, stale: false, pct5h: 42, resets5h: 999, pctWeek: 10, resetsWeek: 111, error: null };
  const snapshot = JSON.stringify(good);
  staleMerge(good, 'retrying in 8m');
  assert.strictEqual(JSON.stringify(good), snapshot);
});

test('staleMerge returns null when there is no lastGood to fall back on', () => {
  assert.strictEqual(staleMerge(null, 'retrying in 8m'), null);
});

// ---------- retryNote ----------
test('retryNote renders a short relative countdown', () => {
  const now = 0;
  assert.strictEqual(retryNote(8 * 60_000, now), 'rate limited · retrying in 8m');
});

test('retryNote rounds up to the next whole minute', () => {
  assert.strictEqual(retryNote(90_000, 0), 'rate limited · retrying in 2m');
});

test('retryNote returns null once the cooldown has already elapsed', () => {
  assert.strictEqual(retryNote(1000, 5000), null);
});

test('retryNote reflects the ladder wait after a retry-after: 0 response, not "0s"', () => {
  const state = onRateLimited(resetBackoff(), 0, 0); // retry-after: 0 -> ladder's first rung, 2m
  assert.strictEqual(retryNote(state.cooldownUntil, 0), 'rate limited · retrying in 2m');
});

// ---------- shouldPoll ----------
test('shouldPoll polls immediately on startup (lastAttemptAt 0)', () => {
  assert.strictEqual(shouldPoll(0, 1_000, false, CLAUDE_MIN_INTERVAL_MS), true);
});

test('shouldPoll declines a poll inside the 5-minute floor', () => {
  const lastAttemptAt = 1_000;
  const now = lastAttemptAt + CLAUDE_MIN_INTERVAL_MS - 1;
  assert.strictEqual(shouldPoll(lastAttemptAt, now, false, CLAUDE_MIN_INTERVAL_MS), false);
});

test('shouldPoll allows a poll once the 5-minute floor has fully elapsed', () => {
  const lastAttemptAt = 1_000;
  const now = lastAttemptAt + CLAUDE_MIN_INTERVAL_MS;
  assert.strictEqual(shouldPoll(lastAttemptAt, now, false, CLAUDE_MIN_INTERVAL_MS), true);
});

test('shouldPoll force bypasses the floor', () => {
  const lastAttemptAt = 1_000;
  const now = lastAttemptAt + 1; // barely any time elapsed
  assert.strictEqual(shouldPoll(lastAttemptAt, now, true, CLAUDE_MIN_INTERVAL_MS), true);
});
