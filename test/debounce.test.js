const { test } = require('node:test');
const assert = require('node:assert');
const { debounced } = require('../src/debounce');

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('debounced collapses rapid calls into one', async () => {
  let calls = 0;
  const d = debounced(() => { calls += 1; }, 10);
  d(); d(); d();
  assert.strictEqual(calls, 0);
  await tick(30);
  assert.strictEqual(calls, 1);
});

test('flush runs a pending call immediately and cancels the timer', async () => {
  let calls = 0;
  const d = debounced(() => { calls += 1; }, 10_000);
  d();
  d.flush();
  assert.strictEqual(calls, 1);
  await tick(20);
  assert.strictEqual(calls, 1); // the cancelled timer never fires
});

test('flush with nothing pending does nothing', () => {
  let calls = 0;
  const d = debounced(() => { calls += 1; }, 10);
  d.flush();
  assert.strictEqual(calls, 0);
});

test('a call after flush schedules again', async () => {
  let calls = 0;
  const d = debounced(() => { calls += 1; }, 10);
  d();
  d.flush();
  d();
  await tick(30);
  assert.strictEqual(calls, 2);
});
