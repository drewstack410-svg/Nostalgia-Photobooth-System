/**
 * Lightroom / Camera Raw .xmp → 3D LUT (global colour) plus spatial
 * settings (detail / lens). Neighbourhood tools cannot live in a LUT.
 */

const LUT_SIZE = 25;
const REF_TEMP = 5500;

export type LrToneCurve = { x: number; y: number }[];

export type LrGradeHsl = { h: number; s: number; l: number };

export type LrPreset = {
  name: string;
  grayscale: boolean;
  temperature: number;
  tint: number;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
  curve: LrToneCurve | null;
  curveR: LrToneCurve | null;
  curveG: LrToneCurve | null;
  curveB: LrToneCurve | null;
  paramShadows: number;
  paramDarks: number;
  paramLights: number;
  paramHighlights: number;
  paramShadowSplit: number;
  paramMidSplit: number;
  paramHighlightSplit: number;
  splitShadowHue: number;
  splitShadowSat: number;
  splitHighlightHue: number;
  splitHighlightSat: number;
  splitBalance: number;
  gradeShadow: LrGradeHsl;
  gradeMid: LrGradeHsl;
  gradeHigh: LrGradeHsl;
  gradeGlobal: LrGradeHsl;
  gradeBlending: number;
  gradeBalance: number;
  hslHue: number[];
  hslSat: number[];
  hslLum: number[];
  vignette: number;
  grain: number;
  grainSize: number;
  grainFreq: number;
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
};

const HSL_HUES = [0, 30, 60, 120, 180, 240, 270, 300];
const HSL_WIDTHS = [32, 28, 28, 50, 28, 42, 28, 28];
const HSL_KEYS = [
  "Red",
  "Orange",
  "Yellow",
  "Green",
  "Aqua",
  "Blue",
  "Purple",
  "Magenta",
];

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

function crsHas(xml: string, key: string): boolean {
  return new RegExp(`crs:${key}(?:="|>)`, "i").test(xml);
}

function crsNumber(xml: string, key: string, fallback = 0): number {
  const attr = xml.match(new RegExp(`crs:${key}="([^"]*)"`, "i"));
  const el = xml.match(
    new RegExp(`<crs:${key}(?:\\s[^>]*)?>([^<]*)</crs:${key}>`, "i"),
  );
  const raw = (attr?.[1] ?? el?.[1] ?? "").trim();
  if (!raw) return fallback;
  const n = parseFloat(raw.replace(/^\+/, ""));
  return Number.isFinite(n) ? n : fallback;
}

function crsBool(xml: string, key: string): boolean {
  const attr = xml.match(new RegExp(`crs:${key}="([^"]*)"`, "i"));
  const el = xml.match(
    new RegExp(`<crs:${key}(?:\\s[^>]*)?>([^<]*)</crs:${key}>`, "i"),
  );
  return /true/i.test((attr?.[1] ?? el?.[1] ?? "").trim());
}

function crsName(xml: string): string {
  const attr = xml.match(/\bcrs:Name="([^"]+)"/i);
  if (attr?.[1]?.trim()) return attr[1].trim();
  const block = xml.match(/<crs:Name(?:\s[^>]*)?>[\s\S]*?<\/crs:Name>/i);
  if (!block) return "";
  const li = block[0].match(/<rdf:li[^>]*>([^<]+)<\/rdf:li>/i);
  if (li?.[1]?.trim()) return li[1].trim();
  return block[0].replace(/<[^>]+>/g, "").trim();
}

