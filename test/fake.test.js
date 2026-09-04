const { test } = require('node:test');
const assert = require('node:assert');
const { fakeSnapshot, fakeHistory } = require('../src/fake');

const P = [{ id: 'claude' }, { id: 'codex' }];

test('fakeSnapshot with a seed is deterministic', () => {
  const a = fakeSnapshot(P, 7);
  const b = fakeSnapshot(P, 7);
  assert.deepStrictEqual([a.claude.pct5h, a.claude.pctWeek, a.codex.pct5h, a.codex.pctWeek],
    [b.claude.pct5h, b.claude.pctWeek, b.codex.pct5h, b.codex.pctWeek],
  );
});

test('fakeSnapshot with different seeds can differ', () => {
  const a = fakeSnapshot(P, 1);
  const b = fakeSnapshot(P, 50);
  assert.notDeepStrictEqual([a.claude.pct5h, a.claude.pctWeek, a.codex.pct5h, a.codex.pctWeek],
    [b.claude.pct5h, b.claude.pctWeek, b.codex.pct5h, b.codex.pctWeek],
  );
});

test('fakeSnapshot without a seed still returns valid percentages', () => {
  const s = fakeSnapshot(P);
  for (const pct of [s.claude.pct5h, s.claude.pctWeek, s.codex.pct5h, s.codex.pctWeek]) {
    assert.ok(pct >= 0 && pct <= 100);
  }
});

test('fakeSnapshot covers exactly the providers it is given', () => {
  assert.deepStrictEqual(Object.keys(fakeSnapshot([], 1)), []);
  assert.deepStrictEqual(Object.keys(fakeSnapshot([{ id: 'gemini' }], 1)), ['gemini']);
  const three = fakeSnapshot([...P, { id: 'gemini' }], 1);
  assert.deepStrictEqual(Object.keys(three), ['claude', 'codex', 'gemini']);
  assert.ok(three.gemini.pct5h >= 0 && three.gemini.pct5h <= 100);
});

test('an unknown provider id gets a stable curve of its own', () => {
  const a = fakeSnapshot([{ id: 'gemini' }], 3).gemini;
  const b = fakeSnapshot([{ id: 'gemini' }], 3).gemini;
  const other = fakeSnapshot([{ id: 'grok' }], 3).grok;
  assert.strictEqual(a.pct5h, b.pct5h);
  assert.notStrictEqual(a.pct5h, other.pct5h);
});

test('fakeHistory writes one pair of columns per provider', () => {
  const h = fakeHistory([...P, { id: 'gemini' }], 1_000_000_000_000);
  assert.ok(h.length > 100);
  for (const key of ['claude.5h', 'claude.wk', 'codex.5h', 'codex.wk', 'gemini.5h', 'gemini.wk']) {
    assert.strictEqual(typeof h[0][key], 'number', key);
  }
});
