// Desktop (Windows / macOS) shell: serves the built browser app from ./app over app://butcher/.
const { app, BrowserWindow, Menu, ipcMain, nativeTheme, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = 'pikoponpoko/butcher';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const ROOT = path.join(__dirname, 'app');
const MAC = process.platform === 'darwin';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 360, minHeight: 480,
    title: 'Butcher',
    icon: path.join(__dirname, 'app', 'icons', 'icon-512.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111316' : '#E6E9ED',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://butcher/')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('did-start-loading', () => { ready = false; });
  win.loadURL('app://butcher/index.html');
}

// "1.2.10" > "1.2.9"
function newer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

// 'latest' = already up to date; otherwise the release page is opened in the browser.
ipcMain.handle('check-update', async () => {
  try {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (r.ok) {
      const j = await r.json(), v = String(j.tag_name || '').replace(/^v/, '');
      if (v && !newer(v, app.getVersion())) return 'latest';
      await shell.openExternal(j.html_url || RELEASES);
      return 'opened';
    }
  } catch {}
  await shell.openExternal(RELEASES);
  return 'opened';
});
ipcMain.on('version', e => { e.returnValue = app.getVersion(); });

// Files the OS hands over: "Open with" / ScanSnap Home "send to application" (command line), macOS open-file.
// They are kept until the page asks for them, then sent as they arrive.
const OPEN_RE = /\.(psd|psb|clip|png|jpe?g|webp|gif|bmp|pdf|mp4|webm|mov|m4v)$/i;
let pending = [], ready = false;
const fromArgs = argv => argv.slice(1).filter(a => OPEN_RE.test(a) && fs.existsSync(a));
function openFiles(paths) {
  if (!paths.length) return;
  pending.push(...paths);
  if (ready && win) { win.webContents.send('files', take()); if (win.isMinimized()) win.restore(); win.focus(); }
}
function take() {
  const out = [];
  for (const p of pending.splice(0)) { try { out.push({ name: path.basename(p), data: fs.readFileSync(p) }); } catch {} }
  return out;
}
pending = fromArgs(process.argv);
ipcMain.handle('take-files', () => { ready = true; return take(); });
app.on('open-file', (e, p) => { e.preventDefault(); openFiles([p]); });

app.on('second-instance', (e, argv) => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } openFiles(fromArgs(argv)); });
app.whenReady().then(() => {
  // macOS needs a menu bar for Cmd+C / Cmd+V / Cmd+Q etc.
  Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  protocol.handle('app', req => {
    const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname)));
    if (!p.startsWith(ROOT)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  });
  createWindow();
});
app.on('window-all-closed', () => { if (!MAC) app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
