// The PR #20 HIGH finding: a credential could reach the card through an error
// message. undici's header validation throws
//   TypeError: Headers.append: "<the whole value>" is an invalid header value
// when a header carries a control character — and a pasted cookie or token is
// exactly the value that can, since the sanitizer only trimmed the ends. That
// TypeError went into `fail('network: ' + e.message)`, which becomes
// services[].data.error, crosses IPC and renders in every layout and in a
// `title=` tooltip.
//
// Three layers are asserted here: the sanitizer refuses such a token, the
// collectors never pass an exception's message on, and main.js's scrub removes
// any saved token from an error whatever produced it.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildHeaders, classifyNetworkError, scrubSecrets, REDACTED,
} = require('../src/collectors/shared');
const { sanitizeConfigPatch, usableToken } = require('../src/settings');
const { DEFAULTS } = require('../src/config');
const { collectGemini } = require('../src/collectors/gemini');
const { collectCopilot } = require('../src/collectors/copilot');
const { collectCursor } = require('../src/collectors/cursor');
const { collectGrok } = require('../src/collectors/grok');
const { collectOpenai } = require('../src/collectors/openai');
const { collectDeepseek } = require('../src/collectors/deepseek');
const { collectClaude } = require('../src/collectors/claude');

const cfg = () => ({ ...DEFAULTS });
// The shape of a bad paste: a real credential with a newline in the middle.
const DIRTY = 'sso=abc123\nsecret-tail-value';
const CLEAN = 'clean-token-value';

// ---------- layer 1: the sanitizer refuses it ----------
test('a token with a line break never reaches config.json', () => {
  const patch = (token) => sanitizeConfigPatch(cfg(), { providers: [{ id: 'grok', token }] }).providers[0];
  assert.strictEqual('token' in patch(DIRTY), false);
  assert.strictEqual('token' in patch('a\r\nb'), false);
  assert.strictEqual('token' in patch('a\tb'), false);
  assert.strictEqual('token' in patch('a\0b'), false);
  assert.strictEqual(patch(`  ${CLEAN}\n`).token, CLEAN); // a trailing newline is just trim
});

test('usableToken only hands back a credential a meter can actually use', () => {
  const { BUILTINS } = require('../src/providers');
  assert.strictEqual(usableToken(CLEAN, BUILTINS.grok), CLEAN);
  assert.strictEqual(usableToken(DIRTY, BUILTINS.grok), null);
  assert.strictEqual(usableToken(CLEAN, BUILTINS.claude), null); // acceptsToken unset
  assert.strictEqual(usableToken(CLEAN, undefined), null);
});

// PR #20 finding 3: a meter with no token to accept must not persist one a
// hand-edited config.json put there.
test('a built-in that accepts no token never stores one', () => {
  for (const id of ['claude', 'codex']) {
    const [p] = sanitizeConfigPatch(cfg(), { providers: [{ id, token: CLEAN }] }).providers;
    assert.strictEqual('token' in p, false, id);
  }
  const [grok] = sanitizeConfigPatch(cfg(), { providers: [{ id: 'grok', token: CLEAN }] }).providers;
  assert.strictEqual(grok.token, CLEAN);
});

// ---------- layer 2: the collectors ----------
test('buildHeaders refuses a control character instead of throwing', () => {
  assert.strictEqual(buildHeaders({ Cookie: DIRTY }), null);
  assert.ok(buildHeaders({ Cookie: CLEAN }) instanceof Headers);
});

test('classifyNetworkError never passes a message through', () => {
  const err = (props) => Object.assign(new Error('ENOTFOUND api.example.com token=SECRET'), props);
  assert.strictEqual(classifyNetworkError(err({ code: 'ENOTFOUND' })), 'network: dns');
  assert.strictEqual(classifyNetworkError(err({ cause: { code: 'ECONNREFUSED' } })), 'network: refused');
  assert.strictEqual(classifyNetworkError(err({ code: 'ECONNRESET' })), 'network: connection lost');
  assert.strictEqual(classifyNetworkError(err({ name: 'TimeoutError' })), 'network: timeout');
  assert.strictEqual(classifyNetworkError(err({ code: 'UND_ERR_HEADERS_TIMEOUT' })), 'network: timeout');
  assert.strictEqual(classifyNetworkError(err({})), 'network error');
  assert.strictEqual(classifyNetworkError(undefined), 'network error');
  for (const props of [{ code: 'ENOTFOUND' }, {}, { name: 'TimeoutError' }]) {
    assert.ok(!classifyNetworkError(err(props)).includes('SECRET'));
  }
});

