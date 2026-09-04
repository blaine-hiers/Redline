const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULTS } = require('../src/config');
const { sanitizeConfigPatch, MAX_PROVIDERS } = require('../src/settings');

const cfg = () => ({ ...DEFAULTS });
const ABS = require('path').resolve('/usage/meter.json');

test('passes through valid values for every control key', () => {
  const patch = {
    theme: 'neon', warnAt: 70, alertAt: 90,
    opacity: 0.6, alwaysOnTop: false, autoStart: true, speakAlerts: true, showHistory: false,
    solidBackground: true,
  };
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, patch), patch);
});

test('keeps a valid solidBackground and drops a non-boolean one', () => {
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { solidBackground: true }), { solidBackground: true });
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { solidBackground: 'yes' }), {});
});

test('drops unknown keys', () => {
  const out = sanitizeConfigPatch(DEFAULTS, { theme: 'hud', evil: 'yes', position: { x: 1, y: 1 } });
  assert.deepStrictEqual(out, { theme: 'hud' });
});

// A later change removed the pulseSeconds setting; sanitizeConfigPatch has no case
// for it any more, so it's dropped the same way any other unknown key is.
test('drops a legacy pulseSeconds key as unknown', () => {
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { pulseSeconds: 300 }), {});
});

test('drops a theme not in the known set', () => {
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { theme: 'rainbow' }), {});
});

test('drops wrong-typed values instead of coercing them', () => {
  const out = sanitizeConfigPatch(DEFAULTS, {
    warnAt: '80', opacity: '0.5', alwaysOnTop: 'true', theme: 42,
  });
  assert.deepStrictEqual(out, {});
});

test('clamps warnAt/alertAt to the 1-100 range and rounds', () => {
  // 150 clamps to 100, which then also pushes alertAt (default 95) up to 100
  // via the cross-validation rule — covered on its own below.
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { warnAt: 150 }), { warnAt: 100, alertAt: 100 });
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { warnAt: -5 }), { warnAt: 1 });
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { warnAt: 62.7 }), { warnAt: 63 });
});

test('clamps opacity to the 0.2-1.0 range', () => {
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { opacity: 0.01 }), { opacity: 0.2 });
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { opacity: 5 }), { opacity: 1.0 });
});

test('rejects non-finite numbers', () => {
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { warnAt: NaN }), {});
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { opacity: Infinity }), {});
});

test('bumps alertAt above warnAt when a patch would put alertAt at or below warnAt', () => {
  const out = sanitizeConfigPatch(DEFAULTS, { warnAt: 90, alertAt: 80 });
  assert.strictEqual(out.warnAt, 90);
  assert.ok(out.alertAt > out.warnAt);
});

test('bumps alertAt above the existing cfg.warnAt when only alertAt is patched low', () => {
  const cfg = { ...DEFAULTS, warnAt: 80, alertAt: 95 };
  const out = sanitizeConfigPatch(cfg, { alertAt: 50 });
  assert.ok(out.alertAt > cfg.warnAt);
});

test('caps the alertAt bump at 100 when warnAt is already 100', () => {
  const cfg = { ...DEFAULTS, warnAt: 100, alertAt: 100 };
  const out = sanitizeConfigPatch(cfg, { warnAt: 100, alertAt: 100 });
  assert.strictEqual(out.warnAt, 100);
  assert.strictEqual(out.alertAt, 100);
});

test('leaves a valid alertAt/warnAt pair untouched', () => {
  const out = sanitizeConfigPatch(DEFAULTS, { warnAt: 80, alertAt: 95 });
  assert.deepStrictEqual(out, { warnAt: 80, alertAt: 95 });
});

test('a lone valid warnAt patch is not distorted by an unrelated cfg.alertAt', () => {
  const cfg = { ...DEFAULTS, warnAt: 10, alertAt: 20 };
  const out = sanitizeConfigPatch(cfg, { warnAt: 15 });
  assert.deepStrictEqual(out, { warnAt: 15 });
});

test('empty or non-object patches sanitize to an empty object', () => {
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, {}), {});
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, null), {});
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, undefined), {});
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, 'nope'), {});
});

test('scale is clamped into the 0.6–3.0 zoom range', () => {
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { scale: 1.5 }), { scale: 1.5 });
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { scale: 0.1 }), { scale: 0.6 });
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { scale: 9 }), { scale: 3 });
  assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { scale: '2' }), {});
});

// ---------- a later change: the providers list ----------
test('a valid providers list survives, keeping order and enabled flags', () => {
  const out = sanitizeConfigPatch(cfg(), { providers: [
    { id: 'codex', enabled: false },
    { id: 'claude' },
    { id: 'mylab', type: 'json', path: 'C:/usage/mylab.json', label: 'My Lab', colour: '#7DD3FC' },
  ] });
  assert.deepStrictEqual(out.providers, [
    { id: 'codex', enabled: false },
    { id: 'claude', enabled: true },
    { id: 'mylab', enabled: true, label: 'My Lab', colour: '#7dd3fc', type: 'json', path: 'C:/usage/mylab.json' },
  ]);
});

test('a command meter keeps only string args and a clamped timeout', () => {
  const [p] = sanitizeConfigPatch(cfg(), { providers: [
    { id: 'otherlab', type: 'command', command: 'node', args: ['a', 3, null, 'b'], timeoutMs: 999_999 },
  ] }).providers;
  assert.deepStrictEqual(p.args, ['a', 'b']);
  assert.strictEqual(p.timeoutMs, 60_000);
});

