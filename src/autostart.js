function loginItemSettings(cfg, ctx) {
  const openAtLogin = !!cfg.autoStart;
  if (ctx.isPackaged) {
    return { openAtLogin, args: ['--hidden'] };
  }
  // electron.d.ts (Settings#args): "Take care to wrap paths in quotes" — Electron
  // joins path + args into a single Windows registry command line, so an unquoted
  // appPath containing a space gets split into two argv tokens on next login.
  return { openAtLogin, path: ctx.execPath, args: [`"${ctx.appPath}"`, '--hidden'] };
}

module.exports = { loginItemSettings };
