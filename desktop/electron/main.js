const { app, BrowserWindow, ipcMain, session, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
// Outbound client for the client's payment middleware (PULL mode).
// Inert unless PAYMENT_API_URL is set — see electron/paymentMiddleware.js.
const paymentMiddleware = require('./paymentMiddleware');
const r2 = require('./r2Upload');
r2.loadEnvFile(path.join(__dirname, '..', '.env'));

// Try to load Canon EDSDK wrapper (optional - will fallback if not available)
let CanonCameraBrowser, Camera, CameraProperty, Option, ImageQuality;
let edsdkAvailable = false;

try {
  const canonModule = require('@brick-a-brack/napi-canon-cameras');
  CanonCameraBrowser = canonModule.CameraBrowser;
  Camera = canonModule.Camera;
  CameraProperty = canonModule.CameraProperty;
  Option = canonModule.Option;
  ImageQuality = canonModule.ImageQuality;
  edsdkAvailable = true;
  console.log('[Main] ✓ Canon EDSDK module loaded successfully');
} catch (err) {
  console.warn('[Main] ⚠ Canon EDSDK module not available:', err.message);
  console.warn('[Main] ⚠ Install @brick-a-brack/napi-canon-cameras to use direct Canon camera control');
  console.warn('[Main] ⚠ Falling back to webcam mode');
}

let canonCameraBrowser = null;
let connectedCanonCamera = null;
let liveViewInterval = null;

// Use app.isPackaged as the primary indicator (most reliable for Electron)
// If app.isPackaged is true, we're in production regardless of NODE_ENV
const isDev = !app.isPackaged;

/**
 * Window/taskbar icon (the Nostalgia wordmark). Previously this pointed
 * at ../public/icon.png, which does not exist — so Electron silently
 * fell back to its own default icon. `public/` is copied into `dist/` at
 * build time, so the packaged path differs from the dev path; try both
 * and fall back to undefined (Electron default) rather than crashing.
 */
function appIconPath() {
  const candidates = [
    path.join(__dirname, '../dist/app-icon.png'),   // packaged
    path.join(__dirname, '../public/app-icon.png'), // dev
    path.join(__dirname, '../build/icon.png'),      // repo master
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) { /* keep looking */ }
  }
  console.warn('[Main] app icon not found; using Electron default');
  return undefined;
}

let mainWindow;
let logFile;

// Setup file logging
function setupLogging() {
  const logDir = path.join(app.getPath('documents'), 'NostalgiaPhotobooth');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  logFile = path.join(logDir, `app-log-${new Date().toISOString().replace(/:/g, '-').split('.')[0]}.txt`);
  
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  
  function writeLog(level, ...args) {
    const message = `[${new Date().toISOString()}] [${level}] ${args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`;
    
    try {
      fs.appendFileSync(logFile, message);
    } catch (err) {
      // Fallback to original if file write fails
    }
    
    if (level === 'ERROR') {
      originalError.apply(console, args);
    } else if (level === 'WARN') {
      originalWarn.apply(console, args);
    } else {
      originalLog.apply(console, args);
    }
  }
  
  console.log = (...args) => writeLog('LOG', ...args);
  console.error = (...args) => writeLog('ERROR', ...args);
  console.warn = (...args) => writeLog('WARN', ...args);
  
  console.log(`[Main] Logging initialized. Log file: ${logFile}`);
}

// Initialize logging early
setupLogging();

function createWindow() {
  const preloadPath = path.join(__dirname, "preload.js");
  console.log("[Main] Preload script path:", preloadPath);
  console.log("[Main] Preload script exists:", fs.existsSync(preloadPath));

  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true, // Always start fullscreen for kiosk
    frame: false, // Frameless for kiosk mode
    kiosk: !isDev, // Kiosk mode in production
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
      webSecurity: true,
      // Allow connections to Cloudflare R2 / PocketBase
      allowRunningInsecureContent: false,
    },
    icon: appIconPath(),
    backgroundColor: "#f5f0e1",
  });

  // Open DevTools in dev mode only
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    console.log('[Main] DevTools opened in detached mode');
  }

  // Grant camera and microphone permissions (required for getUserMedia)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`[Main] Permission requested: ${permission}`);
    if (permission === 'camera' || permission === 'microphone' || permission === 'media') {
      console.log(`[Main] Granting ${permission} permission`);
      callback(true); // Grant permission
    } else {
      callback(false); // Deny other permissions
    }
  });

  // Also check existing permissions
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    console.log(`[Main] Permission check: ${permission} for ${requestingOrigin}`);
    if (permission === 'camera' || permission === 'microphone' || permission === 'media') {
      console.log(`[Main] Allowing ${permission} permission check`);
      return true;
    }
    return false;
  });

  console.log('[Main] Camera/microphone permissions configured');

  // Set Content Security Policy to allow Cloudflare R2 + PocketBase
  // Modify CSP headers before page loads
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      const cspHeader =
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
        "connect-src 'self' https://*.r2.dev https://*.r2.cloudflarestorage.com http://127.0.0.1:8090 http://localhost:8090 ws://127.0.0.1:8090 ws://localhost:8090; " +
        "img-src 'self' data: blob: https: https://*.r2.dev https://*.r2.cloudflarestorage.com; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' data: https://fonts.gstatic.com;";

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [cspHeader],
        },
      });
    },
  );

  // Also modify CSP meta tags in the HTML content
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents
      .executeJavaScript(
        `
      // Remove existing CSP meta tag if present
      const existingCSP = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      if (existingCSP) {
        existingCSP.remove();
      }
      // Add new CSP meta tag (Cloudflare R2 + PocketBase)
      const meta = document.createElement('meta');
      meta.httpEquiv = 'Content-Security-Policy';
      meta.content = "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' https://*.r2.dev https://*.r2.cloudflarestorage.com http://127.0.0.1:8090 http://localhost:8090 ws://127.0.0.1:8090 ws://localhost:8090; img-src 'self' data: blob: https: https://*.r2.dev https://*.r2.cloudflarestorage.com; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';";
      document.getElementsByTagName('head')[0].appendChild(meta);
      void 0;
    `,
      )
      .catch((err) => console.error("[Main] Error setting CSP:", err));
  });

  // Log when preload script loads
  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[Main] Page finished loading");
    // Pin the zoom to 1:1. Windows display scaling (the client's 24"
    // kiosk runs at 125%) otherwise shrinks the CSS viewport to
    // ~1536x864, so every layout designed against 1920x1080 renders
    // 25% larger than intended and tall screens overflow. Designs are
    // measured at 1920x1080, so the app must render there too.
    try {
      mainWindow.webContents.setZoomFactor(1);
      mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
      const [vw, vh] = mainWindow.getContentSize();
      console.log(`[Main] Zoom pinned to 1.0 — content size ${vw}x${vh}`);
    } catch (e) {
      console.warn("[Main] Could not pin zoom factor:", e.message);
    }
    // Check if electronAPI is available
    mainWindow.webContents
      .executeJavaScript('typeof window.electronAPI !== "undefined"')
      .then((hasAPI) => {
        console.log("[Main] electronAPI available in renderer:", hasAPI);
      })
      .catch((err) => {
        console.error("[Main] Error checking electronAPI:", err);
      });
  });

  // Add comprehensive error handlers
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    const errorMsg = `Failed to load: ${validatedURL}\nError code: ${errorCode}\nDescription: ${errorDescription}`;
    console.error('[Main]', errorMsg);
    dialog.showErrorBox('Load Error', errorMsg + `\n\nCheck log file: ${logFile}`);
  });
  
  // Log console messages from renderer
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer] [${level}] ${message} (${sourceId}:${line})`);
  });
  
  // Log when page starts loading
  mainWindow.webContents.on('did-start-loading', () => {
    console.log('[Main] Page started loading');
  });

  // DevTools are now opened immediately after window creation (see above)

  // Prevent right-click context menu in production
  if (!isDev) {
    mainWindow.webContents.on("context-menu", (e) => {
      e.preventDefault();
    });
  }

  // Log the mode detection
  console.log('[Main] isDev:', isDev);
  console.log('[Main] app.isPackaged:', app.isPackaged);
  console.log('[Main] NODE_ENV:', process.env.NODE_ENV);
  
  // Load the app
  if (isDev) {
    console.log('[Main] Running in DEV mode - loading from localhost');
    mainWindow.loadURL('http://localhost:5173');
    // Uncomment to open devtools in dev mode
    // mainWindow.webContents.openDevTools();
  } else {
    console.log('[Main] Running in PRODUCTION mode - loading from file');
    // In production - use loadURL with file:// protocol (works better with asar archives)
    const appPath = app.getAppPath();
    console.log('[Main] App path:', appPath);
    console.log('[Main] __dirname:', __dirname);
    console.log('[Main] process.resourcesPath:', process.resourcesPath);

    // Try multiple possible paths
    const possiblePaths = [
      path.join(appPath, 'dist', 'index.html'),
      path.join(__dirname, 'dist', 'index.html'),
      path.join(__dirname, '../dist', 'index.html'),
      path.join(process.resourcesPath, 'app', 'dist', 'index.html'),
      path.join(process.resourcesPath, 'app.asar', 'dist', 'index.html')
    ];

    console.log('[Main] Checking possible paths:');
    let foundPath = null;
    for (const testPath of possiblePaths) {
      const exists = fs.existsSync(testPath);
      console.log(`[Main]   ${testPath} - ${exists ? 'EXISTS ✓' : 'NOT FOUND ✗'}`);
      if (exists && !foundPath) {
        foundPath = testPath;
      }
    }

    if (foundPath) {
      // Use loadURL with file:// protocol (works better with asar)
      const fileUrl = `file://${foundPath.replace(/\\/g, '/')}`;
      console.log(`[Main] Loading from: ${foundPath}`);
      console.log(`[Main] File URL: ${fileUrl}`);

      mainWindow.loadURL(fileUrl).catch(err => {
        console.error('[Main] Error loading with loadURL:', err);
        // Fallback: try loadFile
        console.log('[Main] Trying loadFile as fallback...');
        mainWindow.loadFile(foundPath).catch(fallbackErr => {
          const errorMsg = `Failed to load index.html\n\nPath: ${foundPath}\nError: ${err.message}`;
          console.error('[Main]', errorMsg);
          dialog.showErrorBox('Load Error', errorMsg + `\n\nCheck log file: ${logFile}`);
        });
      });
    } else {
      const errorMsg = 'Could not find index.html in any expected location!';
      const details = `Searched paths:\n${possiblePaths.join('\n')}\n\nApp path: ${appPath}\n__dirname: ${__dirname}\nresourcesPath: ${process.resourcesPath}`;
      console.error(`[Main] ${errorMsg}`);
      console.error('[Main]', details);
      dialog.showErrorBox('File Not Found', `${errorMsg}\n\n${details}\n\nCheck log file: ${logFile}`);
    }
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  void r2.pingR2().then((status) => {
    if (status.connected) {
      console.log(
        `[R2] Connected. Cloudflare API healthy (bucket ${status.bucket}) — public ${status.publicUrl}`,
      );
    } else if (!status.configured) {
      console.warn(
        `[R2] Not configured — missing ${(status.missing || []).join(", ")}. Guest QR uploads will be skipped.`,
      );
    } else {
      console.error(`[R2] Not connected to Cloudflare. ${status.error || ""}`);
    }
  });

  // Route getDisplayMedia() straight at the middleware's window so the
  // admin panel can show it live with no picker dialog (this is a kiosk
  // — there is nobody to click through a permission prompt).
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        desktopCapturer
          .getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const re = middlewareWindowPattern();
            const match = sources.find((s) => re.test(s.name));
            if (!match) {
              console.warn('[Middleware] no matching window to stream');
              // Deny rather than silently streaming the wrong window.
              return callback({});
            }
            console.log(`[Middleware] streaming window "${match.name}"`);
            callback({ video: match });
          })
          .catch((e) => {
            console.error('[Middleware] getSources failed:', e.message);
            callback({});
          });
      },
      { useSystemPicker: false },
    );
  } catch (e) {
    console.warn('[Main] display-media handler unavailable:', e.message);
  }

  createWindow();
  startLumaMiddlewareListener();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ───────────────────────────────────────────────────────────────────
