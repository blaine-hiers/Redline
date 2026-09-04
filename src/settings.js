// Pure validation/clamp for a partial config patch coming off either the
// context menu or the in-widget settings panel — both surfaces route through
// this so they can't drift. Never touches disk or IPC.

const { THEME_IDS: THEMES } = require('../renderer/themelist');
const { clampScale } = require('../renderer/sizing');
const path = require('path');
const { BUILTINS, COLOUR_RE, isValidId } = require('./providers');
const { MIN_TIMEOUT_MS, MAX_TIMEOUT_MS } = require('./collectors/custom');

const BOOL_KEYS = ['alwaysOnTop', 'autoStart', 'speakAlerts', 'showHistory', 'solidBackground'];

// A later change ships every built-in in the list, most of them disabled, so the cap
// is no longer a cap on *rows* — a disabled meter is a checkbox in the panel,
// never a row on the card. It only has to stay above "every built-in plus a
// few of your own".
const MAX_PROVIDERS = 16;
const MAX_LABEL = 24;
const MAX_ARGS = 16;
// A pasted credential. Long enough for a JWT or a session cookie, short enough
// that a paste accident can't bloat config.json.
const MAX_TOKEN = 4096;
// A credential is a single header value, so any control character in it — a
// newline picked up from a sloppy copy out of the dev tools above all — makes
// it unusable. It is dropped rather than stripped: silently editing a
// credential and then failing to authenticate is worse than asking for it
// again, and undici's own complaint about it quotes the whole value.
const CONTROL_RE = /[\x00-\x1f\x7f]/;

// The pasted credential a built-in entry may keep, or null.
//
// Two things are refused rather than stored. A meter that has no credential to
// accept (`acceptsToken` unset — Claude and Codex read their own files, and a
// custom meter has no token at all) must not persist one a hand-edited
// config.json put there: it would be a secret sitting in a file with nothing
// that could ever use it. And a value carrying a control character isn't a
// usable header value at all, so it is dropped at the door — the collectors
// refuse it a second time (buildHeaders in collectors/shared.js), but that
// second line only exists because config.json can be edited by hand.
function usableToken(value, builtin) {
  if (!builtin || builtin.acceptsToken !== true) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || CONTROL_RE.test(trimmed)) return null;
  return trimmed.slice(0, MAX_TOKEN);
}

