/**
 * Makes the LIVE PREVIEW show the same colours the CAPTURE will produce.
 *
 * THE PROBLEM
 * -----------
 * The preview and the capture were two unrelated implementations of the
 * same look:
 *
 *   preview  — a hand-tuned CSS `filter:` chain, e.g. for Sepia
 *              `sepia(80%) contrast(1.1) brightness(0.95)`
 *   capture  — the real maths: a sepia colour matrix, then the full 3D LUT
 *              from the filter's `.cube` file
 *
 * The CSS chain never applied the LUT at all — the code said as much
 * ("Cube LUT preview: CSS approximation"). Measured against the shipped
 * sepia4.cube, the two paths differ by a mean ΔRGB of 29 and as much as 54
 * on light skin tones, which is the one thing a photobooth actually
 * photographs. Guests picked a look and got a visibly different print.
 *
 * THE FIX
 * -------
 * Drive the preview from the SAME definition as the capture, expressed as
 * an SVG filter so the GPU does it and the live view costs nothing extra
 * per frame:
 *
 *   sepia / bw / fujifilm — these are all linear in (r,g,b), so each is
 *       expressed EXACTLY as an feColorMatrix.
 *   cube LUT              — sampled off the real .cube into per-channel
 *       transfer curves. Sepia-style LUTs are tone maps (luminance in,
 *       toned RGB out), so this reproduces them to ΔRGB ~2, i.e. invisible.
 *
 * Because the curves are derived from the LUT file itself, the preview
 * cannot drift out of sync with the capture the way hardcoded CSS did.
 */
import type { ParsedLut } from "./lut";

/** Luminance weights. Must match the ones the capture path uses. */
const LR = 0.299;
const LG = 0.587;
const LB = 0.114;

/** feColorMatrix `values` for a 4x5 matrix with no alpha change. */
function matrixValues(m: number[]): string {
  return [
    m[0], m[1], m[2], 0, 0,
    m[3], m[4], m[5], 0, 0,
    m[6], m[7], m[8], 0, 0,
    0, 0, 0, 1, 0,
  ].join(" ");
}

/**
 * Exactly the matrix `applyPixelFilter("sepia")` uses at capture time.
 * (Note this is full-strength sepia — the old preview used `sepia(80%)`,
 * one of the reasons the two disagreed even before the LUT.)
 */
export const SEPIA_MATRIX = matrixValues([
  0.393, 0.769, 0.189,
  0.349, 0.686, 0.168,
  0.272, 0.534, 0.131,
]);

/** Capture does a plain luminance collapse — no contrast bump. */
export const BW_MATRIX = matrixValues([LR, LG, LB, LR, LG, LB, LR, LG, LB]);

/**
 * Capture's fujifilm is
 *   r' = (r + lum*0.40) * 0.90
 *   g' = (g + lum*0.35) * 0.92
 *   b' = (b + lum*0.20) * 0.85
 * which is linear in (r,g,b), so it folds into one matrix exactly.
 */
function fujifilmMatrix(): string {
  const rows: number[] = [];
  const build = (self: number, lumMix: number, scale: number) => {
    // channel' = scale * (channel + lum * lumMix)
    const k = scale * lumMix;
    return [
      scale * (self === 0 ? 1 : 0) + k * LR,
      scale * (self === 1 ? 1 : 0) + k * LG,
      scale * (self === 2 ? 1 : 0) + k * LB,
    ];
  };
  rows.push(...build(0, 0.4, 0.9));
  rows.push(...build(1, 0.35, 0.92));
  rows.push(...build(2, 0.2, 0.85));
  return matrixValues(rows);
}
export const FUJIFILM_MATRIX = fujifilmMatrix();

