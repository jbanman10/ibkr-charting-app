// Electron main process — wraps the ibkr-chart web app as a standalone desktop
// app with multi-window support.
//
// One backend process (one IBKR connection) serves every window. In production
// the backend also serves the built frontend statically, so windows just load
// http://127.0.0.1:<port> and all the app's relative /api + ws://<host>/ws URLs
// keep working unchanged. In dev we assume `npm run dev` is already running
// (backend :3001 + Vite :5173) and only open windows.

const { app, BrowserWindow, Menu, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:5173';

let backendProc = null;
let nextWinId = 1;
let userCfg = null; // loaded once in app.whenReady

// ─── User config (packaged app) ──────────────────────────────────────────────
// Read/create <userData>/config.json so the user can point at live vs paper
// without rebuilding. Shipped defaults = paper trading on localhost.
//
// Port 3002 / client id 2 — deliberately NOT the dev stack's 3001 / client 1,
// so the exe and `npm run dev` can run at the same time without stealing each
// other's port or TWS connection (the collision shows up as "No data received"
// and windows served by the wrong backend).
function loadUserConfig() {
  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  const defaults = {
    BACKEND_PORT: process.env.BACKEND_PORT ?? '3002',
    IBKR_HOST: '127.0.0.1',
    IBKR_PORT: '7497',
    IBKR_CLIENT_ID: '2',
  };
  try {
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    const cfg = { ...defaults, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
    // Migrate configs still on the OLD shipped defaults (3001 / client 1):
    // they collide with the dev stack. Any other values are a deliberate
    // user choice and are left alone.
    if (cfg.BACKEND_PORT === '3001' && cfg.IBKR_CLIENT_ID === '1') {
      cfg.BACKEND_PORT = defaults.BACKEND_PORT;
      cfg.IBKR_CLIENT_ID = defaults.IBKR_CLIENT_ID;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
    return cfg;
  } catch {
    return defaults;
  }
}

const prodUrl = () => `http://127.0.0.1:${userCfg?.BACKEND_PORT ?? '3002'}`;

// ─── Backend lifecycle ────────────────────────────────────────────────────────
function startBackend() {
  if (isDev) return; // dev: backend is started by `npm run dev`

  // extraResources land under process.resourcesPath in the packaged app.
  const backendEntry = path.join(process.resourcesPath, 'backend', 'backend.cjs');
  const frontendDist = path.join(process.resourcesPath, 'frontend-dist');

  // Backend output goes to <userData>/backend.log — in a packaged app there is
  // no console, and without this a crash (port in use, TWS rejects the client
  // id, …) is invisible. Truncated each launch.
  const logPath = path.join(app.getPath('userData'), 'backend.log');
  let logFd = null;
  try { logFd = fs.openSync(logPath, 'w'); } catch { /* logging is best-effort */ }

  backendProc = spawn(process.execPath, [backendEntry], {
    env: {
      ...process.env,
      ...userCfg,
      ELECTRON_RUN_AS_NODE: '1', // run the bundled backend on Electron's Node
      NODE_ENV: 'production',
      SERVE_STATIC: '1',
      FRONTEND_DIST: frontendDist,
      // File-backed stores (drawings.json, …) live in userData so they survive
      // reinstalls, cache clears, and origin/port changes.
      DATA_DIR: app.getPath('userData'),
    },
    stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
  });

  backendProc.on('exit', (code) => {
    console.error(`[desktop] backend exited with code ${code}`);
    if (logFd != null) { try { fs.writeSync(logFd, `\n[desktop] backend exited with code ${code}\n`); } catch { /* ignore */ } }
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
      // Occluded/background windows otherwise get their timers throttled (and
      // rAF suspended) by Chromium — which starves the charts' periodic history
      // re-sync, so a covered window drifts from official bars and never
      // reconciles. Live market charts must keep ticking while hidden.
      backgroundThrottling: false,
    },
  });

  const base = isDev ? DEV_URL : prodUrl();
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
  userCfg = loadUserConfig();
  buildMenu();
  startBackend();

  // The frontend is served over HTTP from the local backend, so Chromium's HTTP
  // cache applies — a cached index.html from a previous install can pin an old
  // JS bundle and silently run stale code. Assets are local, so clearing on
  // every launch is free and guarantees each launch runs the shipped build.
  try { await session.defaultSession.clearCache(); } catch { /* non-fatal */ }

  const readyUrl = isDev ? DEV_URL : `${prodUrl()}/api/status`;
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
