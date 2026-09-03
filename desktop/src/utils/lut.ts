/**
 * 3D LUT (.cube file) parser and applicator.
 * Supports 64³ LUTs (standard photobooth/cinema color grading LUTs).
 * Uses trilinear interpolation for accurate per-pixel color mapping.
 */

export interface ParsedLut {
  size: number;
  /** Flat Float32Array: index = (r + g*size + b*size²) * 3, values in [0,1] */
  data: Float32Array;
}

/** In-memory cache: cubeData key → parsed LUT */
const lutCache = new Map<string, ParsedLut>();

/**
 * Parse the text content of a .cube file into a usable LUT structure.
 */
export function parseCubeText(text: string): ParsedLut {
  const lines = text.split('\n');
  let size = 0;
  const entries: number[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('LUT_3D_SIZE')) {
      size = parseInt(trimmed.split(/\s+/)[1], 10);
      continue;
    }
    // Skip other header keywords (TITLE, DOMAIN_MIN, DOMAIN_MAX, etc.)
    if (/^[A-Z_]+(\s|$)/.test(trimmed)) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      entries.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
    }
  }

  if (size === 0 || entries.length === 0) {
    throw new Error('Invalid .cube file: missing LUT_3D_SIZE or data entries');
  }

  return { size, data: new Float32Array(entries) };
}

/**
 * Load and parse a LUT.
 * - If cubeData starts with '/', treat it as a URL and fetch the file.
 * - Otherwise treat cubeData as the raw .cube file text.
 * Results are cached by key so each LUT is only parsed once.
 */
export async function loadLut(cubeData: string): Promise<ParsedLut> {
  const cacheKey = cubeData.startsWith('/')
    ? cubeData
    : `${cubeData.length}:${cubeData.slice(0, 64)}:${cubeData.slice(-64)}`;

  if (lutCache.has(cacheKey)) {
    return lutCache.get(cacheKey)!;
  }

  let text: string;
  if (cubeData.startsWith('/') || cubeData.startsWith('http')) {
    const res = await fetch(cubeData);
    if (!res.ok) throw new Error(`Failed to fetch LUT: ${cubeData} (${res.status})`);
    text = await res.text();
  } else {
    text = cubeData;
  }

  const lut = parseCubeText(text);
  lutCache.set(cacheKey, lut);
  console.log(`[LUT] Loaded: size=${lut.size}³, entries=${lut.data.length / 3}`);
  return lut;
}

/**
 * Apply a 3D LUT to ImageData in-place using trilinear interpolation.
 * Modifies the R, G, B channels; leaves alpha unchanged.
 */
export function applyLutToImageData(imageData: ImageData, lut: ParsedLut): void {
  const { size, data } = lut;
  const pixels = imageData.data;
  const s = size - 1;       // max index
  const s2 = size * size;   // stride for blue axis

  for (let i = 0; i < pixels.length; i += 4) {
    // Normalize pixel values to LUT coordinate space
    const ri = (pixels[i]     / 255) * s;
    const gi = (pixels[i + 1] / 255) * s;
    const bi = (pixels[i + 2] / 255) * s;

    // Integer floor/ceil for trilinear corners
    const r0 = ri | 0; const r1 = r0 < s ? r0 + 1 : s;
    const g0 = gi | 0; const g1 = g0 < s ? g0 + 1 : s;
    const b0 = bi | 0; const b1 = b0 < s ? b0 + 1 : s;

    // Fractional parts for interpolation weights
    const rf = ri - r0;
    const gf = gi - g0;
    const bf = bi - b0;

    // Base indices into the flat LUT array (×3 for RGB)
    const i000 = (r0 + g0 * size + b0 * s2) * 3;
    const i100 = (r1 + g0 * size + b0 * s2) * 3;
    const i010 = (r0 + g1 * size + b0 * s2) * 3;
    const i110 = (r1 + g1 * size + b0 * s2) * 3;
    const i001 = (r0 + g0 * size + b1 * s2) * 3;
    const i101 = (r1 + g0 * size + b1 * s2) * 3;
    const i011 = (r0 + g1 * size + b1 * s2) * 3;
    const i111 = (r1 + g1 * size + b1 * s2) * 3;

    // Trilinear interpolation per channel (R=0, G=1, B=2)
    for (let c = 0; c < 3; c++) {
      const c00 = data[i000 + c] + (data[i100 + c] - data[i000 + c]) * rf;
      const c10 = data[i010 + c] + (data[i110 + c] - data[i010 + c]) * rf;
      const c01 = data[i001 + c] + (data[i101 + c] - data[i001 + c]) * rf;
      const c11 = data[i011 + c] + (data[i111 + c] - data[i011 + c]) * rf;
      const c0  = c00 + (c10 - c00) * gf;
      const c1  = c01 + (c11 - c01) * gf;
      pixels[i + c] = Math.round((c0 + (c1 - c0) * bf) * 255);
    }
  }
}
