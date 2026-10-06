/**
 * Wire Canon EDSDK into @brick-a-brack/napi-canon-cameras on macOS.
 *
 * The npm package does not ship EDSDK. Mac builds look for:
 *   node_modules/@brick-a-brack/napi-canon-cameras/third_party/EDSDKv131830M/macos/EDSDK/Framework/EDSDK.framework
 *
 * Put your Canon Developer EDSDK (Macintosh) here first:
 *   desktop/vendor/EDSDKv131830M/
 *   or set CANON_EDSDK_DIR to the unpacked SDK folder / zip.
 *
 * Then: npm run canon:edsdk
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EDSDK_VERSION = "131830";
const PKG = path.join(
  ROOT,
  "node_modules",
  "@brick-a-brack",
  "napi-canon-cameras",
);
const DEST = path.join(PKG, "third_party", `EDSDKv${EDSDK_VERSION}M`);

function exists(p) {
  try {
    return !!(p && fs.existsSync(p));
  } catch {
    return false;
  }
}

function walkFind(dir, matcher, depth = 0) {
  if (!exists(dir) || depth > 8) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (matcher(full, e)) return full;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const hit = walkFind(path.join(dir, e.name), matcher, depth + 1);
    if (hit) return hit;
  }
  return "";
}

function findFramework(root) {
  return walkFind(root, (full, e) => {
    const n = e.name.toLowerCase();
    return n === "edsdk.framework" && (e.isDirectory() || e.isSymbolicLink());
  });
}

function findHeaders(root) {
  const header = walkFind(root, (full, e) => {
    return e.isFile() && /^EDSDK\.h$/i.test(e.name);
  });
  return header ? path.dirname(header) : "";
}

function unpackZip(zipPath) {
  const tmp = path.join(ROOT, ".tmp", "edsdk-mac");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (process.platform === "darwin") {
    execFileSync("ditto", ["-x", "-k", zipPath, tmp], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", zipPath, "-C", tmp], { stdio: "inherit" });
  }
  return tmp;
}

function candidateRoots() {
  const names = [
    `EDSDKv${EDSDK_VERSION}M`,
    "EDSDKv131830M",
    "edsdk-mac",
    "EDSDK",
  ];
  const roots = [];
  if (process.env.CANON_EDSDK_DIR) roots.push(process.env.CANON_EDSDK_DIR);
  for (const n of names) {
    roots.push(path.join(ROOT, "vendor", n));
    roots.push(path.join(ROOT, "third_party", n));
  }
  try {
    const vendor = path.join(ROOT, "vendor");
    if (exists(vendor)) {
      for (const e of fs.readdirSync(vendor)) {
        if (/edsdk/i.test(e)) roots.push(path.join(vendor, e));
      }
    }
  } catch {
    /* ignore */
  }
  return roots;
}

function locateSdk() {
  for (const raw of candidateRoots()) {
    let root = raw;
    if (!exists(root)) continue;
    if (/\.zip$/i.test(root)) root = unpackZip(root);
    const fw = findFramework(root);
    const headers = findHeaders(root);
    if (fw && headers) return { fw, headers, root };
  }
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function stampEdsdk(sdk) {
  const fwDestA = path.join(DEST, "macos", "EDSDK", "Framework", "EDSDK.framework");
  const fwDestB = path.join(DEST, "macos", "EDSDK", "Framework", "EDSDK.Framework");
  const hdrDest = path.join(DEST, "macos", "EDSDK", "Header");
  fs.rmSync(path.join(DEST, "macos"), { recursive: true, force: true });
  copyDir(sdk.fw, fwDestA);
  if (!exists(fwDestB)) {
    try {
      fs.symlinkSync("EDSDK.framework", fwDestB);
    } catch {
      copyDir(sdk.fw, fwDestB);
    }
  }
  copyDir(sdk.headers, hdrDest);
  console.log("[Canon EDSDK] Stamped", DEST);
}

function ensurePackage() {
  if (exists(path.join(PKG, "package.json"))) return;
  console.log("[Canon EDSDK] Installing @brick-a-brack/napi-canon-cameras (scripts skipped)…");
  const r = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "@brick-a-brack/napi-canon-cameras@^0.1.5",
      "--ignore-scripts",
      "--no-save",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (r.status) {
    throw new Error("npm install napi-canon-cameras failed");
  }
}

function rebuildForElectron() {
  const electron = path.join(ROOT, "node_modules", "electron");
  if (!exists(electron)) {
    console.warn("[Canon EDSDK] Electron not installed yet; skip native rebuild.");
    return;
  }
  console.log("[Canon EDSDK] Rebuilding native addon for Electron…");
  const bin = path.join(ROOT, "node_modules", "@electron", "rebuild", "lib", "src", "cli.js");
  const args = exists(bin)
    ? [bin, "-f", "-w", "@brick-a-brack/napi-canon-cameras"]
    : [
        path.join(ROOT, "node_modules", "npx", "index.js"),
      ];
  let r;
  if (exists(bin)) {
    r = spawnSync(process.execPath, [bin, "-f", "-w", "@brick-a-brack/napi-canon-cameras"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } else {
    r = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["--yes", "@electron/rebuild", "-f", "-w", "@brick-a-brack/napi-canon-cameras"],
      { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" },
    );
  }
  if (r.status) {
    console.warn(
      "[Canon EDSDK] electron-rebuild failed; trying node-gyp-build in the package…",
    );
    const gyp = spawnSync(process.execPath, [path.join(PKG, "node_modules", "node-gyp-build", "bin.js")], {
      cwd: PKG,
      stdio: "inherit",
    });
    const gyp2 = gyp.status
      ? spawnSync(
          process.platform === "win32" ? "npx.cmd" : "npx",
          ["node-gyp-build"],
          { cwd: PKG, stdio: "inherit", shell: process.platform === "win32" },
        )
      : gyp;
    if (gyp2.status) {
      throw new Error("Canon native rebuild failed");
    }
  }
}

function printHelp() {
  console.log(`
[Canon EDSDK] Macintosh SDK not found.

1. Join Canon’s developer programme and download EDSDK for macOS:
     https://developercommunity.usa.canon.com/
     https://developers.canon-europe.com/

2. Unpack it (or the .zip) into:
     desktop/vendor/EDSDKv131830M/

   You need EDSDK.framework and the Header folder (EDSDK.h).
   Folder name can vary; the script will find the framework.

3. From desktop/:
     npm run canon:edsdk

Until that SDK is in place, Mac still runs — webcam only.
`);
}

function main() {
  if (process.platform !== "darwin") {
    console.log("[Canon EDSDK] macOS only — skipped on", process.platform);
    return;
  }
  const sdk = locateSdk();
  if (!sdk) {
    printHelp();
    process.exit(0);
    return;
  }
  console.log("[Canon EDSDK] Using framework:", sdk.fw);
  console.log("[Canon EDSDK] Using headers:", sdk.headers);
  ensurePackage();
  stampEdsdk(sdk);
  rebuildForElectron();
  console.log("[Canon EDSDK] Ready. Launch with npm run electron:dev");
}

main();
