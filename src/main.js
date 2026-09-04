const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, screenshotConfig } = require('./config');
const { resolveProviders, collectWithDeadline, builtinMeta, windowsFor, BUILTIN_IDS } = require('./providers');
const { computeAlerts, worstLevel } = require('./alerts');
const { alertsPhrase, summaryPhrase } = require('./speech');
const { trayIconPng } = require('./trayicon');
const { fakeSnapshot, fakeHistory } = require('./fake');
const { append, prune, series, key5h, loadHistory, saveHistory } = require('./history');
const { loginItemSettings } = require('./autostart');
const { sanitizeConfigPatch, redactCfg } = require('./settings');
const { scrubSecrets } = require('./collectors/shared');
const { windowOptions } = require('./windowoptions');
const { THEMES, THEME_BY_ID } = require('../renderer/themelist');
const { MAX_SCALE, clampScale, resizeAction, keepOnScreen } = require('../renderer/sizing');

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};
const { debounced } = require('./debounce');
const { resetBackoff, onRateLimited, onCooldown, staleMerge, retryNote, shouldPoll } = require('./backoff');

const FAKE = process.argv.includes('--fake');
const HIDDEN = process.argv.includes('--hidden');
const SCREENSHOT_DIR = argValue('--screenshot');
const SEED_ARG = argValue('--seed');
// Deterministic fake data: an explicit --seed always wins; --screenshot picks
// a fixed default seed so a screenshot run never depends on call order.
const SEED = SEED_ARG != null ? Number(SEED_ARG) : (SCREENSHOT_DIR ? 1 : undefined);
// Verification-only: `--fake --providers 4` pads the meter list out to N with
// throwaway demo meters, so the "does every theme render N rows" check
// doesn't need the user's real config edited. Ignored outside --fake, and the
// default (no flag) is the same two meters the screenshots have always shown.
const FAKE_PROVIDERS_ARG = FAKE ? argValue('--providers') : null;
const FAKE_PROVIDER_COUNT = Number(FAKE_PROVIDERS_ARG) || 0;
// `--fake --providers all` (or a comma-separated id list) instead force-enables
// built-in meters that ship disabled, so each new collector's row — its accent,
// its window labels — can be previewed without a credential. Numeric values
// keep the demo-padding behaviour above.
const FAKE_PROVIDER_IDS = FAKE && FAKE_PROVIDERS_ARG && !FAKE_PROVIDER_COUNT
  ? (FAKE_PROVIDERS_ARG === 'all' ? BUILTIN_IDS : FAKE_PROVIDERS_ARG.split(',').map((s) => s.trim()).filter(Boolean))
  : [];
const DEMO_COLOURS = ['#9ae06a', '#e06ac0', '#e0d06a', '#6ae0d0'];
const BUILTIN_META = builtinMeta(); // static; the panel's Meters list reads it every snapshot
const HISTORY_WINDOW_MS = 86400_000; // sparklines show the last 24h
// the pulse interval is no longer user-configurable — fixed at 6
// minutes (comfortably above CLAUDE_MIN_INTERVAL_MS in backoff.js). Startup
// still polls immediately (see the `await pulse()` below) and "Refresh now"
// still bypasses both this cadence and the 429 cooldown.
const PULSE_MS = 6 * 60_000;
// --fake has no real endpoint to protect and the demo should keep animating
// for anyone watching it, so it ticks fast instead of on the real cadence.
const FAKE_PULSE_MS = 2_000;
// Smallest window a drag may produce; the height is content-fitted anyway, so
// this is really just a floor on how far the width can be dragged in.
const MIN_WINDOW = { width: 200, height: 120 };
// Breathing room left around the widget when it is big enough to run into the
// edges of the screen, so a maxed-out card still reads as a window.
const WORK_AREA_MARGIN = 40;

if (SCREENSHOT_DIR && !FAKE) {
  console.error('--screenshot requires --fake (screenshot mode never hits the network)');
  process.exit(1);
}

