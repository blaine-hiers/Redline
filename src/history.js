const fs = require('fs');
const path = require('path');

const MIN_GAP_MS = 5 * 60 * 1000; // one sample per 5 min, whatever the pulse interval is
const RETAIN_MS = 7 * 86400_000;
const MAX_SAMPLES = 2500;

// Samples are appended in time order, so prune/series can assume ascending `t`.
const pct = (s, key) => (s && s.ok && typeof s[key] === 'number' ? s[key] : null);

// One column per provider window. Before a later change these were four fixed keys
// (c5/cw/x5/xw); now every meter names its own pair, so an added meter starts
// recording without a schema change. See migrateSample for the old names.
const key5h = (id) => `${id}.5h`;
const keyWeek = (id) => `${id}.wk`;

// `snap` is the per-id result map; `providers` the ordered enabled meters.
function append(hist, snap, providers, now = Date.now()) {
  const last = hist[hist.length - 1];
  if (last && now - last.t < MIN_GAP_MS) return false;
  const sample = { t: now };
  for (const { id } of providers) {
    sample[key5h(id)] = pct(snap[id], 'pct5h');
    sample[keyWeek(id)] = pct(snap[id], 'pctWeek');
  }
  hist.push(sample);
  return true;
}

function prune(hist, now = Date.now()) {
  const cutoff = now - RETAIN_MS;
  let old = 0;
  while (old < hist.length && hist[old].t < cutoff) old += 1;
  if (old) hist.splice(0, old);
  if (hist.length > MAX_SAMPLES) hist.splice(0, hist.length - MAX_SAMPLES);
  return hist;
}

function series(hist, key, sinceMs, now = Date.now()) {
  const from = now - sinceMs;
  const out = [];
  for (const s of hist) if (s.t >= from) out.push({ t: s.t, v: s[key] ?? null });
  return out;
}

// A hand-edited or half-written file must not put junk into `hist`: prune and
// series read `.t` on every entry, and a throw there would break every pulse.
const isSample = (s) => !!s && typeof s === 'object' && Number.isFinite(s.t);

// Pre-a later change files carry four fixed columns. Renaming them on load (rather
// than teaching series() both spellings) means the migration happens exactly
// once, and the next save writes only the new names.
const LEGACY_KEYS = { c5: 'claude.5h', cw: 'claude.wk', x5: 'codex.5h', xw: 'codex.wk' };

function migrateSample(s) {
  let touched = false;
  const out = { ...s };
  for (const [old, next] of Object.entries(LEGACY_KEYS)) {
    if (!(old in out)) continue;
    if (!(next in out)) out[next] = out[old];
    delete out[old];
    touched = true;
  }
  return touched ? out : s;
}

function loadHistory(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isSample).map(migrateSample) : [];
  } catch (_) { return []; }
}

function saveHistory(dir, hist) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(hist));
}

module.exports = { MIN_GAP_MS, RETAIN_MS, MAX_SAMPLES, LEGACY_KEYS, key5h, keyWeek, migrateSample, append, prune, series, loadHistory, saveHistory };
