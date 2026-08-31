/** Short guest-gallery codes and the R2 manifest the public site fetches. */

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
