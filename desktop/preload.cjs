// Exposed only in the desktop app; the browser version has no window.butcherDesktop.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('butcherDesktop', {
  version: ipcRenderer.sendSync('version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  // files opened with the app (command line / macOS open-file): the ones waiting now, then each new batch
  onFiles: cb => {
    ipcRenderer.on('files', (_, fs) => cb(fs));
    ipcRenderer.invoke('take-files').then(fs => { if (fs.length) cb(fs); });
  },
});