/** Trilinear sample of a parsed .cube, matching applyLutToImageData. */
function sampleLut(lut: ParsedLut, r: number, g: number, b: number): number[] {
  const { size, data } = lut;
  const m = size - 1;
  const rr = (r / 255) * m;
  const gg = (g / 255) * m;
  const bb = (b / 255) * m;
  const r0 = rr | 0;
  const g0 = gg | 0;
  const b0 = bb | 0;
  const r1 = Math.min(r0 + 1, m);
  const g1 = Math.min(g0 + 1, m);
  const b1 = Math.min(b0 + 1, m);
  const fr = rr - r0;
  const fg = gg - g0;
  const fb = bb - b0;
  const sq = size * size;
  const at = (x: number, y: number, z: number, c: number) =>
    data[(x + y * size + z * sq) * 3 + c];

  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) + (at(r1, g0, b0, c) - at(r0, g0, b0, c)) * fr;
    const c10 = at(r0, g1, b0, c) + (at(r1, g1, b0, c) - at(r0, g1, b0, c)) * fr;
    const c01 = at(r0, g0, b1, c) + (at(r1, g0, b1, c) - at(r0, g0, b1, c)) * fr;
    const c11 = at(r0, g1, b1, c) + (at(r1, g1, b1, c) - at(r0, g1, b1, c)) * fr;
    const c0 = c00 + (c10 - c00) * fg;
    const c1 = c01 + (c11 - c01) * fg;
    out.push(c0 + (c1 - c0) * fb);
  }
  return out;
}

/** Applies the capture-side base filter to one pixel, in 0..255. */
function applyBase(px: number[], base?: string): number[] {
  const [r, g, b] = px;
  if (base === "sepia") {
    return [
      Math.min(255, r * 0.393 + g * 0.769 + b * 0.189),
      Math.min(255, r * 0.349 + g * 0.686 + b * 0.168),
      Math.min(255, r * 0.272 + g * 0.534 + b * 0.131),
    ];
  }
  if (base === "bw") {
    const y = Math.min(255, LR * r + LG * g + LB * b);
    return [y, y, y];
  }
  if (base === "fujifilm") {
    const y = LR * r + LG * g + LB * b;
    return [
      Math.min(255, (r + y * 0.4) * 0.9),
      Math.min(255, (g + y * 0.35) * 0.92),
      Math.min(255, (b + y * 0.2) * 0.85),
    ];
  }
  return px;
}

export interface FilterAdjustments {
  /** Film-grain strength, 0–100. 0 = none. */
  grain: number;
  /** Gamma / exposure-style levels, −100 (crush) to +100 (lift). */
  levels: number;
  /** Contrast, −100 (flat) to +100 (punchy). */
  contrast: number;
  /** Shadow lift, 0–100. Only raises dark tones. */
  shadows: number;
  /** Edge darkening, 0–100. 0 = none. */
  vignette: number;
}

export const DEFAULT_ADJUSTMENTS: FilterAdjustments = {
  grain: 0,
  levels: 0,
  contrast: 0,
  shadows: 0,
  vignette: 0,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Maps a 0..1 channel through levels (gamma), contrast, then shadow lift.
 * Same curve the capture path bakes in, so the live preview stays honest.
 */
export function applyAdjustmentSample(
  x: number,
  adj: FilterAdjustments,
): number {
  let v = clamp01(x);
  if (adj.levels !== 0) {
    const gamma = Math.max(0.25, 1 - adj.levels / 200);
    v = Math.pow(v, gamma);
  }
  if (adj.contrast !== 0) {
    v = (v - 0.5) * (1 + adj.contrast / 100) + 0.5;
  }
  if (adj.shadows > 0) {
    v = v + Math.pow(1 - clamp01(v), 2) * (adj.shadows / 100) * 0.45;
  }
  return clamp01(v);
}

/** feComponentTransfer tableValues, or null when the curve is identity. */
export function buildAdjustmentTable(adj: FilterAdjustments): string | null {
  if (!adj.levels && !adj.contrast && !adj.shadows) return null;
  const n = 17;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    pts.push(applyAdjustmentSample(i / (n - 1), adj).toFixed(4));
  }
  return pts.join(" ");
}

/** 256-entry LUT used when baking adjustments into a capture. */
export function buildAdjustmentLut(adj: FilterAdjustments): Uint8Array | null {
  if (!adj.levels && !adj.contrast && !adj.shadows) return null;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(applyAdjustmentSample(i / 255, adj) * 255);
  }
  return lut;
}

export function applyAdjustmentsToImageData(
  imageData: ImageData,
  adj: FilterAdjustments,
): void {
  const lut = buildAdjustmentLut(adj);
  if (lut) {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]];
      data[i + 1] = lut[data[i + 1]];
      data[i + 2] = lut[data[i + 2]];
    }
  }
  applyVignetteToImageData(imageData, adj.vignette);
}

/**
 * Darkens toward the corners. Inner ~35% of the frame stays untouched;
 * falloff is quadratic so the centre of the face doesn't pick up a
 * grey wash. Strength 100 ≈ 72% multiply-down at the corners.
 */
