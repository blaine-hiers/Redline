const { test } = require('node:test');
const assert = require('node:assert');
const { computeAlerts, worstLevel } = require('../src/alerts');

const cfg = { warnAt: 80, alertAt: 95 };
const P = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }];
const svc = (pct5h, pctWeek = 10) => ({ ok: true, pct5h, pctWeek });

test('warn fires when crossing warnAt upward', () => {
  const out = computeAlerts({ claude: svc(75), codex: svc(10) }, { claude: svc(82), codex: svc(10) }, cfg, P);
  assert.deepStrictEqual(out, [{ service: 'claude', name: 'Claude', window: '5h', level: 'warn', pct: 82 }]);
});

test('no repeat while staying above threshold', () => {
  const out = computeAlerts({ claude: svc(82) }, { claude: svc(85) }, cfg, P);
  assert.deepStrictEqual(out, []);
});

test('alert supersedes warn on a single jump', () => {
  const out = computeAlerts({ claude: svc(50) }, { claude: svc(96) }, cfg, P);
  assert.deepStrictEqual(out, [{ service: 'claude', name: 'Claude', window: '5h', level: 'alert', pct: 96 }]);
});

test('re-arms after window reset (pct dropped)', () => {
  const a = computeAlerts({ claude: svc(85) }, { claude: svc(5) }, cfg, P);
  assert.deepStrictEqual(a, []);
  const b = computeAlerts({ claude: svc(5) }, { claude: svc(81) }, cfg, P);
  assert.strictEqual(b.length, 1);
});

test('missing prev treated as 0; null pct ignored', () => {
  assert.strictEqual(computeAlerts(null, { claude: svc(85) }, cfg, P).length, 1);
  assert.strictEqual(computeAlerts(null, { claude: svc(null) }, cfg, P).length, 0);
});

test('worstLevel picks max across services/windows', () => {
  assert.strictEqual(worstLevel({ claude: svc(50), codex: svc(96) }, cfg, P), 'alert');
  assert.strictEqual(worstLevel({ claude: svc(85), codex: svc(10) }, cfg, P), 'warn');
  assert.strictEqual(worstLevel({ claude: svc(10), codex: svc(10) }, cfg, P), 'ok');
});

// ---------- a later change: N providers, not a hardcoded pair ----------
test('no providers means no alerts and no level', () => {
  assert.deepStrictEqual(computeAlerts({}, { claude: svc(99) }, cfg, []), []);
  assert.strictEqual(worstLevel({ claude: svc(99) }, cfg, []), 'ok');
});

test('one provider only reports on itself', () => {
  const one = [{ id: 'codex', label: 'Codex' }];
  assert.deepStrictEqual(computeAlerts({}, { claude: svc(99), codex: svc(10) }, cfg, one), []);
  assert.strictEqual(worstLevel({ claude: svc(99), codex: svc(10) }, cfg, one), 'ok');
});

test('a third provider alerts like any other, and carries its own name', () => {
  const three = [...P, { id: 'gemini', label: 'Gemini' }];
  const out = computeAlerts({}, { gemini: svc(96) }, cfg, three);
  assert.deepStrictEqual(out, [{ service: 'gemini', name: 'Gemini', window: '5h', level: 'alert', pct: 96 }]);
  assert.strictEqual(worstLevel({ gemini: svc(85) }, cfg, three), 'warn');
});

test('alerts come back in provider (display) order, both windows each', () => {
  const three = [...P, { id: 'gemini', label: 'Gemini' }];
  const next = { claude: svc(96, 96), codex: svc(85, 10), gemini: svc(10, 99) };
  const out = computeAlerts({}, next, cfg, three);
  assert.deepStrictEqual(out.map((a) => `${a.service}/${a.window}/${a.level}`), [
    'claude/5h/alert', 'claude/week/alert', 'codex/5h/warn', 'gemini/week/alert',
  ]);
});