/** Decode Lightroom XMP that may be UTF-8 or UTF-16 (with or without BOM). */
export function decodeXmpFile(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes);
    }
  }
  if (
    bytes.length >= 8 &&
    bytes[1] === 0 &&
    bytes[3] === 0 &&
    bytes[5] === 0 &&
    bytes[7] === 0
  ) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function parseCurve(xml: string, tag: string): LrToneCurve | null {
  const block = xml.match(
    new RegExp(`<crs:${tag}(?:\\s[^>]*)?>[\\s\\S]*?</crs:${tag}>`, "i"),
  );
  if (!block) return null;
  const pts: LrToneCurve = [];
  for (const m of block[0].matchAll(/<rdf:li>([^<]+)<\/rdf:li>/gi)) {
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      pts.push({ x: parts[0], y: parts[1] });
    }
  }
  if (pts.length < 2) return null;
  const maxX = Math.max(...pts.map((p) => p.x));
  const maxY = Math.max(...pts.map((p) => p.y));
  if (maxX <= 1.01 && maxY <= 1.01) {
    return pts.map((p) => ({ x: p.x * 255, y: p.y * 255 }));
  }
  return pts;
}

function namedToneCurve(xml: string): LrToneCurve | null {
  const name = (
    xml.match(/\bcrs:ToneCurveName2012="([^"]+)"/i)?.[1] ??
    xml.match(/\bcrs:ToneCurveName="([^"]+)"/i)?.[1] ??
    ""
  ).toLowerCase();
  if (name.includes("medium")) {
    return [
      { x: 0, y: 0 },
      { x: 32, y: 22 },
      { x: 64, y: 56 },
      { x: 128, y: 128 },
      { x: 192, y: 200 },
      { x: 255, y: 255 },
    ];
  }
  if (name.includes("strong")) {
    return [
      { x: 0, y: 0 },
      { x: 32, y: 14 },
      { x: 64, y: 48 },
      { x: 128, y: 128 },
      { x: 192, y: 214 },
      { x: 255, y: 255 },
    ];
  }
  return null;
}

function evalCurve(pts: LrToneCurve | null, t: number): number {
  if (!pts || pts.length < 2) return t;
  const x = t * 255;
  if (x <= pts[0]!.x) return pts[0]!.y / 255;
  const last = pts[pts.length - 1]!;
  if (x >= last.x) return last.y / 255;
  const n = pts.length;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const m = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    m[i] = (ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]! || 1);
  }
  const d = new Array<number>(n).fill(0);
  d[0] = m[0]!;
  d[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1]! * m[i]! <= 0) d[i] = 0;
    else d[i] = (m[i - 1]! + m[i]!) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]!) < 1e-9) {
      d[i] = 0;
      d[i + 1] = 0;
      continue;
    }
    const a = d[i]! / m[i]!;
    const b = d[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const q = 3 / Math.sqrt(s);
      d[i] = q * a * m[i]!;
      d[i + 1] = q * b * m[i]!;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    if (x > x1) continue;
    const h = x1 - x0 || 1;
    const u = (x - x0) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    const y =
      (2 * u3 - 3 * u2 + 1) * ys[i]! +
      (u3 - 2 * u2 + u) * h * d[i]! +
      (-2 * u3 + 3 * u2) * ys[i + 1]! +
      (u3 - u2) * h * d[i + 1]!;
    return y / 255;
  }
  return t;
}

export function isLightroomXmp(text: string): boolean {
  return (
    /<x:xmpmeta|<xmpmeta/i.test(text) &&
    /camera-raw-settings|crs:Version|crs:ProcessVersion|crs:HasSettings/i.test(
      text,
    )
  );
}