let win = null, tray = null, timer = null;
// The content size the renderer last asked for. Every content-fit resize this
// process performs echoes back as a 'resize' event, so a matching size means
// "that was us" rather than a user dragging an edge — and a size that differs
// only in height is a drag the fit has to undo. null until the renderer has
// fitted once, which keeps startup resizes from clobbering the saved scale.
let lastFit = null;
let cfg, lastSnap = null;
// The ordered, enabled meters this run is polling — resolved from
// cfg.providers (src/providers.js) and re-resolved whenever that changes.
let providers = [];
let hist = [];
let pulsing = false;
let quitting = false;
// All three are keyed by provider id, so all three are null-prototype: a
// plain `{}` would answer `cooldown['constructor']` with an inherited
// function and silently corrupt that meter's state.
const lastGood = Object.create(null); // the alert baseline survives failed pulses
// Per-provider 429 cooldown (src/backoff.js owns the pure math). A provider on
// cooldown is skipped entirely in pulse() rather than re-hitting a
// rate-limited endpoint; this state tracks when it's safe to try again.
const cooldown = Object.create(null);
// Wall-clock time of each provider's last collector *attempt* (0 = never),
// used to enforce its minIntervalMs floor — see shouldPoll in backoff.js.
const lastAttemptAt = Object.create(null);

// The meter list a run actually uses: the saved config, padded out with demo
// meters under `--fake --providers N`.
function providerConfig() {
  let base = Array.isArray(cfg.providers) ? cfg.providers : [];
  if (FAKE_PROVIDER_IDS.length) {
    const wanted = new Set(FAKE_PROVIDER_IDS);
    base = base.map((p) => (wanted.has(p.id) ? { ...p, enabled: true } : p));
    // an id the saved config has never heard of still gets a row
    for (const id of FAKE_PROVIDER_IDS) if (!base.some((p) => p.id === id)) base.push({ id, enabled: true });
  }
  if (FAKE_PROVIDER_COUNT <= base.length) return base;
  const extra = [];
  for (let i = base.length; i < FAKE_PROVIDER_COUNT; i += 1) {
    extra.push({
      id: `demo${i + 1}`, enabled: true, label: `Demo ${i + 1}`,
      colour: DEMO_COLOURS[(i - base.length) % DEMO_COLOURS.length],
      type: 'json', path: '', // never collected: --fake short-circuits collect()
    });
  }
  return [...base, ...extra];
}

// Re-resolve the meter list and make sure every one of them has its own
// cooldown/attempt state. Existing state is kept, so toggling one meter off
// and back on doesn't clear another's backoff.
function refreshProviders() {
  providers = resolveProviders(providerConfig());
  for (const p of providers) {
    if (!cooldown[p.id]) cooldown[p.id] = resetBackoff();
    if (!(p.id in lastAttemptAt)) lastAttemptAt[p.id] = 0;
  }
}

// Builds the display object for one service: pass through a fresh result
// as-is, but when the live collection failed and a previous good reading
// exists, ship that reading dimmed with a short reason instead of the bare
// failure — the card keeps its numbers. lastGood itself is never mutated.
function displayService(id, now) {
  const raw = lastSnap ? lastSnap.services[id] : null;
  if (!raw || raw.ok) return raw;
  const good = lastGood[id];
  if (!good) return raw; // full failure, nothing to fall back on
  const cd = cooldown[id];
  const reason = (cd && onCooldown(cd, now) ? retryNote(cd.cooldownUntil, now) : null) ?? raw.error;
  return staleMerge(good, reason);
}

// Every saved credential, so the one string a collector composes freely — its
// error message — can be checked against them on the way out.
function savedTokens() {
  const list = Array.isArray(cfg.providers) ? cfg.providers : [];
  return list.map((p) => (p && typeof p.token === 'string' ? p.token : null)).filter(Boolean);
}

// Belt and braces. Each collector is tested never to put a credential in its
// error, and none of them interpolates one — but `error` is the single field
// that crosses IPC, lands in the DOM and shows up in a `title=` tooltip, so a
// value matching a saved token is replaced rather than displayed, whatever
// produced it. Returns the reading untouched when there is nothing to scrub,
// and never mutates it (lastGood/lastSnap hold the same objects).
function scrubService(data, secrets) {
  if (!data || !secrets.length || typeof data.error !== 'string' || !data.error) return data;
  const clean = scrubSecrets(data.error, secrets);
  return clean === data.error ? data : { ...data, error: clean };
}

