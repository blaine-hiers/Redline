const { test } = require('node:test');
const assert = require('node:assert');
const { sparkline, blockSpark } = require('../renderer/spark');

const pts = (vals, step = 1000) => vals.map((v, i) => ({ t: i * step, v }));

test('sparkline renders nothing with fewer than two plottable points', () => {
  assert.strictEqual(sparkline([], 60, 18), '');
  assert.strictEqual(sparkline(pts([50]), 60, 18), '');
  assert.strictEqual(sparkline(pts([null, 50, null]), 60, 18), '');
});

test('sparkline maps time to x and percent to an inset y', () => {
  const svg = sparkline(pts([0, 100]), 60, 18);
  assert.match(svg, /^<svg class="spark" width="60" height="18">/);
  assert.match(svg, /<polyline points="0,17 60,1"\/>/);
  assert.strictEqual(svg.match(/<polyline/g).length, 1);
});

test('sparkline breaks the line at gaps', () => {
  const svg = sparkline(pts([10, 20, null, 30, 40]), 40, 10);
  assert.strictEqual(svg.match(/<polyline/g).length, 2);
});

test('sparkline emits no inline style attributes', () => {
  assert.doesNotMatch(sparkline(pts([10, 90, 40]), 60, 18), /style=/);
});

test('sparkline clamps out-of-range percentages', () => {
  const svg = sparkline(pts([-20, 140]), 10, 10);
  assert.match(svg, /points="0,9 10,1"/);
});

test('blockSpark renders one block per bucket, low to high', () => {
  const s = blockSpark(pts([0, 100]), 2);
  assert.strictEqual(s, '\u2581\u2588');
});

test('blockSpark leaves a space for a bucket with no data', () => {
  const s = blockSpark([{ t: 0, v: 0 }, { t: 1000, v: null }, { t: 2000, v: 100 }], 3);
  assert.strictEqual(s, '\u2581 \u2588');
});

test('blockSpark renders nothing with fewer than two plottable points', () => {
  assert.strictEqual(blockSpark(pts([50]), 10), '');
  assert.strictEqual(blockSpark([], 10), '');
});
