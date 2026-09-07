const { test } = require('node:test');
const assert = require('node:assert');
const {
  resolveProvider, resolveProviders, defaultProviders, isValidId, BUILTIN_IDS,
  collectWithDeadline, collectDeadlineMs, COLLECT_SLACK_MS, MAX_COLLECT_MS,
} = require('../src/providers');

test('the default config resolves to the two built-ins, in order', () => {
  const out = resolveProviders(defaultProviders());
  assert.deepStrictEqual(out.map((p) => p.id), ['claude', 'codex']);
  assert.deepStrictEqual(out.map((p) => p.label), ['Claude', 'Codex']);
  for (const p of out) assert.strictEqual(typeof p.collect, 'function');
});

// Every built-in is listed in the defaults so the panel can offer it a toggle,
// but only the two that ship enabled are ever resolved.
const DEFAULT_ENABLED = defaultProviders().filter((p) => p.enabled).map((p) => p.id);

test('an empty or non-array providers list falls back to the enabled built-ins', () => {
  assert.deepStrictEqual(DEFAULT_ENABLED, ['claude', 'codex']);
  assert.ok(BUILTIN_IDS.length > DEFAULT_ENABLED.length);
  assert.deepStrictEqual(resolveProviders([]).map((p) => p.id), DEFAULT_ENABLED);
  assert.deepStrictEqual(resolveProviders(null).map((p) => p.id), DEFAULT_ENABLED);
  assert.deepStrictEqual(resolveProviders('nope').map((p) => p.id), DEFAULT_ENABLED);
});

test('config order is display order, and disabled meters are dropped', () => {
  const out = resolveProviders([{ id: 'codex' }, { id: 'claude', enabled: false }]);
  assert.deepStrictEqual(out.map((p) => p.id), ['codex']);
  const both = resolveProviders([{ id: 'codex' }, { id: 'claude' }]);
  assert.deepStrictEqual(both.map((p) => p.id), ['codex', 'claude']);
});

test('only Claude carries a poll floor', () => {
  const [claude, codex] = resolveProviders(defaultProviders());
  assert.ok(claude.minIntervalMs > 0);
  assert.strictEqual(codex.minIntervalMs, 0);
});

test('a built-in may be relabelled and recoloured without becoming custom', () => {
  const [p] = resolveProviders([{ id: 'claude', label: 'Anthropic', colour: '#123456' }]);
  assert.strictEqual(p.label, 'Anthropic');
  assert.strictEqual(p.colour, '#123456');
});

test('junk entries are dropped rather than throwing', () => {
  for (const junk of [null, 7, 'claude', {}, { id: '' }, { id: 'Bad Id' }, { id: 'has.dot' }, { id: 'at' }]) {
    assert.strictEqual(resolveProvider(junk), null, JSON.stringify(junk));
  }
  // an unknown id with no usable custom type is not a provider
  assert.strictEqual(resolveProvider({ id: 'mylab' }), null);
  assert.strictEqual(resolveProvider({ id: 'mylab', type: 'json' }), null); // no path
  assert.strictEqual(resolveProvider({ id: 'mylab', type: 'command' }), null); // no command
});

test('a duplicate id is kept once', () => {
  const out = resolveProviders([{ id: 'claude' }, { id: 'claude' }, { id: 'codex' }]);
  assert.deepStrictEqual(out.map((p) => p.id), ['claude', 'codex']);
});

test('a custom json meter resolves with a collect() and a default colour', () => {
  const [p] = resolveProviders([{ id: 'mylab', type: 'json', path: 'x.json', label: 'My Lab' }]);
  assert.strictEqual(p.id, 'mylab');
  assert.strictEqual(p.label, 'My Lab');
  assert.strictEqual(p.colour, '#9aa4b8');
  assert.strictEqual(typeof p.collect, 'function');
});

test('a custom meter with no label falls back to its id', () => {
  const [p] = resolveProviders([{ id: 'otherlab', type: 'command', command: 'node' }]);
  assert.strictEqual(p.label, 'otherlab');
});

test('three providers resolve to three, in config order', () => {
  const out = resolveProviders([
    { id: 'claude' }, { id: 'codex' }, { id: 'mylab', type: 'json', path: 'g.json' },
  ]);
  assert.deepStrictEqual(out.map((p) => p.id), ['claude', 'codex', 'mylab']);
});

