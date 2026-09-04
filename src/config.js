const fs = require('fs');
const path = require('path');
const { defaultProviders, withMissingBuiltins } = require('./providers');
const { sanitizeProviders, MAX_PROVIDERS } = require('./settings');

const DEFAULTS = {
  theme: 'glass',
  warnAt: 80,
  alertAt: 95,
  opacity: 1.0,
  scale: 1.0,
  alwaysOnTop: true,
  autoStart: false,
  speakAlerts: false,
  showHistory: true,
  solidBackground: false,
  // The ordered list of usage meters. Entries are
  // { id, enabled, label?, colour?, type?, path?, command?, args? }; order is
  // display order. src/providers.js resolves these into collectors.
  providers: defaultProviders(),
  position: { x: null, y: null },
};

// Only keys still in DEFAULTS survive a load — a key an old config.json
// carries that's no longer part of the schema (e.g. a saved `pulseSeconds`
// from before a later change removed the pulse setting) is silently dropped here
// rather than merged through, so it can't survive into `cfg` and get
// re-persisted on the next save.
const KNOWN_KEYS = Object.keys(DEFAULTS);

function loadConfig(dir) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); }
  catch (_) { saved = {}; }
  const known = {};
  for (const key of KNOWN_KEYS) if (key in saved) known[key] = saved[key];
  return {
    ...DEFAULTS,
    ...known,
    // Both are mutable containers on DEFAULTS — hand back copies so a loaded
    // config can never alias (and then mutate) the defaults themselves.
    // A hand-edited providers list goes through the *same* validator the
    // settings panel's patches do, so its defaults and clamps (the command
    // timeout floor above all) apply whatever route the list arrived by.
    // Then any built-in the saved list predates is appended switched off
    // (withMissingBuiltins), so a meter added by a later release still shows
    // up in the panel's Meters list with a toggle instead of being reachable
    // only by hand-editing this file.
    providers: withMissingBuiltins(sanitizeProviders(known.providers) ?? defaultProviders(), MAX_PROVIDERS,
    ),
    position: { ...DEFAULTS.position, ...(saved.position || {}) },
  };
}

function saveConfig(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

// A fresh copy of the defaults, ignoring whatever is saved on disk. Used by
// screenshot mode so a capture run can't be affected by (or leak) the real
// user config — no warnAt/alertAt/opacity/alwaysOnTop/position bleed-through.
function screenshotConfig() {
  return { ...DEFAULTS, providers: defaultProviders(), position: { ...DEFAULTS.position } };
}

module.exports = { DEFAULTS, loadConfig, saveConfig, screenshotConfig };
