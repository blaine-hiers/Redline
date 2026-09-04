// Window sizing maths, shared by the renderer (which measures the card) and
// the main process (which turns a user drag into a scale). Loaded as a plain
// <script> in the renderer and as a CommonJS module in main and the tests,
// the same way themelist.js and spark.js are.
//
// The widget is sized by its *content*: the renderer measures whatever it just
// rendered and asks main for exactly that content size, so a card that grew a
// row (both services, sparklines, a stale note) is never clipped. The user
// resizes by *width*: main turns the dragged width into a scale relative to
// the size on screen, the renderer applies it as `zoom` on #root, and the
// height re-fits to the scaled content. Two things then keep the result on the
// display it lives on — fitScale shrinks content taller than the work area,
// and keepOnScreen shifts a window that has grown past its edges.

const MIN_SCALE = 0.6;
const MAX_SCALE = 3.0;

// Clamps a scale into range, rounded to 2dp so slider steps and drag widths
// can't produce a long float that churns the config file. Non-numbers → null,
// so callers can tell "not a scale" from "clamped to the edge of the range".
function clampScale(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(v * 100) / 100));
}

// The content size that fits the card, from its bounding rect. `top`/`left`
// are the card's own margin (the cards and the panel all use a symmetric
// `margin: 10px`), and under `zoom` the rect is already reported scaled — so
// the margin allowance scales with the card instead of being a fixed +20.
function fitSize({ top, left, width, height }) {
  return { w: Math.ceil(width + left * 2), h: Math.ceil(height + top * 2) };
}

// The zoom actually applied: the user's scale, reduced when the content at
// that scale would be taller than the display's work area. A window taller
// than the screen puts the bottom of the settings panel (Reset size, Done)
// out of reach, and the panel is a no-drag region so it can't be dragged up.
//
// The card's CSS width is fixed, so its layout height doesn't depend on the
// zoom and the rendered height is exactly `layoutHeight * zoom` — which makes
// one correction exact rather than iterative. cfg.scale is left alone, so
// closing the panel brings the card back at the size the user chose.
function fitScale(scale, measuredHeight, maxHeight) {
  if (!(maxHeight > 0) || !(measuredHeight > maxHeight)) return scale;
  return scale * (maxHeight / measuredHeight);
}

// What a window 'resize' event means, given `fit` — the content size the
// renderer last asked for. Every content-fit resize this app performs echoes
// back as a 'resize' event, so the first job is telling those apart from a
// user drag; the second is that only the *width* is the user's to choose.
//
//   'ignore'  — our own content-fit echo, or nothing has been fitted yet.
//   'scale'   — the width changed: re-derive the scale from it.
//   'restore' — anything else. A height-only drag (the height belongs to the
//               content, not the drag) or a width drag the scale clamp
//               swallowed; either way the last fit still stands and the window
//               has to be put back on it, or the card stays clipped.
//
// The new scale is derived *relative to the last fit*, not from the theme's
// base width, because the width on screen doesn't always encode cfg.scale:
// fitScale may have shrunk the zoom to fit the display, and the settings panel
// takes its width from the window rather than from the card. Dragging an edge
// therefore means "this much bigger than what I'm looking at", which is what
// the user is actually doing — and a nudge too small to move the 2dp scale
// leaves it exactly where it was.
function resizeAction(size, fit, currentScale) {
  if (!fit) return { type: 'ignore' };
  if (size.w === fit.w && size.h === fit.h) return { type: 'ignore' };
  if (size.w !== fit.w && fit.w > 0) {
    const scale = clampScale(currentScale * (size.w / fit.w));
    if (scale != null && scale !== currentScale) return { type: 'scale', scale };
  }
  return { type: 'restore' };
}

// Nudges a window back inside the display's work area: shifted up and left by
// however much it overhangs, but never past the work area's own origin, so
// something bigger than the screen sits at the top-left corner rather than
// being pushed off the opposite edge. Growing the content — opening the
// settings panel — is what makes an on-screen window overhang, and the panel
// is a no-drag region, so it can't be dragged back into view by hand.
function keepOnScreen({ x, y, width, height }, workArea) {
  const axis = (pos, size, origin, extent) => Math.max(origin, Math.min(pos, origin + extent - size));
  return {
    x: axis(x, width, workArea.x, workArea.width),
    y: axis(y, height, workArea.y, workArea.height),
  };
}

if (typeof module !== 'undefined') {
  module.exports = { MIN_SCALE, MAX_SCALE, clampScale, fitSize, fitScale, resizeAction, keepOnScreen };
}
