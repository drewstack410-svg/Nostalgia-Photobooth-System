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

/** QR target: gallery page + short code only — no photo/video keys. */
export function buildShortGalleryUrl(shortCode: string): string {
  const raw = (
    import.meta.env.VITE_GALLERY_BASE_URL ||
    `${window.location.origin}/gallery/`
  ).replace(/\/+$/, "");
  // Local kiosk gallery is /gallery/index.html (relative assets), so
  // keep the code in the query. The Vercel site is the domain root and
  // can use a short path the phone's address bar will actually show.
  if (/\/gallery$/i.test(raw) || /localhost|127\.0\.0\.1/i.test(raw)) {
    return `${raw}/?s=${encodeURIComponent(shortCode)}`;
  }
  return `${raw}/s/${encodeURIComponent(shortCode)}`;
}

export type GalleryManifest = {
  v: 1;
  title: string;
  ids: string[];
  print?: string;
  vids?: string[];
  slots?: string;
  par?: string;
};

export function galleryManifestDataUrl(manifest: GalleryManifest): string {
  const json = JSON.stringify(manifest);
  return `data:application/json;base64,${btoa(json)}`;
}