// PAYMENT / BILL-ACCEPTOR BRIDGE — LUMABOOTH MIDDLEWARE INTEGRATION
// ───────────────────────────────────────────────────────────────────
// The client runs "LumaBooth Middleware" (C:\Program Files\LumaBooth
// Middleware\luma_booth_api.exe — a Flutter app that owns the physical
// bill acceptor over serial AND PayMongo QR payments). When a customer
// has paid IN FULL, the middleware reports it the only way it knows:
// by calling the LumaBooth/dslrBooth HTTP API —
//
//     GET http://localhost:1500/api/start?mode=print
//
// We IMPERSONATE that API (see startLumaMiddlewareListener below): a
// tiny HTTP server on the same port accepts the call and forwards a
// "session paid in full" credit to the renderer over `payment:credit`
// (consumed by src/services/billAcceptor.ts → IpcBillAcceptorAdapter →
// payment store). The middleware needs zero changes — it believes it
// is talking to LumaBooth.
//
// `emitPaymentCredit()` payloads:
//   { paidInFull: true, source, mode } — middleware says sale complete
//   { amount: <wholeCurrencyUnits> }   — per-bill credit (future use)
//   { error: '<message>' }             — acceptor fault
// ── Live status for the admin panel ────────────────────────────────
// The client wants to SEE that the middleware is connected from inside
// this app. Another Windows program's window cannot be embedded in an
// Electron page, so instead we surface everything that actually proves
// the link is alive: whether we are listening, on which port, and every
// signal the middleware has sent.
const paymentBridge = {
  listening: false,
  port: null,
  error: null,
  lastSignalAt: null,
  lastSignalKind: null, // 'paid' | 'partial' | 'failed' | 'other'
  lastSignalDetail: null,
  signalCount: 0,
  recent: [], // newest first, capped
};

function pushBridgeStatus() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('payment:bridge-status', { ...paymentBridge });
    }
  } catch (_) { /* window going away */ }
}

function noteBridgeSignal(kind, detail) {
  paymentBridge.lastSignalAt = Date.now();
  paymentBridge.lastSignalKind = kind;
  paymentBridge.lastSignalDetail = detail || null;
  paymentBridge.signalCount += 1;
  paymentBridge.recent.unshift({ at: paymentBridge.lastSignalAt, kind, detail: detail || null });
  if (paymentBridge.recent.length > 20) paymentBridge.recent.length = 20;
  pushBridgeStatus();
}

ipcMain.handle('payment:get-bridge-status', async () => ({ ...paymentBridge }));

// ── Live view of the middleware's own window ───────────────────────
// The client wants the middleware "as is" inside the app. A separate
// Windows program's window cannot be re-hosted inside an HTML page, so
// we stream it instead: the admin panel shows the middleware's real
// window, live, using screen capture. It is a VIEW — clicks are not
// forwarded — with a button to bring the real window forward to use it.
//
// Matches on window title; the middleware's window is named after the
// app. MIDDLEWARE_WINDOW_MATCH overrides if their build differs.
function middlewareWindowPattern() {
  const raw = process.env.MIDDLEWARE_WINDOW_MATCH || 'luma|middleware|booth_api';
  try {
    return new RegExp(raw, 'i');
  } catch (_) {
    return /luma|middleware|booth_api/i;
  }
}

ipcMain.handle('middleware:list-windows', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const re = middlewareWindowPattern();
    return {
      success: true,
      matches: sources.filter((s) => re.test(s.name)).map((s) => ({ id: s.id, name: s.name })),
      all: sources.map((s) => ({ id: s.id, name: s.name })),
    };
  } catch (e) {
    return { success: false, error: e.message, matches: [], all: [] };
  }
});

