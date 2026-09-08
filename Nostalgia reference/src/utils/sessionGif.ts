/**
 * Animated GIF encoder for the session folder.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every session folder is supposed to carry the strip, the individual
 * captures and a GIF. The app had no way to make the GIF: the only encoder
 * in the project is `public/gallery/gif.js`, which belongs to the phone
 * gallery and runs its quantiser in a Web Worker. The kiosk renderer is
 * loaded from `file://` in the packaged build, where `new Worker(...)` is
 * blocked outright — so that encoder cannot be reused here.
 *
 * This is a small, synchronous, dependency-free GIF89a encoder instead.
 *
 * The frames come from one camera under one filter, so a single palette is
 * built across the whole animation rather than per frame — per-frame
 * quantisation makes the colours crawl between frames. Palette is
 * median-cut; the bitstream is standard LZW.
 */

export interface SessionGifOptions {
  /** Longest edge of the output, in px. Frames are cover-fitted to it. */
  maxWidth?: number;
  /** Delay between frames, in milliseconds. */
  delayMs?: number;
  /** Palette size, 2..256. */
  colors?: number;
}

type RGB = [number, number, number];

// ── image loading / scaling ───────────────────────────────────────────
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("sessionGif: could not load a frame"));
    img.src = src;
  });
}

function drawCoverFit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const ia = iw / ih;
  const ca = w / h;
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (ia > ca) {
    sw = ih * ca;
    sx = (iw - sw) / 2;
  } else {
    sh = iw / ca;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

// ── median-cut palette ────────────────────────────────────────────────
/**
 * Samples pixels rather than reading every one — a 480×640 frame is
 * ~300k pixels and a representative spread is all the split needs.
 */
function buildPalette(
  frames: ArrayLike<number>[],
  maxColors: number,
): RGB[] {
  const samples: RGB[] = [];
  const stride = 4 * 7; // odd stride keeps the sample spread even
  for (const d of frames) {
    for (let i = 0; i + 2 < d.length; i += stride) {
      samples.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  if (samples.length === 0) samples.push([0, 0, 0]);

  let boxes: RGB[][] = [samples];
  while (boxes.length < maxColors) {
    // Split whichever box has the widest spread on any channel.
    let target = -1;
    let targetRange = -1;
    let targetAxis = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.length < 2) continue;
      for (let ax = 0; ax < 3; ax++) {
        let lo = 255;
        let hi = 0;
        for (const px of box) {
          const v = px[ax];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > targetRange) {
          targetRange = hi - lo;
          target = b;
          targetAxis = ax;
        }
      }
    }
    if (target < 0 || targetRange <= 0) break;
    const src = boxes[target];
    src.sort((a, b) => a[targetAxis] - b[targetAxis]);
    const mid = src.length >> 1;
    boxes = [
      ...boxes.slice(0, target),
      src.slice(0, mid),
      src.slice(mid),
      ...boxes.slice(target + 1),
    ];
  }

  const palette: RGB[] = [];
  for (const box of boxes) {
    if (!box.length) continue;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const px of box) {
      r += px[0];
      g += px[1];
      b += px[2];
    }
    palette.push([
      Math.round(r / box.length),
      Math.round(g / box.length),
      Math.round(b / box.length),
    ]);
  }
  while (palette.length < 2) palette.push([0, 0, 0]);
  return palette;
}

/** Nearest-palette-entry lookup, memoised on a 6-bit-per-channel key. */
function paletteMapper(palette: RGB[]) {
  const cache = new Map<number, number>();
  return (r: number, g: number, b: number): number => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0];
      const dg = g - p[1];
      const db = b - p[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache.set(key, best);
    return best;
  };
}

// ── byte sink ─────────────────────────────────────────────────────────
class Bytes {
  private buf: number[] = [];
  u8(v: number) {
    this.buf.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >> 8);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes(a: ArrayLike<number>) {
    for (let i = 0; i < a.length; i++) this.u8(a[i]);
  }
  toUint8Array() {
    return new Uint8Array(this.buf);
  }
}

