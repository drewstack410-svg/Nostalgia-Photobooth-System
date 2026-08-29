/**
 * PNG frame alpha — imported layouts are often authored on a white
 * canvas, so "empty" gutters land as opaque #FFFFFF instead of holes.
 * Near-white pixels are knocked out to true transparency so only the
 * layout's real ink (black film, hearts, borders) sits on the page.
 *
 * Cream/beige film stock is left alone: it is warm (wide RGB spread),
 * not a neutral white.
 */

const WHITE_MIN = 238;
const WHITE_CHROMA = 18;

function isKnockoutWhite(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= WHITE_MIN && max - min <= WHITE_CHROMA;
}

/** Sets near-white opaque pixels to alpha 0. Returns whether anything changed. */
export function knockoutWhiteToTransparent(imageData: ImageData): boolean {
  const d = imageData.data;
  let changed = false;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (isKnockoutWhite(d[i]!, d[i + 1]!, d[i + 2]!)) {
      d[i + 3] = 0;
      changed = true;
    }
  }
  return changed;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`frame image failed to load: ${src}`));
    img.src = src;
  });
}

const canvasCache = new Map<string, Promise<HTMLCanvasElement>>();
const dataUrlCache = new Map<string, Promise<string>>();

/**
 * Raster of a frame PNG with authored-white knocked out to alpha.
 * Cached per source URL / data URL.
 */
export function prepareFrameCanvas(src: string): Promise<HTMLCanvasElement> {
  const hit = canvasCache.get(src);
  if (hit) return hit;
  const pending = (async () => {
    const img = await loadImage(src);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return canvas;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (knockoutWhiteToTransparent(data)) ctx.putImageData(data, 0, 0);
    return canvas;
  })();
  canvasCache.set(src, pending);
  return pending;
}

/** Same knockout, as a PNG data URL for <img src>. */
export function prepareFrameDataUrl(src: string): Promise<string> {
  const hit = dataUrlCache.get(src);
  if (hit) return hit;
  const pending = prepareFrameCanvas(src).then((c) => c.toDataURL("image/png"));
  dataUrlCache.set(src, pending);
  return pending;
}

/** Paint an opaque colour behind remaining transparent pixels (printers). */
export function flattenTransparentToColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color = "#ffffff",
): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

export function flattenPngDataUrlToWhite(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 1;
      c.height = img.naturalHeight || 1;
      const cx = c.getContext("2d");
      if (!cx) {
        resolve(dataUrl);
        return;
      }
      cx.drawImage(img, 0, 0);
      flattenTransparentToColor(cx, c.width, c.height, "#ffffff");
      resolve(c.toDataURL("image/png", 0.95));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
