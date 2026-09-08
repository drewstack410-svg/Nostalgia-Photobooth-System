/**
 * Downscale a (potentially multi-MB) image data URL to a compact JPEG
 * preview.
 *
 * `recentStrips` persists to localStorage (~5–10 MB quota), so any
 * image stored there must pass through this first — a single raw
 * 3600×2400 capture is ~2–5 MB of base64, and one 8-photo session
 * would blow the quota outright. Full-resolution originals live on
 * disk (Pictures/NostalgiaPhotobooth) and on Cloudinary; consumers
 * that need full-res (admin reprint, admin download) re-read the disk
 * file instead of using the stored preview.
 *
 * Returns the ORIGINAL url unchanged if anything goes wrong (decode
 * failure, canvas unavailable) — a preview must never break the flow
 * that requested it.
 */
export function makePreviewDataUrl(
  dataUrl: string,
  maxDim = 1100,
  quality = 0.82,
): Promise<string> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
        const scale = Math.min(1, maxDim / longest);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const cx = c.getContext("2d");
        if (!cx) return resolve(dataUrl);
        cx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch {
      resolve(dataUrl);
    }
  });
}
