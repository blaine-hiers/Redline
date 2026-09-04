const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Encodes an RGBA raster PNG, one pixel at a time via colorAt(x, y) -> [r,g,b,a].
// Shared from-scratch PNG encoder (no external image tools) used by both the
// tray icon (this file) and the app icon generator (scripts/make-icon.mjs).
function rasterPng(size, colorAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(colorAt(x, y), row + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const LEVEL_COLORS = {
  ok: [96, 200, 120, 255],
  warn: [235, 175, 80, 255],
  alert: [230, 90, 80, 255],
};

// Light, contrasting stroke color for the pulse line against any of the level discs.
const LINE_COLOR = [245, 250, 255, 255];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lenSq : 0;
  t = clamp01(t);
  const cx = ax + t * abx, cy = ay + t * aby;
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

// A heartbeat/pulse trace, in units of the disc radius, centered on (0, 0).
// The whole trace rides below the disc's vertical center (min y = 0.28) so
// the disc's own center pixel always stays pure level color, at every size.
// Used at 32px and up — at 16px it reads as a blurry blob (the diagonal
// strokes overlap in too few pixels), so SIMPLE_THRESHOLD switches to
// simplePulseColorAt() below instead.
const PULSE_PATH = [
  [-0.85, 0.5], [-0.4, 0.5], [-0.22, 0.28], [0, 0.85], [0.22, 0.35], [0.4, 0.5], [0.85, 0.5],
];

// colorAt(x, y) for the full "M"-shaped trace (32px, 256px, ...).
function fullPulseColorAt(size, discColor) {
  const cx = size / 2, cy = size / 2;
  const margin = Math.max(1, size * 0.07);
  const radius = size / 2 - margin;
  const strokeHalf = Math.max(0.75, size * 0.05);
  const path = PULSE_PATH.map(([fx, fy]) => [cx + fx * radius, cy + fy * radius]);
  return discPulseColorAt(size, discColor, radius, strokeHalf, path);
}

// Below this size the fuller trace's diagonal strokes land in too few
// pixels to read as anything but a blurry cross — swap in a single sharp
// spike instead. Legibility beats fidelity at tray-icon sizes.
const SIMPLE_THRESHOLD = 24;

// colorAt(x, y) for the simplified single-spike trace (16px and smaller):
// baseline, one up-stroke, one apex, one down-stroke, baseline. The
// baseline is snapped to a whole pixel row (row-center, i.e. an
// integer + 0.5) so it rasterizes as one crisp row instead of being
// feathered across two — the fix for the 16px blur.
function simplePulseColorAt(size, discColor) {
  const cx = size / 2, cy = size / 2;
  const margin = Math.max(1, size * 0.07);
  const radius = size / 2 - margin;

  const baselineY = Math.round(cy + radius * 0.42) + 0.5;
  const apexY = Math.round(cy - radius * 0.4) + 0.5;
  const apexX = Math.round(cx) + 0.5;
  const halfRun = Math.max(2, Math.round(radius * 0.4));
  const flankX = Math.max(1, Math.round(radius * 0.7));

  const path = [
    [cx - flankX, baselineY],
    [apexX - halfRun, baselineY],
    [apexX, apexY],
    [apexX + halfRun, baselineY],
    [cx + flankX, baselineY],
  ];

  // A hard ~1.1px stroke (full coverage at the centerline, feathered only
  // at the true edge) rather than the softer, wider feather used above —
  // "edge-only" anti-aliasing so the line doesn't smear at 16px.
  const strokeHalf = 0.55;
  return discPulseColorAt(size, discColor, radius, strokeHalf, path);
}

// Shared disc + stroked-polyline compositor for both trace variants above.
// Edges are anti-aliased with a coverage feather (not supersampling), so
// it stays sharp and fast at every size.
function discPulseColorAt(size, discColor, radius, strokeHalf, path) {
  const cx = size / 2, cy = size / 2;
  return (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    const dx = px - cx, dy = py - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const discAlpha = clamp01(radius - dist + 0.5);
    if (discAlpha <= 0) return [0, 0, 0, 0];

    let lineDist = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const d = distToSegment(px, py, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
      if (d < lineDist) lineDist = d;
    }
    const lineAlpha = clamp01(strokeHalf - lineDist + 0.5);

    const r = Math.round(discColor[0] + (LINE_COLOR[0] - discColor[0]) * lineAlpha);
    const g = Math.round(discColor[1] + (LINE_COLOR[1] - discColor[1]) * lineAlpha);
    const b = Math.round(discColor[2] + (LINE_COLOR[2] - discColor[2]) * lineAlpha);
    const a = Math.round(255 * discAlpha);
    return [r, g, b, a];
  };
}

function pulseGlyphColorAt(size, discColor) {
  return size < SIMPLE_THRESHOLD ? simplePulseColorAt(size, discColor) : fullPulseColorAt(size, discColor);
}

// A filled disc (colored by alert level) with a pulse/heartbeat line across
// it — the "Redline" glyph. Deterministic; same (size, level) always
// produces the same bytes.
function trayIconPng(size, level) {
  const discColor = LEVEL_COLORS[level];
  if (!discColor) throw new Error(`unknown level: ${level}`);
  return rasterPng(size, pulseGlyphColorAt(size, discColor));
}

module.exports = { rasterPng, trayIconPng, LEVEL_COLORS };
