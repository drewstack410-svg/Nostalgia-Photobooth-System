/**
 * Rasterize public/Logo.svg onto a square cream badge and write the
 * Windows/Electron icon files. The running app and the installer both
 * use the same artwork:
 *   build/icon.ico      — installer, exe, shortcuts, window/taskbar
 *   build/icon.png      — 1024 master
 *   public/icon.ico     — copied next to the renderer for packaging
 *   public/app-icon.png — favicon / fallback PNG
 *
 * Run: node scripts/generate-app-icon.js
 */

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const LOGO = path.join(ROOT, "public", "Logo.svg");
const BUILD = path.join(ROOT, "build");
const CREAM = { r: 251, g: 242, b: 222, alpha: 1 }; // --color-cream
const BROWN = { r: 61, g: 43, b: 31, alpha: 1 }; // --color-brown-dark
/** BMP DIB for small sizes (rcedit / Explorer); PNG only for 256. */
const ICO_BMP_SIZES = [16, 24, 32, 48, 64, 128];
const ICO_PNG_SIZE = 256;

function icoFromImages(entries) {
  const count = entries.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const placed = entries.map((e) => {
    const item = { ...e, offset };
    offset += e.buf.length;
    return item;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(count, 4);
  placed.forEach((e, i) => {
    const p = 6 + i * 16;
    out.writeUInt8(e.size >= 256 ? 0 : e.size, p);
    out.writeUInt8(e.size >= 256 ? 0 : e.size, p + 1);
    out.writeUInt8(0, p + 2);
    out.writeUInt8(0, p + 3);
    out.writeUInt16LE(1, p + 4);
    out.writeUInt16LE(32, p + 6);
    out.writeUInt32LE(e.buf.length, p + 8);
    out.writeUInt32LE(e.offset, p + 12);
  });
  placed.forEach((e) => e.buf.copy(out, e.offset));
  return out;
}

/** 32-bit BGRA DIB (no BMP file header) plus AND mask — Windows ICO format. */
async function bmpDib(pngMaster, size) {
  const { data } = await sharp(pngMaster)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const headerSize = 40;
  const xorSize = size * size * 4;
  const andRow = Math.ceil(size / 32) * 4;
  const andSize = andRow * size;
  const buf = Buffer.alloc(headerSize + xorSize + andSize);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(xorSize, 20);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const si = (srcY * size + x) * 4;
      const di = headerSize + (y * size + x) * 4;
      buf[di] = data[si + 2];
      buf[di + 1] = data[si + 1];
      buf[di + 2] = data[si];
      buf[di + 3] = data[si + 3];
    }
  }
  return buf;
}

function roundedRectSvg(size, radius, fill, stroke, strokeWidth) {
  const f = `rgb(${fill.r},${fill.g},${fill.b})`;
  const s = `rgb(${stroke.r},${stroke.g},${stroke.b})`;
  const inset = strokeWidth / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect x="${inset}" y="${inset}" width="${size - strokeWidth}" height="${size - strokeWidth}"
        rx="${radius}" ry="${radius}" fill="${f}" stroke="${s}" stroke-width="${strokeWidth}"/>
    </svg>`,
  );
}

async function main() {
  if (!fs.existsSync(LOGO)) {
    throw new Error(`Missing logo: ${LOGO}`);
  }
  fs.mkdirSync(BUILD, { recursive: true });

  const MASTER = 1024;
  const pad = Math.round(MASTER * 0.11);
  const stroke = Math.round(MASTER * 0.045);
  const radius = Math.round(MASTER * 0.18);
  const badge = await sharp(
    roundedRectSvg(MASTER, radius, CREAM, BROWN, stroke),
  )
    .png()
    .toBuffer();

  const logoSvg = fs.readFileSync(LOGO);
  const logoPng = new Resvg(logoSvg, {
    fitTo: { mode: "width", value: MASTER - pad * 2 },
  })
    .render()
    .asPng();
  const logoMeta = await sharp(logoPng).metadata();
  const logoH = logoMeta.height || 1;
  const logoW = logoMeta.width || 1;
  const maxH = MASTER - pad * 2;
  let wordmark = logoPng;
  let w = logoW;
  let h = logoH;
  if (logoH > maxH) {
    h = maxH;
    w = Math.round((logoW * maxH) / logoH);
    wordmark = await sharp(logoPng).resize(w, h).png().toBuffer();
  }
  const left = Math.round((MASTER - w) / 2);
  const top = Math.round((MASTER - h) / 2);

  const masterPng = await sharp(badge)
    .composite([{ input: wordmark, left, top }])
    .png()
    .toBuffer();

  await sharp(masterPng).toFile(path.join(BUILD, "icon.png"));
  await sharp(masterPng)
    .resize(256, 256)
    .png()
    .toFile(path.join(ROOT, "public", "app-icon.png"));

  const icoParts = [];
  for (const size of ICO_BMP_SIZES) {
    icoParts.push({ size, buf: await bmpDib(masterPng, size) });
  }
  icoParts.push({
    size: ICO_PNG_SIZE,
    buf: await sharp(masterPng).resize(ICO_PNG_SIZE, ICO_PNG_SIZE).png().toBuffer(),
  });
  const ico = icoFromImages(icoParts);
  fs.writeFileSync(path.join(BUILD, "icon.ico"), ico);
  fs.writeFileSync(path.join(ROOT, "public", "icon.ico"), ico);

  console.log(
    "[icon] wrote build/icon.ico, build/icon.png, public/icon.ico, public/app-icon.png",
  );
}

main().catch((e) => {
  console.error("[icon]", e);
  process.exit(1);
});
