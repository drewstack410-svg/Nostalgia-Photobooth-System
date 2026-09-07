/**
 * Chromium on Windows will not decode a QuickTime container (`ftypqt  `)
 * even when the blob is tagged video/mp4. Many operator overlays are
 * H.264 .mov files from Photoshop / After Effects / iPhone.
 *
 * Rewriting the ftyp brands to ISO-BMFF (`isom` / `mp41`) is enough for
 * those files to play. ProRes / Animation MOVs still cannot play — those
 * need an H.264 MP4 or WebM export.
 */
function brandsAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function writeBrand(bytes: Uint8Array, offset: number, brand: string) {
  bytes[offset] = brand.charCodeAt(0);
  bytes[offset + 1] = brand.charCodeAt(1);
  bytes[offset + 2] = brand.charCodeAt(2);
  bytes[offset + 3] = brand.charCodeAt(3);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function isIsoBmff(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

export function normalizeQuicktimeToMp4(input: Uint8Array): Uint8Array {
  if (!isIsoBmff(input)) return input;
  const size = readU32(input, 0);
  if (size < 16 || size > input.length) return input;

  const major = brandsAt(input, 8);
  let hasQtBrand = major === "qt  ";
  for (let i = 16; i + 4 <= size; i += 4) {
    if (brandsAt(input, i) === "qt  ") hasQtBrand = true;
  }
  if (!hasQtBrand) return input;

  const out = new Uint8Array(input);
  writeBrand(out, 8, "isom");
  for (let i = 16; i + 4 <= size; i += 4) {
    if (brandsAt(out, i) === "qt  ") writeBrand(out, i, "mp41");
  }
  return out;
}

export function playbackMimeForOverlayVideo(
  filename?: string,
  mime?: string,
): string {
  const name = filename || "";
  const type = (mime || "").toLowerCase();
  if (/\.webm$/i.test(name) || type.includes("webm")) return "video/webm";
  return "video/mp4";
}