function snapshotPayload() {
  const now = Date.now();
  const secrets = savedTokens();
  return {
    // Ordered, so the renderer draws one row per meter in config order — the
    // renderer no longer knows the names of any particular service.
    services: providers.map((p) => {
      const data = scrubService(displayService(p.id, now), secrets);
      // windowsFor: a couple of meters only learn what their window is called
      // from the reading itself (src/providers.js).
      return { id: p.id, label: p.label, colour: p.colour, windows: windowsFor(p, data), data };
    }),
    at: lastSnap ? lastSnap.at : 0,
    theme: cfg.theme,
    // Redacted: a pasted credential lives in config.json but must never cross
    // into the renderer — the Meters list gets `hasToken: true` instead.
    cfg: redactCfg(cfg),
    // Static registry facts for every built-in, enabled or not, so the panel's
    // Meters list can name and offer a Token field to a meter that is switched
    // off (and therefore absent from `services`).
    builtins: BUILTIN_META,
    winPlatform: process.platform === 'win32', // gates the settings panel's autoStart control
    // Keyed by provider id; each value is that meter's last-24h 5h-window series.
    history: cfg.showHistory
      ? Object.fromEntries(providers.map((p) => [p.id, series(hist, key5h(p.id), HISTORY_WINDOW_MS)]))
      : null,
    solidBackground: cfg.solidBackground,
    maxContent: maxContentSize(), // the renderer shrinks its fit to the work area
    screenshot: !!SCREENSHOT_DIR, // pauses skin animations so a capture is deterministic
  };
}

const COOLDOWN_SKIP = { ok: false, stale: true, pct5h: null, resets5h: null, pctWeek: null, resetsWeek: null, error: 'rate limited — cooldown active' };

// bypassCooldown: the manual "Refresh now" action skips the cooldown check
// once, without resetting or otherwise touching the backoff state.
async function pulse({ bypassCooldown = false } = {}) {
  if (pulsing) return; // never overlap slow pulses
  pulsing = true;
  try {
    const now = Date.now();
    const prev = lastSnap ? lastSnap.services : Object.create(null);
    let results = Object.create(null);
    if (FAKE) {
      // Fake mode has no real endpoint to protect, and the demo should keep
      // animating every tick — so the per-provider interval floor below is
      // deliberately not applied here (guarded by the FAKE branch itself).
      results = fakeSnapshot(providers, SEED);
    } else {
      const attempted = [];
      const jobs = providers.map((p) => {
        if (!bypassCooldown && onCooldown(cooldown[p.id], now)) return Promise.resolve(COOLDOWN_SKIP);
        // Independent of the 429 cooldown above: a provider may declare a
        // minimum interval (Claude's endpoint isn't built for per-minute
        // polling — a later change). Inside that floor the previous result is
        // reused unchanged rather than attempted or marked stale.
        if (!shouldPoll(lastAttemptAt[p.id], now, bypassCooldown, p.minIntervalMs)) {
          return Promise.resolve(prev[p.id] ?? COOLDOWN_SKIP);
        }
        lastAttemptAt[p.id] = now;
        attempted.push(p.id);
        // Hard deadline per meter (src/providers.js): a collector that throws,
        // returns junk, or never settles degrades that one meter instead of
        // holding `pulsing` — and every other meter — open forever.
        return collectWithDeadline(p);
      });
      const settled = await Promise.all(jobs);
      providers.forEach((p, i) => { results[p.id] = settled[i]; });
      for (const id of attempted) {
        const r = results[id];
        if (r.ok) cooldown[id] = resetBackoff();
        else if (r.retryAfterMs !== undefined) cooldown[id] = onRateLimited(cooldown[id], r.retryAfterMs, now);
      }
    }
    const next = { services: results, at: Date.now() };
    const alerts = computeAlerts(lastGood, results, cfg, providers);
    for (const a of alerts) {
      new Notification({
        title: `${a.name.toUpperCase()} ${a.window} window at ${a.pct}%`,
        body: a.level === 'alert' ? 'Nearly out of budget.' : 'Heads up — usage is climbing.',
      }).show();
    }
    if (cfg.speakAlerts && alerts.length) win?.webContents.send('speak', alertsPhrase(alerts));
    for (const p of providers) if (results[p.id]?.ok) lastGood[p.id] = results[p.id];
    lastSnap = next;
    if (append(hist, results, providers, next.at)) { prune(hist, next.at); persistHistory(); }
    if (win && !win.isDestroyed()) win.webContents.send('snapshot', snapshotPayload());
    updateTray();
  } finally {
    pulsing = false;
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(pulse, FAKE ? FAKE_PULSE_MS : PULSE_MS);
}

// Windows picks the representation matching the display's DPI scaling
// (16px at 100%, 32px at 150-200%), so the tray icon is built with both.
function trayImage(level) {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ width: 16, height: 16, scaleFactor: 1.0, buffer: trayIconPng(16, level) });
  img.addRepresentation({ width: 32, height: 32, scaleFactor: 2.0, buffer: trayIconPng(32, level) });
  return img;
}

