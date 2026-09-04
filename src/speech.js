const WINDOW_WORDS = { '5h': 'five hour window', week: 'weekly window' };

// The spoken name comes off the alert itself (computeAlerts copies the
// provider's label onto it), so a user-added meter is announced by its own
// name without any table here to keep in sync.
function alertPhrase(a) {
  const name = a.name || a.service;
  let out = `${name} ${WINDOW_WORDS[a.window] || a.window} at ${a.pct} percent.`;
  if (a.level === 'alert') out += ' Nearly out of budget.';
  return out;
}

function alertsPhrase(alerts) { // one utterance per pulse, so a later alert's speak() can't cancel an earlier one
  return alerts.map(alertPhrase).join(' ');
}

function effPct(pct, resets, now) { // mirrors the renderer's reset-passed-means-zero rule
  if (typeof pct !== 'number') return null;
  if (resets && resets < now) return 0;
  return pct;
}

function unit(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function countdownWords(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0 && m > 0) return `${unit(h, 'hour')} ${unit(m, 'minute')}`;
  if (h > 0) return unit(h, 'hour');
  return unit(m, 'minute');
}

function serviceSummary(name, s, now) {
  if (!s || !s.ok) return `${name}: unavailable.`;
  const p5 = effPct(s.pct5h, s.resets5h, now);
  const pw = effPct(s.pctWeek, s.resetsWeek, now);
  let out = `${name}: 5 hour window ${p5 ?? '—'} percent`;
  if (typeof s.resets5h === 'number' && s.resets5h >= now) {
    out += `, resets in ${countdownWords(s.resets5h - now)}`;
  }
  out += `. Weekly ${pw ?? '—'} percent.`;
  return out;
}

// `snap` is the per-id result map; `providers` the ordered enabled meters.
function summaryPhrase(snap, providers, now = Date.now()) {
  return providers.map((p) => serviceSummary(p.label, snap?.[p.id], now)).join(' ');
}

module.exports = { alertPhrase, alertsPhrase, summaryPhrase };
