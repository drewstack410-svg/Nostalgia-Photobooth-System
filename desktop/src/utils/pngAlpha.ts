/**
 * PNG/JPEG frame alpha — imported layouts are often authored on a white
 * canvas, so empty photo WINDOWS land as opaque #FFFFFF instead of holes.
 *
 * Only those windows (and edge-connected sheet background) are knocked
 * out. White ink that is part of the artwork — text, logos, borders,
 * hearts — is left opaque so it shows in the live preview. Cream/beige
 * film stock is left alone: it is warm (wide RGB spread), not a
 * neutral white.
 */

const WHITE_MIN = 238;
const WHITE_CHROMA = 18;
/** Same floor as frameWindows: specks and letterforms are not slots. */
const MIN_WINDOW_AREA_FRACTION = 0.004;
/** File already has real transparent windows — don't eat white artwork. */
const EXISTING_ALPHA_FRACTION = 0.02;
const ALPHA_HOLE = 40;

function isKnockoutWhite(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= WHITE_MIN && max - min <= WHITE_CHROMA;
}

/**
 * Sets photo-window / sheet-background near-white pixels to alpha 0.
 * Small interior white blobs (artwork) stay. Returns whether anything
 * changed.
 */
export function knockoutWhiteToTransparent(imageData: ImageData): boolean {
  const w = imageData.width;
  const h = imageData.height;
  const d = imageData.data;
  const n = w * h;
  if (n < 4) return false;

  const white = new Uint8Array(n);
  let alreadyHole = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (d[p + 3]! <= ALPHA_HOLE) {
      alreadyHole++;
      continue;
    }
    if (isKnockoutWhite(d[p]!, d[p + 1]!, d[p + 2]!)) white[i] = 1;
  }

  if (alreadyHole / n >= EXISTING_ALPHA_FRACTION) return false;

  const seen = new Uint8Array(n);
  const kill = new Uint8Array(n);
  const stack = new Int32Array(n);
  const minArea = n * MIN_WINDOW_AREA_FRACTION;

  const flood = (start: number, applyKill: boolean): number => {
    let sp = 0;
    let area = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const p = stack[--sp]!;
      area++;
      if (applyKill) kill[p] = 1;
      const x = p % w;
      const y = (p / w) | 0;
      const push = (np: number) => {
        if (!seen[np] && white[np]) {
          seen[np] = 1;
          stack[sp++] = np;
        }
      };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    return area;
  };

  const collect = (start: number): number[] => {
    const cells: number[] = [];
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const p = stack[--sp]!;
      cells.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      const push = (np: number) => {
        if (!seen[np] && white[np]) {
          seen[np] = 1;
          stack[sp++] = np;
        }
      };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    return cells;
  };

  // White touching the sheet edge is canvas background, not artwork.
  for (let x = 0; x < w; x++) {
    if (white[x] && !seen[x]) flood(x, true);
    const bottom = (h - 1) * w + x;
    if (white[bottom] && !seen[bottom]) flood(bottom, true);
  }
  for (let y = 0; y < h; y++) {
    const left = y * w;
    if (white[left] && !seen[left]) flood(left, true);
    const right = left + w - 1;
    if (white[right] && !seen[right]) flood(right, true);
  }

  // Interior white: large blobs are photo windows; small ones are ink.
  for (let i = 0; i < n; i++) {
    if (!white[i] || seen[i]) continue;
    const cells = collect(i);
    if (cells.length >= minArea) {
      for (const p of cells) kill[p] = 1;
    }
  }

  let changed = false;
  for (let i = 0, p = 3; i < n; i++, p += 4) {
    if (kill[i]) {
      d[p] = 0;
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
 * Raster of a frame PNG with authored-white windows knocked out to alpha.
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
