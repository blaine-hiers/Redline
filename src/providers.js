// The meter registry: one place that turns `cfg.providers` into the ordered
// list of usage meters the rest of the app loops over. Before a later change the
// pair "claude, codex" was hardcoded in pulse(), alerts, speech, history, the
// sparkline payload, the tray tooltip and all four layouts; now every one of
// those iterates whatever this returns.
//
// A resolved provider is:
//   { id, label, colour, enabled, minIntervalMs, windows, collect() -> Promise<result> }
// where `result` is the same shape every collector already produced:
//   { ok, stale, pct5h, resets5h, pctWeek, resetsWeek, error, retryAfterMs? }
//
// `windows` is how a meter whose limits aren't a 5h and a weekly
// window says so: [{ key, label }, { key, label }] renames the two slots in
// every layout ("day"/"month" instead of "5h"/"week"), and a null label in the
// second slot means the service has no second window at all, so the layouts
// leave that line out rather than printing "week —". Claude and Codex carry no
// `windows`, which keeps their rows byte-identical to what the screenshots pin.

const { collectClaude } = require('./collectors/claude');
const { collectCodex } = require('./collectors/codex');
const { collectGemini } = require('./collectors/gemini');
const { collectCopilot } = require('./collectors/copilot');
const { collectCursor } = require('./collectors/cursor');
const { collectGrok } = require('./collectors/grok');
const { collectOpenai } = require('./collectors/openai');
const { collectDeepseek } = require('./collectors/deepseek');
const { createCustomCollector, clampTimeout } = require('./collectors/custom');
const { CLAUDE_MIN_INTERVAL_MS } = require('./backoff');

// Ids become object keys (the per-id snapshot map) and history column names
// (`<id>.5h` / `<id>.wk`), so they must be a single flat token — no dots, no
// whitespace, nothing that could collide with the `at`/`services` keys the
// snapshot itself uses.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Snapshot payload keys an id would collide with, plus the Object.prototype
// member names. Ids index plain objects in several places, and every one of
// those lookups is now an own-property check — but an id that *spells* a
// prototype member is confusing enough on its own that it is refused outright.
const RESERVED_IDS = new Set([
  'at', 'services', 'history', 'cfg', 'theme',
  'constructor', 'prototype', '__proto__', 'tostring', 'valueof',
  'hasownproperty', 'isprototypeof', 'propertyisenumerable', 'tolocalestring',
]);
const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

const isValidId = (id) => typeof id === 'string' && ID_RE.test(id) && !RESERVED_IDS.has(id);

// The first-party meters. `colour` is only a fallback for skins that have no
// rule of their own — themes.css still owns the per-theme palette for Claude
// and Codex, so their rendering is untouched by the registry.
//
// Everything added by a later change ships `enabledByDefault: false`: it appears in
// the settings panel's Meters list with a toggle, but a fresh install still
// draws exactly the two rows it always has (which is also what keeps the
// committed screenshots byte-identical). `acceptsToken: true` means the panel
// offers a "Token" field for that meter — the fallback for when the tool's own
// credential can't be found on disk.
const BUILTINS = {
  claude: {
    label: 'Claude',
    colour: '#e07a52',
    // The Claude usage endpoint isn't built for per-minute polling,
    // so its collector is called at most this often. Previously a bare
    // constant read straight out of backoff.js by pulse(); now it is just a
    // provider option, and any provider may set one.
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS,
    collect: () => collectClaude(),
  },
  codex: {
    label: 'Codex',
    colour: '#5ac8fa',
    minIntervalMs: 0,
    collect: () => Promise.resolve(collectCodex()),
  },
  // ---- a later change: every one of these ships off, and none has been verified
  // against a live account. Each collector's header cites the source its
  // endpoint and response shape came from. ----
  gemini: {
    label: 'Gemini',
    colour: '#7dd3fc',
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS, // a quota RPC, not a free local read
    enabledByDefault: false,
    acceptsToken: true,
    tokenHint: 'optional — a Code Assist access token',
    windows: [{ key: 'pct5h', label: 'day' }, { key: 'pctWeek', label: null }],
    collect: (opts) => collectGemini(opts),
  },
  copilot: {
    label: 'Copilot',
    colour: '#c9a3ff',
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS,
    enabledByDefault: false,
    acceptsToken: true,
    tokenHint: 'optional — a GitHub OAuth token',
    // The window label is overridden per reading (windowsFor below): which
    // snapshot is metered depends on the plan.
    windows: [{ key: 'pct5h', label: 'premium' }, { key: 'pctWeek', label: null }],
    collect: (opts) => collectCopilot(opts),
  },
  cursor: {
    label: 'Cursor',
    colour: '#8fd6b4',
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS,
    enabledByDefault: false,
    acceptsToken: true,
    tokenHint: 'WorkosCursorSessionToken cookie',
    windows: [{ key: 'pct5h', label: 'month' }, { key: 'pctWeek', label: null }],
    collect: (opts) => collectCursor(opts),
  },
  grok: {
    label: 'Grok',
    colour: '#9ae06a',
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS,
    enabledByDefault: false,
    acceptsToken: true,
    tokenHint: 'grok.com sso cookie',
    // Grok's window is rolling and its length only comes back in the response,
    // so this label is replaced per reading (windowsFor below).
    windows: [{ key: 'pct5h', label: 'day' }, { key: 'pctWeek', label: null }],
    collect: (opts) => collectGrok(opts),
  },
  openai: {
    label: 'OpenAI',
    colour: '#74d7c4',
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS,
    enabledByDefault: false,
    acceptsToken: true,
    tokenHint: 'organization admin key (sk-admin-…)',
    windows: [{ key: 'pct5h', label: 'month' }, { key: 'pctWeek', label: null }],
    collect: (opts) => collectOpenai(opts),
  },
  deepseek: {
    label: 'DeepSeek',
    colour: '#7f9cf5',
    minIntervalMs: CLAUDE_MIN_INTERVAL_MS,
    enabledByDefault: false,
    acceptsToken: true,
    tokenHint: 'API key',
    // A prepaid balance, not a window — hence no reset countdown and no
    // second slot.
    windows: [{ key: 'pct5h', label: 'balance' }, { key: 'pctWeek', label: null }],
    collect: (opts) => collectDeepseek(opts),
  },
};