export function parseLightroomXmp(xml: string): LrPreset | null {
  if (!isLightroomXmp(xml)) return null;
  const hslHue = HSL_KEYS.map((k) => crsNumber(xml, `HueAdjustment${k}`));
  const hslSat = HSL_KEYS.map((k) => crsNumber(xml, `SaturationAdjustment${k}`));
  const hslLum = HSL_KEYS.map((k) => crsNumber(xml, `LuminanceAdjustment${k}`));
  const incTemp = crsNumber(xml, "IncrementalTemperature");
  const incTint = crsNumber(xml, "IncrementalTint");
  const jpegRelativeWb =
    crsHas(xml, "IncrementalTemperature") || crsHas(xml, "IncrementalTint");
  let temperature = crsNumber(xml, "Temperature");
  let tint = crsNumber(xml, "Tint");
  if (jpegRelativeWb) {
    temperature = REF_TEMP + incTemp;
    tint = incTint;
  } else if (!temperature) {
    temperature = REF_TEMP;
  }
  const curve =
    parseCurve(xml, "ToneCurvePV2012") ??
    parseCurve(xml, "ToneCurve") ??
    namedToneCurve(xml);

  return {
    name: crsName(xml),
    grayscale: crsBool(xml, "ConvertToGrayscale"),
    temperature,
    tint,
    exposure: crsNumber(xml, "Exposure2012", crsNumber(xml, "Exposure")),
    contrast: crsNumber(xml, "Contrast2012", crsNumber(xml, "Contrast")),
    highlights: crsNumber(xml, "Highlights2012", crsNumber(xml, "Highlights")),
    shadows: crsNumber(xml, "Shadows2012", crsNumber(xml, "Shadows")),
    whites: crsNumber(xml, "Whites2012", crsNumber(xml, "Whites")),
    blacks: crsNumber(xml, "Blacks2012", crsNumber(xml, "Blacks")),
    texture: crsNumber(xml, "Texture"),
    clarity: crsNumber(xml, "Clarity2012", crsNumber(xml, "Clarity")),
    dehaze: crsNumber(xml, "Dehaze"),
    vibrance: crsNumber(xml, "Vibrance"),
    saturation: crsNumber(xml, "Saturation"),
    curve,
    curveR:
      parseCurve(xml, "ToneCurvePV2012Red") ??
      parseCurve(xml, "ToneCurveRed"),
    curveG:
      parseCurve(xml, "ToneCurvePV2012Green") ??
      parseCurve(xml, "ToneCurveGreen"),
    curveB:
      parseCurve(xml, "ToneCurvePV2012Blue") ??
      parseCurve(xml, "ToneCurveBlue"),
    paramShadows: crsNumber(xml, "ParametricShadows"),
    paramDarks: crsNumber(xml, "ParametricDarks"),
    paramLights: crsNumber(xml, "ParametricLights"),
    paramHighlights: crsNumber(xml, "ParametricHighlights"),
    paramShadowSplit: crsNumber(xml, "ParametricShadowSplit", 25),
    paramMidSplit: crsNumber(xml, "ParametricMidtoneSplit", 50),
    paramHighlightSplit: crsNumber(xml, "ParametricHighlightSplit", 75),
    splitShadowHue: crsNumber(xml, "SplitToneShadowHue"),
    splitShadowSat: crsNumber(xml, "SplitToneShadowSaturation"),
    splitHighlightHue: crsNumber(xml, "SplitToneHighlightHue"),
    splitHighlightSat: crsNumber(xml, "SplitToneHighlightSaturation"),
    splitBalance: crsNumber(xml, "SplitToneBalance"),
    gradeShadow: {
      h: crsNumber(xml, "ColorGradeShadowHue"),
      s: crsNumber(xml, "ColorGradeShadowSat"),
      l: crsNumber(xml, "ColorGradeShadowLum"),
    },
    gradeMid: {
      h: crsNumber(xml, "ColorGradeMidtoneHue"),
      s: crsNumber(xml, "ColorGradeMidtoneSat"),
      l: crsNumber(xml, "ColorGradeMidtoneLum"),
    },
    gradeHigh: {
      h: crsNumber(xml, "ColorGradeHighlightHue"),
      s: crsNumber(xml, "ColorGradeHighlightSat"),
      l: crsNumber(xml, "ColorGradeHighlightLum"),
    },
    gradeGlobal: {
      h: crsNumber(xml, "ColorGradeGlobalHue"),
      s: crsNumber(xml, "ColorGradeGlobalSat"),
      l: crsNumber(xml, "ColorGradeGlobalLum"),
    },
    gradeBlending: crsNumber(xml, "ColorGradeBlending", 50),
    gradeBalance: crsNumber(xml, "ColorGradeBalance"),
    hslHue,
    hslSat,
    hslLum,
    vignette: crsNumber(
      xml,
      "PostCropVignetteAmount",
      crsNumber(xml, "VignetteAmount"),
    ),
    grain: crsNumber(xml, "GrainAmount"),
    grainSize: crsNumber(xml, "GrainSize", 25),
    grainFreq: crsNumber(xml, "GrainFrequency", 50),
    sharpen: crsNumber(xml, "Sharpness"),
    sharpenRadius: crsNumber(xml, "SharpenRadius", 1),
    sharpenDetail: crsNumber(xml, "SharpenDetail", 25),
    sharpenMasking: crsNumber(xml, "SharpenEdgeMasking"),
    luminanceNR: crsNumber(
      xml,
      "LuminanceSmoothing",
      crsNumber(xml, "LuminanceNoiseReduction"),
    ),
    colorNR: crsNumber(
      xml,
      "ColorNoiseReduction",
      crsNumber(xml, "ChromaNoiseReduction"),
    ),
    distortion: crsNumber(
      xml,
      "LensManualDistortionAmount",
      crsNumber(xml, "DistortionAmount"),
    ),
    caRed: crsNumber(xml, "ChromaticAberrationR"),
    caBlue: crsNumber(xml, "ChromaticAberrationB"),
    vignetteMidpoint: crsNumber(xml, "PostCropVignetteMidpoint", 50),
    vignetteFeather: crsNumber(xml, "PostCropVignetteFeather", 50),
    vignetteRoundness: crsNumber(xml, "PostCropVignetteRoundness"),
  };
}

