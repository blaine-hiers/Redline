const { test } = require('node:test');
const assert = require('node:assert');
const { windowOptions } = require('../src/windowoptions');

test('default: transparent, no backgroundColor', () => {
  assert.deepStrictEqual(windowOptions({ solidBackground: false }), { transparent: true });
});

test('solidBackground true: opaque with a dark slate backdrop', () => {
  assert.deepStrictEqual(windowOptions({ solidBackground: true }), {
    transparent: false,
    backgroundColor: '#14161c',
  });
});