const BUILTIN_IDS = Object.keys(BUILTINS);

// What a fresh config starts with: every built-in, in registry order, each
// enabled or not per its own `enabledByDefault`. Disabled entries are still
// listed so the panel's Meters section can offer them a toggle — resolveProviders
// drops them, so nothing disabled is ever polled or drawn.
const DEFAULT_PROVIDERS = BUILTIN_IDS.map((id) => ({ id, enabled: BUILTINS[id].enabledByDefault !== false }));

const defaultProviders = () => DEFAULT_PROVIDERS.map((p) => ({ ...p }));

// A config.json written before a built-in existed carries no entry for it —
// and the settings panel only ever lists what `providers` holds, with no way
// to put a built-in back (its "Add custom meter" form makes json/command
// meters only). So every built-in the saved list doesn't mention is appended
// here, which is what makes a meter a later release adds reachable on an
// install that already has a config: without this, everything a later change ships
// would be invisible to anyone who had run the widget once.
//
// Appended entries are always `enabled: false`, never `enabledByDefault`: a
// built-in missing from a saved list was taken out by hand, and switching it
// back on underneath someone would be a surprise. A fresh config still starts
// from defaultProviders() above, so Claude and Codex are on out of the box.
// `max` is the cap sanitizeProviders already applies, so a list that is
// already at the limit gains nothing rather than growing past it.
function withMissingBuiltins(list, max = Infinity) {
  const out = Array.isArray(list) ? list.slice() : [];
  const seen = new Set(out.map((p) => p && p.id));
  for (const id of BUILTIN_IDS) {
    if (out.length >= max) break;
    if (!seen.has(id)) out.push({ id, enabled: false });
  }
  return out;
}

// The per-meter options a config entry may carry into a built-in collector.
// `token` is the pasted-credential fallback for meters whose tool keeps its
// credential somewhere this app can't read; `budgetUsd` turns a source that
// only reports dollars into a percentage of a ceiling the user picked. Both
// are optional and neither is ever logged or sent back to the renderer (see
// redactProviders in settings.js).
function builtinOptions(entry) {
  const opts = {};
  if (typeof entry.token === 'string' && entry.token) opts.token = entry.token;
  if (typeof entry.budgetUsd === 'number' && Number.isFinite(entry.budgetUsd) && entry.budgetUsd > 0) {
    opts.budgetUsd = entry.budgetUsd;
  }
  return opts;
}

