const { test } = require('node:test');
const assert = require('node:assert');
const { alertPhrase, alertsPhrase, summaryPhrase } = require('../src/speech');

const P = [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }];

test('alertPhrase for a warn-level alert', () => {
  const a = { service: 'claude', name: 'Claude', window: '5h', level: 'warn', pct: 82 };
  assert.strictEqual(alertPhrase(a), 'Claude five hour window at 82 percent.');
});

test('alertPhrase for an alert-level alert adds the budget warning', () => {
  const a = { service: 'codex', name: 'Codex', window: 'week', level: 'alert', pct: 96 };
  assert.strictEqual(alertPhrase(a), 'Codex weekly window at 96 percent. Nearly out of budget.');
});

test('alertsPhrase joins multiple alerts into one utterance', () => {
  const alerts = [
    { service: 'claude', name: 'Claude', window: '5h', level: 'warn', pct: 82 },
    { service: 'codex', name: 'Codex', window: '5h', level: 'warn', pct: 81 },
  ];
  assert.strictEqual(alertsPhrase(alerts),
    'Claude five hour window at 82 percent. Codex five hour window at 81 percent.'
  );
});

test('alertsPhrase returns empty string for no alerts', () => {
  assert.strictEqual(alertsPhrase([]), '');
});

test('summaryPhrase reads both services with reset countdowns', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const snap = {
    claude: { ok: true, pct5h: 41, resets5h: now + (2 * 3600 + 10 * 60) * 1000, pctWeek: 63, resetsWeek: now + 86400000 },
    codex: { ok: true, pct5h: 12, resets5h: now + 4 * 3600 * 1000, pctWeek: 30, resetsWeek: now + 86400000 },
  };
  assert.strictEqual(summaryPhrase(snap, P, now),
    'Claude: 5 hour window 41 percent, resets in 2 hours 10 minutes. Weekly 63 percent. '
    + 'Codex: 5 hour window 12 percent, resets in 4 hours. Weekly 30 percent.'
  );
});

test('summaryPhrase reports a failed service as unavailable', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const snap = {
    claude: { ok: false, error: 'token stale' },
    codex: { ok: true, pct5h: 12, resets5h: now + 3600000, pctWeek: 30, resetsWeek: now + 86400000 },
  };
  assert.strictEqual(summaryPhrase(snap, P, now),
    'Claude: unavailable. Codex: 5 hour window 12 percent, resets in 1 hour. Weekly 30 percent.'
  );
});

test('summaryPhrase zeroes a window whose reset already passed, and drops its countdown', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const snap = {
    claude: { ok: true, pct5h: 85, resets5h: now - 1000, pctWeek: 63, resetsWeek: now + 86400000 },
    codex: null,
  };
  assert.strictEqual(summaryPhrase(snap, P, now),
    'Claude: 5 hour window 0 percent. Weekly 63 percent. Codex: unavailable.'
  );
});