function updateTray() {
  if (!tray) return;
  const level = lastSnap ? worstLevel(lastSnap.services, cfg, providers) : 'ok';
  tray.setImage(trayImage(level));
  const f = (s) => (s && typeof s.pct5h === 'number' ? `${s.pct5h}%` : '—');
  const parts = providers.map((p) => `${p.label} 5h ${f(lastSnap?.services?.[p.id])}`);
  tray.setToolTip(['Gauge', ...parts].join(' · '));
}

function applyAutoStart() {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings(loginItemSettings(cfg, {
    isPackaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(),
  }));
}

// Applies a validated settings patch identically whether it came from the
// context menu or the in-widget settings panel, so the two surfaces can't
// drift. Mirrors what the menu `click` handlers used to do inline: persist,
// restyle the window on alwaysOnTop/opacity, reapply the login item on
// autoStart, and re-send a snapshot only when the rendered card itself needs
// to change shape (theme, history visibility) — other keys take effect on
// the next natural pulse.
function applySettings(partial) {
  const clean = sanitizeConfigPatch(cfg, partial);
  if (Object.keys(clean).length === 0) return clean;
  const solidChanged = 'solidBackground' in clean && clean.solidBackground !== cfg.solidBackground;
  Object.assign(cfg, clean);
  persist();
  if ('alwaysOnTop' in clean) win?.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
  if ('opacity' in clean) win?.setOpacity(cfg.opacity);
  if ('autoStart' in clean) applyAutoStart();
  if ('theme' in clean) applyMaxSize();
  if ('providers' in clean) {
    refreshProviders();
    if (FAKE) hist = fakeHistory(providers); // demo sparklines for a just-added meter
  }
  if ('theme' in clean || 'showHistory' in clean || 'scale' in clean || 'providers' in clean) {
    win?.webContents.send('snapshot', snapshotPayload());
  }
  // transparent can't be flipped on a live BrowserWindow — rebuild it last, so
  // every other effect above (including the snapshot re-send) already landed
  // on the still-current window before it's torn down.
  if (solidChanged) recreateWindow();
  return clean;
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Theme', submenu: THEMES.map(({ id, label }) => ({
        label, type: 'radio', checked: cfg.theme === id,
        click: () => applySettings({ theme: id }),
      })) },
    { label: 'Always on top', type: 'checkbox', checked: cfg.alwaysOnTop,
      click: (item) => applySettings({ alwaysOnTop: item.checked }) },
    ...(process.platform === 'win32' ? [
      { label: 'Start with Windows', type: 'checkbox', checked: cfg.autoStart,
        click: (item) => applySettings({ autoStart: item.checked }) },
    ] : []),
    { label: 'Speak alerts', type: 'checkbox', checked: cfg.speakAlerts,
      click: (item) => applySettings({ speakAlerts: item.checked }) },
    { label: 'Show history', type: 'checkbox', checked: cfg.showHistory,
      click: (item) => applySettings({ showHistory: item.checked }) },
    { label: 'Solid background', type: 'checkbox', checked: cfg.solidBackground,
      click: (item) => applySettings({ solidBackground: item.checked }) },
    { type: 'separator' },
    { label: 'Show widget', click: () => { win?.show(); } },
    { label: 'Refresh now', click: () => pulse({ bypassCooldown: true }) },
    { label: 'Read usage aloud', click: () => { win?.webContents.send('speak', summaryPhrase(lastSnap?.services, providers)); } },
    { label: 'Open config file', click: () => shell.openPath(path.join(app.getPath('userData'), 'config.json')) },
    { type: 'separator' },
    { label: 'Quit Gauge', click: () => app.quit() },
  ]);
}

