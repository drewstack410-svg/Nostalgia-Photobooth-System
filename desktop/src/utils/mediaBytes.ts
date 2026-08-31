/**
 * Turn a blob:, data:, or http(s) media URL into raw bytes for Electron
 * IPC. Highlight clips are object URLs, not data: URLs — parsing only
 * `data:` silently dropped every video on disk and R2.
 */

export type ParsedMediaBytes = {
  bytes: Uint8Array;
  mime: string;
  ext: string;
};

const blobRegistry = new Map<string, Blob>();

/** Prefer this over URL.createObjectURL so save/upload can recover the Blob. */
export function objectUrlFromBlob(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  blobRegistry.set(url, blob);
  return url;
}

export function revokeMediaUrl(url: string) {
  blobRegistry.delete(url);
  if (url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

function mimeToExt(mime: string): string {
  const t = (mime || "").toLowerCase();
  if (t.includes("mp4") || t.includes("m4v") || t.includes("quicktime") || t.includes("avc")) {
    return "mp4";
  }
  if (t.includes("webm")) return "webm";
  if (t.includes("json")) return "json";
  if (t.includes("png")) return "png";
  if (t.includes("gif")) return "gif";
  if (t.includes("webp")) return "webp";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  return "bin";
}

function sniffMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "video/mp4";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return "image/png";
  }
  return null;
}

/** Standalone copy so Electron IPC does not see a view into a detached buffer. */
export function cloneBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function bytesFromBase64(payload: string): Uint8Array {
  const raw = atob(payload);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function mediaUrlToBytes(
  url: string,
): Promise<ParsedMediaBytes | null> {
  if (!url) return null;
  try {
    const registered = blobRegistry.get(url);
    if (registered) {
      const bytes = new Uint8Array(await registered.arrayBuffer());
      if (bytes.byteLength < 32) return null;
      let mime = (registered.type || "").split(";")[0].trim();
      if (!mime || mime === "application/octet-stream") {
        mime = sniffMime(bytes) || "application/octet-stream";
      }
      return { bytes: cloneBytes(bytes), mime, ext: mimeToExt(mime) };
    }

    if (url.startsWith("data:")) {
      const match = /^data:([^,]*),(.*)$/s.exec(url);
      if (!match) return null;
      const meta = match[1];
      const payload = match[2];
      const isBase64 = /;base64$/i.test(meta);
      let mime = (
        meta.replace(/;base64$/i, "").split(";")[0] || ""
      ).trim();
      const bytes = isBase64
        ? bytesFromBase64(payload)
        : new TextEncoder().encode(decodeURIComponent(payload));
      if (!mime || mime === "application/octet-stream") {
        mime = sniffMime(bytes) || mime || "application/octet-stream";
      }
      if (bytes.byteLength < 32) return null;
      return { bytes: cloneBytes(bytes), mime, ext: mimeToExt(mime) };
    }

    const res = await fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 32) {
      console.warn("[mediaBytes] payload too small:", bytes.byteLength);
      return null;
    }
    let mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!mime || mime === "application/octet-stream") {
      mime = sniffMime(bytes) || mime || "application/octet-stream";
    }
    return { bytes: cloneBytes(bytes), mime, ext: mimeToExt(mime) };
  } catch (e) {
    console.warn("[mediaBytes] Could not read media URL:", e);
    return null;
  }
}
