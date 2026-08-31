/**
 * Downloads the PocketBase binary into vendor/pocketbase/ so the
 * Electron installer can ship it and the kiosk can start it locally.
 */
const fs = require("fs");
const https = require("https");
const path = require("path");
const { execFileSync } = require("child_process");

const VERSION = "0.40.1";
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "vendor", "pocketbase");

function archiveName() {
  if (process.platform === "win32") {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    return `pocketbase_${VERSION}_windows_${arch}.zip`;
  }
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    return `pocketbase_${VERSION}_darwin_${arch}.zip`;
  }
  const arch =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "arm"
        ? "armv7"
        : "amd64";
  return `pocketbase_${VERSION}_linux_${arch}.zip`;
}

function binaryName() {
  return process.platform === "win32" ? "pocketbase.exe" : "pocketbase";
}

function download(url) {
  return new Promise((resolve, reject) => {
    const go = (current, hops) => {
      if (hops > 8) {
        reject(new Error("Too many redirects"));
        return;
      }
      https
        .get(
          current,
          { headers: { "User-Agent": "nostalgia-photobooth" } },
          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              res.resume();
              go(res.headers.location, hops + 1);
              return;
            }
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`Download failed HTTP ${res.statusCode}`));
              return;
            }
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          },
        )
        .on("error", reject);
    };
    go(url, 0);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, binaryName());
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    console.log("[PocketBase] Binary already present:", dest);
    return;
  }

  const zipName = archiveName();
  const url = `https://github.com/pocketbase/pocketbase/releases/download/v${VERSION}/${zipName}`;
  console.log("[PocketBase] Downloading", url);
  const zip = await download(url);
  const zipPath = path.join(OUT_DIR, zipName);
  fs.writeFileSync(zipPath, zip);
  execFileSync("tar", ["-xf", zipPath, "-C", OUT_DIR], { stdio: "inherit" });
  try {
    fs.unlinkSync(zipPath);
  } catch {
    /* keep zip if locked */
  }
  if (!fs.existsSync(dest)) {
    throw new Error(`Expected ${dest} after extract`);
  }
  console.log("[PocketBase] Ready:", dest);
}

main().catch((err) => {
  console.error("[PocketBase] ensure failed:", err.message || err);
  process.exit(1);
});