const persist = debounced(() => {
  if (SCREENSHOT_DIR) return; // never touch the user's saved config from a screenshot run (flush included)
  saveConfig(app.getPath('userData'), cfg);
}, 250);

const persistHistory = debounced(() => {
  if (FAKE) return; // seeded demo samples must never overwrite the real file
  saveHistory(app.getPath('userData'), hist);
}, 250);

// The unscaled content width of the current theme's card — the baseline a
// dragged width is turned into a scale against.
function baseWidth() {
  return (THEME_BY_ID[cfg.theme] ?? THEME_BY_ID.glass).width;
}

// The largest content the widget may occupy: the work area of whichever
// display it is on, less a margin. This is the *whole* work area rather than
// what is left below the window's current top edge, because keepWindowOnScreen
// shifts the window up afterwards — measuring from the current top would shrink
// a low-parked card that only ever needed moving.
function maxContentSize() {
  if (!win || win.isDestroyed()) return null;
  const { width, height } = screen.getDisplayMatching(win.getBounds()).workAreaSize;
  return {
    w: Math.max(MIN_WINDOW.width, width - WORK_AREA_MARGIN),
    h: Math.max(MIN_WINDOW.height, height - WORK_AREA_MARGIN),
  };
}

// Cap the drag at MAX_SCALE so the window can't be pulled wider than the card
// will ever grow, and at the work area so it can't be pulled off the screen.
function applyMaxSize() {
  if (!win || win.isDestroyed()) return;
  const max = maxContentSize();
  win.setMaximumSize(Math.min(Math.round(baseWidth() * MAX_SCALE), max.w), max.h);
}

// The width of a user drag becomes the scale, the renderer zooms #root to it,
// and its re-fit brings the height along. Everything else a drag can do — our
// own echoed resize, a height-only drag, a width the clamp swallowed — is
// decided by resizeAction (renderer/sizing.js).
function onWindowResize() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const action = resizeAction({ w, h }, lastFit, cfg.scale);
  if (action.type === 'ignore') return;
  if (action.type === 'scale') { applySettings({ scale: action.scale }); return; }
  win.setContentSize(lastFit.w, lastFit.h); // matches lastFit, so the echo is ignored
}

// Content that grew — opening the settings panel, or turning on history — can
// push a window that was fully on screen past the bottom or right edge, taking
// the panel's Reset size / Done with it. fitScale only caps the *size*, so the
// position has to be brought back in too. Persisted like any other move, since
// this is where the widget now lives.
function keepWindowOnScreen() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const { x, y } = keepOnScreen(bounds, screen.getDisplayMatching(bounds).workArea);
  if (x === bounds.x && y === bounds.y) return;
  win.setPosition(x, y);
  cfg.position = { x, y };
  persist();
}

function createWindow() {
  lastFit = null;
  win = new BrowserWindow({
    width: Math.round(baseWidth() * (clampScale(cfg.scale) ?? 1)), height: 220,
    x: cfg.position.x ?? undefined, y: cfg.position.y ?? undefined,
    frame: false, resizable: true, show: !HIDDEN,
    minWidth: MIN_WINDOW.width, minHeight: MIN_WINDOW.height,
    alwaysOnTop: cfg.alwaysOnTop, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
    ...windowOptions(cfg),
  });
  applyMaxSize();
  win.on('resize', onWindowResize);
  win.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
  win.setOpacity(Math.min(1, Math.max(0.2, typeof cfg.opacity === 'number' ? cfg.opacity : 1)));
  if (SCREENSHOT_DIR) {
    // capturePage() on a transparent window can come back solid black on
    // Windows; give screenshot mode a real backdrop so the PNG shows the card.
    win.webContents.on('did-finish-load', () => win.webContents.insertCSS('body { background: #1e1e1e !important; }'));
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); } // close hides; quit via menu/tray
  });
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    cfg.position = { x, y };
    persist();
    // The window may have crossed onto a display with a different work area,
    // which changes both the drag ceiling and the height the renderer may fit.
    applyMaxSize();
    win.webContents.send('snapshot', snapshotPayload());
  });
}

