const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulse', {
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, snap) => cb(snap)),
  getInit: () => ipcRenderer.invoke('get-init'),
  openMenu: () => ipcRenderer.send('open-menu'),
  resize: (w, h) => ipcRenderer.send('resize', { w, h }),
  onSpeak: (cb) => ipcRenderer.on('speak', (_e, text) => cb(text)),
  setConfig: (partial) => ipcRenderer.send('set-config', partial),
  refreshNow: () => ipcRenderer.send('refresh-now'),
  readUsageAloud: () => ipcRenderer.send('read-usage-aloud'),
  openConfigFile: () => ipcRenderer.send('open-config-file'),
});
