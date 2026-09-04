// The BrowserWindow options that depend on cfg.solidBackground. Split out as a
// pure function (no `electron` import) so it's testable under plain `node --test`.
//
// Hybrid-GPU machines can fail to composite a per-pixel-alpha window on the
// monitor driven by the non-primary GPU adapter (a DWM cross-adapter
// limitation) — the whole card renders as a hard black rectangle instead of
// staying transparent. solidBackground is the escape hatch: drop transparency
// entirely and paint a real backdrop, which DWM can always composite.
function windowOptions(cfg) {
  return cfg.solidBackground
    ? { transparent: false, backgroundColor: '#14161c' }
    : { transparent: true };
}

module.exports = { windowOptions };