function hasDevelopWork(p: LrPreset): boolean {
  const nums = [
    p.exposure,
    p.contrast,
    p.highlights,
    p.shadows,
    p.whites,
    p.blacks,
    p.texture,
    p.clarity,
    p.dehaze,
    p.vibrance,
    p.saturation,
    p.tint,
    p.paramShadows,
    p.paramDarks,
    p.paramLights,
    p.paramHighlights,
    p.splitShadowSat,
    p.splitHighlightSat,
    p.gradeShadow.s,
    p.gradeMid.s,
    p.gradeHigh.s,
    p.gradeGlobal.s,
    p.gradeGlobal.l,
    p.vignette,
    p.grain,
    p.sharpen,
    p.luminanceNR,
    p.colorNR,
    p.distortion,
    p.caRed,
    p.caBlue,
    ...p.hslHue,
    ...p.hslSat,
    ...p.hslLum,
  ];
  const moved = nums.some((n) => Math.abs(n) > 0.001);
  const wb = Math.abs(p.temperature - REF_TEMP) > 8;
  const curves = !!(p.curve || p.curveR || p.curveG || p.curveB);
  return p.grayscale || moved || wb || curves;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const x = Math.max(0, c);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function kelvinToRgb(temp: number): [number, number, number] {
  const t = Math.max(1000, Math.min(40000, temp)) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [clamp01(r / 255), clamp01(g / 255), clamp01(b / 255)];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = ((h % 360) + 360) % 360 / 360;
  return [hue2rgb(p, q, hn + 1 / 3), hue2rgb(p, q, hn), hue2rgb(p, q, hn - 1 / 3)];
}

function hueRgb(h: number, s: number): [number, number, number] {
  return hslToRgb(h, clamp01(s / 100), 0.5);
}

function applyWb(rgb: [number, number, number], temp: number, tint: number) {
  const src = kelvinToRgb(temp);
  const ref = kelvinToRgb(REF_TEMP);
  const tintF = tint / 100;
  rgb[0] *= (ref[0] / (src[0] || 1e-6)) * (1 - tintF * 0.18);
  rgb[1] *= (ref[1] / (src[1] || 1e-6)) * (1 + tintF * 0.55);
  rgb[2] *= (ref[2] / (src[2] || 1e-6)) * (1 - tintF * 0.22);
}

function applyTone(c: number, p: LrPreset): number {
  let x = Math.max(0, c) * Math.pow(2, p.exposure);
  if (p.exposure > 0 && x > 0.72) {
    const over = x - 0.72;
    x = 0.72 + over / (1 + over * (0.55 + p.exposure * 0.12));
  }

  const pivot = 0.184;
  const cf = 1 + p.contrast / 100 * 0.72;
  x = Math.max(0, pivot + (x - pivot) * cf);

  const hi = p.highlights / 100;
  const sh = p.shadows / 100;
  const wh = p.whites / 100;
  const bl = p.blacks / 100;
  const hiW = smoothstep(0.38, 0.98, x);
  const shW = 1 - smoothstep(0.02, 0.52, x);
  const whW = smoothstep(0.62, 1, x);
  const blW = 1 - smoothstep(0, 0.32, x);

  if (hi < 0) x *= 1 + hi * hiW * 0.62;
  else x += hi * hiW * (1 - x) * 0.42;
  if (sh < 0) x *= 1 + sh * shW * 0.5;
  else x += sh * shW * 0.38 * (1 - x);
  if (wh >= 0) x += wh * whW * (1 - x) * 0.4;
  else x *= 1 + wh * whW * 0.45;
  if (bl >= 0) x += bl * blW * 0.28;
  else x *= 1 + bl * blW * 0.55;

  const haze = p.dehaze / 100;
  x += (x - 0.18) * haze * 0.42 + haze * 0.03;
  return x;
}

function applyParametric(t: number, p: LrPreset): number {
  const s0 = clamp01(p.paramShadowSplit / 100);
  const s1 = clamp01(p.paramMidSplit / 100);
  const s2 = clamp01(p.paramHighlightSplit / 100);
  const wSh = 1 - smoothstep(0, s0, t);
  const wHi = smoothstep(s2, 1, t);
  const wDk = Math.max(0, smoothstep(0, s0, t) * (1 - smoothstep(s0, s1, t)));
  const wLi = Math.max(0, smoothstep(s1, s2, t) * (1 - smoothstep(s2, 1, t)));
  let y = t;
  y += (p.paramShadows / 100) * 0.18 * wSh;
  y += (p.paramDarks / 100) * 0.16 * wDk;
  y += (p.paramLights / 100) * 0.16 * wLi;
  y += (p.paramHighlights / 100) * 0.18 * wHi;
  return clamp01(y);
}

function applySatVibrance(
  rgb: [number, number, number],
  sat: number,
  vib: number,
) {
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const sAmt = sat / 100;
  rgb[0] = lum + (rgb[0] - lum) * (1 + sAmt);
  rgb[1] = lum + (rgb[1] - lum) * (1 + sAmt);
  rgb[2] = lum + (rgb[2] - lum) * (1 + sAmt);
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  const chroma = max - min;
  const vAmt = (vib / 100) * (1 - clamp01(chroma * 1.8));
  rgb[0] = lum + (rgb[0] - lum) * (1 + vAmt);
  rgb[1] = lum + (rgb[1] - lum) * (1 + vAmt);
  rgb[2] = lum + (rgb[2] - lum) * (1 + vAmt);
}

function hueWeight(h: number, center: number, width: number): number {
  let d = Math.abs(h - center);
  if (d > 180) d = 360 - d;
  return clamp01(1 - d / width);
}

function applyHsl(rgb: [number, number, number], p: LrPreset) {
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  let dh = 0;
  let ds = 0;
  let dl = 0;
  let wsum = 0;
  for (let i = 0; i < 8; i++) {
    const w = hueWeight(h, HSL_HUES[i]!, HSL_WIDTHS[i]!);
    if (w <= 0) continue;
    dh += w * p.hslHue[i]!;
    ds += w * p.hslSat[i]!;
    dl += w * p.hslLum[i]!;
    wsum += w;
  }
  if (wsum <= 0) return;
  const [nr, ng, nb] = hslToRgb(
    h + dh / wsum,
    clamp01(s * (1 + ds / wsum / 100)),
    clamp01(l + dl / wsum / 180),
  );
  rgb[0] = nr;
  rgb[1] = ng;
  rgb[2] = nb;
}

function luma(rgb: [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function applyGradeBand(
  rgb: [number, number, number],
  grade: LrGradeHsl,
  weight: number,
) {
  const w = clamp01(weight);
  if (w < 0.001) return;
  const satAmt = (grade.s / 100) * w;
  const lumAmt = (grade.l / 100) * w * 0.35;
  if (Math.abs(satAmt) > 0.001) {
    const [cr, cg, cb] = hueRgb(grade.h, Math.abs(grade.s));
    const t = clamp01(Math.abs(satAmt) * 0.72);
    rgb[0] = lerp(rgb[0], cr, t);
    rgb[1] = lerp(rgb[1], cg, t);
    rgb[2] = lerp(rgb[2], cb, t);
  }
  if (Math.abs(lumAmt) > 0.001) {
    rgb[0] = clamp01(rgb[0] + lumAmt);
    rgb[1] = clamp01(rgb[1] + lumAmt);
    rgb[2] = clamp01(rgb[2] + lumAmt);
  }
}

function mixColor(
  rgb: [number, number, number],
  hue: number,
  sat: number,
  amount: number,
) {
  if (sat === 0 || amount === 0) return;
  const [cr, cg, cb] = hueRgb(hue, Math.abs(sat));
  const t = clamp01(Math.abs(amount) * Math.abs(sat) / 100);
  rgb[0] = lerp(rgb[0], cr, t);
  rgb[1] = lerp(rgb[1], cg, t);
  rgb[2] = lerp(rgb[2], cb, t);
}

function applyGrade(rgb: [number, number, number], p: LrPreset) {
  const y = luma(rgb);
  const bal = p.splitBalance / 100 + p.gradeBalance / 100;
  const shW = 1 - smoothstep(0.06, 0.52 + bal * 0.18, y);
  const hiW = smoothstep(0.48 + bal * 0.18, 0.96, y);
  const midW = 4 * y * (1 - y);
  const blend = clamp01(p.gradeBlending / 100);

  mixColor(rgb, p.splitShadowHue, p.splitShadowSat, shW * 0.5);
  mixColor(rgb, p.splitHighlightHue, p.splitHighlightSat, hiW * 0.5);

  applyGradeBand(rgb, p.gradeShadow, shW * (0.35 + blend * 0.65));
  applyGradeBand(rgb, p.gradeMid, midW * (0.25 + blend * 0.75));
  applyGradeBand(rgb, p.gradeHigh, hiW * (0.35 + blend * 0.65));
  applyGradeBand(rgb, p.gradeGlobal, 0.55);
}

function processRgb(r: number, g: number, b: number, p: LrPreset): [number, number, number] {
  let rgb: [number, number, number] = [
    srgbToLinear(r),
    srgbToLinear(g),
    srgbToLinear(b),
  ];
  applyWb(rgb, p.temperature, p.tint);
  rgb[0] = applyTone(rgb[0], p);
  rgb[1] = applyTone(rgb[1], p);
  rgb[2] = applyTone(rgb[2], p);
  rgb[0] = applyParametric(linearToSrgb(Math.max(0, rgb[0])), p);
  rgb[1] = applyParametric(linearToSrgb(Math.max(0, rgb[1])), p);
  rgb[2] = applyParametric(linearToSrgb(Math.max(0, rgb[2])), p);
  rgb[0] = evalCurve(p.curveR, evalCurve(p.curve, rgb[0]));
  rgb[1] = evalCurve(p.curveG, evalCurve(p.curve, rgb[1]));
  rgb[2] = evalCurve(p.curveB, evalCurve(p.curve, rgb[2]));
  applySatVibrance(rgb, p.saturation, p.vibrance);
  applyHsl(rgb, p);
  applyGrade(rgb, p);
  if (p.grayscale) {
    const y = luma(rgb);
    rgb = [y, y, y];
  }
  if (p.dehaze) {
    const satBoost = 1 + clamp01(p.dehaze / 100) * 0.12;
    const y = luma(rgb);
    rgb[0] = y + (rgb[0] - y) * satBoost;
    rgb[1] = y + (rgb[1] - y) * satBoost;
    rgb[2] = y + (rgb[2] - y) * satBoost;
  }
  return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])];
}

