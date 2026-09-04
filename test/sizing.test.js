const { test } = require('node:test');
const assert = require('node:assert');
const { MIN_SCALE, MAX_SCALE, clampScale, fitSize, fitScale, resizeAction, keepOnScreen } = require('../renderer/sizing');

test('clampScale holds the 0.6–3.0 range and rounds to 2dp', () => {
  assert.strictEqual(clampScale(1), 1);
  assert.strictEqual(clampScale(0.1), MIN_SCALE);
  assert.strictEqual(clampScale(99), MAX_SCALE);
  assert.strictEqual(clampScale(1.9500000000000002), 1.95);
  assert.strictEqual(clampScale(1.234), 1.23);
});

test('clampScale rejects non-numbers', () => {
  for (const v of ['1', null, undefined, NaN, Infinity, {}]) assert.strictEqual(clampScale(v), null);
});

test('fitSize adds the card margin on both sides and rounds up', () => {
  assert.deepStrictEqual(fitSize({ top: 10, left: 10, width: 280, height: 225 }), { w: 300, h: 245 });
  assert.deepStrictEqual(fitSize({ top: 10.5, left: 10.5, width: 280.2, height: 224.4 }), { w: 302, h: 246 });
});

test('fitSize scales the margin with a zoomed rect', () => {
  assert.deepStrictEqual(fitSize({ top: 20, left: 20, width: 560, height: 450 }), { w: 600, h: 490 });
});

test('fitScale leaves a scale that already fits the work area alone', () => {
  assert.strictEqual(fitScale(3, 935, 992), 3);
  assert.strictEqual(fitScale(1, 313, 992), 1);
});

test('fitScale shrinks a scale whose content is taller than the work area', () => {
  // the settings panel at 3.0 wants ~1614px on a 1032px-tall work area
  assert.strictEqual(fitScale(3, 1614, 992), 3 * (992 / 1614));
  // and the corrected zoom lands the content exactly on the cap
  assert.ok(Math.abs(1614 * (fitScale(3, 1614, 992) / 3) - 992) < 1e-9);
});

test('fitScale is a no-op without a usable maximum', () => {
  assert.strictEqual(fitScale(2, 900, 0), 2);
  assert.strictEqual(fitScale(2, 900, undefined), 2);
});

test('resizeAction ignores our own content-fit echo', () => {
  assert.deepStrictEqual(resizeAction({ w: 480, h: 497 }, { w: 480, h: 497 }, 1.6), { type: 'ignore' });
});

test('resizeAction ignores events before anything has been fitted', () => {
  assert.deepStrictEqual(resizeAction({ w: 480, h: 497 }, null, 1), { type: 'ignore' });
});

const WORK = { x: 0, y: 0, width: 1920, height: 1032 };

test('keepOnScreen leaves a window that already fits alone', () => {
  assert.deepStrictEqual(keepOnScreen({ x: 1560, y: 700, width: 300, height: 313 }, WORK), { x: 1560, y: 700 });
  assert.deepStrictEqual(keepOnScreen({ x: 0, y: 0, width: 300, height: 313 }, WORK), { x: 0, y: 0 });
});

// The reviewer's repro: a card parked low, then grown into the settings panel.
test('keepOnScreen shifts a window the panel grew off the bottom', () => {
  assert.deepStrictEqual(keepOnScreen({ x: 1560, y: 700, width: 300, height: 502 }, WORK), { x: 1560, y: 530 });
});

test('keepOnScreen shifts left as well as up', () => {
  assert.deepStrictEqual(keepOnScreen({ x: 1800, y: 900, width: 596, height: 975 }, WORK), { x: 1324, y: 57 });
});

test('keepOnScreen parks something bigger than the work area at its origin', () => {
  assert.deepStrictEqual(keepOnScreen({ x: 400, y: 400, width: 3000, height: 2000 }, WORK), { x: 0, y: 0 });
});

test('keepOnScreen respects a work area that does not start at the origin', () => {
  const left = { x: -1920, y: 1, width: 1920, height: 1032 };
  assert.deepStrictEqual(keepOnScreen({ x: -400, y: 800, width: 596, height: 975 }, left), { x: -596, y: 58 });
  assert.deepStrictEqual(keepOnScreen({ x: -3000, y: -50, width: 300, height: 313 }, left), { x: -1920, y: 1 });
});

test('resizeAction turns a width drag into a scale', () => {
  assert.deepStrictEqual(resizeAction({ w: 480, h: 313 }, { w: 300, h: 313 }, 1), { type: 'scale', scale: 1.6 });
});

test('resizeAction scales relative to what is on screen, not the theme width', () => {
  // already at 1.6 and 480 wide: dragging to 600 is another 1.25x, not 2.0
  assert.deepStrictEqual(resizeAction({ w: 600, h: 497 }, { w: 480, h: 497 }, 1.6), { type: 'scale', scale: 2 });
  assert.deepStrictEqual(resizeAction({ w: 240, h: 497 }, { w: 480, h: 497 }, 1.6), { type: 'scale', scale: 0.8 });
});

test('resizeAction clamps a drag past either end of the range', () => {
  assert.deepStrictEqual(resizeAction({ w: 60, h: 313 }, { w: 300, h: 313 }, 1), { type: 'scale', scale: MIN_SCALE });
  assert.deepStrictEqual(resizeAction({ w: 3000, h: 313 }, { w: 300, h: 313 }, 1), { type: 'scale', scale: MAX_SCALE });
});

// The panel at 3.0 is shrunk by fitScale to 596px, which no longer encodes
// cfg.scale — deriving from the theme's 300px base width used to read that as
// 2.0 and silently collapse the user's size on the smallest nudge.
test('resizeAction does not collapse the scale when a nudge hits a shrunk panel', () => {
  assert.deepStrictEqual(resizeAction({ w: 600, h: 975 }, { w: 596, h: 975 }, 3), { type: 'restore' });
  assert.deepStrictEqual(resizeAction({ w: 592, h: 975 }, { w: 596, h: 975 }, 3), { type: 'scale', scale: 2.98 });
});

// The bug this ticket exists to fix: dragging only the bottom edge used to
// leave the window short and the card clipped, because nothing put it back.
test('resizeAction restores the fit after a height-only drag', () => {
  assert.deepStrictEqual(resizeAction({ w: 480, h: 200 }, { w: 480, h: 497 }, 1.6), { type: 'restore' });
});

test('resizeAction restores when the scale clamp swallows a width drag', () => {
  // already at MAX_SCALE: a wider drag derives the same scale, so nothing
  // would re-fit and the window would sit wider than the card.
  assert.deepStrictEqual(resizeAction({ w: 1200, h: 900 }, { w: 900, h: 900 }, 3), { type: 'restore' });
});
