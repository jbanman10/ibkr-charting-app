// Electron main process — wraps the ibkr-chart web app as a standalone desktop
// app with multi-window support.
//
// One backend process (one IBKR connection) serves every window. In production
// the backend also serves the built frontend statically, so windows just load
// http://127.0.0.1:<port> and all the app's relative /api + ws://<host>/ws URLs
// keep working unchanged. In dev we assume `npm run dev` is already running
// (backend :3001 + Vite :5173) and only open windows.

const { app, BrowserWindow, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const isDev = !app.isPackaged;
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 3001);
const DEV_URL = 'http://localhost:5173';
const PROD_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let backendProc = null;
let nextWinId = 1;

// ─── User config (packaged app) ──────────────────────────────────────────────
// Read/create <userData>/config.json so the user can point at live vs paper
// without rebuilding. Shipped defaults = paper trading on localhost.
function loadUserConfig() {
  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  const defaults = {
    BACKEND_PORT: String(BACKEND_PORT),
    IBKR_HOST: '127.0.0.1',
    IBKR_PORT: '7497',
    IBKR_CLIENT_ID: '1',
  };
  try {
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    return { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
  } catch {
    return defaults;
  }
}

// ─── Backend lifecycle ────────────────────────────────────────────────────────
function startBackend() {
  if (isDev) return; // dev: backend is started by `npm run dev`

  const userCfg = loadUserConfig();
  // extraResources land under process.resourcesPath in the packaged app.
  const backendEntry = path.join(process.resourcesPath, 'backend', 'backend.cjs');
  const frontendDist = path.join(process.resourcesPath, 'frontend-dist');

  backendProc = spawn(process.execPath, [backendEntry], {
    env: {
      ...process.env,
      ...userCfg,
      ELECTRON_RUN_AS_NODE: '1', // run the bundled backend on Electron's Node
      NODE_ENV: 'production',
      SERVE_STATIC: '1',
      FRONTEND_DIST: frontendDist,
    },
    stdio: 'inherit',
  });

  backendProc.on('exit', (code) => {
    console.error(`[desktop] backend exited with code ${code}`);
    backendProc = null;
  });
}

function stopBackend() {
  if (backendProc && !backendProc.killed) {
    backendProc.kill();
    backendProc = null;
  }
}

// Poll a URL until it responds (any status < 500) or we time out.
function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if ((res.statusCode ?? 500) < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${url}`));
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

// ─── Windows ──────────────────────────────────────────────────────────────────
function createWindow() {
  const winId = nextWinId++;
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#131722',
    title: 'IBKR Chart',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const base = isDev ? DEV_URL : PROD_URL;
  win.loadURL(`${base}/?win=${winId}`);

  // Open external links (e.g. docs) in the OS browser, never a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  buildMenu();
  startBackend();

  const readyUrl = isDev ? DEV_URL : `${PROD_URL}/api/status`;
  try {
    await waitForHttp(readyUrl);
  } catch (err) {
    console.error(`[desktop] ${err.message} — opening window anyway (app will reconnect)`);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', stopBackend);