function fmt(n: number): string {
  return n.toFixed(6);
}

function buildCubeFromPreset(preset: LrPreset, title: string): string {
  const size = LUT_SIZE;
  const lines = [
    `TITLE "${(preset.name || title).replace(/"/g, "")}"`,
    "# Generated from a Lightroom / Camera Raw XMP preset (PV2012-style)",
    `LUT_3D_SIZE ${size}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
  ];
  const s = size - 1;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = processRgb(ri / s, gi / s, bi / s, preset);
        lines.push(`${fmt(r)} ${fmt(g)} ${fmt(b)}`);
      }
    }
  }
  return lines.join("\n");
}

export function lightroomXmpToCube(xml: string, title = "Lightroom preset"): string {
  const preset = parseLightroomXmp(xml);
  if (!preset) {
    throw new Error("That file is not a Lightroom / Camera Raw XMP preset.");
  }
  if (!hasDevelopWork(preset)) {
    throw new Error(
      "That XMP has no Lightroom develop settings to import.",
    );
  }
  return buildCubeFromPreset(preset, title);
}

export function importLightroomXmp(
  xml: string,
  title = "Lightroom preset",
): {
  cubeData: string;
  name: string;
  adjustments: {
    grain: number;
    vignette: number;
    exposure: number;
    levels: number;
    contrast: number;
    shadows: number;
    saturation: number;
    glow: number;
  };
  spatial: {
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
} {
  const preset = parseLightroomXmp(xml);
  if (!preset) {
    throw new Error("That file is not a Lightroom / Camera Raw XMP preset.");
  }
  if (!hasDevelopWork(preset)) {
    throw new Error("That XMP has no Lightroom develop settings to import.");
  }
  const grain = Math.max(0, Math.min(100, Math.round(preset.grain)));
  const vignette = Math.max(-100, Math.min(100, Math.round(preset.vignette)));
  return {
    cubeData: buildCubeFromPreset(preset, title),
    name: preset.name || title,
    adjustments: {
      grain,
      vignette,
      exposure: 0,
      levels: 0,
      contrast: 0,
      shadows: 0,
      saturation: 0,
      glow: 0,
    },
    spatial: {
      texture: preset.texture,
      clarity: preset.clarity,
      sharpen: preset.sharpen,
      sharpenRadius: preset.sharpenRadius,
      sharpenDetail: preset.sharpenDetail,
      sharpenMasking: preset.sharpenMasking,
      luminanceNR: preset.luminanceNR,
      colorNR: preset.colorNR,
      distortion: preset.distortion,
      caRed: preset.caRed,
      caBlue: preset.caBlue,
      vignetteMidpoint: preset.vignetteMidpoint,
      vignetteFeather: preset.vignetteFeather,
      vignetteRoundness: preset.vignetteRoundness,
      grainSize: preset.grainSize,
      grainFreq: preset.grainFreq,
    },
  };
}

export function xmpPresetName(xml: string, fallback = "Lightroom preset"): string {
  return crsName(xml) || fallback;
}
