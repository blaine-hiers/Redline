// Generates build/icon.png — a 256x256 render of the same "Redline"
// glyph (a level-colored disc with a heartbeat/pulse line across it) used
// for the tray icon, so the installer/taskbar icon matches the tray.
//
// The from-scratch PNG encoder and the glyph itself live in src/trayicon.js
// (CommonJS) so the app icon and the tray share one implementation; this
// script just requires it via createRequire since it itself is ESM.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { trayIconPng } = require('../src/trayicon.js');

const SIZE = 256;
// The app/installer icon isn't tied to a live alert — 'ok' is the steady,
// at-rest state.
const LEVEL = 'ok';

const png = trayIconPng(SIZE, LEVEL);
const outDir = path.join(__dirname, '..', 'build');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
writeFileSync(outFile, png);
console.log(`wrote ${outFile} (${png.length} bytes)`);
