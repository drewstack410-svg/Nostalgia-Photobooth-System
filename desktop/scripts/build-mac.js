/**
 * Package NOSTALGIA BOOTH for macOS (DMG + zip).
 * electron-builder can only produce a .app on Darwin.
 */
const { spawnSync } = require("child_process");
const path = require("path");

if (process.platform !== "darwin") {
  console.error(
    "[build-mac] Mac installers must be built on macOS.\n" +
      "  On a Mac, in desktop/:  npm install && npm run electron:build:mac\n" +
      "  Output: dist-electron/NOSTALGIA BOOTH-<version>-mac-<arch>.dmg",
  );
  process.exit(1);
}

const root = path.join(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args) => {
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  });
  if (r.status) process.exit(r.status);
};

run([path.join(root, "scripts/ensure-pocketbase.js")]);
run([path.join(root, "scripts/generate-app-icon.js")]);
run([
  path.join(root, "node_modules/vite/bin/vite.js"),
  "build",
]);
run([
  path.join(root, "node_modules/electron-builder/cli.js"),
  "--mac",
]);