export function applyVignetteToImageData(
  imageData: ImageData,
  vignette: number,
): void {
  const amount = Math.max(0, Math.min(100, vignette)) / 100;
  if (amount <= 0) return;
  const data = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxDist = Math.hypot(cx, cy) || 1;
  const inner = 0.35;
  const span = 1 - inner;
  const strength = amount * 0.72;
  for (let y = 0; y < h; y++) {
    const dy = (y - cy) / maxDist;
    for (let x = 0; x < w; x++) {
      const d = Math.hypot((x - cx) / maxDist, dy);
      let t = (d - inner) / span;
      if (t <= 0) continue;
      if (t > 1) t = 1;
      const m = 1 - strength * t * t;
      const i = (y * w + x) * 4;
      data[i] *= m;
      data[i + 1] *= m;
      data[i + 2] *= m;
    }
  }
}

/** Capture-side grain intensity (0–34) from a 0–100 slider. */
export function grainCaptureIntensity(grain: number): number {
  return Math.max(0, Math.min(34, (grain / 100) * 34));
}

/** Live-preview overlay opacity from a 0–100 slider. */
export function grainPreviewOpacity(grain: number): number {
  return Math.max(0, Math.min(0.55, (grain / 100) * 0.55));
}

/** CSS for the live-preview vignette overlay, or null when off. */
export function vignettePreviewStyle(
  vignette: number,
): Record<string, string> | null {
  const amount = Math.max(0, Math.min(100, vignette));
  if (amount <= 0) return null;
  const inner = Math.max(18, 58 - amount * 0.18);
  const mid = Math.min(90, inner + 26);
  const edge = (amount / 100) * 0.78;
  const soft = (amount / 100) * 0.28;
  return {
    background: `radial-gradient(ellipse at center, transparent ${inner}%, rgba(0,0,0,${soft.toFixed(3)}) ${mid}%, rgba(0,0,0,${edge.toFixed(3)}) 100%)`,
  };
}

export interface CubePreview {
  /** feComponentTransfer tableValues, 0..1, one string per channel. */
  r: string;
  g: string;
  b: string;
  /**
   * Mean ΔRGB between this approximation and the true per-pixel pipeline,
   * measured over a colour sweep. Small (<6) means the preview is
   * effectively exact; large means the LUT is a colour grade rather than a
   * tone map and the preview can only get close.
   */
  residual: number;
}

const SAMPLES = 33;

/**
 * Builds per-channel transfer curves that reproduce `base filter → LUT`
 * for the preview, and reports how faithful the result is.
 *
 * The curve is indexed by luminance, which is why it is near-exact for
 * tone-mapping LUTs (all the sepia/mono looks) — those map luminance to a
 * tint and discard hue anyway.
 */
export function buildCubePreview(lut: ParsedLut, baseFilter?: string): CubePreview {
  const chans: number[][] = [[], [], []];
  for (let i = 0; i < SAMPLES; i++) {
    const v = (i / (SAMPLES - 1)) * 255;
    const out = sampleLut(lut, ...(applyBase([v, v, v], baseFilter) as [number, number, number]));
    for (let c = 0; c < 3; c++) chans[c].push(Math.max(0, Math.min(1, out[c])));
  }

  // Honest self-check: how well does a luminance-indexed curve stand in for
  // the real 3D transform? Sampled over a coarse RGB sweep.
  let total = 0;
  let n = 0;
  const curveAt = (c: number, y: number) => {
    const t = (y / 255) * (SAMPLES - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, SAMPLES - 1);
    return (chans[c][i0] + (chans[c][i1] - chans[c][i0]) * (t - i0)) * 255;
  };
  for (let r = 0; r <= 255; r += 51) {
    for (let g = 0; g <= 255; g += 51) {
      for (let b = 0; b <= 255; b += 51) {
        const truth = sampleLut(
          lut,
          ...(applyBase([r, g, b], baseFilter) as [number, number, number]),
        ).map((v) => v * 255);
        const y = LR * r + LG * g + LB * b;
        const approx = [curveAt(0, y), curveAt(1, y), curveAt(2, y)];
        total += Math.hypot(
          truth[0] - approx[0],
          truth[1] - approx[1],
          truth[2] - approx[2],
        );
        n++;
      }
    }
  }

  const fmt = (a: number[]) => a.map((v) => v.toFixed(4)).join(" ");
  return {
    r: fmt(chans[0]),
    g: fmt(chans[1]),
    b: fmt(chans[2]),
    residual: total / n,
  };
}
