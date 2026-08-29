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
  const base = (
    import.meta.env.VITE_GALLERY_BASE_URL ||
    `${window.location.origin}/gallery/`
  ).replace(/\/+$/, "/");
  const url = new URL(base);
  url.searchParams.set("s", shortCode);
  return url.toString();
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