test('isValidId rejects the snapshot payload keys it would collide with', () => {
  assert.ok(isValidId('mylab'));
  assert.ok(!isValidId('at'));
  assert.ok(!isValidId('services'));
  assert.ok(!isValidId('UPPER'));
});

// ---------- a later change review: a hung collector must not hold the pulse ----------
// A literal `new Promise(() => {})` models a hung collector accurately but leaves a
// forever-pending promise behind, and Node 20's test runner reports that as
// "Promise resolution is still pending but the event loop has already resolved",
// failing the rest of the file. So each stuck collector hands back its resolver and
// the test releases it once the assertions are done: the collector is still hung for
// the whole of the window under test, and nothing is left pending afterwards.
function hungCollector() {
  let release = null;
  const collect = () => new Promise((resolve) => { release = resolve; });
  // Resolving is necessary but not sufficient. The collector's promise sits at the
  // head of a .then chain inside collectWithDeadline, and that chain needs the
  // microtask queue to drain before nothing is pending. A macrotask tick is the
  // simplest thing that guarantees it.
  const settle = async () => {
    if (release) release(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { collect, settle };
}

test('collectWithDeadline gives up on a collector that never settles', async () => {
  const stuck = hungCollector();
  const p = { id: 'stuck', collect: stuck.collect };
  const out = await collectWithDeadline(p, 20);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.stale, true);
  assert.strictEqual(out.retryAfterMs, null); // ladder only
  assert.match(out.error, /timed out/);
  await stuck.settle();
});

test('one hung meter does not stop the others resolving in the same pass', async () => {
  const good = { pct5h: 12, ok: true };
  const stuck = hungCollector();
  const list = [
    { id: 'stuck', collect: stuck.collect },
    { id: 'fine', collect: () => Promise.resolve(good) },
    { id: 'thrower', collect: () => { throw new Error('boom'); } },
  ];
  const settled = await Promise.all(list.map((p) => collectWithDeadline(p, 20)));
  assert.strictEqual(settled[0].ok, false);
  assert.match(settled[0].error, /timed out/);
  assert.strictEqual(settled[1], good);
  assert.strictEqual(settled[2].ok, false);
  assert.match(settled[2].error, /meter failed/);
  await stuck.settle();
});

test('collectWithDeadline survives a collector that is missing or returns junk', async () => {
  assert.strictEqual((await collectWithDeadline({ id: 'x' }, 20)).ok, false);
  assert.match((await collectWithDeadline({ id: 'x', collect: () => 'nope' }, 20)).error, /no reading/);
});

test('the deadline is bounded by MAX_COLLECT_MS whatever a provider asks for', () => {
  assert.strictEqual(collectDeadlineMs({ timeoutMs: 5_000 }), 5_000 + COLLECT_SLACK_MS);
  assert.strictEqual(collectDeadlineMs({ timeoutMs: 10 ** 9 }), MAX_COLLECT_MS);
  assert.strictEqual(collectDeadlineMs({}), MAX_COLLECT_MS);
  assert.strictEqual(collectDeadlineMs({ timeoutMs: 0 }), MAX_COLLECT_MS);
});

// ---------- a later change review: prototype-named ids ----------
test('a prototype member name is not a built-in and not a valid id', () => {
  for (const id of ['constructor', 'prototype', 'tostring', 'hasownproperty', 'valueof']) {
    assert.ok(!isValidId(id), id);
    assert.strictEqual(resolveProvider({ id, type: 'json', path: 'C:/x.json' }), null, id);
  }
});

test('no accepted provider ever comes back without a usable collect()', () => {
  const accepted = resolveProviders([
    { id: 'claude' }, { id: 'codex' },
    { id: 'mylab', type: 'json', path: 'C:/usage/mylab.json' },
    { id: 'otherlab', type: 'command', command: 'node', args: ['x.mjs'] },
    { id: 'constructor', type: 'command', command: 'node' },
    { id: 'tostring' },
  ]);
  assert.deepStrictEqual(accepted.map((p) => p.id), ['claude', 'codex', 'mylab', 'otherlab']);
  for (const p of accepted) assert.strictEqual(typeof p.collect, 'function', p.id);
});

test('a custom command meter carries a clamped timeout into its collector', () => {
  const [p] = resolveProviders([{ id: 'otherlab', type: 'command', command: 'node', timeoutMs: 0 }]);
  assert.strictEqual(p.timeoutMs, 10_000); // the default, not 0
});

// ---------- a later change: default-off built-ins, per-meter options, window labels ----------
const { BUILTINS, builtinOptions, builtinMeta, windowsFor } = require('../src/providers');

test('every a later change built-in ships disabled, so the default card is unchanged', () => {
  const off = defaultProviders().filter((p) => !p.enabled).map((p) => p.id);
  assert.deepStrictEqual(off, ['gemini', 'copilot', 'cursor', 'grok', 'openai', 'deepseek']);
  for (const id of off) assert.strictEqual(BUILTINS[id].enabledByDefault, false, id);
});

test('a disabled built-in is listed in the defaults but never resolved', () => {
  assert.ok(defaultProviders().some((p) => p.id === 'cursor'));
  assert.ok(!resolveProviders(defaultProviders()).some((p) => p.id === 'cursor'));
  // ...and turning it on in config is all it takes
  const [p] = resolveProviders([{ id: 'cursor', enabled: true }]);
  assert.strictEqual(p.id, 'cursor');
  assert.strictEqual(typeof p.collect, 'function');
});

test('every built-in that declares windows maps its own two slots', () => {
  for (const [id, b] of Object.entries(BUILTINS)) {
    if (!b.windows) { assert.ok(id === 'claude' || id === 'codex', id); continue; }
    assert.strictEqual(b.windows.length, 2, id);
    assert.deepStrictEqual(b.windows.map((w) => w.key), ['pct5h', 'pctWeek'], id);
    assert.strictEqual(typeof b.windows[0].label, 'string', id);
  }
  // Claude and Codex carry none, which is what keeps their markup identical.
  const [claude, codex] = resolveProviders(defaultProviders());
  assert.strictEqual(claude.windows, null);
  assert.strictEqual(codex.windows, null);
});

test('builtinOptions passes only a usable token and budget through', () => {
  assert.deepStrictEqual(builtinOptions({ id: 'cursor' }), {});
  assert.deepStrictEqual(builtinOptions({ token: 'abc', budgetUsd: 50 }), { token: 'abc', budgetUsd: 50 });
  assert.deepStrictEqual(builtinOptions({ token: '', budgetUsd: 0 }), {});
  assert.deepStrictEqual(builtinOptions({ token: 7, budgetUsd: 'x' }), {});
});

test('a config entry token reaches the collector and nothing else does', async () => {
  const seen = [];
  const stub = { label: 'X', colour: '#111111', minIntervalMs: 0, collect: (o) => { seen.push(o); return Promise.resolve({ ok: true }); } };
  const saved = BUILTINS.cursor;
  BUILTINS.cursor = stub;
  try {
    const [p] = resolveProviders([{ id: 'cursor', token: 'sekrit', budgetUsd: 25, label: 'Mine' }]);
    await p.collect();
    assert.deepStrictEqual(seen, [{ token: 'sekrit', budgetUsd: 25 }]);
  } finally { BUILTINS.cursor = saved; }
});

test('builtinMeta describes every built-in without leaking a collector', () => {
  const meta = builtinMeta();
  assert.deepStrictEqual(Object.keys(meta), BUILTIN_IDS);
  assert.deepStrictEqual(meta.claude, { label: 'Claude', colour: '#e07a52', acceptsToken: false, tokenHint: null });
  assert.strictEqual(meta.cursor.acceptsToken, true);
  for (const m of Object.values(meta)) assert.strictEqual(m.collect, undefined);
});

test('windowsFor lets a reading rename its own first window', () => {
  const p = { windows: [{ key: 'pct5h', label: 'day' }, { key: 'pctWeek', label: null }] };
  assert.strictEqual(windowsFor(p, { ok: true }), p.windows); // no override, same object
  assert.deepStrictEqual(windowsFor(p, { windowLabel: '2h' }), [
    { key: 'pct5h', label: '2h' }, { key: 'pctWeek', label: null },
  ]);
  assert.strictEqual(windowsFor({ windows: null }, { windowLabel: '2h' }), null);
  assert.strictEqual(windowsFor(p, null), p.windows);
});
