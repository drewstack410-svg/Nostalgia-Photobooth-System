/**
 * Spatial Lightroom settings that cannot live in a 3D LUT
 * (neighbourhood filters: local contrast, sharpen, NR, lens).
 */
import { imageDataRGBA } from "stackblur-canvas";

export type LrSpatialLook = {
  texture: number;
  clarity: number;
  sharpen: number;
  sharpenRadius: number;
  sharpenDetail: number;
  sharpenMasking: number;
  luminanceNR: number;
  colorNR: number;
  distortion: number;
  caRed: number;
  caBlue: number;
  vignetteMidpoint: number;
  vignetteFeather: number;
  vignetteRoundness: number;
  grainSize: number;
  grainFreq: number;
};

export function parseLrSpatial(raw: unknown): LrSpatialLook | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const n = (k: string, fallback = 0) => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const look: LrSpatialLook = {
    texture: n("texture"),
    clarity: n("clarity"),
    sharpen: n("sharpen"),
    sharpenRadius: n("sharpenRadius", 1),
    sharpenDetail: n("sharpenDetail", 25),
    sharpenMasking: n("sharpenMasking"),
    luminanceNR: n("luminanceNR"),
    colorNR: n("colorNR"),
    distortion: n("distortion"),
    caRed: n("caRed"),
    caBlue: n("caBlue"),
    vignetteMidpoint: n("vignetteMidpoint", 50),
    vignetteFeather: n("vignetteFeather", 50),
    vignetteRoundness: n("vignetteRoundness"),
    grainSize: n("grainSize", 25),
    grainFreq: n("grainFreq", 50),
  };
  const used =
    Math.abs(look.texture) > 0.01 ||
    Math.abs(look.clarity) > 0.01 ||
    Math.abs(look.sharpen) > 0.01 ||
    Math.abs(look.sharpenRadius - 1) > 0.01 ||
    Math.abs(look.sharpenDetail - 25) > 0.01 ||
    Math.abs(look.sharpenMasking) > 0.01 ||
    Math.abs(look.luminanceNR) > 0.01 ||
    Math.abs(look.colorNR) > 0.01 ||
    Math.abs(look.distortion) > 0.01 ||
    Math.abs(look.caRed) > 0.01 ||
    Math.abs(look.caBlue) > 0.01 ||
    Math.abs(look.vignetteMidpoint - 50) > 0.5 ||
    Math.abs(look.vignetteFeather - 50) > 0.5 ||
    Math.abs(look.vignetteRoundness) > 0.01 ||
    Math.abs(look.grainSize - 25) > 0.5 ||
    Math.abs(look.grainFreq - 50) > 0.5;
  return used ? look : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function cloneImageData(src: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

function blurCopy(src: ImageData, radius: number): ImageData {
  const out = cloneImageData(src);
  const r = Math.max(1, Math.round(radius));
  imageDataRGBA(out, 0, 0, src.width, src.height, r);
  return out;
}

/** Unsharp mask: out = src + amount * (src - blur), with optional threshold. */
function unsharp(
  imageData: ImageData,
  radius: number,
  amount: number,
  threshold: number,
): void {
  if (Math.abs(amount) < 0.002 || radius < 0.4) return;
  const blur = blurCopy(imageData, radius);
  const a = imageData.data;
  const b = blur.data;
  const thr = Math.max(0, threshold);
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c]! - b[i + c]!;
      if (Math.abs(d) < thr) continue;
      a[i + c] = clamp(a[i + c]! + d * amount, 0, 255);
    }
  }
}

function lumaAt(data: Uint8ClampedArray, i: number): number {
  return 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
}