// One config entry → one resolved provider, or null when the entry names
// neither a built-in nor a usable custom type. A hand-edited config.json can
// hold anything, and a junk entry must be dropped rather than crash a pulse.
function resolveProvider(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const { id } = entry;
  if (!isValidId(id)) return null;
  const enabled = entry.enabled !== false;
  // Own-property only: a plain `BUILTINS[id]` would treat id "constructor" as
  // a built-in and hand back a provider whose collect() is undefined.
  const builtin = Object.hasOwn(BUILTINS, id) ? BUILTINS[id] : null;
  if (builtin) {
    const options = builtinOptions(entry);
    return {
      id,
      label: typeof entry.label === 'string' && entry.label ? entry.label : builtin.label,
      colour: COLOUR_RE.test(entry.colour || '') ? entry.colour : builtin.colour,
      enabled,
      minIntervalMs: builtin.minIntervalMs,
      windows: builtin.windows ?? null,
      collect: () => builtin.collect(options),
    };
  }
  if (entry.type !== 'json' && entry.type !== 'command') return null;
  if (entry.type === 'json' && typeof entry.path !== 'string') return null;
  if (entry.type === 'command' && typeof entry.command !== 'string') return null;
  const timeoutMs = clampTimeout(entry.timeoutMs);
  return {
    id,
    label: typeof entry.label === 'string' && entry.label ? entry.label : id,
    colour: COLOUR_RE.test(entry.colour || '') ? entry.colour : '#9aa4b8',
    enabled,
    minIntervalMs: 0,
    windows: null, // a custom meter's payload is defined as 5h + week (see README)
    timeoutMs,
    collect: createCustomCollector({ ...entry, timeoutMs }),
  };
}

// Two of the new meters only learn what their window is called from the
// response itself — Grok's is rolling and its length comes back in the payload,
// and which Copilot snapshot is metered depends on the plan — so a collector
// may return a `windowLabel` that replaces the registry's static first label
// for that reading. Everything else keeps the registry's own labels, and a
// provider with no `windows` (Claude, Codex, any custom meter) keeps none.
function windowsFor(provider, data) {
  const windows = (provider && provider.windows) || null;
  if (!windows) return null;
  const label = data && typeof data.windowLabel === 'string' && data.windowLabel ? data.windowLabel : null;
  if (!label) return windows;
  return [{ ...windows[0], label }, ...windows.slice(1)];
}

// Static registry facts the settings panel needs for *every* built-in, enabled
// or not: a disabled meter never reaches `services`, so without this the
// Meters list would show its bare id and no Token field. Colours and labels
// only — nothing here is derived from the user's config.
function builtinMeta() {
  const out = {};
  for (const [id, b] of Object.entries(BUILTINS)) {
    out[id] = {
      label: b.label,
      colour: b.colour,
      acceptsToken: b.acceptsToken === true,
      tokenHint: b.tokenHint ?? null,
    };
  }
  return out;
}

// A collector that never settles must not hold the pulse open — pulse() keeps
// its `pulsing` guard for the whole await, so one hung meter would freeze
// every meter for the life of the process. Each collect() is therefore raced
// against a hard deadline: its own timeout plus slack (a well-behaved command
// collector kills its child first and reports that), capped so no provider
// option can push a pulse past MAX_COLLECT_MS.
const COLLECT_SLACK_MS = 5_000;
const MAX_COLLECT_MS = 90_000;

const failResult = (error) => ({
  ok: false, stale: true, pct5h: null, resets5h: null, pctWeek: null, resetsWeek: null,
  error, retryAfterMs: null, // ladder-only backoff
});

function collectDeadlineMs(provider) {
  const own = provider && provider.timeoutMs;
  const base = typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : MAX_COLLECT_MS;
  return Math.min(MAX_COLLECT_MS, base + COLLECT_SLACK_MS);
}

function collectWithDeadline(provider, deadlineMs = collectDeadlineMs(provider)) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(failResult('meter timed out')), deadlineMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // never hold the process open
  });
  // A user-configured collector is third-party code: a throw (or a missing
  // collect()) must degrade that one meter, not take the whole pulse down.
  const attempt = Promise.resolve()
    .then(() => provider.collect())
    .then((r) => (r && typeof r === 'object' ? r : failResult('meter returned no reading')))
    .catch(() => failResult('meter failed'));
  return Promise.race([attempt, guard]).finally(() => clearTimeout(timer));
}

// The ordered list of *enabled* providers — what pulse() and the renderer
// iterate. Config order is display order.
function resolveProviders(list) {
  const entries = Array.isArray(list) && list.length ? list : defaultProviders();
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const p = resolveProvider(entry);
    if (!p || seen.has(p.id)) continue; // a duplicate id would collide in the snapshot map
    seen.add(p.id);
    if (p.enabled) out.push(p);
  }
  return out;
}

module.exports = {
  BUILTINS, BUILTIN_IDS, DEFAULT_PROVIDERS, ID_RE, RESERVED_IDS, COLOUR_RE,
  COLLECT_SLACK_MS, MAX_COLLECT_MS,
  isValidId, defaultProviders, withMissingBuiltins, resolveProvider, resolveProviders,
  collectDeadlineMs, collectWithDeadline, builtinOptions, builtinMeta, windowsFor,
};