// The exact throw undici produces, reproduced so the regression can't come
// back through a different code path.
const undiciHeaderError = (value) =>
  Object.assign(new TypeError(`Headers.append: "${value}" is an invalid header value.`), { name: 'TypeError' });

// A hand-edited config.json bypasses the sanitizer, so every collector is
// asked directly with a dirty token — with the real `fetch` shape faked by a
// fetchFn that throws exactly what undici would.
const CALLS = [
  ['gemini', (token, fetchFn) => collectGemini({ token, fetchFn, env: { GOOGLE_CLOUD_PROJECT: 'p' }, now: 0 })],
  ['copilot', (token, fetchFn) => collectCopilot({ token, fetchFn, now: 0 })],
  ['cursor', (token, fetchFn) => collectCursor({ token: `u1%3A%3A${token}`, fetchFn, now: 0 })],
  ['grok', (token, fetchFn) => collectGrok({ token, fetchFn, now: 0 })],
  ['openai', (token, fetchFn) => collectOpenai({ token, budgetUsd: 50, env: {}, fetchFn, now: 0 })],
  ['deepseek', (token, fetchFn) => collectDeepseek({ token, budgetUsd: 50, env: {}, fetchFn, now: 0 })],
];

test('a dirty credential is refused before the request, with nothing of it in the message', async () => {
  for (const [id, call] of CALLS) {
    let called = 0;
    const out = await call(DIRTY, () => { called += 1; throw new Error('must not be called'); });
    assert.strictEqual(called, 0, `${id} must not reach the network with an unusable credential`);
    assert.strictEqual(out.ok, false, id);
    assert.ok(!out.error.includes('secret-tail-value'), `${id}: ${out.error}`);
    assert.ok(!out.error.includes('abc123'), `${id}: ${out.error}`);
    assert.ok(!out.error.includes('Headers.append'), `${id}: ${out.error}`);
  }
});

test('the undici header error can never be echoed, even if it escapes buildHeaders', async () => {
  for (const [id, call] of CALLS) {
    const out = await call(CLEAN, () => { throw undiciHeaderError(DIRTY); });
    assert.strictEqual(out.ok, false, id);
    assert.ok(!out.error.includes('secret-tail-value'), `${id}: ${out.error}`);
    assert.ok(!out.error.includes('Headers.append'), `${id}: ${out.error}`);
    assert.strictEqual(out.error, 'network error', id);
  }
});

test('Claude collector classifies its network failures the same way', async () => {
  const fsImpl = { readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: CLEAN, expiresAt: null } }) };
  // claude.js reads through the real fs, so point it at a written file instead
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-claude-'));
  const file = path.join(dir, 'creds.json');
  fs.writeFileSync(file, fsImpl.readFileSync());
  const out = await collectClaude({
    credFile: file, now: 1, fetchFn: () => { throw undiciHeaderError(DIRTY); },
  });
  assert.strictEqual(out.error, 'network error');
  const dns = await collectClaude({
    credFile: file, now: 1,
    fetchFn: () => { throw Object.assign(new Error('boom'), { code: 'ENOTFOUND' }); },
  });
  assert.strictEqual(dns.error, 'network: dns');
});

// ---------- layer 3: the scrub on the way into the snapshot ----------
test('scrubSecrets removes a saved token from any message', () => {
  assert.strictEqual(scrubSecrets(`network: ${CLEAN} refused`, [CLEAN]), `network: ${REDACTED} refused`);
  assert.strictEqual(scrubSecrets('nothing to do', [CLEAN]), 'nothing to do');
  assert.strictEqual(scrubSecrets('untouched', []), 'untouched');
  assert.strictEqual(scrubSecrets(null, [CLEAN]), null);
  // a longer secret is removed first, so a shorter one inside it leaves no fragment
  assert.strictEqual(scrubSecrets('sso=abc123-tail', ['abc123', 'abc123-tail']), `sso=${REDACTED}`);
  // trivially short values are ignored, so a one-character token can't blank the message
  assert.strictEqual(scrubSecrets('network error', ['e']), 'network error');
});