// Structural validator for one `providers` entry. Everything the user can
// name here ends up either in the DOM (label/colour) or in an execFile call
// (command/args/path), so nothing is coerced: a field that isn't the right
// type is dropped, and an entry missing what its type needs is dropped whole.
function sanitizeProvider(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (!isValidId(entry.id)) return null;
  const out = { id: entry.id, enabled: entry.enabled !== false };
  if (typeof entry.label === 'string' && entry.label.trim()) out.label = entry.label.trim().slice(0, MAX_LABEL);
  if (typeof entry.colour === 'string' && COLOUR_RE.test(entry.colour)) out.colour = entry.colour.toLowerCase();
  // Own-property only: `BUILTINS['constructor']` is truthy on a plain object,
  // which would strip a custom meter's type/path/command and leave the
  // registry with nothing to collect from.
  if (Object.hasOwn(BUILTINS, entry.id)) {
    // A built-in never carries a type/path/command, but it may carry the two
    // per-meter collector options (src/providers.js builtinOptions): a pasted
    // credential, and the dollar ceiling a spend-based source is measured
    // against. An empty-string token is dropped, which is how the panel clears
    // a saved one.
    const token = usableToken(entry.token, BUILTINS[entry.id]);
    if (token) out.token = token;
    const budget = clampNum(entry.budgetUsd, 1, 1_000_000);
    if (budget != null) out.budgetUsd = budget;
    return out;
  }
  if (entry.type === 'json') {
    // Absolute only: a relative path would be resolved against the process's
    // cwd, which for a packaged app is wherever it happened to be launched
    // from — the same config would read a different file on different days.
    if (typeof entry.path !== 'string' || !entry.path.trim() || !path.isAbsolute(entry.path.trim())) return null;
    out.type = 'json';
    out.path = entry.path.trim();
    return out;
  }
  if (entry.type === 'command') {
    if (typeof entry.command !== 'string' || !entry.command.trim()) return null;
    out.type = 'command';
    out.command = entry.command;
    out.args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string').slice(0, MAX_ARGS) : [];
    const t = clampNum(entry.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (t != null) out.timeoutMs = Math.round(t);
    return out;
  }
  return null; // unknown custom type
}

// The whole list. Junk entries and duplicate ids are dropped rather than
// rejecting the patch, so one bad row from a hand-edited config.json can't
// take the user's other meters down with it. An entirely empty result is
// rejected (returns undefined) — a widget with no meters is a blank card.
function sanitizeProviders(v) {
  if (!Array.isArray(v)) return undefined;
  const out = [];
  const seen = new Set();
  for (const entry of v.slice(0, MAX_PROVIDERS)) {
    const clean = sanitizeProvider(entry);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    out.push(clean);
  }
  return out.length ? out : undefined;
}

function clampNum(v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

// ---------- pasted credentials ----------
// A saved token is never sent to the renderer (redactProviders below), so the
// providers list the panel sends back has no `token` on any entry it didn't
// just have one typed into. Merging the stored value back in here is what
// keeps "reorder the meters" from silently wiping a credential.
//
// `token: ''` is how the panel clears one deliberately — an entry that carries
// the key at all (even empty) is taken at its word, so only an entry with no
// `token` key inherits the stored one.
function keepTokens(clean, rawList, prev) {
  const stored = new Map((Array.isArray(prev) ? prev : []).map((p) => [p && p.id, p && p.token]));
  const raw = new Map((Array.isArray(rawList) ? rawList : []).map((p) => [p && p.id, p]));
  return clean.map((entry) => {
    if (entry.token) return entry; // a freshly typed one
    const sent = raw.get(entry.id);
    if (sent && typeof sent.token === 'string') return entry; // '' — cleared on purpose
    const kept = stored.get(entry.id);
    return typeof kept === 'string' && kept ? { ...entry, token: kept } : entry;
  });
}

// The `cfg` the snapshot carries into the renderer, with every pasted
// credential replaced by the single bit the Meters list actually needs: is one
// saved? The token itself never crosses the IPC boundary, never reaches the
// DOM, and so can't end up in a devtools dump or a screenshot.
function redactProviders(providers) {
  if (!Array.isArray(providers)) return providers;
  return providers.map((p) => {
    if (!p || typeof p !== 'object' || typeof p.token !== 'string' || !p.token) return p;
    const { token, ...rest } = p;
    return { ...rest, hasToken: true };
  });
}

function redactCfg(cfg) {
  return { ...cfg, providers: redactProviders(cfg.providers) };
}

// Sanitizes one incoming key at a time: unknown keys and wrong-typed or
// out-of-set values are dropped rather than coerced. Numeric range keys are
// clamped into range instead of dropped, since "82.7" and "150" both have a
// sensible in-range meaning.
function sanitizeValue(key, v) {
  switch (key) {
    case 'theme':
      return typeof v === 'string' && THEMES.includes(v) ? v : undefined;
    case 'warnAt':
    case 'alertAt': {
      const n = clampNum(v, 1, 100);
      return n == null ? undefined : Math.round(n);
    }
    case 'opacity':
      return clampNum(v, 0.2, 1.0) ?? undefined;
    case 'scale':
      return clampScale(v) ?? undefined;
    case 'providers':
      return sanitizeProviders(v);
    default:
      if (BOOL_KEYS.includes(key)) return typeof v === 'boolean' ? v : undefined;
      return undefined; // unknown key
  }
}

// Sanitizes a whole patch against the current cfg (used to resolve
// alertAt/warnAt cross-validation when only one of the pair is patched).
// Returns a partial object containing only the keys that survived — ready
// to Object.assign onto cfg.
function sanitizeConfigPatch(cfg, patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};
  for (const key of Object.keys(patch)) {
    const v = sanitizeValue(key, patch[key]);
    if (v !== undefined) out[key] = v;
  }
  if ('warnAt' in out || 'alertAt' in out) {
    const warn = 'warnAt' in out ? out.warnAt : cfg.warnAt;
    const alert = 'alertAt' in out ? out.alertAt : cfg.alertAt;
    if (alert <= warn) out.alertAt = Math.min(100, warn + 1);
  }
  if ('providers' in out) out.providers = keepTokens(out.providers, patch.providers, cfg.providers);
  return out;
}

module.exports = {
  sanitizeConfigPatch, sanitizeProvider, sanitizeProviders, keepTokens, usableToken,
  redactCfg, redactProviders, MAX_PROVIDERS, MAX_TOKEN, THEMES,
};
