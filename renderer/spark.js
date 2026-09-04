// Sparkline helpers — loaded as a plain <script> in the renderer and as a
// CommonJS module in the tests. Output is markup only (no style attributes),
// so it stays inside the widget's CSP; colours live in themes.css.

const BLOCKS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';

function plottable(series) {
  return series.filter((p) => typeof p.v === 'number').length >= 2;
}

function num(v) {
  return String(Math.round(v * 10) / 10);
}

// series: [{ t, v }] with v === null for a failed pulse (breaks the line).
function sparkline(series, w, h) {
  if (!series || !plottable(series)) return '';
  const t0 = series[0].t, span = series[series.length - 1].t - t0;
  if (span <= 0) return '';
  const runs = [];
  let run = [];
  for (const p of series) {
    if (typeof p.v !== 'number') { if (run.length > 1) runs.push(run); run = []; continue; }
    const x = ((p.t - t0) / span) * w;
    const y = 1 + (1 - Math.max(0, Math.min(100, p.v)) / 100) * (h - 2); // 1px inset for the stroke
    run.push(`${num(x)},${num(y)}`);
  }
  if (run.length > 1) runs.push(run);
  if (!runs.length) return '';
  const lines = runs.map((r) => `<polyline points="${r.join(' ')}"/>`).join('');
  return `<svg class="spark" width="${w}" height="${h}">${lines}</svg>`;
}

// Terminal-theme variant: the same series as a row of block characters.
function blockSpark(series, n) {
  if (!series || !plottable(series)) return '';
  const t0 = series[0].t, span = series[series.length - 1].t - t0;
  if (span <= 0) return '';
  const sum = new Array(n).fill(0), count = new Array(n).fill(0);
  for (const p of series) {
    if (typeof p.v !== 'number') continue;
    const i = Math.min(n - 1, Math.floor(((p.t - t0) / span) * n));
    sum[i] += Math.max(0, Math.min(100, p.v));
    count[i] += 1;
  }
  let out = '';
  for (let i = 0; i < n; i += 1) {
    if (!count[i]) { out += ' '; continue; }
    out += BLOCKS[Math.round((sum[i] / count[i] / 100) * (BLOCKS.length - 1))];
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { plottable, sparkline, blockSpark };
