// OpenAI platform — this calendar month's spend, as a percentage of a budget
// the user sets. Unlike every other meter here the source is denominated in
// dollars, not requests, so there is no percentage to read: `budgetUsd` is
// what turns it into one, and without it the meter says so rather than
// inventing a ceiling.
//
// SOURCE: the Costs Admin API.
//   GET https://api.openai.com/v1/organization/costs
//       ?start_time=<epoch seconds>&bucket_width=1d&limit=31
//   Authorization: Bearer <organization *admin* key, sk-admin-…>
//   Response: { object: 'page', has_more, next_page,
//               data: [{ object: 'bucket', start_time, end_time,
//                        results: [{ amount: { value, currency }, … }] }] }
//   https://developers.openai.com/cookbook/examples/completions_usage_api
//   (the same shape the platform docs give for /v1/organization/costs)
//
// NOT VERIFIED LIVE: no OpenAI admin key exists on this machine;
// the parsing is exercised only against test/fixtures/openai-costs.json.
// `has_more` paging is deliberately not followed — one month of daily buckets
// is 31 rows, comfortably inside the default page.
//
// CREDENTIAL: an admin key pasted into the panel, or OPENAI_ADMIN_KEY in the
// environment. A project key (sk-proj-…) cannot read this endpoint.
//
// SECURITY: the key is sent only to api.openai.com and never logged.

const { fail, rateLimited, reading, toPct, buildHeaders, classifyNetworkError } = require('./shared');

const COSTS_URL = 'https://api.openai.com/v1/organization/costs';

// The billing period this endpoint is asked about, and the instant the bar
// resets: OpenAI bills by calendar month in UTC.
function monthStart(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function monthEnd(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// Sum every bucket's every result. A bucket with no activity has an empty
// `results`, which contributes nothing rather than being an error.
function totalUsd(body) {
  const buckets = body && Array.isArray(body.data) ? body.data : null;
  if (!buckets) return null;
  let sum = 0;
  for (const b of buckets) {
    const results = b && Array.isArray(b.results) ? b.results : [];
    for (const r of results) {
      const v = r && r.amount && r.amount.value;
      if (typeof v === 'number' && Number.isFinite(v)) sum += v;
    }
  }
  return sum;
}

function normalizeCosts(body, budgetUsd, now = Date.now()) {
  const spent = totalUsd(body);
  if (spent === null) return fail('unexpected response from OpenAI');
  return reading({ pct5h: toPct((100 * spent) / budgetUsd), resets5h: monthEnd(now) }, now);
}

async function collectOpenai({
  token = null, budgetUsd = null, fetchFn = fetch, now = Date.now(), env = process.env,
} = {}) {
  const key = token || env.OPENAI_ADMIN_KEY || null;
  // No key: never reach the network.
  if (!key) return fail('OpenAI: paste an admin key in Meters');
  if (!budgetUsd) return fail('OpenAI: set budgetUsd in config.json');
  const url = `${COSTS_URL}?start_time=${Math.floor(monthStart(now) / 1000)}&bucket_width=1d&limit=31`;
  // Built before the try, never inside it: undici's header validation error
  // quotes the whole offending value, so a credential with a stray newline in
  // it would otherwise be printed on the card (see buildHeaders in shared.js).
  const headers = buildHeaders({ Authorization: `Bearer ${key}`, Accept: 'application/json' });
  if (!headers) return fail('OpenAI: invalid admin key');
  let res;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (e) { return fail(classifyNetworkError(e)); }
  if (res.status === 401 || res.status === 403) return fail('OpenAI: admin key rejected');
  if (res.status === 429) return rateLimited(res, now);
  if (!res.ok) return fail('OpenAI costs endpoint HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch (e) { return fail('bad response: ' + e.message); }
  return normalizeCosts(body, budgetUsd, now);
}

module.exports = { collectOpenai, normalizeCosts, totalUsd, monthStart, monthEnd, COSTS_URL };