// Brings the middleware's window to the front so staff can actually
// operate it (the embedded stream is view-only).
ipcMain.handle('middleware:focus-window', async () => {
  try {
    const { execFile } = require('child_process');
    const re = middlewareWindowPattern().source;
    const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -match '${re}' } | Select-Object -First 1
if ($p) { [W]::ShowWindow($p.MainWindowHandle, 9); [W]::SetForegroundWindow($p.MainWindowHandle); Write-Output 'OK' }
else { Write-Output 'NOTFOUND' }`;
    return await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 8000 },
        (err, stdout) => {
          if (err) return resolve({ success: false, error: err.message });
          resolve(
            String(stdout).includes('OK')
              ? { success: true }
              : { success: false, error: 'Middleware window not found — is it running?' },
          );
        },
      );
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Opens the client's middleware app from the admin panel. It is a
// separate Windows program (LumaBooth Middleware / luma_booth_api.exe),
// so it cannot be drawn inside this window — the best we can do is
// start it, stream it, and report whether it is talking to us.
ipcMain.handle('payment:launch-middleware', async () => {
  const candidates = [
    process.env.MIDDLEWARE_EXE_PATH,
    'C:\\Program Files\\LumaBooth Middleware\\luma_booth_api.exe',
    'C:\\Program Files (x86)\\LumaBooth Middleware\\luma_booth_api.exe',
  ].filter(Boolean);
  for (const exe of candidates) {
    try {
      if (fs.existsSync(exe)) {
        const err = await shell.openPath(exe);
        if (err) return { success: false, error: err };
        console.log('[Main] Launched middleware:', exe);
        return { success: true, path: exe };
      }
    } catch (e) {
      console.warn('[Main] launch attempt failed:', e.message);
    }
  }
  return {
    success: false,
    error:
      'Could not find the middleware. Set MIDDLEWARE_EXE_PATH in .env to its full path, or start it manually.',
  };
});

function emitPaymentCredit(payload) {
  // payload: { amount?: number } | { error?: string }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('payment:credit', payload || {});
    }
  } catch (e) {
    console.error('[Main] emitPaymentCredit failed:', e);
  }
}
// Exposed on global so a future integration module can require()/call
// it without threading it through every function. Harmless if unused.
global.emitPaymentCredit = emitPaymentCredit;

// ── LumaBooth-API impersonation server ──
// Listens where the middleware expects LumaBooth to be. Port 1500 is
// the LumaBooth/dslrBooth convention (confirmed against the
// middleware's own binary: "http://localhost:1500" + "/api/start").
// Override with LUMA_API_PORT if the middleware is ever reconfigured.
//
//   GET /api/start?mode=print  → payment complete → credit the session
//   GET /api/start?mode=block  → logged only (middleware lock signal;
//                                not a payment)
//
// Bound to 127.0.0.1 — the middleware runs on the same machine and
// this endpoint must not be reachable from the venue's network.
let lumaApiServer = null;
function startLumaMiddlewareListener() {
  const port = Number(process.env.LUMA_API_PORT || 1500);
  lumaApiServer = http.createServer((req, res) => {
    let pathname = '/';
    let params = new URLSearchParams();
    try {
      const parsed = new URL(req.url, `http://127.0.0.1:${port}`);
      pathname = parsed.pathname;
      params = parsed.searchParams;
    } catch (_) { /* fall through to 404 */ }

    console.log(`[LumaAPI] ${req.method} ${req.url}`);

    if (pathname === '/api/start') {
      const mode = (params.get('mode') || 'print').toLowerCase();
      if (mode === 'print' || mode === '') {
        console.log('[LumaAPI] ✓ Middleware reports payment complete — crediting session');
        noteBridgeSignal('paid', 'Payment complete (LumaBooth middleware)');
        emitPaymentCredit({
          paidInFull: true,
          source: 'lumabooth-middleware',
          mode,
        });
      } else {
        noteBridgeSignal('other', `mode=${mode}`);
        // e.g. mode=block — the middleware's "lock the booth" signal.
        // Log it; wire to a store action later if the client uses it.
        console.log(`[LumaAPI] mode=${mode} acknowledged (no credit emitted)`);
      }
      // Mimic a happy LumaBooth/dslrBooth response — the middleware
      // only needs the 200.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ IsSuccessful: true, app: 'nostalgia-photobooth' }));
      return;
    }

    // ── PUSH endpoint for the client's own middleware ──────────────
    // A cleaner, documented contract than impersonating LumaBooth. The
    // middleware calls this when a sale completes; nothing else is
    // needed for a working integration.
    //
    //   POST /api/payment      {"status":"paid","transactionId":"abc"}
    //   POST /api/payment      {"amount":50}        (partial credit)
    //   POST /api/payment      {"status":"failed","message":"..."}
    //   GET  /api/payment?status=paid&transactionId=abc
    //
    // If PAYMENT_PUSH_SECRET is set, the caller must send the same value
    // in an X-Payment-Secret header (the endpoint is bound to 127.0.0.1,
    // so this is defence-in-depth rather than the primary control).
    if (pathname === '/api/payment') {
      const finish = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const handle = (payload) => {
        const secret = process.env.PAYMENT_PUSH_SECRET;
        if (secret && req.headers['x-payment-secret'] !== secret) {
          console.warn('[PayPush] rejected: bad or missing X-Payment-Secret');
          return finish(401, { success: false, error: 'unauthorized' });
        }
        const status = String(payload.status || '').toLowerCase();
        const amount = Number(payload.amount);
        if (status === 'paid' || status === 'success' || status === 'completed') {
          console.log(`[PayPush] ✓ payment complete (txn=${payload.transactionId || 'n/a'})`);
          noteBridgeSignal('paid', `Payment complete${payload.transactionId ? ` · txn ${payload.transactionId}` : ''}`);
          emitPaymentCredit({
            paidInFull: true,
            source: 'middleware-push',
            transactionId: payload.transactionId || null,
          });
        } else if (Number.isFinite(amount) && amount > 0) {
          console.log(`[PayPush] + partial credit ${amount}`);
          noteBridgeSignal('partial', `Partial credit ${amount}`);
          emitPaymentCredit({ amount });
        } else if (status) {
          console.warn(`[PayPush] payment ${status}: ${payload.message || ''}`);
          noteBridgeSignal('failed', payload.message || `Payment ${status}`);
          emitPaymentCredit({ error: payload.message || `Payment ${status}.` });
        } else {
          return finish(400, { success: false, error: 'send status or amount' });
        }
        return finish(200, { success: true });
      };

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1e6) req.destroy();
        });
        req.on('end', () => {
          let payload = {};
          try {
            payload = body ? JSON.parse(body) : {};
          } catch (_) {
            return finish(400, { success: false, error: 'invalid JSON' });
          }
          handle(payload);
        });
        return;
      }
      handle(Object.fromEntries(params.entries()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ IsSuccessful: false, error: 'unknown endpoint' }));
  });

  paymentBridge.port = port;

  lumaApiServer.on('error', (err) => {
    paymentBridge.listening = false;
    if (err.code === 'EADDRINUSE') {
      paymentBridge.error =
        `Port ${port} is already in use — another program (the real LumaBooth/dslrBooth?) ` +
        'has it. Payment signals cannot reach this app until that program is closed.';
      console.error(`[LumaAPI] ✗ ${paymentBridge.error}`);
    } else {
      paymentBridge.error = err.message;
      console.error('[LumaAPI] server error:', err.message);
    }
    pushBridgeStatus();
  });

  lumaApiServer.listen(port, '127.0.0.1', () => {
    paymentBridge.listening = true;
    paymentBridge.error = null;
    pushBridgeStatus();
    console.log(
      `[LumaAPI] Impersonating LumaBooth API at http://127.0.0.1:${port}/api/start ` +
      '(payment signal from LumaBooth Middleware)',
    );
  });
}

app.on('will-quit', () => {
  try { lumaApiServer?.close(); } catch (_) { /* shutting down anyway */ }
});

// Drives the outbound middleware API (PULL mode). The renderer already
// calls this on every phase change from BillAcceptorView:
//   begin   → guest landed on the Payment screen; start a sale
//   consume → paid; session handed off to the camera
//   reset   → guest pressed Back / timed out; void the sale
// When PAYMENT_API_URL is unset this stays a no-op and the existing
// LumaBooth localhost:1500 path is unaffected.
ipcMain.handle('payment:session', async (_event, state) => {
  const phase = state && state.phase;
  console.log('[Main] payment:session:', JSON.stringify(state));

  if (!paymentMiddleware.isEnabled()) {
    return { success: true, mode: 'push-only' };
  }

  try {
    if (phase === 'begin') {
      return await paymentMiddleware.beginSession(
        { amount: state.required, templateId: state.templateId },
        emitPaymentCredit,
      );
    }
    if (phase === 'reset') return await paymentMiddleware.cancelSession('guest-cancelled');
    if (phase === 'consume') return { success: true };
  } catch (err) {
    console.error('[Main] payment:session failed:', err);
    return { success: false, error: err.message };
  }
  return { success: true };
});

