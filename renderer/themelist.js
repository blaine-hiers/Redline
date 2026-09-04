// The theme catalogue — one source of truth for the tray menu, the screenshot
// loop, the settings allowlist, the settings panel's picker and the card width.
// Loaded as a plain <script> in the renderer and as a CommonJS module in the
// main process and the tests, the same way spark.js is.
//
// A theme is a *layout* plus a *skin*: `layout` picks the render function in
// renderer.js (several themes share one), and the skin is the matching
// `body[data-theme="<id>"]` block in themes.css. `width` is the card's
// unscaled content width (the `.w-*` width plus its 10px margin on each side)
// — the baseline a user drag is measured against to derive a scale. Heights
// aren't catalogued: the renderer measures whatever it rendered and asks for
// exactly that, so a taller card can't be clipped.

const THEMES = [
  { id: 'glass', label: 'Frosted Glass', layout: 'glass', width: 300 },
  { id: 'terminal', label: 'Terminal', layout: 'terminal', width: 310 },
  { id: 'hud', label: 'HUD Rings', layout: 'hud', width: 270 },
  { id: 'neon', label: 'Neon Gauge', layout: 'neon', width: 320 },
  { id: 'paper', label: 'Paper', layout: 'glass', width: 300 },
  { id: 'carbon', label: 'Carbon', layout: 'neon', width: 320 },
  { id: 'aurora', label: 'Aurora', layout: 'glass', width: 300 },
  { id: 'lcd', label: 'LCD', layout: 'terminal', width: 310 },
];

const THEME_IDS = THEMES.map((t) => t.id);
const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

if (typeof module !== 'undefined') module.exports = { THEMES, THEME_IDS, THEME_BY_ID };
