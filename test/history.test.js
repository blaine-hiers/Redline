const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  append, prune, series, loadHistory, saveHistory, migrateSample,
  MIN_GAP_MS, RETAIN_MS, MAX_SAMPLES,
} = require('../src/history');

const P = [{ id: 'claude' }, { id: 'codex' }];
const svc = (p5, pw) => ({ ok: true, pct5h: p5, pctWeek: pw, resets5h: 0, resetsWeek: 0, error: null });
const snap = (c, x) => ({ claude: c, codex: x });
const sample = (t, c5, cw, x5, xw) => ({ t, 'claude.5h': c5, 'claude.wk': cw, 'codex.5h': x5, 'codex.wk': xw });

test('append records one pair of columns per provider', () => {
  const h = [];
  assert.strictEqual(append(h, snap(svc(10, 20), svc(30, 40)), P, 1000), true);
  assert.deepStrictEqual(h, [sample(1000, 10, 20, 30, 40)]);
});

test('append stores null for a failed service', () => {
  const h = [];
  append(h, snap({ ok: false, error: 'boom' }, svc(30, 40)), P, 1000);
  assert.deepStrictEqual(h[0], sample(1000, null, null, 30, 40));
});

test('append scales to any number of providers', () => {
  const zero = [];
  append(zero, {}, [], 1000);
  assert.deepStrictEqual(zero, [{ t: 1000 }]);

  const one = [];
  append(one, { codex: svc(5, 6) }, [{ id: 'codex' }], 1000);
  assert.deepStrictEqual(one, [{ t: 1000, 'codex.5h': 5, 'codex.wk': 6 }]);

  const three = [];
  append(three, { ...snap(svc(1, 2), svc(3, 4)), gemini: svc(5, 6) }, [...P, { id: 'gemini' }], 1000);
  assert.deepStrictEqual(three[0], { ...sample(1000, 1, 2, 3, 4), 'gemini.5h': 5, 'gemini.wk': 6 });
});

test('append suppresses samples closer together than MIN_GAP_MS', () => {
  const h = [];
  append(h, snap(svc(1, 1), svc(1, 1)), P, 0);
  assert.strictEqual(append(h, snap(svc(2, 2), svc(2, 2)), P, MIN_GAP_MS - 1), false);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(append(h, snap(svc(3, 3), svc(3, 3)), P, MIN_GAP_MS), true);
  assert.strictEqual(h.length, 2);
});

test('prune drops samples older than RETAIN_MS', () => {
  const now = 10 * RETAIN_MS;
  const h = [sample(now - RETAIN_MS - 1, 1, 1, 1, 1), sample(now - RETAIN_MS, 2, 2, 2, 2), sample(now, 3, 3, 3, 3)];
  prune(h, now);
  assert.deepStrictEqual(h.map((s) => s['claude.5h']), [2, 3]);
});

test('prune hard-caps the sample count, keeping the newest', () => {
  const h = [];
  for (let i = 0; i < MAX_SAMPLES + 50; i += 1) h.push(sample(i, i, null, null, null));
  prune(h, MAX_SAMPLES + 50);
  assert.strictEqual(h.length, MAX_SAMPLES);
  assert.strictEqual(h[h.length - 1]['claude.5h'], MAX_SAMPLES + 49);
  assert.strictEqual(h[0]['claude.5h'], 50);
});

test('series filters by window and keeps nulls', () => {
  const h = [sample(100, 1, 1, 1, 1), sample(200, null, 1, 1, 1), sample(300, 3, 1, 1, 1)];
  assert.deepStrictEqual(series(h, 'claude.5h', 150, 300), [{ t: 200, v: null }, { t: 300, v: 3 }]);
});

test('saveHistory then loadHistory round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  const h = [sample(1, 1, 2, 3, 4)];
  saveHistory(dir, h);
  assert.deepStrictEqual(loadHistory(dir), h);
});

test('loadHistory returns [] for a missing or corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  assert.deepStrictEqual(loadHistory(dir), []);
  fs.writeFileSync(path.join(dir, 'history.json'), '{nope');
  assert.deepStrictEqual(loadHistory(dir), []);
  fs.writeFileSync(path.join(dir, 'history.json'), '{"not":"an array"}');
  assert.deepStrictEqual(loadHistory(dir), []);
});

test('loadHistory drops entries that are not samples', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  const write = (json) => fs.writeFileSync(path.join(dir, 'history.json'), json);

  write('[null]');
  assert.deepStrictEqual(loadHistory(dir), []);

  const good = sample(5, 1, 2, 3, 4);
  write(JSON.stringify([null, good, 'nope', 7, [], {}, { t: 'later' }, { t: null }]));
  assert.deepStrictEqual(loadHistory(dir), [good]);
});

test('a history file full of junk still prunes without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  fs.writeFileSync(path.join(dir, 'history.json'), '[null, null]');
  assert.doesNotThrow(() => prune(loadHistory(dir), 1000));
});

// ---------- a later change: legacy column migration ----------
test('migrateSample renames the four pre-a later change columns', () => {
  assert.deepStrictEqual(migrateSample({ t: 7, c5: 1, cw: 2, x5: 3, xw: 4 }),
    sample(7, 1, 2, 3, 4),
  );
});

test('migrateSample leaves an already-migrated sample untouched (same object)', () => {
  const s = sample(7, 1, 2, 3, 4);
  assert.strictEqual(migrateSample(s), s);
});

test('migrateSample keeps a new-name column that is already present', () => {
  const out = migrateSample({ t: 7, c5: 1, 'claude.5h': 9 });
  assert.deepStrictEqual(out, { t: 7, 'claude.5h': 9 });
});

test('loadHistory migrates a pre-a later change history.json once, on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([
    { t: 1, c5: 10, cw: 20, x5: 30, xw: 40 },
    { t: 2, c5: null, cw: 21, x5: 31, xw: 41 },
  ]));
  const loaded = loadHistory(dir);
  assert.deepStrictEqual(loaded, [sample(1, 10, 20, 30, 40), sample(2, null, 21, 31, 41)]);
  // and the next save writes only the new names
  saveHistory(dir, loaded);
  assert.ok(!fs.readFileSync(path.join(dir, 'history.json'), 'utf8').includes('"c5"'));
  assert.deepStrictEqual(series(loaded, 'claude.5h', 10, 5), [{ t: 1, v: 10 }, { t: 2, v: null }]);
});
