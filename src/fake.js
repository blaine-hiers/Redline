const { MIN_GAP_MS, key5h, keyWeek } = require('./history');

const DAY_MS = 86400_000;
const FIVE_H_MS = 5 * 3600_000;

let t = 0;
const wave = (base, amp, speed, tt) => Math.max(0, Math.min(100, Math.round(base + amp * Math.sin(tt * speed))));
const mk = (p5, pw) => ({
  ok: true, stale: false,
  pct5h: p5, resets5h: Date.now() + 2 * 3600_000,
  pctWeek: pw, resetsWeek: Date.now() + 3 * 86400_000,
  error: null,
});

// The curve constants for one meter. The two built-ins keep the exact numbers
// they had before a later change so `--fake` (and the committed screenshots) are
// unchanged; any other id gets a stable curve derived from its own name, so a
// user-added meter animates plausibly and identically on every run.
const SHAPES = {
  claude: { base: 45, amp: 40, speed: 0.13, wkBase: 30, wkAmp: 15, wkSpeed: 0.05, peak: 88, phase: 0, wkStart: 30, wkDrop: 12 },
  codex: { base: 70, amp: 25, speed: 0.09, wkBase: 45, wkAmp: 20, wkSpeed: 0.04, peak: 72, phase: 0.45, wkStart: 45, wkDrop: 20 },
};

// FNV-1a over the id: any string in, the same integer out, on every platform.
function hashId(id) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function shapeFor(id) {
  if (Object.hasOwn(SHAPES, id)) return SHAPES[id];
  const h = hashId(id);
  const pick = (shift, mod, min) => min + ((h >>> shift) % mod);
  return {
    base: pick(0, 40, 30), amp: pick(5, 25, 12), speed: 0.06 + ((h >>> 10) % 12) / 100,
    wkBase: pick(14, 35, 20), wkAmp: pick(19, 15, 6), wkSpeed: 0.03 + ((h >>> 23) % 5) / 100,
    peak: pick(3, 35, 55), phase: ((h >>> 7) % 100) / 100, wkStart: pick(11, 30, 25), wkDrop: pick(17, 18, 6),
  };
}

// Pass a seed to get the same reading back on every call — used for
// screenshots (and anything else that needs reproducible fake data). Without
// a seed the internal counter advances each call, so plain `--fake` animates.
function fakeSnapshot(providers, seed) {
  const tt = seed != null ? seed : (t += 1);
  const out = Object.create(null); // keyed by provider id — never inherit Object.prototype
  for (const { id } of providers) {
    const s = shapeFor(id);
    out[id] = mk(wave(s.base, s.amp, s.speed, tt), wave(s.wkBase, s.wkAmp, s.wkSpeed, tt));
  }
  return out;
}

// ~24h of plausible samples so `npm run dev:fake` shows sparklines immediately:
// 5h windows fill and reset on their own cycle, weekly usage drifts upward.
function fakeHistory(providers, now = Date.now()) {
  const out = [];
  // Phase is relative to now, so the curve is identical on every run (screenshots).
  const ramp = (ts, peak, phase) => Math.round(peak * (((((ts - now) / FIVE_H_MS) + phase) % 1 + 1) % 1));
  for (let ts = now - DAY_MS; ts <= now; ts += MIN_GAP_MS) {
    const age = (now - ts) / DAY_MS; // 1 at the oldest sample, 0 at the newest
    const sample = { t: ts };
    for (const { id } of providers) {
      const s = shapeFor(id);
      sample[key5h(id)] = ramp(ts, s.peak, s.phase);
      sample[keyWeek(id)] = Math.round(s.wkStart - s.wkDrop * age);
    }
    out.push(sample);
  }
  return out;
}

module.exports = { fakeSnapshot, fakeHistory, shapeFor };
