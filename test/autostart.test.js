const { test } = require('node:test');
const assert = require('node:assert');
const { loginItemSettings } = require('../src/autostart');

test('unpackaged: runs electron.exe against the app dir with --hidden', () => {
  const cfg = { autoStart: true };
  const ctx = { isPackaged: false, execPath: 'C:\\electron\\electron.exe', appPath: 'C:\\repo\\redline' };
  assert.deepStrictEqual(loginItemSettings(cfg, ctx), {
    openAtLogin: true,
    path: 'C:\\electron\\electron.exe',
    args: ['"C:\\repo\\redline"', '--hidden'],
  });
});

test('unpackaged: quotes an appPath containing a space so it survives as one argv token', () => {
  const cfg = { autoStart: true };
  const ctx = { isPackaged: false, execPath: 'C:\\electron\\electron.exe', appPath: 'C:\\Users\\Some One\\repo\\redline' };
  assert.deepStrictEqual(loginItemSettings(cfg, ctx), {
    openAtLogin: true,
    path: 'C:\\electron\\electron.exe',
    args: ['"C:\\Users\\Some One\\repo\\redline"', '--hidden'],
  });
});

test('packaged: just --hidden, no explicit path/exe args', () => {
  const cfg = { autoStart: true };
  const ctx = { isPackaged: true, execPath: 'C:\\Program Files\\Redline\\Redline.exe', appPath: 'C:\\Program Files\\Redline\\resources\\app.asar' };
  assert.deepStrictEqual(loginItemSettings(cfg, ctx), {
    openAtLogin: true,
    args: ['--hidden'],
  });
});

test('autoStart false: openAtLogin is false', () => {
  const cfg = { autoStart: false };
  const ctx = { isPackaged: true, execPath: 'C:\\app.exe', appPath: 'C:\\app' };
  const out = loginItemSettings(cfg, ctx);
  assert.strictEqual(out.openAtLogin, false);
});