// Save the print-ready sheet to the OS temp directory instead of the
// user's Pictures folder. The print sheet is just a transient artifact
// the printer needs — the canonical user-facing photos are the
// individual captures saved via `save-photo`. Putting print sheets in
// temp keeps the user's Pictures folder clean.
ipcMain.handle("save-temp-photo", async (event, { imageData, filename }) => {
  try {
    const os = require("os");
    const tempDir = path.join(os.tmpdir(), "nostalgia-photobooth-print");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const finalFilename = filename || `print_${Date.now()}.png`;
    const filePath = path.join(tempDir, finalFilename);
    if (!imageData) {
      return { success: false, error: "No image data provided" };
    }
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(filePath, buffer);
    console.log("[Main] Print sheet saved to temp:", filePath);
    return { success: true, path: filePath };
  } catch (error) {
    console.error("[Main] Error saving temp photo:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
});

ipcMain.handle("r2:status", async () => {
  return r2.pingR2();
});

ipcMain.handle("r2:upload", async (_event, payload) => {
  return r2.uploadToR2({
    imageDataUrl: payload?.imageData || payload?.imageDataUrl,
    folder: payload?.folder,
    publicId: payload?.publicId,
  });
});

// IPC Handlers
ipcMain.handle("save-photo", async (event, { imageData, filename }) => {
  try {
    console.log("[Main] Save photo request received");
    const picturesPath = app.getPath("pictures");
    console.log("[Main] Pictures directory:", picturesPath);

    const photosDir = path.join(picturesPath, "NostalgiaPhotobooth");
    console.log("[Main] Target photos directory:", photosDir);

    if (!fs.existsSync(photosDir)) {
      console.log("[Main] Creating photos directory...");
      fs.mkdirSync(photosDir, { recursive: true });
      console.log("[Main] Photos directory created");
    } else {
      console.log("[Main] Photos directory already exists");
    }

    const finalFilename = filename || `nostalgia_${Date.now()}.png`;
    // `filename` may now carry a session sub-path
    // ("08-06-26/Session 2/photo-1.jpg"), so resolve it and confirm the
    // result really is inside the photos folder before creating anything.
    const filePath = path.resolve(photosDir, finalFilename);
    if (filePath !== photosDir && !filePath.startsWith(photosDir + path.sep)) {
      console.error(
        "[Main] Rejected filename outside the photos folder:",
        finalFilename,
      );
      return { success: false, error: "Invalid filename" };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    console.log("[Main] Saving file to:", filePath);

    if (!imageData) {
      console.error("[Main] No image data provided");
      return { success: false, error: "No image data provided" };
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
    console.log("[Main] Base64 data length:", base64Data.length);

    const buffer = Buffer.from(base64Data, "base64");
    console.log("[Main] Buffer created, size:", buffer.length, "bytes");

    fs.writeFileSync(filePath, buffer);
    console.log("[Main] File written successfully");

    // Verify file exists
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      console.log("[Main] File verified, size:", stats.size, "bytes");
    } else {
      console.error("[Main] File was not created!");
    }

    return { success: true, path: filePath };
  } catch (error) {
    console.error("[Main] Error saving photo:", error);
    console.error("[Main] Error stack:", error.stack);
    return { success: false, error: error.message };
  }
});

// ── Title screen background (image or video) ───────────────────────────────
// Stored on disk (userData), NOT localStorage — a video background can
// easily be tens of MB as base64, which blows past localStorage's ~5-10MB
// quota and silently fails. Only one background file exists at a time; any
// previous file is removed before writing the new one.
// Backgrounds are stored per "slot" so each screen can have its own.
//   title   -> the Home/title screen
//   payment -> the Payment screen
// Unknown slots fall back to title so older callers keep working.
function backgroundDir(slot) {
  const safe = slot === "payment" ? "payment" : "title";
  return path.join(app.getPath("userData"), `${safe}-background`);
}

function titleBackgroundDir() {
  return backgroundDir("title");
}

ipcMain.handle("save-title-background", async (event, { dataUrl }) => {
  try {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
    if (!match) {
      return { success: false, error: "Invalid data URL" };
    }
    const [, mime, base64Data] = match;
    const assetsDir = titleBackgroundDir();
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    for (const f of fs.readdirSync(assetsDir)) fs.unlinkSync(path.join(assetsDir, f));
    const ext = mime.split("/")[1] || "bin";
    const filePath = path.join(assetsDir, `background.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
    console.log("[Main] Title background saved:", filePath);
    return { success: true, path: filePath };
  } catch (error) {
    console.error("[Main] Error saving title background:", error);
    return { success: false, error: error.message };
  }
});

// Raw-bytes variant of save-title-background: avoids building a base64
// data URL (~33% larger) in the renderer for what can be a multi-MB MP4.
ipcMain.handle("save-title-background-bytes", async (event, { bytes, mime, slot }) => {
  try {
    if (!bytes || !mime) return { success: false, error: "Missing bytes or mime" };
    const assetsDir = backgroundDir(slot);
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    for (const f of fs.readdirSync(assetsDir)) fs.unlinkSync(path.join(assetsDir, f));
    const ext = (mime.split("/")[1] || "bin").split(";")[0];
    const filePath = path.join(assetsDir, `background.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(bytes));
    console.log(`[Main] ${slot || "title"} background saved (${bytes.length} bytes):`, filePath);
    return { success: true, path: filePath };
  } catch (error) {
    console.error("[Main] Error saving title background bytes:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-title-background", async (event, arg) => {
  const empty = { success: true, bytes: null, mime: null, mediaType: null };
  try {
    const assetsDir = backgroundDir(arg && arg.slot);
    if (!fs.existsSync(assetsDir)) return empty;
    const files = fs.readdirSync(assetsDir);
    if (files.length === 0) return empty;
    const filePath = path.join(assetsDir, files[0]);
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const videoExts = ["mp4", "webm", "ogg", "mov", "m4v"];
    const mediaType = videoExts.includes(ext) ? "video" : "image";
    const mime =
      mediaType === "video"
        ? `video/${ext === "mov" ? "mp4" : ext}`
        : `image/${ext === "jpg" ? "jpeg" : ext}`;
    // Raw bytes, NOT a data URL — the renderer wraps these in a Blob and
    // uses an object URL. media-src in the CSP allows blob: but not
    // data:, and Chromium won't play a large data-URL video regardless.
    return { success: true, bytes: buffer, mime, mediaType };
  } catch (error) {
    console.error("[Main] Error reading title background:", error);
    return { success: false, error: error.message, bytes: null, mime: null, mediaType: null };
  }
});

ipcMain.handle("clear-title-background", async (event, arg) => {
  try {
    const assetsDir = backgroundDir(arg && arg.slot);
    if (fs.existsSync(assetsDir)) {
      for (const f of fs.readdirSync(assetsDir)) fs.unlinkSync(path.join(assetsDir, f));
    }
    return { success: true };
  } catch (error) {
    console.error("[Main] Error clearing title background:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-photos-directory", async () => {
  const photosDir = path.join(app.getPath("pictures"), "NostalgiaPhotobooth");
  if (!fs.existsSync(photosDir)) {
    fs.mkdirSync(photosDir, { recursive: true });
  }
  return photosDir;
});

// ── Booth configuration (runtime, NOT build-time) ───────────────────────────
// The kiosk id and PocketBase URL used to come from VITE_* env vars, which
// Vite inlines at BUILD time. With one booth that was invisible; with a fleet
// it is fatal — every booth compiled from the same build reports the same
// kiosk_id, so all their sales collapse into one indistinguishable bucket,
// and giving each booth its own identity would mean a separate build per
// booth (and 20 rebuilds for every bug fix).
//
// So the identity lives in a plain JSON file next to the app's other state.
// Set it once per machine, from Admin -> Settings, and it survives updates
// because userData is not touched by a reinstall.
function boothConfigFile() {
  return path.join(app.getPath("userData"), "booth-config.json");
}

function readBoothConfig() {
  try {
    const file = boothConfigFile();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch (error) {
    console.error("[Booth] Could not read booth-config.json:", error);
    return {};
  }
}

ipcMain.handle("booth:get-config", async () => {
  const cfg = readBoothConfig();
  // Env vars still win when present, so an operator can override a machine
  // from a launcher script without editing the file.
  const kioskId = (process.env.KIOSK_ID || cfg.kioskId || "").trim();
  const pocketBaseUrl = (process.env.POCKETBASE_URL || cfg.pocketBaseUrl || "").trim();
  console.log(`[Booth] kioskId="${kioskId || "(unset)"}" pocketBaseUrl="${pocketBaseUrl || "(unset)"}"`);
  return { success: true, kioskId, pocketBaseUrl };
});

ipcMain.handle("booth:set-config", async (event, patch) => {
  try {
    const file = boothConfigFile();
    const next = { ...readBoothConfig() };
    if (typeof patch?.kioskId === "string") next.kioskId = patch.kioskId.trim();
    if (typeof patch?.pocketBaseUrl === "string") {
      next.pocketBaseUrl = patch.pocketBaseUrl.trim().replace(/\/+$/, "");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, file);
    console.log("[Booth] Saved booth config:", next);
    return { success: true, ...next };
  } catch (error) {
    console.error("[Booth] Could not write booth-config.json:", error);
    return { success: false, error: error.message };
  }
});

// ── Template persistence ────────────────────────────────────────────────────
// Templates used to live in localStorage. They cannot: an imported template
// carries its frame artwork AND both thumbnails as base64 data URLs, so one
// template is often several hundred KB, and localStorage is capped at ~5MB
// per origin. The cap is reached quickly (the recent-strips list alone holds
// up to 200 preview JPEGs), and once it is, every `setItem` throws
// QuotaExceededError — so newly added templates were silently never written
// and vanished on the next restart.
//
// Disk has no such ceiling. This is the same treatment the title/payment
// backgrounds already get, and for the same reason.
function templatesFile() {
  return path.join(app.getPath("userData"), "templates.json");
}

/**
 * Crash-safe JSON write. Write a sibling .tmp, then replace the real
 * file. On Windows `rename` often fails with EPERM/EEXIST when the
 * destination already exists or is briefly locked, so fall back to
 * copy-over + unlink — otherwise layout saves look successful in the
 * UI and then vanish on the next launch.
 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* leftover .tmp is harmless */
    }
    if (error) {
      console.warn("[Templates] rename-over failed, copied instead:", error.message);
    }
  }
}

ipcMain.handle("templates:load", async () => {
  try {
    const file = templatesFile();
    if (!fs.existsSync(file)) return { success: true, data: null };
    const raw = fs.readFileSync(file, "utf8");
    return { success: true, data: JSON.parse(raw) };
  } catch (error) {
    console.error("[Templates] Could not read templates.json:", error);
    return { success: false, error: error.message, data: null };
  }
});

ipcMain.handle("templates:save", async (event, data) => {
  try {
    const file = templatesFile();
    writeJsonAtomic(file, data);
    const count = Array.isArray(data?.customTemplates)
      ? data.customTemplates.length
      : 0;
    console.log(`[Templates] Saved ${count} custom template(s) to disk`);
    return { success: true, path: file };
  } catch (error) {
    console.error("[Templates] Could not write templates.json:", error);
    return { success: false, error: error.message };
  }
});

// ── Session folders ─────────────────────────────────────────────────────────
// Captures used to land in one flat pile in Pictures/NostalgiaPhotobooth. The
// client wants them filed by day and by session instead:
//
//   NostalgiaPhotobooth/
//     08-06-26/
//       Session 1/   strip.png · photo-1.jpg … · session.gif
//       Session 2/
//     08-07-26/
//       Session 1/
//
// Numbering lives in MAIN rather than the renderer: this is the only process
// that can see what is already on disk, so a restart mid-event continues from
// the right number instead of overwriting Session 1.
function sessionDateFolder(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getFullYear() % 100)}`;
}

ipcMain.handle("session:begin", async () => {
  try {
    const photosDir = path.join(app.getPath("pictures"), "NostalgiaPhotobooth");
    const dateRel = sessionDateFolder();
    const dateDir = path.join(photosDir, dateRel);
    fs.mkdirSync(dateDir, { recursive: true });

    let highest = 0;
    for (const name of fs.readdirSync(dateDir)) {
      const m = /^Session (\d+)$/.exec(name);
      if (m) highest = Math.max(highest, parseInt(m[1], 10));
    }

    const folder = `${dateRel}/Session ${highest + 1}`;
    fs.mkdirSync(path.join(photosDir, folder), { recursive: true });
    console.log("[Session] Started:", folder);
    return { success: true, folder, path: path.join(photosDir, folder) };
  } catch (error) {
    console.error("[Session] Could not create session folder:", error);
    return { success: false, error: error.message, folder: null };
  }
});

// Raw-bytes save for the session GIF — the renderer builds it as a
// Uint8Array and there is no reason to pay a ~33% base64 tax to hand it over.
ipcMain.handle("save-session-bytes", async (event, { bytes, filename }) => {
  try {
    if (!bytes || !filename) {
      return { success: false, error: "Missing bytes or filename" };
    }
    const photosDir = path.join(app.getPath("pictures"), "NostalgiaPhotobooth");
    const filePath = path.resolve(photosDir, filename);
    if (!filePath.startsWith(photosDir + path.sep)) {
      return { success: false, error: "Invalid filename" };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(bytes));
    console.log(`[Session] Wrote ${filename} (${bytes.length} bytes)`);
    return { success: true, path: filePath };
  } catch (error) {
    console.error("[Session] Error saving bytes:", error);
    return { success: false, error: error.message };
  }
});

// Highlight clips live under Videos/NostalgiaPhotobooth so they are
// not mixed into the Pictures photo dumps.
ipcMain.handle("save-highlight-video", async (_event, { bytes, filename }) => {
  try {
    if (!bytes || !filename) {
      return { success: false, error: "Missing bytes or filename" };
    }
    const videosDir = path.join(app.getPath("videos"), "NostalgiaPhotobooth");
    const safeRel = String(filename).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!safeRel || safeRel.includes("..")) {
      return { success: false, error: "Invalid filename" };
    }
    const filePath = path.resolve(videosDir, safeRel);
    if (!filePath.startsWith(videosDir + path.sep)) {
      return { success: false, error: "Invalid filename" };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(bytes));
    console.log(`[Highlight] Saved local video: ${filePath} (${bytes.length} bytes)`);
    return { success: true, path: filePath };
  } catch (error) {
    console.error("[Highlight] Error saving local video:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("list-saved-photos", async () => {
  try {
    const photosDir = path.join(app.getPath("pictures"), "NostalgiaPhotobooth");
    if (!fs.existsSync(photosDir)) {
      return [];
    }

    // Photos now live in <date>/<session>/ subfolders, so this has to walk
    // the tree — a flat readdir would report an empty gallery. `name` keeps
    // the relative path so the admin gallery can still show provenance.
    const files = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (/\.(png|jpg|jpeg)$/i.test(entry.name)) {
          files.push({ name: rel, path: abs, created: fs.statSync(abs).birthtime });
        }
      }
    };
    walk(photosDir, "");

    return files.sort((a, b) => b.created - a.created);
  } catch (error) {
    console.error("Error listing photos:", error);
    return [];
  }
});

ipcMain.handle("read-photo", async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString("base64");
    const ext = path.extname(filePath).toLowerCase().slice(1);
    return `data:image/${ext};base64,${base64}`;
  } catch (error) {
    console.error("Error reading photo:", error);
    return null;
  }
});

ipcMain.handle("delete-photo", async (event, filePath) => {
  try {
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (error) {
    console.error("Error deleting photo:", error);
    return { success: false, error: error.message };
  }
});

// ── Printer IPC handlers ────────────────────────────────────────────────────

/** Return all printers visible to the OS. */
ipcMain.handle('get-printers', async () => {
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return { success: true, printers };
  } catch (error) {
    console.error('[Main] get-printers error:', error);
    return { success: false, printers: [], error: error.message };
  }
});

/**
 * Print the saved composite image to a printer.
 * @param {object} opts
 * @param {string}  opts.filePath      - Absolute path to the PNG file.
 * @param {string}  [opts.printerName] - Specific printer name; empty = OS default.
 * @param {number}  [opts.copies=1]    - Number of copies.
 * @param {string}  [opts.paperLayout] - 'portrait' | 'landscape'
 * @param {string}  [opts.cutMode]     - 'standard' | 'dnp-2-inch-cut'
 */
// `paperSize` is the template's PaperSize (e.g. '6x8-portrait'). It used
// to be dropped here, and the script below then force-selected a 4x6
// driver form on EVERY job — so a correctly composed 1800x2400 sheet was
// stretched onto 4x6 media. That is why "everything came out 4x6 even
// when it was set to 6x8".
ipcMain.handle('print-photo', async (event, { filePath, printerName, copies = 1, paperLayout = 'portrait', cutMode = 'standard', paperSize = '' }) => {
  const os = require('os');
  const { exec } = require('child_process');

  if (!fs.existsSync(filePath)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  // Resolve printer — find first real (non-virtual) printer if none configured
  const VIRTUAL_PRINTERS = [
    'Microsoft Print to PDF', 'Microsoft XPS Document Writer',
    'Fax', 'OneNote', 'Send To OneNote', 'Adobe PDF',
  ];

  let targetPrinter = (printerName || '').trim();
  if (!targetPrinter) {
    try {
      const allPrinters = await mainWindow.webContents.getPrintersAsync();
      const real = allPrinters.filter(
        p => !VIRTUAL_PRINTERS.some(v => p.name.includes(v))
      );
      const def = real.find(p => p.isDefault) || real[0];
      targetPrinter = def?.name || '';
      if (targetPrinter) console.log(`[Main] Auto-selected printer: "${targetPrinter}"`);
    } catch (e) {
      console.warn('[Main] Could not enumerate printers:', e.message);
    }
  }

  if (!targetPrinter) {
    return {
      success: false,
      error: 'No printer found. Please connect a printer and configure it in Settings → Printer.',
    };
  }

  // Use .NET System.Drawing via PowerShell — sends proper raster GDI data that
  // dye-sub drivers (like DNP) understand, unlike Chromium's EMF/PDF output.
  const isLandscape = paperLayout === 'landscape';
  const safePath    = filePath.replace(/'/g, "''");
  const safePrinter = targetPrinter.replace(/'/g, "''");
  const safeCutMode = String(cutMode || 'standard').replace(/'/g, "''");
  // Only the media family matters to the driver form name, not the
  // orientation (that is handled by $wantLandscape).
  const paperFamily = String(paperSize || '').startsWith('6x8') ? '6x8' : '4x6';
  const copiesVal   = Math.max(1, Math.min(10, copies || 1));

  const psScript = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${safePath}')
$pd  = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = '${safePrinter}'
$pd.PrinterSettings.Copies      = ${copiesVal}
$wantLandscape = $${isLandscape ? 'true' : 'false'}
$pd.DefaultPageSettings.Landscape = $wantLandscape
$pd.DefaultPageSettings.Margins   = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$pd.OriginAtMargins = $false

# Dump every paper size the driver exposes — essential for debugging
# when DNP paper names vary across driver versions (e.g. "PC (2x6)*2"
# vs "(2x6)" vs "2x6*2"). Logs are returned via stdout.
Write-Output 'AVAILABLE_PAPER_SIZES:'
$pd.PrinterSettings.PaperSizes | ForEach-Object { Write-Output ("  - " + $_.PaperName) }

$cutMode = '${safeCutMode}'
$paperFamily = '${paperFamily}'
$paperSelected = $false

# Paper preference order depends on cut mode AND orientation. On the
# DS-RX1 the "PR (…)" sizes are PORTRAIT-oriented (dimensions listed
# tall, e.g. "PR (4x6)" = 4" wide × 6" tall) and the plain "(…)"
# sizes are LANDSCAPE (e.g. "(6x4)" = 6" wide × 4" tall). Sending a
# portrait composite to a landscape paper size makes the driver
# rotate it → sideways prints, which is exactly the bug we hit. So:
#   - cut jobs           → PR (4x6) (cut fires on the PR size)
#   - portrait, no cut   → PR (4x6) (native portrait, no rotation)
#   - landscape, no cut  → (6x4)
#
# Driver-side prerequisite for the cut: Devices and Printers →
# DS-RX1 → Printing Preferences → Advanced → Printer Features →
# "2 inch cut: Enable" (persists as the printer default). Keep that
# toggle OFF for portrait grid templates (2×2 etc.) or they'll be
# cut too — it's a global driver setting, not per-job.
if ($paperFamily -eq '6x8') {
    # 6x8 media (DS620-class). The DNP driver exposes it as "(6x8)";
    # the 8x6 variants cover a landscape-mounted build.
    $preferredPaperNames = @(
        '(6x8)', '6x8', 'PC (6x8)', 'PC(6x8)', 'PR (6x8)', 'PR(6x8)',
        '(8x6)', '8x6', 'PC (8x6)', 'PC(8x6)'
    )
} elseif ($cutMode -eq 'dnp-2-inch-cut') {
    $preferredPaperNames = @(
        'PR (4x6)', 'PR(4x6)', 'PR (6x4)', 'PR(6x4)',
        # Fallback if the PR size isn't present in this driver build.
        'PC (4x6)', 'PC(4x6)', '(4x6)', '4x6',
        'PC (6x4)', 'PC(6x4)', '(6x4)', '6x4'
    )
} elseif ($wantLandscape) {
    $preferredPaperNames = @(
        'PC (6x4)', 'PC(6x4)', '(6x4)', '6x4',
        'PR (6x4)', 'PR(6x4)',
        'PC (4x6)', 'PC(4x6)', '(4x6)', '4x6', 'PR (4x6)', 'PR(4x6)'
    )
} else {
    # Portrait, no cut → prefer the PR (portrait) 4×6 size.
    $preferredPaperNames = @(
        'PR (4x6)', 'PR(4x6)',
        'PC (4x6)', 'PC(4x6)', '(4x6)', '4x6',
        'PC (6x4)', 'PC(6x4)', '(6x4)', '6x4', 'PR (6x4)', 'PR(6x4)'
    )
}
foreach ($name in $preferredPaperNames) {
    $paper = $pd.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -eq $name } | Select-Object -First 1
    if ($paper) {
        $pd.DefaultPageSettings.PaperSize = $paper
        Write-Output "PAPER_SIZE=$($paper.PaperName)"
        $paperSelected = $true
        break
    }
}
if (-not $paperSelected) {
    if ($paperFamily -eq '6x8') {
        # Do NOT silently fall back to 4x6 here: printing a 6x8 sheet on
        # 4x6 media is what produced "lahat 4x6 lang lumalabas kahit naka
        # set na siya ng 6x8". Leave the driver default in place and say
        # so loudly instead.
        Write-Output 'PAPER_SIZE_MISSING=6x8'
        Write-Output ('AVAILABLE_PAPER_SIZES:' + (($pd.PrinterSettings.PaperSizes | ForEach-Object { $_.PaperName }) -join '|'))
    } else {
        $paper = $pd.PrinterSettings.PaperSizes |
            Where-Object { ($_.PaperName -match '6x4' -or $_.PaperName -match '4x6') -and $_.PaperName -notmatch '2x6' } |
            Select-Object -First 1
        if ($paper) {
            $pd.DefaultPageSettings.PaperSize = $paper
            Write-Output "PAPER_SIZE_FALLBACK=$($paper.PaperName)"
            $paperSelected = $true
        }
    }
}
if ($cutMode -eq 'dnp-2-inch-cut') {
    Write-Output 'CUT_MODE_NOTE: PR(4x6) selected; driver must have "2 inch cut: Enable" toggled on (Printer Preferences → Advanced → Printer Features) for the physical cut to fire.'
}

$pd.add_PrintPage({
    param($s,$e)
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $e.Graphics.DrawImage($img, $e.PageBounds)
    $e.HasMorePages = $false
})
$pd.Print()
$img.Dispose()
Write-Output 'PRINT_OK'
`;

  const tmpPs = path.join(os.tmpdir(), `nostalgia_print_${Date.now()}.ps1`);
  fs.writeFileSync(tmpPs, psScript, 'utf8');

  console.log(`[Main] Printing via .NET: printer="${targetPrinter}", copies=${copiesVal}, landscape=${isLandscape}, cutMode=${safeCutMode}, paperSize=${paperSize || '(unset)'} -> family ${paperFamily}`);

  return new Promise((resolve) => {
    exec(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpPs}"`,
      { timeout: 30000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpPs); } catch (_) {}
        if (err) {
          console.error('[Main] Print error:', err.message, stderr);
          return resolve({ success: false, error: err.message || stderr || 'Print failed' });
        }
        if (stdout.includes('PRINT_OK')) {
          console.log('[Main] ✓ Photo printed successfully');
          // Echo diagnostic output (picked paper size, cut-mode note) so
          // the operator can confirm the right paper was chosen and that
          // the driver's "2inch cut" toggle is what controls the cutter.
          console.log('[Main] Print stdout:\n' + stdout.trim());
          resolve({ success: true, stdout: stdout.trim() });
        } else {
          const errMsg = stderr || stdout || 'Unknown print error';
          console.error('[Main] Print failed:', errMsg);
          resolve({ success: false, error: errMsg });
        }
      }
    );
  });
});

// (legacy did-fail-load placeholder — kept so diff is clean)

// ────────────────────────────────────────────────────────────────────────────

/**
 * Open the Windows "Printer properties" dialog for a specific printer. This
 * is a one-click shortcut so operators can reach DNP-specific options
 * (like "2inch cut: Enable") without navigating Control Panel.
 *
 * The dialog is launched via `rundll32 printui.dll,PrintUIEntry /p /n` which
 * opens the same Properties window Windows uses. Once open the operator
 * clicks Advanced → Printing Defaults → Advanced → Printer Features →
 * "2inch cut: Enable" → OK. That default persists for every print the app
 * sends via .NET PrintDocument.
 *
 * Why not auto-toggle "2inch cut" programmatically? The flag lives in the
 * driver's DEVMODE driver-extra bytes — a vendor-specific opaque blob.
 * Without DNP's SDK we can't safely flip the correct byte across driver
 * versions, so we surface the driver dialog itself.
 *
 * @param {string} printerName - Exact printer name (e.g. "DS-RX1" or
 *                               "DP-DS-RX1"). Empty uses system default.
 */
ipcMain.handle('open-printer-properties', async (_event, printerName) => {
  const { exec } = require('child_process');

  let target = (printerName || '').trim();
  if (!target) {
    try {
      const allPrinters = await mainWindow.webContents.getPrintersAsync();
      const def = allPrinters.find(p => p.isDefault) || allPrinters[0];
      target = def?.name || '';
    } catch (e) {
      return { success: false, error: `Could not enumerate printers: ${e.message}` };
    }
  }
  if (!target) {
    return { success: false, error: 'No printer selected or available.' };
  }

  // `printui.dll,PrintUIEntry /p /n "printer"` opens Printer properties.
  // From there the operator reaches Printing Defaults → Advanced →
  // Printer Features → 2inch cut.
  const safe = target.replace(/"/g, '\\"');
  const cmd = `rundll32 printui.dll,PrintUIEntry /p /n "${safe}"`;
  console.log(`[Main] Opening printer properties: ${cmd}`);

  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (err) => {
      if (err) {
        console.error('[Main] Failed to open printer properties:', err.message);
        return resolve({ success: false, error: err.message });
      }
      resolve({ success: true, printerName: target });
    });
  });
});