// `transparent` can only be set at BrowserWindow construction, so toggling
// solidBackground has to tear down and rebuild the window. win.destroy()
// skips the 'close' handler's hide-instead-of-close guard.
function recreateWindow() {
  if (win && !win.isDestroyed()) win.destroy();
  createWindow();
  win.webContents.once('did-finish-load', () => win.webContents.send('snapshot', snapshotPayload()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForThemeRender(themeId) {
  // The renderer only fires the resize IPC when a theme's footprint actually
  // changes size, so a same-size theme (e.g. the very first one, which is
  // already what's on screen) never signals "done" that way. Poll the DOM
  // for the renderer's own record of which theme it last rendered instead.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rendered = await win.webContents.executeJavaScript('document.body.dataset.theme').catch(() => null);
    if (rendered === themeId) break;
    await sleep(25);
  }
  // The card's height is measured, not tabulated, so the window is still
  // catching up to the theme it just rendered. Wait for the size the renderer
  // asked for (its data-fit record) to actually be the window's content size.
  while (Date.now() < deadline) {
    const [w, h] = win.getContentSize();
    const fit = await win.webContents.executeJavaScript('document.body.dataset.fit').catch(() => null);
    if (fit === `${w}x${h}`) break;
    await sleep(25);
  }
  // Let two compositor frames land so the paint from that DOM change is settled.
  await win.webContents
    .executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    .catch(() => {});
}

async function captureTheme(themeId, dir) {
  let img;
  for (let attempt = 0; attempt < 5; attempt++) {
    img = await win.webContents.capturePage();
    if (!img.isEmpty()) break; // window surface not composited yet under load; retry
    await sleep(200);
  }
  fs.writeFileSync(path.join(dir, `${themeId}.png`), img.toPNG());
}

async function runScreenshots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const { id: themeId } of THEMES) {
    cfg.theme = themeId;
    win.webContents.send('snapshot', snapshotPayload());
    await waitForThemeRender(themeId);
    await captureTheme(themeId, dir);
  }
}

app.whenReady().then(async () => {
  // Screenshot mode never touches the real config — start from defaults so a
  // capture run can't inherit warnAt/alertAt/opacity/alwaysOnTop/position
  // from whatever the user has saved (and, per the no-persist guard, never
  // writes any of this back either).
  cfg = SCREENSHOT_DIR ? screenshotConfig() : loadConfig(app.getPath('userData'));
  if (!SCREENSHOT_DIR) applyAutoStart(); // never touch the real login item from a capture run
  refreshProviders(); // must precede fakeHistory/snapshotPayload — both iterate `providers`
  hist = FAKE ? fakeHistory(providers) : loadHistory(app.getPath('userData'));
  createWindow();
  tray = new Tray(trayImage('ok'));
  tray.setToolTip('Gauge');
  tray.on('click', () => win?.show());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  ipcMain.handle('get-init', () => snapshotPayload());
  ipcMain.on('open-menu', () => buildMenu().popup({ window: win }));
  ipcMain.on('resize', (_e, { w, h }) => {
    if (!win || win.isDestroyed()) return;
    lastFit = { w: Math.round(w), h: Math.round(h) }; // marks the echoed 'resize' event as ours, not a drag
    win.setContentSize(lastFit.w, lastFit.h);
    keepWindowOnScreen(); // the new size may not fit where the old one did
  });
  ipcMain.on('set-config', (_e, partial) => applySettings(partial));
  // Settings-panel action buttons — the same three actions the context menu
  // already offers ('Refresh now', 'Read usage aloud', 'Open config file'),
  // reachable from the panel without popping the menu.
  ipcMain.on('refresh-now', () => pulse({ bypassCooldown: true }));
  ipcMain.on('read-usage-aloud', () => { win?.webContents.send('speak', summaryPhrase(lastSnap?.services, providers)); });
  ipcMain.on('open-config-file', () => shell.openPath(path.join(app.getPath('userData'), 'config.json')));
  await pulse(); // first snapshot must render before a screenshot run starts capturing
  if (SCREENSHOT_DIR) {
    try { await runScreenshots(SCREENSHOT_DIR); }
    finally { app.quit(); }
    return;
  }
  schedule();
});

app.on('before-quit', () => {
  quitting = true;
  persist.flush(); // a debounced write must not die with the timer
  persistHistory.flush();
});
app.on('window-all-closed', (e) => e.preventDefault()); // stays alive in tray
