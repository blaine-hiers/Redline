const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { trayIconPng, LEVEL_COLORS } = require('../src/trayicon');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Minimal from-scratch PNG decoder for the RGBA8, single-IDAT, filter-0
// rasters this encoder always produces — enough to assert real pixel values
// rather than trusting the encoder that wrote them.
function decodePng(buf) {
  assert.deepStrictEqual([...buf.subarray(0, 8)], PNG_SIGNATURE);
  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatParts = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  assert.strictEqual(bitDepth, 8);
  assert.strictEqual(colorType, 6); // RGBA
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = 1 + width * 4;
  assert.strictEqual(raw.length, height * stride);
  const pixels = (x, y) => {
    const rowStart = y * stride;
    assert.strictEqual(raw[rowStart], 0, 'expected filter type 0 (none)');
    const p = rowStart + 1 + x * 4;
    return [raw[p], raw[p + 1], raw[p + 2], raw[p + 3]];
  };
  return { width, height, pixels };
}

for (const size of [16, 32]) {
  test(`trayIconPng(${size}) is a structurally valid PNG`, () => {
    const buf = trayIconPng(size, 'ok');
    assert.deepStrictEqual([...buf.subarray(0, 8)], PNG_SIGNATURE);
    assert.strictEqual(buf.readUInt32BE(16), size); // IHDR width
    assert.strictEqual(buf.readUInt32BE(20), size); // IHDR height
    assert.ok(buf.includes(Buffer.from('IEND')));
  });

  test(`trayIconPng(${size}) has fully transparent corners`, () => {
    const { width, height, pixels } = decodePng(trayIconPng(size, 'ok'));
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
      assert.strictEqual(pixels(x, y)[3], 0, `corner (${x},${y}) should be transparent`);
    }
  });

  test(`trayIconPng(${size}) centre pixel is the level color`, () => {
    for (const level of Object.keys(LEVEL_COLORS)) {
      const { width, height, pixels } = decodePng(trayIconPng(size, level));
      const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
      assert.deepStrictEqual(pixels(cx, cy), LEVEL_COLORS[level], `level ${level} at size ${size}`);
    }
  });
}

test('trayIconPng produces a different image per level', () => {
  const images = Object.keys(LEVEL_COLORS).map((level) => trayIconPng(16, level).toString('base64'));
  assert.strictEqual(new Set(images).size, images.length);
});

test('trayIconPng is deterministic', () => {
  const a = trayIconPng(32, 'warn');
  const b = trayIconPng(32, 'warn');
  assert.ok(a.equals(b));
});

test('trayIconPng rejects an unknown level', () => {
  assert.throws(() => trayIconPng(16, 'nope'));
});

// Legibility guard for the 16px glyph (the size that actually renders in the
// tray at 100% DPI): the simplified single-spike trace must land a real
// pixel-aligned stroke, not a soft blur — so some row has to carry a solid
// run of near-full-white pixels (the flat baseline either side of the
// spike), not just a scatter of partially-blended ones.
test('trayIconPng(16) has a legible pulse line (a solid run of white pixels in one row)', () => {
  const MIN_RUN = 3;
  for (const level of Object.keys(LEVEL_COLORS)) {
    const { width, height, pixels } = decodePng(trayIconPng(16, level));
    let bestRun = 0;
    for (let y = 0; y < height; y++) {
      let run = 0;
      for (let x = 0; x < width; x++) {
        const [r, g, b, a] = pixels(x, y);
        const isLine = a === 255 && r >= 240 && g >= 240 && b >= 240;
        run = isLine ? run + 1 : 0;
        if (run > bestRun) bestRun = run;
      }
    }
    assert.ok(bestRun >= MIN_RUN, `level ${level}: longest solid white run was ${bestRun}, expected >= ${MIN_RUN}`);
  }
});