ipcMain.handle("toggle-fullscreen", async () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  }
  return false;
});

ipcMain.handle("quit-app", async () => {
  app.quit();
});

// Canon EDSDK IPC Handlers
if (edsdkAvailable) {
  // Initialize Canon camera browser
  ipcMain.handle('canon-list-cameras', async () => {
    try {
      if (!CanonCameraBrowser) {
        return { success: false, error: 'EDSDK not available' };
      }
      
      if (!canonCameraBrowser) {
        canonCameraBrowser = new CanonCameraBrowser();
      }
      
      const cameras = canonCameraBrowser.getCameras();
      console.log(`[Main] Found ${cameras.length} Canon camera(s)`);
      
      return {
        success: true,
        cameras: cameras.map((cam, index) => ({
          index,
          name: cam.name || `Canon Camera ${index + 1}`,
          portName: cam.portName || 'Unknown'
        }))
      };
    } catch (error) {
      console.error('[Main] Error listing Canon cameras:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Connect to Canon camera
  ipcMain.handle('canon-connect', async (event, cameraIndex) => {
    try {
      if (!canonCameraBrowser) {
        canonCameraBrowser = new CanonCameraBrowser();
      }
      
      const cameras = canonCameraBrowser.getCameras();
      if (cameraIndex < 0 || cameraIndex >= cameras.length) {
        return { success: false, error: 'Invalid camera index' };
      }
      
      const camera = cameras[cameraIndex];
      
      // Connect to camera and open session.
      // NOTE: the addon exposes only `description` and `portName` — there is
      // no `isConnected` and no `name` on Camera, so the old guard was always
      // true and the old log always printed "undefined". connect() is a
      // no-op when the session is already open. connect(true) enables EDSDK
      // keep-alive so a WillSoonShutDown event sends ExtendShutDownTimer
      // instead of letting the body power off mid-session.
      camera.connect(true);
      console.log(`[Main] Connected to Canon camera: ${camera.description} @ ${camera.portName}`);

      // Open a session explicitly (required before takePicture)
      try {
        camera.setProperties({ [CameraProperty.ID.SaveTo]: Option.SaveTo.Host });
      } catch (_) {}

      // Store connected camera reference
      connectedCanonCamera = camera;
      
      // Configure camera properties (optional - don't fail connection if properties aren't supported)
      // Each property is set independently so one failure doesn't affect others
      console.log('[Main] Attempting to configure camera properties (optional)...');
      
      // Try to set SaveTo property (save to computer) - optional
      try {
        camera.setProperties({
          [CameraProperty.ID.SaveTo]: Option.SaveTo.Host,
        });
        console.log('[Main] ✓ Set SaveTo property to Host');
      } catch (saveToError) {
        console.warn('[Main] ⚠ Could not set SaveTo property (non-critical, continuing):', saveToError.message);
        // Continue - this property might not be supported or already set
      }
      
      // Try to set ImageQuality property - optional
      try {
        camera.setProperties({
          [CameraProperty.ID.ImageQuality]: ImageQuality.ID.LargeJPEGFine,
        });
        console.log('[Main] ✓ Set ImageQuality property to LargeJPEGFine');
      } catch (qualityError) {
        console.warn('[Main] ⚠ Could not set ImageQuality property (non-critical, continuing):', qualityError.message);
        // Continue - camera might use default quality or property not available
      }
      
      console.log('[Main] ✓ Camera connection successful');
      return { success: true, cameraName: camera.name || `Canon Camera ${cameraIndex + 1}` };
    } catch (error) {
      const errorMsg = error.message || String(error);
      console.error('[Main] Error connecting to Canon camera:', errorMsg);
      
      // If it's a property error but camera is connected, still return success
      if (errorMsg.includes('INVALID_DEVICEPROP_VALUE') || errorMsg.includes('INVALID')) {
        console.warn('[Main] Property setting failed, but camera connection may have succeeded');
        // Check if camera is actually connected
        try {
          const cameras = canonCameraBrowser.getCameras();
          if (cameras.length > cameraIndex && cameras[cameraIndex].isConnected) {
            console.log('[Main] Camera is connected despite property error - continuing');
            connectedCanonCamera = cameras[cameraIndex];
            return { success: true, cameraName: cameras[cameraIndex].name };
          }
        } catch (checkError) {
          // Camera check failed, return error
        }
      }
      
      return { success: false, error: errorMsg };
    }
  });
  
  // Set up event handler for download requests (one-time setup)
  let downloadRequestHandler = null;
  let pendingPhotoPromise = null;
  // Monotonic shot counter + shutter timestamp so every Canon log line is
  // attributable to a specific shot in the client's log file
  // (Documents/NostalgiaPhotobooth/app-log-*.txt). Without this the log is
  // an undifferentiated stream and a post-mortem on the client's machine
  // can't tell shot 1 from shot 2.
  let shotNo = 0;
  let shutterFiredAt = 0;
  
  if (!canonCameraBrowser) {
    canonCameraBrowser = new CanonCameraBrowser();
  }
  
  downloadRequestHandler = (eventName, event) => {
    if (eventName !== 'DownloadRequest') return;
    {
      const file = event.file;
      if (!pendingPhotoPromise) {
        // An image the app didn't ask for: an extra frame (RAW+JPEG, or a
        // burst from a held shutter), or one that arrived after its capture
        // promise timed out. It MUST still be resolved on the EDSDK side —
        // an un-transferred, un-cancelled directory item keeps the camera
        // busy and makes every later takePicture() fail with DEVICE_BUSY /
        // TAKE_PICTURE_CARD_NG. Silently dropping it (the old
        // `&& pendingPhotoPromise` guard) is how one stray frame jammed the
        // whole session.
        console.warn(`[Canon][shot #${shotNo}] ORPHAN DownloadRequest "${file.name}" — cancelling transfer`);
        try { file.cancel(); } catch (e) { console.warn('[Canon] orphan cancel failed:', e.message); }
        return;
      }
      console.log(`[Canon][shot #${shotNo}] DownloadRequest "${file.name}" (+${Date.now() - shutterFiredAt}ms after shutter)`);

      // Download image: save to temp file then read as base64 (most reliable)
      try {
        const os = require('os');
        const tmpDir = os.tmpdir();
        const localFile = file.downloadToPath(tmpDir);
        console.log(`[Main] Photo downloaded to temp file: ${localFile}`);
        const buffer = fs.readFileSync(localFile);
        console.log(`[Main] File size: ${buffer.length} bytes`);
        const base64 = buffer.toString('base64');
        const ext = path.extname(localFile).toLowerCase().replace('.', '') || 'jpeg';
        const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
        const dataUrl = `data:${mimeType};base64,${base64}`;
        console.log(`[Main] dataUrl created: length=${dataUrl.length}, mimeType=${mimeType}`);
        // Cleanup temp file
        try { fs.unlinkSync(localFile); } catch (_) {}
        pendingPhotoPromise.resolve({
          success: true,
          imageData: dataUrl,
          fileName: file.name
        });
        pendingPhotoPromise = null;
      } catch (downloadError) {
        console.error('[Main] Error downloading image:', downloadError);
        if (pendingPhotoPromise) {
          pendingPhotoPromise.reject(downloadError);
          pendingPhotoPromise = null;
        }
      }
    }
  };
  
  canonCameraBrowser.setEventHandler(downloadRequestHandler);
  
  // Take photo with Canon camera
  ipcMain.handle('canon-take-photo', async () => {
    try {
      if (!connectedCanonCamera) {
        return { success: false, error: 'No Canon camera connected' };
      }

      // Guard against overlapping capture requests — e.g. the guest (or the
      // retry button) triggering a second shot while the camera is still
      // processing the first one reliably causes EDSDK - DEVICE_BUSY.
      if (pendingPhotoPromise) {
        return { success: false, error: 'Camera is still processing the previous photo. Please wait a moment and try again.' };
      }

      // Re-open session if it was closed (e.g. after hot reload or sleep)
      try {
        connectedCanonCamera.setProperties({ [CameraProperty.ID.SaveTo]: Option.SaveTo.Host });
      } catch (sessionErr) {
        const msg = sessionErr.message || '';
        if (msg.includes('SESSION_NOT_OPEN') || msg.includes('SESSION')) {
          console.warn('[Main] Session closed, reconnecting camera...');
          try {
            connectedCanonCamera.connect();
            console.log('[Main] ✓ Camera session reopened');
          } catch (reconnectErr) {
            console.error('[Main] Failed to reopen session:', reconnectErr.message);
            return { success: false, error: 'Camera session lost. Please reconnect the camera.' };
          }
        }
      }

      shotNo++;
      console.log(`[Canon][shot #${shotNo}] BEGIN — pendingPhoto=${!!pendingPhotoPromise}, liveViewInterval=${!!liveViewInterval}`);

      // Pause live view during capture. The camera needs a moment to fully
      // settle out of live-view streaming before it'll accept a shutter
      // command — too short a wait here is a common cause of
      // EDSDK - DEVICE_BUSY on the very next takePicture() call.
      //
      // CameraView tears EVF down during the last countdown second so the
      // shutter at "0" isn't waiting on this. If live view is already
      // gone, only a short settle is needed; the old unconditional 700ms
      // was dead time between the on-screen "0" and the actual capture.
      const liveViewWasRunning = !!liveViewInterval;
      if (liveViewInterval) { clearInterval(liveViewInterval); liveViewInterval = null; }
      try {
        connectedCanonCamera.stopLiveView();
        console.log(`[Canon][shot #${shotNo}] live view torn down before shutter`);
      } catch (lvErr) {
        console.warn(`[Canon][shot #${shotNo}] stopLiveView before shutter failed:`, lvErr.message);
      }
      await new Promise(r => setTimeout(r, liveViewWasRunning ? 700 : 80));

      // Fire the shutter, retrying a couple of times if the camera reports
      // DEVICE_BUSY — that error is normally transient (camera still
      // finishing a prior operation) and clears within a few hundred ms.
      // Shutter constants from the addon rather than magic numbers.
      const CMD_PRESS_SHUTTER = Camera.Command.PressShutterButton;     // 4
      const SHUTTER_OFF = Camera.PressShutterButton.OFF;               // 0
      const SHUTTER_NONAF = Camera.PressShutterButton.CompletelyNonAF; // 65539

      // ALWAYS leave the shutter button released. Camera::takePicture()
      // sends Halfway -> Completely -> OFF but bails out of that chain the
      // moment a step errors, so an AF failure at the half-press (very
      // likely under photobooth lighting) leaves the button logically HELD
      // DOWN on the body. The old AF_NG recovery below then sent another
      // press and never a matching OFF, so every later command returned
      // DEVICE_BUSY for the rest of the session — exactly "the 1st shot
      // works, then a camera error blocks everything". Releasing in a
      // finally makes each shot independent and lets the DEVICE_BUSY retry
      // loop actually recover instead of re-pressing a held button.
      const releaseShutter = () => {
        try {
          connectedCanonCamera.sendCommand(CMD_PRESS_SHUTTER, SHUTTER_OFF);
          console.log(`[Canon][shot #${shotNo}] shutter released`);
        } catch (relErr) {
          console.warn(`[Canon][shot #${shotNo}] shutter release failed (non-fatal):`, relErr.message);
        }
      };

      const fireShutter = () => {
        try {
          try {
            connectedCanonCamera.takePicture();
          } catch (afErr) {
            const msg = afErr.message || '';
            if (msg.includes('TAKE_PICTURE_AF_NG') || msg.includes('AF_NG')) {
              console.warn(`[Canon][shot #${shotNo}] AF_NG -> firing CompletelyNonAF`);
              connectedCanonCamera.sendCommand(CMD_PRESS_SHUTTER, SHUTTER_NONAF);
            } else {
              throw afErr;
            }
          }
        } finally {
          releaseShutter();
        }
      };

      const MAX_BUSY_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_BUSY_RETRIES; attempt++) {
        try {
          // Wait for download request event
          let captureTimeout = null;
          try {
            console.log(`[Canon][shot #${shotNo}] takePicture attempt ${attempt + 1}/${MAX_BUSY_RETRIES + 1}`);
            return await new Promise((resolve, reject) => {
              captureTimeout = setTimeout(() => {
                pendingPhotoPromise = null;
                reject(new Error('Photo capture timeout (10 seconds)'));
              }, 10000); // 10 second timeout

              pendingPhotoPromise = { resolve, reject };

              // fireShutter() throws SYNCHRONOUSLY on an EDSDK error, which
              // rejects this promise via the executor and bypasses the
              // stored reject wrapper. The old code cleared the timeout only
              // inside those wrappers, so the 10s timer stayed armed and —
              // 10s later, which is EXACTLY the subsequent-shot countdown —
              // nulled a LATER shot's pendingPhotoPromise. That shot's
              // DownloadRequest was then dropped and its image left
              // un-transferred, jamming the camera. The finally below makes
              // each capture's timer strictly its own.
              shutterFiredAt = Date.now();
              fireShutter();
            });
          } finally {
            if (captureTimeout) clearTimeout(captureTimeout);
            captureTimeout = null;
            pendingPhotoPromise = null;
          }
        } catch (shotErr) {
          pendingPhotoPromise = null;
          const isBusy = (shotErr.message || '').includes('DEVICE_BUSY');
          if (isBusy && attempt < MAX_BUSY_RETRIES) {
            console.warn(`[Main] Camera busy, retrying shutter (attempt ${attempt + 1}/${MAX_BUSY_RETRIES})...`);
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            continue;
          }
          throw shotErr;
        }
      }
    } catch (error) {
      pendingPhotoPromise = null;
      // Log the RAW EDSDK message — 'EDSDK - DEVICE_BUSY' vs
      // 'EDSDK - TAKE_PICTURE_CARD_NG' vs 'EDSDK - SESSION_NOT_OPEN' point
      // at completely different root causes, and the renderer modal
      // flattens them all into one message.
      console.error(`[Canon][shot #${shotNo}] FAILED — raw EDSDK error: ${error.message}`);
      console.error(`[Canon][shot #${shotNo}] stack:`, error.stack);
      return { success: false, error: error.message };
    }
  });
  
  // Start live view - push frames to renderer
  ipcMain.handle('canon-start-liveview', async () => {
    try {
      if (!connectedCanonCamera) {
        return { success: false, error: 'No Canon camera connected' };
      }
      if (liveViewInterval) {
        clearInterval(liveViewInterval);
        liveViewInterval = null;
      }
      // Retry once: immediately after a capture + host download the camera
      // frequently rejects the Evf_OutputDevice write with DEVICE_BUSY. The
      // old code let that failure escape to the renderer, which only
      // console.warn'd it — so the preview went black for the rest of the
      // session with no error shown to anyone.
      try {
        connectedCanonCamera.startLiveView();
      } catch (lvErr) {
        console.warn(`[Canon] startLiveView failed (${lvErr.message}) — retrying in 600ms`);
        await new Promise(r => setTimeout(r, 600));
        connectedCanonCamera.startLiveView();
      }
      console.log('[Main] Live view started');
      // Give camera time to enter live view mode (R50 needs ~1.5s)
      await new Promise(r => setTimeout(r, 1500));
      let frameCount = 0;
      // Poll frames at ~15fps and push to renderer
      liveViewInterval = setInterval(() => {
        try {
          if (!connectedCanonCamera) return;
          const image = connectedCanonCamera.getLiveViewImage();
          if (image && mainWindow && !mainWindow.isDestroyed()) {
            const dataUrl = image.getDataURL();
            if (frameCount === 0) console.log('[Main] ✓ First live view frame delivered');
            frameCount++;
            mainWindow.webContents.send('liveview-frame', dataUrl);
          }
        } catch (err) {
          if (frameCount === 0) console.warn('[Main] Live view frame error:', err.message);
        }
      }, 66);
      return { success: true };
    } catch (err) {
      console.error('[Main] Error starting live view:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Stop live view
  ipcMain.handle('canon-stop-liveview', async () => {
    if (liveViewInterval) {
      clearInterval(liveViewInterval);
      liveViewInterval = null;
    }
    // No isLiveViewActive() guard: that flag is a cached value updated only
    // by an async EDSDK property event, so right after a startLiveView() it
    // still reads false and the stop was skipped entirely — leaving EVF
    // output routed to the PC while the next shutter fired.
    try {
      if (connectedCanonCamera) {
        connectedCanonCamera.stopLiveView();
        console.log('[Main] Live view stopped');
      }
    } catch (lvErr) {
      console.warn('[Main] stopLiveView failed:', lvErr.message);
    }
    return { success: true };
  });

  // Disconnect Canon camera
  ipcMain.handle('canon-disconnect', async () => {
    try {
      if (connectedCanonCamera) {
        connectedCanonCamera.disconnect();
        connectedCanonCamera = null;
        console.log('[Main] Disconnected Canon camera');
      }
      return { success: true };
    } catch (error) {
      console.error('[Main] Error disconnecting Canon camera:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Check if EDSDK is available
  ipcMain.handle('canon-check-available', async () => {
    return { available: true };
  });
} else {
  // Return unavailable if EDSDK not loaded
  ipcMain.handle('canon-check-available', async () => {
    return { available: false, error: 'EDSDK module not installed' };
  });
  
  ipcMain.handle('canon-list-cameras', async () => {
    return { success: false, error: 'EDSDK not available' };
  });
  
  ipcMain.handle('canon-connect', async () => {
    return { success: false, error: 'EDSDK not available' };
  });
  
  ipcMain.handle('canon-take-photo', async () => {
    return { success: false, error: 'EDSDK not available' };
  });
  
  ipcMain.handle('canon-disconnect', async () => {
    return { success: false, error: 'EDSDK not available' };
  });
}
