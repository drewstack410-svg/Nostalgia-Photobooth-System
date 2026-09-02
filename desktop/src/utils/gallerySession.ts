/** Short guest-gallery codes and the R2 manifest the public site fetches. */

import { uploadToR2 } from "@/services/r2";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function makeGalleryShortCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** QR target: gallery page + `?s=` only — no photo/video keys in the link. */
export function buildShortGalleryUrl(shortCode: string): string {
  const raw = (
    import.meta.env.VITE_GALLERY_BASE_URL ||
    `${window.location.origin}/gallery/`
  ).replace(/\/+$/, "");
  return `${raw}/?s=${encodeURIComponent(shortCode)}`;
}

export type GalleryManifest = {
  v: 1;
  title: string;
  /** Viewfinder-cropped stills (Grid tab / print-matching). */
  ids: string[];
  /** Full uncropped stills for the gallery download row. */
  fullIds?: string[];
  print?: string;
  /** Framed strip highlight (and fallback clips). */
  vids?: string[];
  /** Per-shot uncropped highlight clips. */
  fullVids?: string[];
  slots?: string;
  par?: string;
  /** Template occupancy — gallery Grid tab uses these, not a guess from photo count. */
  rows?: number;
  cols?: number;
  shots?: number;
};

export function galleryManifestDataUrl(manifest: GalleryManifest): string {
  const json = JSON.stringify(manifest);
  return `data:application/json;base64,${btoa(json)}`;
}

export type GalleryLayoutMeta = {
  slots?: string;
  par?: string;
  rows?: number;
  cols?: number;
  shots?: number;
};

export async function publishGallerySession(opts: {
  shortCode: string;
  publicIds: string[];
  printId?: string;
  videoIds?: string[];
  fullIds?: string[];
  fullVids?: string[];
  layout?: GalleryLayoutMeta;
}): Promise<string> {
  const {
    shortCode,
    publicIds,
    printId,
    videoIds,
    fullIds,
    fullVids,
    layout,
  } = opts;
  if (
    publicIds.length === 0 &&
    !printId &&
    !(videoIds && videoIds.length) &&
    !(fullIds && fullIds.length) &&
    !(fullVids && fullVids.length)
  ) {
    return "";
  }
  const r2Base = (import.meta.env.VITE_R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!r2Base) {
    console.warn("[Gallery] No VITE_R2_PUBLIC_URL set");
    return "";
  }

  const manifest = galleryManifestDataUrl({
    v: 1,
    title: "Nostalgia Photobooth",
    ids: publicIds,
    fullIds: fullIds && fullIds.length ? fullIds : undefined,
    print: printId || undefined,
    vids: videoIds && videoIds.length ? videoIds : undefined,
    fullVids: fullVids && fullVids.length ? fullVids : undefined,
    slots: layout?.slots,
    par: layout?.par,
    rows: layout?.rows,
    cols: layout?.cols,
    shots: layout?.shots,
  });
  const uploaded = await uploadToR2(
    manifest,
    "nostalgia-photobooth",
    `s/${shortCode}`,
  );
  if (!uploaded.success) {
    console.warn("[Gallery] Manifest upload failed:", uploaded.error);
    return "";
  }
  return buildShortGalleryUrl(shortCode);
}
