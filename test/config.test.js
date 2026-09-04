const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, saveConfig, screenshotConfig, DEFAULTS } = require('../src/config');
const { BUILTIN_IDS } = require('../src/providers');
const { MAX_PROVIDERS } = require('../src/settings');

test('loadConfig returns defaults when file missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  assert.deepStrictEqual(loadConfig(dir), DEFAULTS);
});

test('saveConfig then loadConfig round-trips and merges defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  saveConfig(dir, { ...DEFAULTS, theme: 'neon', opacity: 0.6 });
  const cfg = loadConfig(dir);
  assert.strictEqual(cfg.theme, 'neon');
  assert.strictEqual(cfg.opacity, 0.6);
  assert.strictEqual(cfg.warnAt, 80);
});

// A later change removed the pulseSeconds setting. A config.json saved by an older
// build can still carry it on disk; loadConfig must drop it rather than
// merge it through, and since the returned cfg no longer has the key, a
// later saveConfig(cfg) can't write it back either.
test('loadConfig drops a legacy pulseSeconds key from an old config.json and does not carry it forward', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...DEFAULTS, pulseSeconds: 300 }));
  const cfg = loadConfig(dir);
  assert.strictEqual('pulseSeconds' in cfg, false);
  assert.deepStrictEqual(cfg, DEFAULTS);
  saveConfig(dir, cfg);
  const rewritten = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual('pulseSeconds' in rewritten, false);
});

test('loadConfig survives corrupt json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{nope');
  assert.deepStrictEqual(loadConfig(dir), DEFAULTS);
});

test('screenshotConfig ignores a saved config entirely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  saveConfig(dir, { ...DEFAULTS, warnAt: 10, alertAt: 20, opacity: 0.4, alwaysOnTop: false, position: { x: 500, y: 500 } });
  assert.deepStrictEqual(screenshotConfig(), DEFAULTS); // never even reads `dir`
});

test('screenshotConfig returns a fresh, independently mutable copy each call', () => {
  const a = screenshotConfig();
  a.theme = 'neon';
  a.position.x = 42;
  const b = screenshotConfig();
  assert.strictEqual(b.theme, DEFAULTS.theme);
  assert.strictEqual(b.position.x, DEFAULTS.position.x);
});

// ---------- a later change review: a hand-edited providers list is validated too ----------
test('a loaded providers list goes through the same validator as a panel patch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cfg-'));
  const abs = path.resolve('/usage/mylab.json');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: [
    { id: 'claude' },
    { id: 'otherlab', type: 'command', command: 'node', args: ['x.mjs', 7], timeoutMs: 0 },
    { id: 'mylab', type: 'json', path: 'relative/mylab.json' },
    { id: 'ok', type: 'json', path: abs },
    { id: 'constructor', type: 'command', command: 'node' },
    'junk',
  ] }));
  const { providers } = loadConfig(dir);
  // The entries that survived, in the order they were written, ahead of the
  // built-ins this list never mentioned (appended switched off — below).
  assert.deepStrictEqual(providers.slice(0, 3).map((p) => p.id), ['claude', 'otherlab', 'ok']);
  assert.strictEqual(providers[1].timeoutMs, 1_000); // clamped up off 0, never "no timeout"
  assert.deepStrictEqual(providers[1].args, ['x.mjs']);
});

// ---------- a later change review: a config saved before a built-in existed ----------
// The settings panel lists only what `providers` holds and can't add a
// built-in back, so a meter shipped by a later release has to be merged into
// an existing config or it is unreachable without hand-editing the file.
test('loadConfig appends built-ins a saved config predates, switched off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cfg-'));
  // Exactly what a later change wrote: the only two meters that existed then.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: [
    { id: 'claude', enabled: true },
    { id: 'codex', enabled: true },
  ] }));
  const { providers } = loadConfig(dir);
  assert.deepStrictEqual(providers.slice(0, 2), [
    { id: 'claude', enabled: true }, { id: 'codex', enabled: true },
  ]); // order and state of what was already there, untouched
  const added = providers.slice(2);
  assert.deepStrictEqual(added.map((p) => p.id), BUILTIN_IDS.filter((id) => id !== 'claude' && id !== 'codex'));
  assert.ok(added.every((p) => p.enabled === false)); // never switched on underneath the user
});

test('a built-in switched off by hand is not switched back on by the merge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: [
    { id: 'codex', enabled: false }, { id: 'claude', enabled: true },
  ] }));
  const { providers } = loadConfig(dir);
  assert.deepStrictEqual(providers.slice(0, 2), [
    { id: 'codex', enabled: false }, { id: 'claude', enabled: true },
  ]);
});

test('the merge respects the providers cap rather than growing past it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cfg-'));
  const abs = path.resolve('/usage/m.json');
  const custom = Array.from({ length: MAX_PROVIDERS }, (_, i) => ({ id: `m${i}`, type: 'json', path: abs }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: custom }));
  const { providers } = loadConfig(dir);
  assert.strictEqual(providers.length, MAX_PROVIDERS);
  assert.strictEqual(providers.some((p) => p.id === 'gemini'), false);
});

test('a providers list that survives nothing falls back to the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: [{ id: 'BAD' }, null] }));
  assert.deepStrictEqual(loadConfig(dir).providers, DEFAULTS.providers);
});
