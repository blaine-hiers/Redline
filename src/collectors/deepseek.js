// DeepSeek — prepaid balance drawn down against a top-up the user names.
//
// SOURCE: DeepSeek's documented balance endpoint.
//   GET https://api.deepseek.com/user/balance
//   Authorization: Bearer <api key>
//   Response: { is_available: bool,
//               balance_infos: [{ currency, total_balance, granted_balance,
//                                 topped_up_balance }] }   — amounts are STRINGS
//   Field names confirmed against the struct tags in
//   cohesion-org/deepseek-go — balance.go
//
// NOT VERIFIED LIVE: no DeepSeek key exists on this machine; the
// parsing is exercised only against test/fixtures/deepseek-balance.json.
//
// There is no window here at all: a prepaid balance falls and is refilled by
// hand, so the meter shows "how much of your last top-up is gone" and carries
// no reset countdown. `budgetUsd` is that top-up amount.
//
// SECURITY: the key is sent only to api.deepseek.com and never logged.

const { fail, rateLimited, reading, toPct, buildHeaders, classifyNetworkError } = require('./shared');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

// The amounts come back as strings ("3.60"), so they are parsed rather than
// used directly — and a string that isn't a number is a bad response, not a 0.
function balanceUsd(body) {
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : null;
  if (!infos || !infos.length) return null;
  const usd = infos.find((i) => i && String(i.currency).toUpperCase() === 'USD') ?? infos[0];
  const n = Number(usd && usd.total_balance);
  return Number.isFinite(n) ? n : null;
}

function normalizeBalance(body, budgetUsd, now = Date.now()) {
  const left = balanceUsd(body);
  if (left === null) return fail('unexpected response from DeepSeek');
  // Percent *used* of the top-up (a later change: every bar in this widget is used,
  // not remaining), clamped so a top-up larger than `budgetUsd` reads 0.
  return reading({ pct5h: toPct(100 * (1 - left / budgetUsd)) }, now);
}

async function collectDeepseek({
  token = null, budgetUsd = null, fetchFn = fetch, now = Date.now(), env = process.env,
} = {}) {
  const key = token || env.DEEPSEEK_API_KEY || null;
  if (!key) return fail('DeepSeek: paste an API key in Meters');
  if (!budgetUsd) return fail('DeepSeek: set budgetUsd in config.json');
  // Built before the try, never inside it: undici's header validation error
  // quotes the whole offending value, so a credential with a stray newline in
  // it would otherwise be printed on the card (see buildHeaders in shared.js).
  const headers = buildHeaders({ Authorization: `Bearer ${key}`, Accept: 'application/json' });
  if (!headers) return fail('DeepSeek: invalid API key');
  let res;
  try {
    res = await fetchFn(BALANCE_URL, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (e) { return fail(classifyNetworkError(e)); }
  if (res.status === 401 || res.status === 403) return fail('DeepSeek: API key rejected');
  if (res.status === 429) return rateLimited(res, now);
  if (!res.ok) return fail('DeepSeek balance endpoint HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (e) { return fail('bad response: ' + e.message); }
  return normalizeBalance(body, budgetUsd, now);
}

module.exports = { collectDeepseek, normalizeBalance, balanceUsd, BALANCE_URL };
