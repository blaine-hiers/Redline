let state = null; // last snapshot payload from main
let panelOpen = false; // settings panel replaces the card content while true

// Theme metadata (label, layout, base width) lives in themelist.js, which the
// main process and the settings allowlist read too. Card *heights* aren't
// catalogued — fitWindow() measures whatever was rendered, so an extra row
// (both services, sparklines, a stale note) grows the window instead of being
// clipped off the bottom.


// terminal keeps the bracketed "[⚙]" look the other themes' bare glyph doesn't need.
function cogButton(theme) {
  const glyph = theme === 'terminal' ? '[⚙]' : '⚙';
  return `<button type="button" class="cog" data-open-settings aria-label="Settings">${glyph}</button>`;
}

function fmtCountdown(ms) {
  if (!ms) return '—';
  let s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function effPct(pct, resets) { // zero out client-side once a reset passes
  if (typeof pct !== 'number') return null;
  if (resets && resets < Date.now()) return 0;
  return pct;
}

// The last-24h series (keyed by provider id), or null when there is nothing
// worth drawing. The extra rows grow the card; fitWindow() then grows the
// window to match.
function history() {
  const h = state.history;
  if (!h) return null;
  return (state.services || []).some((s) => Object.hasOwn(h, s.id) && plottable(h[s.id])) ? h : null;
}

// The snapshot's ordered meters, each with its display view. Every layout
// below loops over this — nothing in the renderer knows the name of any
// particular service any more.
function meters() {
  return (state.services || []).map((s) => ({
    id: s.id, label: s.label || s.id, colour: s.colour, w: winLabels(s), v: svcView(s.data),
  }));
}

// A meter's two window labels. `a`/`b` null means "use this
// layout's own wording", which is what Claude and Codex do — their rows stay
// byte-identical to what the committed screenshots pin. A provider that maps
// different windows names them ("day", "month"); one whose second `windows`
// entry has a null label has no second window at all, and `hasB: false` makes
// the layouts leave that line out rather than print "week —".
function winLabels(s) {
  const w = Array.isArray(s.windows) ? s.windows : null;
  if (!w) return { a: null, b: null, hasB: true };
  const b = w[1] && typeof w[1].label === 'string' && w[1].label ? w[1].label : null;
  return { a: (w[0] && w[0].label) || null, b, hasB: b !== null };
}

// The per-meter accent colour has to be a custom property on the row element
// rather than a hardcoded class, so a user-added meter can carry any colour.
// Set from JS (not an inline style= in the markup) after each innerHTML swap;
// themes.css consumes it as var(--accent) and the two built-ins' own rules
// override it, keeping their per-theme palettes exactly as they were.
function paintAccents(list) {
  const colours = new Map(list.map((m) => [m.id, m.colour]));
  for (const el of document.querySelectorAll('#root [data-provider]')) {
    const c = colours.get(el.dataset.provider);
    if (c) el.style.setProperty('--accent', c);
  }
}

function svcView(s) {
  if (!s) return { ok: false, error: 'waiting…', p5: null, pw: null, r5: null, rw: null, stale: false };
  return {
    ok: s.ok, error: s.error, stale: !!s.stale,
    p5: effPct(s.pct5h, s.resets5h), r5: s.resets5h,
    pw: effPct(s.pctWeek, s.resetsWeek), rw: s.resetsWeek,
  };
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pctText = (p) => (p == null ? '—' : `${p}%`);

// ---------- glass ----------
// "5h used" (not "5h window") — both collectors already report a used-percent
// (Codex rate_limits.*.used_percent, Claude utilization); the label used to be
// ambiguous about which convention the number followed.
function rowGlass(name, id, v, spark, w) {
  const pid = ` data-provider="${esc(id)}"`;
  if (!v.ok) {
    return `<div class="row err"${pid}><div class="head"><span class="name"><span class="dot"></span>${name}</span></div><div class="errmsg err-text" title="${esc(v.error)}">${esc(v.error)}</div></div>`;
  }
  const staleCls = v.stale ? ' stale' : '';
  const metaRight = v.stale
    ? `<span class="err-text" title="${esc(v.error)}">${esc(v.error)}</span>`
    : `<span>resets ${fmtCountdown(v.r5)}</span>`;
  const second = w.hasB ? `
    <div class="bar wk"><i style="width:${v.pw ?? 0}%"></i></div>
    <div class="meta"><span>${esc(w.b ?? 'week')}</span><span>${pctText(v.pw)}</span></div>` : '';
  return `<div class="row${staleCls}"${pid}>
    <div class="head"><span class="name"><span class="dot"></span>${name}</span><span class="pct">${pctText(v.p5)}</span></div>
    <div class="bar"><i style="width:${v.p5 ?? 0}%"></i></div>
    <div class="meta"><span>${esc(w.a ?? '5h')} used</span>${metaRight}</div>
    ${spark}${second}
  </div>`;
}
function renderGlass(list, _cfg, h) {
  const sp = (id) => (h ? `<div class="sparkrow">${sparkline(h[id], 244, 20)}</div>` : '');
  const rows = list.map((m) => rowGlass(esc(m.label.toUpperCase()), m.id, m.v, sp(m.id), m.w));
  return `<div class="w-glass">${cogButton('glass')}${rows.join('<div class="divider"></div>')}</div>`;
}

// ---------- terminal ----------
// The terminal layout's bar glyphs, per skin: the LCD skin swaps the filled/empty
// pair for handheld-style segment blocks. Text, so it can't be done in CSS.
const TERM_GLYPHS = { terminal: ['█', '░'], lcd: ['▮', '▯'] };
function blocks(p, glyphs, n = 20) {
  const filled = p == null ? 0 : Math.round((p / 100) * n);
  return '[' + glyphs[0].repeat(filled) + glyphs[1].repeat(n - filled) + ']';
}
function rowsTerm(name, id, v, warnAt, spark, glyphs, w, cols) {
  const pid = ` data-provider="${esc(id)}"`;
  if (!v.ok) return `<div class="line"${pid}><span>${name} !!</span><span class="errtext err-text" title="${esc(v.error)}">${esc(v.error)}</span></div>`;
  const staleCls = v.stale ? ' stale' : '';
  const hot5 = v.p5 != null && v.p5 >= warnAt ? 'hot' : '';
  const hotW = v.pw != null && v.pw >= warnAt ? 'hot' : '';
  const resetLine = v.stale
    ? `<div class="line${staleCls} dim"${pid}><span>&nbsp;&nbsp;reset</span><span class="err-text" title="${esc(v.error)}">${esc(v.error)}</span></div>`
    : `<div class="line dim"${pid}><span>&nbsp;&nbsp;reset</span><span>${fmtCountdown(v.r5)}</span></div>`;
  const second = w.hasB
    ? `
    <div class="line${staleCls}"${pid}><span>${name} ${padLabel(w.b ?? '7d', cols.label)}</span><span class="${hotW}">${blocks(v.pw, glyphs, cols.bars)} ${pctText(v.pw).padStart(4)}</span></div>`
    : '';
  return `
    <div class="line${staleCls}"${pid}><span>${name} ${padLabel(w.a ?? '5h', cols.label)}</span><span class="${hot5}">${blocks(v.p5, glyphs, cols.bars)} ${pctText(v.p5).padStart(4)}</span></div>
    ${resetLine}
    ${spark}${second}`;
}

// The terminal card's width is fixed, so a long window label ("premium",
// "balance") would push the bar and its percentage off the right edge. Every
// label is padded to the widest one so the columns still line up, and the bar
// gives up one block per character past the two the default "5h"/"7d" take —
// which is why the built-ins' rows come out exactly as they always did.
const TERM_BLOCKS = 20;
const TERM_MIN_BLOCKS = 8;
function padLabel(label, width) {
  return esc(label) + '&nbsp;'.repeat(Math.max(0, width - label.length));
}
function termColumns(list) {
  const label = list.reduce((w, m) => Math.max(w, (m.w.a ?? '5h').length, m.w.hasB ? (m.w.b ?? '7d').length : 0,
  ), 2);
  return { label, bars: Math.max(TERM_MIN_BLOCKS, TERM_BLOCKS - (label - 2)) };
}
// The terminal layout right-pads every meter's name to the longest one so the
// 5h / reset / 7d columns line up — `codex` used to carry a hardcoded &nbsp;
// for exactly this reason.
function termName(label, width) {
  return esc(label.toLowerCase()) + '&nbsp;'.repeat(Math.max(0, width - label.length));
}
function renderTerminal(list, cfgIn, h, themeId) {
  const glyphs = TERM_GLYPHS[themeId] || TERM_GLYPHS.terminal;
  const width = list.reduce((w, m) => Math.max(w, m.label.length), 0);
  const sp = (id) => (h
    ? `<div class="line dim sparkrow" data-provider="${esc(id)}"><span>&nbsp;&nbsp;24h</span><span class="spark">${blockSpark(h[id], 20)}</span></div>`
    : '');
  const cols = termColumns(list);
  const rows = list.map((m) => rowsTerm(termName(m.label, width), m.id, m.v, cfgIn.warnAt, sp(m.id), glyphs, m.w, cols));
  return `<div class="w-term">${cogButton('terminal')}
    <div class="title">▚ LIMITS.SYS — polling</div>
    ${rows.join('<div class="gap"></div>')}
    <div class="prompt">&gt; <span class="cursor"></span></div>
  </div>`;
}

// ---------- hud ----------
function ring(name, id, v, spark, w) {
  const C = 232.5, off = C - (C * (v.p5 ?? 0)) / 100;
  const pid = ` data-provider="${esc(id)}"`;
  if (!v.ok) return `<div class="ringwrap err"${pid}><div class="bignum">—</div><div class="sub">${name}</div><div class="sub dim err-text" title="${esc(v.error)}">${esc(v.error)}</div></div>`;
  const staleCls = v.stale ? ' stale' : '';
  const resetSub = v.stale
    ? `<div class="sub dim err-text" title="${esc(v.error)}">${esc(v.error)}</div>`
    : `<div class="sub dim">↻ ${fmtCountdown(v.r5)}</div>`;
  return `<div class="ringwrap${staleCls}"${pid}>
    <div class="ring">
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r="37" class="track"/>
        <circle cx="42" cy="42" r="37" class="fill" stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
      </svg>
      <div class="num"><b>${pctText(v.p5)}</b><span>${name}</span></div>
    </div>
    ${w.hasB ? `<div class="sub">${esc(w.b ?? 'wk')} ${pctText(v.pw)}</div>` : ''}
    ${resetSub}
    ${spark}
  </div>`;
}
function renderHud(list, _cfg, h) {
  const sp = (id) => (h ? `<div class="sparkrow">${sparkline(h[id], 84, 16)}</div>` : '');
  const rings = list.map((m) => ring(esc(m.label.toUpperCase()), m.id, m.v, sp(m.id), m.w)).join('');
  return `<div class="w-hud">${cogButton('hud')}${rings}</div>`;
}

// ---------- neon ----------
function gauge(name, id, v, spark, w) {
  const C = 163.4, off = C - (C * (v.p5 ?? 0)) / 100;
  const pid = ` data-provider="${esc(id)}"`;
  if (!v.ok) return `<div class="nrow err"${pid}><div class="info"><div class="nm">${name}</div><div class="meta err-text" title="${esc(v.error)}">${esc(v.error)}</div></div></div>`;
  const staleCls = v.stale ? ' stale' : '';
  const metaLine = v.stale
    ? `<div class="meta err-text" title="${esc(v.error)}">${esc(v.error)}</div>`
    : `<div class="meta">${esc(w.a ?? '5h')} · resets ${fmtCountdown(v.r5)}</div>`;
  return `<div class="nrow${staleCls}"${pid}>
    <div class="arc">
      <svg width="62" height="62" viewBox="0 0 62 62">
        <circle cx="31" cy="31" r="26" class="track"/>
        <circle cx="31" cy="31" r="26" class="fill" stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
      </svg>
      <div class="num">${pctText(v.p5)}</div>
    </div>
    <div class="info">
      <div class="nm">${name}</div>
      ${metaLine}
      ${spark}${w.hasB ? `
      <div class="bar"><i style="width:${v.pw ?? 0}%"></i></div>
      <div class="meta">${esc(w.b ?? 'week')} ${pctText(v.pw)}</div>` : ''}
    </div>
  </div>`;
}
function renderNeon(list, _cfg, h) {
  const sp = (id) => (h ? `<div class="sparkrow">${sparkline(h[id], 186, 16)}</div>` : '');
  const rows = list.map((m) => gauge(esc(m.label.toUpperCase()), m.id, m.v, sp(m.id), m.w)).join('');
  return `<div class="w-neon">${cogButton('neon')}<div class="wtitle">◇ GAUGE ◇</div>${rows}</div>`;
}

// Layout → render function. Several theme ids share one layout (paper and
// aurora are glass, carbon is neon, lcd is terminal); the skin is CSS only.
const LAYOUTS = { glass: renderGlass, terminal: renderTerminal, hud: renderHud, neon: renderNeon };

// ---------- settings panel ----------
// Segmented "radio group of buttons" control, used in place of a native
// <select> for theme — a native popup is drawn by
// Chromium/Windows with the OS light colour scheme regardless of the panel's
// theme, which is what made a later change's dropdowns unreadable (white text on a
// white popup). `entries` is a list of `[value, label]` pairs; callers pass
// THEMES (renderer/themelist.js) directly so the option list has exactly one
// source — new themes are added to the themelist.js catalogue alone.
function choice(key, label, entries, selected, hint) {
  const labelId = `choice-${key}-label`;
  const buttons = entries.map(([v, text]) => {
    const on = String(v) === String(selected);
    return `<button type="button" class="choice-btn${on ? ' on' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-choice-key="${key}" data-value="${esc(v)}">${esc(text)}</button>`;
  }).join('');
  return `<div class="field">
    <span id="${labelId}"${hint ? ` title="${esc(hint)}"` : ''}>${esc(label)}</span>
    <div class="choice-group" role="radiogroup" aria-labelledby="${labelId}" data-choice-group>${buttons}</div>
  </div>`;
}

// ---------- Meters (the provider list editor) ----------
// The panel edits cfg.providers directly: every action below rebuilds the
// whole array and ships it through setConfig, so main.js's sanitizer is the
// only validator and the panel never holds its own copy of the truth.
const CUSTOM_TYPES = new Set(['json', 'command']);
const DEFAULT_METER_COLOUR = '#9aa4b8';

function providerList() {
  return Array.isArray(state.cfg.providers) ? state.cfg.providers.map((p) => ({ ...p })) : [];
}

// Every configured meter, enabled or not, with the label and colour it is
// actually drawn with. A built-in carries neither in config.json, so both fall
// back to what the registry resolved (state.services) — but only enabled
// meters appear there, hence the last-resort id/grey.
// A built-in that is switched off never reaches `services`, so its label and
// colour come from the registry metadata the snapshot carries
// rather than falling through to the bare id.
function meterList() {
  const resolved = new Map((state.services || []).map((s) => [s.id, s]));
  const meta = state.builtins || {};
  return providerList().map((p) => ({
    ...p,
    label: p.label || resolved.get(p.id)?.label || meta[p.id]?.label || p.id,
    colour: p.colour || resolved.get(p.id)?.colour || meta[p.id]?.colour || DEFAULT_METER_COLOUR,
  }));
}

// The credential field for a built-in whose tool keeps its token somewhere
// this app can't read. The saved value is never sent to the renderer — the
// snapshot carries only `hasToken`, so the input starts empty and its
// placeholder says whether one is already stored. Typing a new one replaces
// it; blanking a stored one and pressing Enter clears it.
function meterTokenRow(p, meta) {
  if (!meta || !meta.acceptsToken) return '';
  const name = p.label || p.id;
  const hint = meta.tokenHint || 'paste token';
  return `<label class="field meter-token">
    <span>${esc(name)} token</span>
    <input type="password" autocomplete="off" spellcheck="false" data-meter-token="${esc(p.id)}"
      placeholder="${esc(p.hasToken ? 'saved — type to replace, blank to clear' : hint)}">
  </label>`;
}

function meterRow(p, i, last, meta) {
  const custom = CUSTOM_TYPES.has(p.type);
  const name = p.label || p.id;
  const arrow = (dir, glyph, disabled, aria) =>
    `<button type="button" class="choice-btn" data-meter-move="${esc(p.id)}" data-dir="${dir}"${disabled ? ' disabled' : ''} aria-label="${aria} ${esc(name)}">${glyph}</button>`;
  return `<div class="meter" data-provider="${esc(p.id)}">
    <input type="checkbox" data-meter-toggle="${esc(p.id)}"${p.enabled === false ? '' : ' checked'} aria-label="Show ${esc(name)}">
    <span class="meter-dot"></span>
    <span class="meter-name">${esc(name)}</span>
    ${arrow(-1, '&#9650;', i === 0, 'Move up')}
    ${arrow(1, '&#9660;', last, 'Move down')}
    ${custom
      ? `<button type="button" class="choice-btn" data-meter-remove="${esc(p.id)}" aria-label="Remove ${esc(name)}">&#10005;</button>`
      : '<span class="meter-gap"></span>'}
  </div>${p.enabled === false ? '' : meterTokenRow(p, meta)}`;
}

// The "Add custom meter" form. Hidden until the button is pressed; the two
// source flavours swap which fields are shown.
function meterAddForm() {
  return `<div class="meter-add" data-meter-add hidden>
    <label class="field"><span>Name</span><input type="text" data-meter-field="label" placeholder="Gemini"></label>
    <label class="field"><span>Colour (#rrggbb)</span><input type="text" data-meter-field="colour" placeholder="${DEFAULT_METER_COLOUR}"></label>
    <div class="field">
      <span id="meter-type-label">Source</span>
      <div class="choice-group meter-types" role="radiogroup" aria-labelledby="meter-type-label">
        <button type="button" class="choice-btn on" role="radio" aria-checked="true" data-meter-type="json">JSON file</button>
        <button type="button" class="choice-btn" role="radio" aria-checked="false" data-meter-type="command">Command</button>
      </div>
    </div>
    <label class="field" data-meter-when="json"><span>File path</span><input type="text" data-meter-field="path" placeholder="C:\\usage\\gemini.json"></label>
    <label class="field" data-meter-when="command" hidden><span>Command (no shell)</span><input type="text" data-meter-field="command" placeholder="node"></label>
    <label class="field" data-meter-when="command" hidden><span>Arguments, one per line</span><textarea rows="2" data-meter-field="args" placeholder="scripts/gemini-usage.mjs"></textarea></label>
    <div class="panel-actions">
      <button type="button" class="primary" data-meter-create>Add meter</button>
      <button type="button" data-meter-cancel>Cancel</button>
    </div>
  </div>`;
}

function renderMeters() {
  const list = meterList();
  const meta = state.builtins || {};
  const rows = list.map((p, i) => meterRow(p, i, i === list.length - 1, meta[p.id])).join('');
  return `<div class="field meters">
    <span>Meters</span>
    ${rows}
    <button type="button" class="choice-btn meter-new" data-meter-open>+ Add custom meter</button>
    ${meterAddForm()}
  </div>`;
}

// Same-window replacement for the card: strict-CSP markup (no inline style=,
// no inline handlers — everything is wired up via the delegated listeners
// below). cfg values are escaped since a hand-edited config.json can carry
// arbitrary strings into an HTML attribute.
function renderPanel(cfg, winPlatform) {
  const chk = (v) => (v ? ' checked' : '');
  const checkbox = (key, label) =>
    `<label class="field checkbox"><input type="checkbox" data-cfg-key="${key}"${chk(cfg[key])}><span>${label}</span></label>`;
  return `<div class="panel" data-panel>
    <div class="panel-head">
      <span class="panel-title">SETTINGS</span>
      <button type="button" class="panel-close" data-panel-done aria-label="Close settings">&#10005;</button>
    </div>
    <div class="panel-body">
      ${choice('theme', 'Theme', THEMES.map((t) => [t.id, t.label]), cfg.theme)}
      ${renderMeters()}
      <div class="warnrow">
        <label class="field">
          <span>Warn at %</span>
          <input type="number" min="1" max="100" data-cfg-key="warnAt" value="${esc(cfg.warnAt)}">
        </label>
        <label class="field">
          <span>Alert at %</span>
          <input type="number" min="1" max="100" data-cfg-key="alertAt" value="${esc(cfg.alertAt)}">
        </label>
      </div>
      <label class="field">
        <span>Opacity</span>
        <input type="range" min="0.2" max="1" step="0.05" data-cfg-key="opacity" value="${esc(cfg.opacity)}">
      </label>
      <label class="field">
        <span>Size</span>
        <input type="range" min="${MIN_SCALE}" max="${MAX_SCALE}" step="0.01" data-cfg-key="scale" value="${esc(cfg.scale)}">
      </label>
      ${checkbox('alwaysOnTop', 'Always on top')}
      ${winPlatform ? checkbox('autoStart', 'Start with Windows') : ''}
      ${checkbox('speakAlerts', 'Speak alerts')}
      ${checkbox('showHistory', 'Show history')}
      ${checkbox('solidBackground', 'Solid background (for monitors that show a black box)')}
    </div>
    <div class="panel-actions">
      <button type="button" data-open-config>Open config file</button>
      <button type="button" data-refresh-now>Refresh now</button>
      <button type="button" data-read-aloud>Read usage aloud</button>
      <button type="button" data-reset-size>Reset size</button>
      <button type="button" class="primary" data-panel-done>Done</button>
    </div>
  </div>`;
}

let lastSize = '';
// The size the user asked for. Screenshot mode ignores any saved scale so a
// capture run is always the 1.0 card.
function shownScale() {
  return state.screenshot ? 1 : (clampScale(state.cfg.scale) ?? 1);
}

const applyZoom = (z) => { document.getElementById('root').style.zoom = String(z); };

// One sizing path for the card and the panel alike — zoom, measure, ask.
// Applying the scale as `zoom` on #root scales every
// layout metric together, so measuring afterwards gives the real footprint —
// and if that footprint is taller than the display's work area, the zoom is
// corrected down once (fitScale) so nothing ends up off the bottom of the
// screen. `data-fit` is the renderer's public record of the size it asked for;
// the screenshot loop waits on it before capturing.
function fitWindow() {
  const el = document.getElementById('root').firstElementChild;
  if (!el) return;
  applyZoom(shownScale());
  let { w, h } = fitSize(el.getBoundingClientRect());
  const maxH = state.maxContent ? state.maxContent.h : 0;
  if (h > maxH && maxH > 0) {
    applyZoom(fitScale(shownScale(), h, maxH));
    ({ w, h } = fitSize(el.getBoundingClientRect()));
  }
  const key = `${w}x${h}`;
  document.body.dataset.fit = key;
  if (key === lastSize) return;
  lastSize = key;
  window.pulse.resize(w, h);
}

// Keeps the Size slider honest when the scale changed somewhere else — an edge
// drag, or Reset size. Only the one input is touched rather than re-rendering
// the panel, because replacing the element mid-drag would end the drag.
function syncPanelScale() {
  const el = document.querySelector('[data-cfg-key="scale"]');
  const s = String(clampScale(state.cfg.scale) ?? 1);
  if (el && el.value !== s) el.value = s;
}

// Everything a fresh snapshot has to do; fitWindow() owns the zoom, so this
// only has to pick whichever surface owns the DOM.
// A providers change made from the panel comes back as a fresh snapshot; the
// Meters list has to be rebuilt from it, but re-rendering the whole panel on
// every unrelated snapshot would fight the user's slider/typing. So the panel
// is only rebuilt when the provider list itself actually changed.
let lastProvidersSig = '';
const providersSig = (cfg) => JSON.stringify(cfg.providers ?? []);

function applyState() {
  if (panelOpen) {
    if (providersSig(state.cfg) !== lastProvidersSig) { drawPanel(); return; }
    syncPanelScale();
    fitWindow();
  } else render();
}

function render() {
  if (!state || panelOpen) return; // the panel owns the DOM until Done/Escape
  const list = meters();
  const theme = THEME_BY_ID[state.theme] ? state.theme : 'glass'; // hand-edited config may hold junk
  const spec = THEME_BY_ID[theme];
  document.body.dataset.theme = theme;
  document.body.dataset.solid = state.solidBackground ? '1' : '0';
  document.body.dataset.screenshot = state.screenshot ? '1' : '0'; // freezes animated skins
  const hist = history();
  document.getElementById('root').innerHTML = LAYOUTS[spec.layout](list, state.cfg, hist, theme);
  paintAccents(list);
  fitWindow();
}

function drawPanel() {
  const theme = THEME_BY_ID[state.theme] ? state.theme : 'glass';
  document.body.dataset.theme = theme;
  lastProvidersSig = providersSig(state.cfg);
  document.getElementById('root').innerHTML = renderPanel(state.cfg, state.winPlatform);
  paintAccents(meterList());
  fitWindow();
}

function openPanel() {
  if (panelOpen || !state) return;
  panelOpen = true;
  drawPanel();
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  render();
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
const sendRange = debounce((key, v) => window.pulse.setConfig({ [key]: v }), 50);

document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.pulse.openMenu(); });
window.pulse.onSpeak((text) => {
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
});
window.pulse.onSnapshot((snap) => { state = snap; applyState(); });

// Marks `btn` selected within its radiogroup and persists the choice — the
// button-group equivalent of a <select>'s change event.
function selectChoice(btn) {
  const key = btn.dataset.choiceKey;
  const group = btn.closest('[data-choice-group]');
  group.querySelectorAll('[data-choice-key]').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  window.pulse.setConfig({ [key]: btn.dataset.value });
}

const commitProviders = (list) => window.pulse.setConfig({ providers: list });

// An id has to survive as an object key and a history column name, so it is
// slugified from the label rather than taken from it, and made unique against
// the meters already configured.
function slugId(label, taken) {
  let base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!/^[a-z0-9]/.test(base)) base = `meter${taken.length + 1}`;
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

function meterMove(id, dir) {
  const list = providerList();
  const i = list.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  commitProviders(list);
}

function meterToggle(id, on) {
  const list = providerList();
  const p = list.find((m) => m.id === id);
  if (!p) return;
  p.enabled = on;
  commitProviders(list);
}

// A stored token never comes back from main (the snapshot is redacted), so the
// list sent here carries `token` on the one meter that was just typed into and
// on no other — keepTokens() in src/settings.js restores the rest. An empty
// string is an explicit "clear it", which is why it is still sent.
function meterSetToken(id, value) {
  const list = providerList();
  const p = list.find((m) => m.id === id);
  if (!p) return;
  p.token = value.trim();
  commitProviders(list);
}

function meterRemove(id) {
  const list = providerList().filter((p) => p.id !== id);
  if (list.length) commitProviders(list); // never leave the widget with no meters
}

// Which source flavour the add form is currently on.
const addFormType = () => (document.querySelector('[data-meter-type].on')?.dataset.meterType ?? 'json');

function setAddFormType(type) {
  for (const b of document.querySelectorAll('[data-meter-type]')) {
    const on = b.dataset.meterType === type;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  for (const f of document.querySelectorAll('[data-meter-when]')) f.hidden = f.dataset.meterWhen !== type;
  fitWindow();
}

const addField = (name) => document.querySelector(`[data-meter-field="${name}"]`)?.value.trim() ?? '';

function meterCreate() {
  const type = addFormType();
  const label = addField('label') || 'Meter';
  const list = providerList();
  const entry = { id: slugId(label, list.map((p) => p.id)), enabled: true, label, type };
  const colour = addField('colour');
  if (colour) entry.colour = colour;
  if (type === 'json') {
    entry.path = addField('path');
    if (!entry.path) return; // nothing to read: leave the form open
  } else {
    entry.command = addField('command');
    if (!entry.command) return;
    entry.args = addField('args').split('\n').map((a) => a.trim()).filter(Boolean);
  }
  commitProviders([...list, entry]);
}

// Delegated on `document` (not `#root`) so listeners survive the innerHTML
// swaps both render() and openPanel()/closePanel() do.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-settings]')) { openPanel(); return; }
  if (e.target.closest('[data-panel-done]')) { closePanel(); return; }
  if (e.target.closest('[data-refresh-now]')) { window.pulse.refreshNow(); return; }
  if (e.target.closest('[data-read-aloud]')) { window.pulse.readUsageAloud(); return; }
  if (e.target.closest('[data-open-config]')) { window.pulse.openConfigFile(); return; }
  if (e.target.closest('[data-reset-size]')) { window.pulse.setConfig({ scale: 1 }); return; }
  if (e.target.closest('[data-meter-open]')) {
    document.querySelector('[data-meter-add]').hidden = false;
    document.querySelector('[data-meter-open]').hidden = true;
    fitWindow();
    return;
  }
  if (e.target.closest('[data-meter-cancel]')) {
    document.querySelector('[data-meter-add]').hidden = true;
    document.querySelector('[data-meter-open]').hidden = false;
    fitWindow();
    return;
  }
  if (e.target.closest('[data-meter-create]')) { meterCreate(); return; }
  const typeBtn = e.target.closest('[data-meter-type]');
  if (typeBtn) { setAddFormType(typeBtn.dataset.meterType); return; }
  const moveBtn = e.target.closest('[data-meter-move]');
  if (moveBtn) { meterMove(moveBtn.dataset.meterMove, Number(moveBtn.dataset.dir)); return; }
  const rmBtn = e.target.closest('[data-meter-remove]');
  if (rmBtn) { meterRemove(rmBtn.dataset.meterRemove); return; }
  const choiceBtn = e.target.closest('[data-choice-key]');
  if (choiceBtn) { selectChoice(choiceBtn); return; }
});

document.addEventListener('change', (e) => {
  if (!panelOpen) return;
  const el = e.target;
  if (el.dataset.meterToggle) { meterToggle(el.dataset.meterToggle, el.checked); return; }
  if (el.dataset.meterToken) { meterSetToken(el.dataset.meterToken, el.value); el.value = ''; return; }
  const key = el.dataset.cfgKey;
  if (!key) return;
  if (el.type === 'checkbox') window.pulse.setConfig({ [key]: el.checked });
  else if (el.type === 'number') window.pulse.setConfig({ [key]: Number(el.value) });
});

document.addEventListener('input', (e) => {
  if (!panelOpen) return;
  const el = e.target;
  if (el.type === 'range' && el.dataset.cfgKey) sendRange(el.dataset.cfgKey, Number(el.value));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelOpen) { closePanel(); return; }
  if (!panelOpen) return;
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
  const btn = e.target.closest('[data-choice-key]');
  if (!btn) return;
  e.preventDefault();
  const buttons = Array.from(btn.closest('[data-choice-group]').querySelectorAll('[data-choice-key]'));
  const i = buttons.indexOf(btn);
  const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
  const next = buttons[(i + dir + buttons.length) % buttons.length];
  next.focus();
  selectChoice(next);
});
window.pulse.getInit().then((snap) => { state = snap; applyState(); });
setInterval(render, 1000); // countdown tick + reset zeroing
