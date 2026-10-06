/**
 * Canon EDSDK is optional. Windows kiosks already have it.
 * On Mac, `npm run canon:edsdk` after you unpack Canon’s Macintosh SDK
 * into desktop/vendor/EDSDKv131830M (see scripts/setup-canon-edsdk.js).
 */
if (process.platform === "win32") process.exit(0);
if (process.env.npm_config_omit && String(process.env.npm_config_omit).includes("optional")) {
  console.log("[preinstall] optional Canon module omitted (webcam until npm run canon:edsdk)");
}
