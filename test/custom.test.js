const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeCustom, collectJsonFile, collectCommand, createCustomCollector,
  clampTimeout, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS,
} = require('../src/collectors/custom');

const NOW = Date.parse('2026-09-03T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lp-custom-'));

// ---------- shape ----------
test('normalizeCustom reads the documented shape', () => {
  const out = normalizeCustom({
    pct5h: 41, resetsAt5h: '2026-09-03T14:00:00Z',
    pctWeek: 63, resetsAtWeek: '2026-09-06T00:00:00Z',
  }, NOW);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 41);
  assert.strictEqual(out.pctWeek, 63);
  assert.strictEqual(out.resets5h, Date.parse('2026-09-03T14:00:00Z'));
  assert.strictEqual(out.resetsWeek, Date.parse('2026-09-06T00:00:00Z'));
  assert.strictEqual(out.error, null);
});

test('normalizeCustom accepts epoch seconds and epoch milliseconds', () => {
  const secs = normalizeCustom({ pct5h: 10, resetsAt5h: NOW / 1000 + 3600 }, NOW);
  const ms = normalizeCustom({ pct5h: 10, resetsAt5h: NOW + 3600_000 }, NOW);
  assert.strictEqual(secs.resets5h, NOW + 3600_000);
  assert.strictEqual(ms.resets5h, NOW + 3600_000);
});

test('normalizeCustom clamps percentages and zeroes a window whose reset has passed', () => {
  assert.strictEqual(normalizeCustom({ pct5h: 140 }, NOW).pct5h, 100);
  assert.strictEqual(normalizeCustom({ pct5h: -5 }, NOW).pct5h, 0);
  assert.strictEqual(normalizeCustom({ pct5h: 88, resetsAt5h: NOW - 1 }, NOW).pct5h, 0);
});

test('normalizeCustom rejects a payload with neither percentage', () => {
  for (const junk of [null, 7, 'nope', [], {}, { pct5h: 'high' }]) {
    const out = normalizeCustom(junk, NOW);
    assert.strictEqual(out.ok, false, JSON.stringify(junk));
    assert.strictEqual(out.retryAfterMs, null); // ladder-only backoff, never a server wait
  }
});

test('a meter that only knows its 5h window is fine', () => {
  const out = normalizeCustom({ pct5h: 12 }, NOW);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pctWeek, null);
  assert.strictEqual(out.resetsWeek, null);
});

// ---------- json file ----------
test('collectJsonFile reads a file the user maintains', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.json');
  fs.writeFileSync(file, JSON.stringify({ pct5h: 33, pctWeek: 44 }));
  const out = collectJsonFile({ filePath: file, now: NOW });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 33);
});

test('collectJsonFile is mtime-aware: an unchanged file is not re-read', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.json');
  fs.writeFileSync(file, JSON.stringify({ pct5h: 10 }));
  const cache = {};
  let reads = 0;
  const fsImpl = {
    statSync: fs.statSync,
    readFileSync: (...a) => { reads += 1; return fs.readFileSync(...a); },
  };
  collectJsonFile({ filePath: file, now: NOW, fsImpl }, cache);
  collectJsonFile({ filePath: file, now: NOW, fsImpl }, cache);
  assert.strictEqual(reads, 1);
});

test('collectJsonFile picks up a changed file', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage.json');
  fs.writeFileSync(file, JSON.stringify({ pct5h: 10 }));
  const collect = createCustomCollector({ type: 'json', path: file });
  return collect().then((first) => {
    assert.strictEqual(first.pct5h, 10);
    fs.writeFileSync(file, JSON.stringify({ pct5h: 77, pctWeek: 5 }));
    return collect().then((second) => {
      assert.strictEqual(second.pct5h, 77);
      assert.strictEqual(second.pctWeek, 5);
    });
  });
});

test('collectJsonFile fails softly on a missing file, a bad path, and bad JSON', () => {
  const dir = tmp();
  const missing = collectJsonFile({ filePath: path.join(dir, 'nope.json'), now: NOW });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.retryAfterMs, null);
  assert.strictEqual(collectJsonFile({ filePath: '', now: NOW }).ok, false);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  const out = collectJsonFile({ filePath: bad, now: NOW });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /bad JSON/);
});

