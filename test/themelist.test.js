const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { THEMES, THEME_IDS } = require('../renderer/themelist');
const { DEFAULTS } = require('../src/config');
const { sanitizeConfigPatch } = require('../src/settings');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// renderer.js is a browser script (it touches `document` at load), so the
// layouts it implements are read out of its source rather than required.
function layoutNames() {
  const m = read('renderer/renderer.js').match(/const LAYOUTS = \{([^}]*)\}/);
  assert.ok(m, 'renderer.js must declare a LAYOUTS map');
  return m[1].split(',').map((pair) => pair.split(':')[0].trim()).filter(Boolean);
}

test('every theme has a unique id, a label, a base width and a known layout', () => {
  const layouts = layoutNames();
  assert.strictEqual(new Set(THEME_IDS).size, THEME_IDS.length, 'duplicate theme id');
  for (const t of THEMES) {
    assert.ok(typeof t.label === 'string' && t.label, `${t.id}: no label`);
    assert.ok(Number.isInteger(t.width) && t.width > 0, `${t.id}: bad width`);
    assert.ok(layouts.includes(t.layout), `${t.id}: layout "${t.layout}" has no renderer`);
  }
});

// Heights are measured at render time now, but the base width still has to
// match the CSS or a scale of 1.0 would not be a no-op: it is the .w-<layout>
// width plus the 10px margin on each side.
test('each theme base width matches its layout card width in themes.css', () => {
  const css = read('renderer/themes.css');
  for (const t of THEMES) {
    const cls = t.layout === 'terminal' ? 'term' : t.layout;
    const m = css.match(new RegExp(`\\.w-${cls} \\{\\s*width: (\\d+)px; margin: 10px`));
    assert.ok(m, `${t.id}: no .w-* width rule for layout ${t.layout}`);
    assert.strictEqual(t.width, Number(m[1]) + 20, `${t.id}: base width disagrees with themes.css`);
  }
});

test('the default theme is one of the catalogued themes', () => {
  assert.ok(THEME_IDS.includes(DEFAULTS.theme));
});

test('every theme id survives sanitizeConfigPatch', () => {
  for (const id of THEME_IDS) {
    assert.deepStrictEqual(sanitizeConfigPatch(DEFAULTS, { theme: id }), { theme: id });
  }
});

test('every theme id has a skin block in themes.css', () => {
  const css = read('renderer/themes.css');
  for (const id of THEME_IDS) {
    assert.ok(css.includes(`body[data-theme="${id}"]`), `${id}: no body[data-theme] rule`);
  }
});
