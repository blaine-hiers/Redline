const WINDOWS = [['pct5h', '5h'], ['pctWeek', 'week']];

// `prev`/`next` are per-id maps ({ claude: result, codex: result, … });
// `providers` is the ordered list of enabled meters (src/providers.js), so
// both loops below scale to however many the user has configured instead of
// the hardcoded Claude/Codex pair this used to carry.
function computeAlerts(prev, next, cfg, providers) {
  const out = [];
  for (const { id, label } of providers) {
    for (const [key, window] of WINDOWS) {
      const n = next?.[id]?.[key];
      if (typeof n !== 'number') continue;
      const p = typeof prev?.[id]?.[key] === 'number' ? prev[id][key] : 0;
      if (p < cfg.alertAt && n >= cfg.alertAt) out.push({ service: id, name: label, window, level: 'alert', pct: n });
      else if (p < cfg.warnAt && n >= cfg.warnAt) out.push({ service: id, name: label, window, level: 'warn', pct: n });
    }
  }
  return out;
}

function worstLevel(snap, cfg, providers) {
  let worst = 'ok';
  for (const { id } of providers) {
    for (const [key] of WINDOWS) {
      const v = snap?.[id]?.[key];
      if (typeof v !== 'number') continue;
      if (v >= cfg.alertAt) return 'alert';
      if (v >= cfg.warnAt) worst = 'warn';
    }
  }
  return worst;
}

module.exports = { computeAlerts, worstLevel };