// ── LZW (GIF variant) ─────────────────────────────────────────────────
function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const dict = new Map<number, number>();

  const out: number[] = [];
  let cur = 0;
  let curBits = 0;

  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    dict.set(key, nextCode);
    if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    nextCode++;
    if (nextCode >= 4096) {
      emit(clearCode);
      dict.clear();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) out.push(cur & 0xff);
  return out;
}

function writeSubBlocks(sink: Bytes, data: number[]) {
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255);
    sink.u8(chunk.length);
    sink.bytes(chunk);
  }
  sink.u8(0);
}

// ── assembly (DOM-free, so it can be unit-tested outside a browser) ───
export function encodeFrames(
  frames: ArrayLike<number>[],
  width: number,
  height: number,
  options: SessionGifOptions = {},
): Uint8Array {
  const delayMs = options.delayMs ?? 800;
  const maxColors = Math.max(2, Math.min(256, options.colors ?? 256));
  if (!frames.length) throw new Error("sessionGif: no frames");

  const palette = buildPalette(frames, maxColors);
  const nearest = paletteMapper(palette);

  // GIF colour tables must be a power of two, at least 2 entries.
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const tableSize = 1 << bits;

  const g = new Bytes();
  g.str("GIF89a");
  g.u16(width);
  g.u16(height);
  g.u8(0xf0 | (bits - 1)); // global colour table present, 8-bit resolution
  g.u8(0); // background colour index
  g.u8(0); // pixel aspect ratio
  for (let c = 0; c < tableSize; c++) {
    const p = palette[c] ?? [0, 0, 0];
    g.u8(p[0]);
    g.u8(p[1]);
    g.u8(p[2]);
  }

  // NETSCAPE2.0 loop-forever extension
  g.u8(0x21);
  g.u8(0xff);
  g.u8(11);
  g.str("NETSCAPE2.0");
  g.u8(3);
  g.u8(1);
  g.u16(0);
  g.u8(0);

  const delayCs = Math.max(1, Math.round(delayMs / 10));
  const minCodeSize = Math.max(2, bits);

  for (const d of frames) {
    // Graphic control extension (frame delay)
    g.u8(0x21);
    g.u8(0xf9);
    g.u8(4);
    g.u8(0); // no transparency, no disposal
    g.u16(delayCs);
    g.u8(0);
    g.u8(0);

    // Image descriptor
    g.u8(0x2c);
    g.u16(0);
    g.u16(0);
    g.u16(width);
    g.u16(height);
    g.u8(0); // no local colour table, not interlaced

    const idx = new Uint8Array(width * height);
    for (let q = 0, o = 0; o < idx.length; q += 4, o++) {
      idx[o] = nearest(d[q], d[q + 1], d[q + 2]);
    }

    g.u8(minCodeSize);
    writeSubBlocks(g, lzwEncode(idx, minCodeSize));
  }

  g.u8(0x3b); // trailer
  return g.toUint8Array();
}

/**
 * Builds an animated GIF from the session's captures.
 *
 * @param sources image sources (data URLs) in shooting order
 */
export async function buildSessionGif(
  sources: string[],
  options: SessionGifOptions = {},
): Promise<Uint8Array> {
  const maxWidth = options.maxWidth ?? 480;
  const imgs = await Promise.all(sources.map(loadImage));
  if (!imgs.length) throw new Error("sessionGif: no frames");

  const first = imgs[0];
  const iw = first.naturalWidth || first.width;
  const ih = first.naturalHeight || first.height;
  const scale = Math.min(1, maxWidth / iw);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("sessionGif: no 2d context");

  const frames: Uint8ClampedArray[] = [];
  for (const img of imgs) {
    ctx.clearRect(0, 0, w, h);
    drawCoverFit(ctx, img, w, h);
    frames.push(ctx.getImageData(0, 0, w, h).data);
  }

  return encodeFrames(frames, w, h, options);
}
