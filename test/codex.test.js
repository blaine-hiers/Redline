const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectCodex, lastRateLimits, normalize } = require('../src/collectors/codex');

// Fixture captured from a real ~/.codex/sessions rollout on 2026-09-02:
// lines are {timestamp, ordinal, type:"event_msg", payload:{type:"token_count",
// rate_limits:{primary:{used_percent, window_minutes:300, resets_at<epoch sec>},
// secondary:{used_percent, window_minutes:10080, resets_at}}}}
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-session.jsonl'), 'utf8');

test('lastRateLimits finds the final rate_limits entry', () => {
  const rl = lastRateLimits(FIXTURE);
  assert.ok(rl.primary);
  assert.strictEqual(typeof rl.primary.used_percent, 'number');
  assert.strictEqual(rl.primary.used_percent, 82); // last line wins
});

test('normalize maps primary->5h and secondary->week, seconds->ms', () => {
  const now = 1788300000000;
  const snap = normalize({
    primary: { used_percent: 77, window_minutes: 300, resets_at: 1788378887 },
    secondary: { used_percent: 45, window_minutes: 10080, resets_at: 1788500000 },
  }, now);
  assert.deepStrictEqual(snap, {
    ok: true, stale: false,
    pct5h: 77, resets5h: 1788378887000,
    pctWeek: 45, resetsWeek: 1788500000000,
    error: null,
  });
});

test('normalize zeroes a window whose reset has passed', () => {
  const snap = normalize({
    primary: { used_percent: 77, window_minutes: 300, resets_at: 1000 },
  }, 2000 * 1000);
  assert.strictEqual(snap.pct5h, 0);
});

test('collectCodex reports error for empty dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-codex-'));
  const snap = collectCodex(dir);
  assert.strictEqual(snap.ok, false);
  assert.match(snap.error, /no codex sessions/i);
});

test('normalize defaults primary->5h and secondary->week when window_minutes absent', () => {
  const snap = normalize({
    primary: { used_percent: 60, resets_at: 4102444800 },
    secondary: { used_percent: 20, resets_at: 4102444800 },
  }, 0);
  assert.strictEqual(snap.pct5h, 60);
  assert.strictEqual(snap.pctWeek, 20);
});

test('collectCodex falls back past a brand-new session with no rate_limits yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-codex-'));
  const day = path.join(dir, '2026', '09', '02');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-old.jsonl'), FIXTURE);
  const fresh = path.join(day, 'rollout-new.jsonl');
  fs.writeFileSync(fresh, '{"type":"session_meta"}\n');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(fresh, future, future); // make it the newest
  const snap = collectCodex(dir, 0);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(snap.pct5h, 82);
});

test('collectCodex end-to-end on fixture tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-codex-'));
  const day = path.join(dir, '2026', '09', '02');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-x.jsonl'), FIXTURE);
  const snap = collectCodex(dir, 0);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(typeof snap.pct5h, 'number');
});
