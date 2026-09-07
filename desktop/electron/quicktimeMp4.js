/**
 * See src/utils/quicktimeMp4.ts — keep this CJS copy in sync.
 * Chromium will not play `ftypqt  ` blobs on Windows.
 */
function brandsAt(buf, offset) {
  return buf.toString("ascii", offset, offset + 4);
}

function writeBrand(buf, offset, brand) {
  buf.write(brand, offset, 4, "ascii");
}

function normalizeQuicktimeToMp4(input) {
  if (!Buffer.isBuffer(input) || input.length < 16) return input;
  if (input.toString("ascii", 4, 8) !== "ftyp") return input;
  const size = input.readUInt32BE(0);
  if (size < 16 || size > input.length) return input;
  let hasQt = brandsAt(input, 8) === "qt  ";
  for (let i = 16; i + 4 <= size; i += 4) {
    if (brandsAt(input, i) === "qt  ") hasQt = true;
  }
  if (!hasQt) return input;
  const out = Buffer.from(input);
  writeBrand(out, 8, "isom");
  for (let i = 16; i + 4 <= size; i += 4) {
    if (brandsAt(out, i) === "qt  ") writeBrand(out, i, "mp41");
  }
  return out;
}

module.exports = { normalizeQuicktimeToMp4 };
