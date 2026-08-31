/**
 * Starts a local PocketBase next to the kiosk when the booth is configured
 * for 127.0.0.1 / localhost (the default). Data lives in userData so an
 * app reinstall does not wipe sales. Remote PocketBase URLs are left alone.
 */
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { app } = require("electron");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8090;

let child = null;
let startedByUs = false;

function isLocalUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost";
  } catch {
    return true;
  }
}

function parseListen(url) {
  try {
    const u = new URL(url || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    let port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!port) port = DEFAULT_PORT;
    return { host: u.hostname || DEFAULT_HOST, port };
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
}

function binaryName() {
  return process.platform === "win32" ? "pocketbase.exe" : "pocketbase";
}

function findBinary() {
  const name = binaryName();
  const candidates = [
    path.join(process.resourcesPath || "", "pocketbase", name),
    path.join(__dirname, "..", "vendor", "pocketbase", name),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

function migrationsDir() {
  const candidates = [
    path.join(process.resourcesPath || "", "pb_migrations"),
    path.join(__dirname, "..", "pb_migrations"),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

function health(baseUrl) {
  return new Promise((resolve) => {
    const req = http.get(
      `${String(baseUrl).replace(/\/$/, "")}/api/health`,
      { timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitHealthy(baseUrl, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await health(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function configuredUrl() {
  const env = (process.env.POCKETBASE_URL || "").trim();
  if (env) return env.replace(/\/+$/, "");
  try {
    const file = path.join(app.getPath("userData"), "booth-config.json");
    if (fs.existsSync(file)) {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8")) || {};
      if (typeof cfg.pocketBaseUrl === "string" && cfg.pocketBaseUrl.trim()) {
        return cfg.pocketBaseUrl.trim().replace(/\/+$/, "");
      }
    }
  } catch {
    /* use default */
  }
  return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
}

function stopPocketBase() {
  if (!startedByUs || !child) return;
  const proc = child;
  child = null;
  startedByUs = false;
  try {
    if (process.platform === "win32" && proc.pid) {
      execFile("taskkill", ["/pid", String(proc.pid), "/t", "/f"], () => {});
    } else {
      proc.kill("SIGTERM");
    }
  } catch (err) {
    console.warn("[PocketBase] Stop failed:", err.message);
  }
}

async function startPocketBase() {
  const url = configuredUrl();
  if (!isLocalUrl(url)) {
    console.log(
      "[PocketBase] Remote server configured — not starting a local process:",
      url,
    );
    return { started: false, url };
  }
  if (await health(url)) {
    console.log("[PocketBase] Already running at", url);
    return { started: false, url, alreadyRunning: true };
  }

  const bin = findBinary();
  if (!bin) {
    console.warn(
      "[PocketBase] Binary not found. Run npm run pb:ensure (or rebuild the installer).",
    );
    return { started: false, url };
  }

  const dataDir = path.join(app.getPath("userData"), "pocketbase");
  fs.mkdirSync(dataDir, { recursive: true });
  const { host, port } = parseListen(url);
  const args = ["serve", `--http=${host}:${port}`, `--dir=${dataDir}`];
  const mig = migrationsDir();
  if (mig) args.push(`--migrationsDir=${mig}`);

  console.log("[PocketBase] Starting", bin, args.join(" "));
  child = spawn(bin, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  startedByUs = true;
  child.stdout?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line) console.log("[PocketBase]", line);
  });
  child.stderr?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line) console.warn("[PocketBase]", line);
  });
  child.on("exit", (code, signal) => {
    console.log(`[PocketBase] Process exited code=${code} signal=${signal}`);
    if (child && child.exitCode === code) {
      child = null;
      startedByUs = false;
    }
  });

  const ok = await waitHealthy(url, 12000);
  if (ok) console.log("[PocketBase] Healthy at", url);
  else console.error("[PocketBase] Started but health check did not pass in time");
  return { started: true, url, healthy: ok };
}

module.exports = { startPocketBase, stopPocketBase };
