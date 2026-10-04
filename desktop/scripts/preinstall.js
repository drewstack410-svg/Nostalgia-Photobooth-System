/**
 * Canon EDSDK (`napi-canon-cameras`) only builds on Windows with the
 * SDK present. On macOS it looks for EDSDK.Framework and fails npm install.
 * That package is optional — Mac booths use the webcam.
 */
if (process.platform === "win32") process.exit(0);
console.log(
  "[preinstall] Canon EDSDK is Windows-only. On Mac run:\n" +
    "  npm install --omit=optional\n" +
    "(or: npm run install:mac)",
);
