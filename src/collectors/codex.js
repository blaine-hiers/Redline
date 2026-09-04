const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

function sessionFilesByMtime(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        let mtime;
        try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
        files.push({ path: p, mtime });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

function findRateLimits(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.rate_limits && typeof obj.rate_limits === 'object' && obj.rate_limits.primary) {
    return obj.rate_limits;
  }
  for (const v of Object.values(obj)) {
    const found = findRateLimits(v);
    if (found) return found;
  }
  return null;
}

function lastRateLimits(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const rl = findRateLimits(JSON.parse(lines[i]));
      if (rl) return rl;
    } catch { /* skip unparseable line */ }
  }
  return null;
}

function toMs(t) {
  if (typeof t !== 'number') return null;
  return t < 1e12 ? t * 1000 : t; // epoch seconds vs ms
}

function normalize(rl, now = Date.now()) {
  let w5 = null, wk = null;
  // primary defaults to the 5h window, secondary to weekly, when window_minutes is absent
  for (const [w, defMinutes] of [[rl.primary, 300], [rl.secondary, 10080]]) {
    if (!w) continue;
    const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : defMinutes;
    if (minutes <= 1440) { if (!w5) w5 = w; } else if (!wk) wk = w;
  }
  const conv = (w) => {
    if (!w) return { pct: null, resets: null };
    const resets = toMs(w.resets_at);
    let pct = typeof w.used_percent === 'number' ? w.used_percent : null;
    if (resets !== null && resets < now) pct = 0; // window reset while idle
    return { pct, resets };
  };
  const five = conv(w5), week = conv(wk);
  return {
    ok: true, stale: false,
    pct5h: five.pct, resets5h: five.resets,
    pctWeek: week.pct, resetsWeek: week.resets,
    error: null,
  };
}

function collectCodex(root = SESSIONS_DIR, now = Date.now()) {
  const fail = (error) => ({ ok: false, stale: true, pct5h: null, resets5h: null, pctWeek: null, resetsWeek: null, error });
  const files = sessionFilesByMtime(root);
  if (!files.length) return fail('no codex sessions found');
  // a just-started session has no rate_limits yet — fall back to recent files
  for (const file of files.slice(0, 5)) {
    let rl = null;
    try { rl = lastRateLimits(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (rl) return normalize(rl, now);
  }
  return fail('no rate_limits in recent sessions');
}

module.exports = { collectCodex, sessionFilesByMtime, lastRateLimits, normalize, SESSIONS_DIR };