test('junk entries and duplicate ids are dropped, the rest survive', () => {
  const out = sanitizeConfigPatch(cfg(), { providers: [
    null, 'claude', { id: 'BAD ID' }, { id: 'claude' }, { id: 'claude' },
    { id: 'mylab', type: 'json' }, { id: 'otherlab', type: 'weird', command: 'x' }, { id: 'codex' },
  ] });
  assert.deepStrictEqual(out.providers.map((p) => p.id), ['claude', 'codex']);
});

test('a providers patch that survives nothing is dropped entirely', () => {
  assert.ok(!('providers' in sanitizeConfigPatch(cfg(), { providers: [null, 7] })));
  assert.ok(!('providers' in sanitizeConfigPatch(cfg(), { providers: 'claude,codex' })));
  assert.ok(!('providers' in sanitizeConfigPatch(cfg(), { providers: [] })));
});

test('a built-in never picks up a command or path from a patch', () => {
  const [p] = sanitizeConfigPatch(cfg(), { providers: [
    { id: 'claude', type: 'command', command: 'evil.exe', args: ['--pwn'] },
  ] }).providers;
  assert.deepStrictEqual(p, { id: 'claude', enabled: true });
});

test('the providers list is capped', () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push({ id: `m${i}`, type: 'json', path: ABS });
  assert.strictEqual(sanitizeConfigPatch(cfg(), { providers: many }).providers.length, MAX_PROVIDERS);
});

test('a prototype-named id is rejected outright', () => {
  const out = sanitizeConfigPatch(cfg(), { providers: [
    { id: 'constructor', type: 'command', command: 'node' },
    { id: 'hasownproperty', type: 'json', path: ABS },
    { id: 'claude' },
  ] });
  assert.deepStrictEqual(out.providers.map((p) => p.id), ['claude']);
});

test('a json meter path must be absolute', () => {
  const rel = sanitizeConfigPatch(cfg(), { providers: [
    { id: 'mylab', type: 'json', path: 'usage/mylab.json' }, { id: 'claude' },
  ] });
  assert.deepStrictEqual(rel.providers.map((p) => p.id), ['claude']);
  const abs = sanitizeConfigPatch(cfg(), { providers: [{ id: 'mylab', type: 'json', path: `  ${ABS}  ` }] });
  assert.strictEqual(abs.providers[0].path, ABS);
});

// ---------- a later change: pasted credentials ----------
const { redactCfg, keepTokens, MAX_TOKEN } = require('../src/settings');

const TOKEN = 'invented-token-value';

test('a built-in may carry a token and a budget, and nothing else', () => {
  const [p] = sanitizeConfigPatch(cfg(), { providers: [
    { id: 'cursor', token: `  ${TOKEN}  `, budgetUsd: 50, type: 'command', command: 'evil.exe' },
  ] }).providers;
  assert.deepStrictEqual(p, { id: 'cursor', enabled: true, token: TOKEN, budgetUsd: 50 });
});

test('an empty or junk token is dropped, and a long one is cut', () => {
  const patch = (token) => sanitizeConfigPatch(cfg(), { providers: [{ id: 'cursor', token }] }).providers[0];
  assert.strictEqual('token' in patch('   '), false);
  assert.strictEqual('token' in patch(7), false);
  assert.strictEqual(patch('x'.repeat(MAX_TOKEN + 500)).token.length, MAX_TOKEN);
});

test('redactCfg never lets a saved token reach the renderer', () => {
  const saved = { ...cfg(), providers: [{ id: 'claude', enabled: true }, { id: 'cursor', enabled: true, token: TOKEN }] };
  const out = redactCfg(saved);
  assert.deepStrictEqual(out.providers[1], { id: 'cursor', enabled: true, hasToken: true });
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.strictEqual(saved.providers[1].token, TOKEN); // the real cfg is untouched
});

test('a providers patch that never saw the token keeps it', () => {
  const stored = [{ id: 'claude', enabled: true }, { id: 'cursor', enabled: true, token: TOKEN }];
  // what the panel sends back after a reorder: redacted entries, no token
  const patch = { providers: [{ id: 'cursor', enabled: true, hasToken: true }, { id: 'claude', enabled: true }] };
  const out = sanitizeConfigPatch({ ...cfg(), providers: stored }, patch);
  assert.deepStrictEqual(out.providers.map((p) => p.id), ['cursor', 'claude']);
  assert.strictEqual(out.providers[0].token, TOKEN);
});

test('an explicit empty token clears the stored one', () => {
  const stored = [{ id: 'cursor', enabled: true, token: TOKEN }];
  const out = sanitizeConfigPatch({ ...cfg(), providers: stored }, { providers: [{ id: 'cursor', token: '' }] });
  assert.strictEqual('token' in out.providers[0], false);
});

test('a newly typed token replaces the stored one', () => {
  const stored = [{ id: 'cursor', enabled: true, token: TOKEN }];
  const out = sanitizeConfigPatch({ ...cfg(), providers: stored }, { providers: [{ id: 'cursor', token: 'fresh' }] });
  assert.strictEqual(out.providers[0].token, 'fresh');
});

test('keepTokens only ever restores a token onto its own id', () => {
  const out = keepTokens([{ id: 'cursor', enabled: true }, { id: 'grok', enabled: true }],
    [{ id: 'cursor' }, { id: 'grok' }],
    [{ id: 'grok', token: TOKEN }],
  );
  assert.strictEqual('token' in out[0], false);
  assert.strictEqual(out[1].token, TOKEN);
});