// ---------- command ----------
const NODE = process.execPath;

test('collectCommand parses stdout from a real child process', async () => {
  const out = await collectCommand({
    command: NODE,
    args: ['-e', 'process.stdout.write(JSON.stringify({pct5h:55,pctWeek:22}))'],
    now: NOW,
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.pct5h, 55);
  assert.strictEqual(out.pctWeek, 22);
});

test('a non-zero exit takes the stale/ladder path and never leaks the child output', async () => {
  const out = await collectCommand({
    command: NODE,
    args: ['-e', 'process.stderr.write("SECRET-TOKEN"); process.exit(3)'],
    now: NOW,
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.stale, true);
  assert.strictEqual(out.retryAfterMs, null); // ladder only
  assert.ok(!out.error.includes('SECRET-TOKEN'));
});

test('stdout that is not the documented JSON fails softly', async () => {
  const out = await collectCommand({ command: NODE, args: ['-e', 'process.stdout.write("hello")'], now: NOW });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /bad JSON/);
});

test('a missing command fails softly instead of throwing', async () => {
  assert.strictEqual((await collectCommand({ command: '', now: NOW })).ok, false);
  const out = await collectCommand({ command: 'definitely-not-a-real-binary-xyz', args: [], now: NOW });
  assert.strictEqual(out.ok, false);
});

test('the command is spawned with an argv array, never a shell string', async () => {
  let seen = null;
  const run = (cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(null, '{"pct5h":1}'); };
  await collectCommand({ command: 'my prog', args: ['a b; rm -rf /', '$(x)'], run, now: NOW });
  assert.strictEqual(seen.cmd, 'my prog');
  assert.deepStrictEqual(seen.args, ['a b; rm -rf /', '$(x)']);
  assert.strictEqual(seen.opts.shell, false);
  assert.strictEqual(seen.opts.windowsHide, true);
  assert.ok(seen.opts.timeout > 0);
  assert.ok(seen.opts.maxBuffer > 0);
});

test('non-string arguments are dropped rather than coerced', async () => {
  let seen = null;
  const run = (cmd, args, opts, cb) => { seen = args; cb(null, '{"pct5h":1}'); };
  await collectCommand({ command: 'x', args: ['ok', 7, null, { a: 1 }], run, now: NOW });
  assert.deepStrictEqual(seen, ['ok']);
});

test('a timeout is reported as a timeout', async () => {
  const run = (cmd, args, opts, cb) => { const e = new Error('killed'); e.killed = true; cb(e, ''); };
  const out = await collectCommand({ command: 'x', run, now: NOW });
  assert.match(out.error, /timed out/);
});

// ---------- a later change review: the timeout can never be disabled ----------
test('clampTimeout turns every unusable value into a real duration', () => {
  for (const junk of [0, null, undefined, -1, NaN, Infinity, 'ten', {}]) {
    assert.strictEqual(clampTimeout(junk), DEFAULT_TIMEOUT_MS, String(junk));
  }
  assert.strictEqual(clampTimeout(1), MIN_TIMEOUT_MS);
  assert.strictEqual(clampTimeout(999_999), MAX_TIMEOUT_MS);
  assert.strictEqual(clampTimeout(5_000), 5_000);
});

test('collectCommand clamps a timeoutMs a hand-edited config could supply', async () => {
  const seen = [];
  const run = (cmd, args, opts, cb) => { seen.push(opts.timeout); cb(null, '{"pct5h":1}'); };
  for (const junk of [0, null, -5, Infinity]) {
    await collectCommand({ command: 'x', timeoutMs: junk, run, now: NOW });
  }
  await collectCommand({ command: 'x', timeoutMs: 999_999, run, now: NOW });
  assert.deepStrictEqual(seen, [
    DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
  ]);
  for (const t of seen) assert.ok(t > 0 && Number.isFinite(t));
});