function applyNoiseReduction(
  imageData: ImageData,
  lumaAmt: number,
  chromaAmt: number,
): void {
  if (lumaAmt <= 0.5 && chromaAmt <= 0.5) return;
  const lumaR = 1 + (lumaAmt / 100) * 3;
  const chromaR = 1 + (chromaAmt / 100) * 5;
  const lumaBlur = lumaAmt > 0.5 ? blurCopy(imageData, lumaR) : null;
  const chromaBlur = chromaAmt > 0.5 ? blurCopy(imageData, chromaR) : null;
  const a = imageData.data;
  const lm = lumaAmt / 100;
  const cm = chromaAmt / 100;
  for (let i = 0; i < a.length; i += 4) {
    const r = a[i]!;
    const g = a[i + 1]!;
    const b = a[i + 2]!;
    const y = lumaAt(a, i);
    let nr = r;
    let ng = g;
    let nb = b;
    if (lumaBlur) {
      const by = lumaAt(lumaBlur.data, i);
      const y2 = y * (1 - lm * 0.85) + by * lm * 0.85;
      const scale = y > 1e-3 ? y2 / y : 1;
      nr *= scale;
      ng *= scale;
      nb *= scale;
    }
    if (chromaBlur) {
      const cr = chromaBlur.data[i]!;
      const cg = chromaBlur.data[i + 1]!;
      const cb = chromaBlur.data[i + 2]!;
      const cy = lumaAt(chromaBlur.data, i);
      const yKeep = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
      nr = yKeep + (cr - cy) * cm + (nr - yKeep) * (1 - cm);
      ng = yKeep + (cg - cy) * cm + (ng - yKeep) * (1 - cm);
      nb = yKeep + (cb - cy) * cm + (nb - yKeep) * (1 - cm);
    }
    a[i] = clamp(nr, 0, 255);
    a[i + 1] = clamp(ng, 0, 255);
    a[i + 2] = clamp(nb, 0, 255);
  }
}

function sampleBilinear(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  c: number,
): number {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - Math.floor(x);
  const fy = y - Math.floor(y);
  const i00 = (y0 * w + x0) * 4 + c;
  const i10 = (y0 * w + x1) * 4 + c;
  const i01 = (y1 * w + x0) * 4 + c;
  const i11 = (y1 * w + x1) * 4 + c;
  return (
    data[i00]! * (1 - fx) * (1 - fy) +
    data[i10]! * fx * (1 - fy) +
    data[i01]! * (1 - fx) * fy +
    data[i11]! * fx * fy
  );
}

function applyDistortionAndCA(
  imageData: ImageData,
  distortion: number,
  caRed: number,
  caBlue: number,
): void {
  if (
    Math.abs(distortion) < 0.5 &&
    Math.abs(caRed) < 0.5 &&
    Math.abs(caBlue) < 0.5
  ) {
    return;
  }
  const w = imageData.width;
  const h = imageData.height;
  const src = new Uint8ClampedArray(imageData.data);
  const dst = imageData.data;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  const k = (distortion / 100) * 0.35;
  const kr = 1 + (caRed / 100) * 0.02;
  const kb = 1 + (caBlue / 100) * 0.02;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / maxR;
      const dy = (y - cy) / maxR;
      const r2 = dx * dx + dy * dy;
      const barrel = 1 + k * r2;
      const sx = cx + dx * maxR * barrel;
      const sy = cy + dy * maxR * barrel;
      const i = (y * w + x) * 4;
      dst[i] = sampleBilinear(src, w, h, cx + (sx - cx) * kr, sy, 0);
      dst[i + 1] = sampleBilinear(src, w, h, sx, sy, 1);
      dst[i + 2] = sampleBilinear(src, w, h, cx + (sx - cx) * kb, sy, 2);
    }
  }
}

export function hasLrSpatialWork(look: LrSpatialLook | null | undefined): boolean {
  return !!parseLrSpatial(look);
}

export function applyLightroomLensToImageData(
  imageData: ImageData,
  look: LrSpatialLook | null | undefined,
): void {
  if (!look) return;
  applyDistortionAndCA(imageData, look.distortion, look.caRed, look.caBlue);
}

/**
 * Texture / clarity / NR / sharpen after the colour LUT.
 */
export function applyLightroomDetailToImageData(
  imageData: ImageData,
  look: LrSpatialLook | null | undefined,
): void {
  if (!look) return;
  const minEdge = Math.min(imageData.width, imageData.height);

  if (Math.abs(look.texture) > 0.5) {
    unsharp(imageData, 1.6, (look.texture / 100) * 0.55, 2);
  }
  if (Math.abs(look.clarity) > 0.5) {
    const radius = Math.max(6, minEdge * 0.028);
    unsharp(imageData, radius, (look.clarity / 100) * 0.48, 1);
  }

  applyNoiseReduction(imageData, look.luminanceNR, look.colorNR);

  if (look.sharpen > 0.5) {
    const radius = clamp(look.sharpenRadius || 1, 0.5, 3.5);
    const amount = (look.sharpen / 150) * (0.55 + look.sharpenDetail / 200);
    const mask = (look.sharpenMasking / 100) * 18;
    unsharp(imageData, radius, amount, mask);
  }
}

export function applyLightroomSpatialToImageData(
  imageData: ImageData,
  look: LrSpatialLook | null | undefined,
): void {
  applyLightroomLensToImageData(imageData, look);
  applyLightroomDetailToImageData(imageData, look);
}
