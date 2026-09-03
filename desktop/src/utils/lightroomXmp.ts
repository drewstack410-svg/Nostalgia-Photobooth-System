/**
 * Lightroom / Camera Raw .xmp preset → IRIDAS .cube LUT.
 *
 * Applies the develop sliders photobooth capture can actually use
 * (tone, curves, WB, vibrance/sat, HSL, split-tone / color grade)
 * by baking them into a 17³ LUT the existing cube pipeline already runs.
 */

const LUT_SIZE = 17;
const REF_TEMP = 5500;

export type LrToneCurve = { x: number; y: number }[];

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
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
  lookAmount: number;
  curve: LrToneCurve | null;
  curveR: LrToneCurve | null;
  curveG: LrToneCurve | null;
  curveB: LrToneCurve | null;
  splitShadowHue: number;
  splitShadowSat: number;
  splitHighlightHue: number;
  splitHighlightSat: number;
  splitBalance: number;
  gradeShadow: { h: number; s: number; l: number };
  gradeMid: { h: number; s: number; l: number };
  gradeHigh: { h: number; s: number; l: number };
  gradeGlobal: { h: number; s: number; l: number };
  gradeBlending: number;
  hslHue: number[];
  hslSat: number[];
  hslLum: number[];
};

const HSL_HUES = [0, 30, 60, 120, 180, 240, 270, 300];
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

function lookAmountFrom(xml: string): number {
  const block = xml.match(/<crs:Look\b[\s\S]*?<\/crs:Look>/i);
  if (!block) return 1;
  const raw = block[0].match(/\bcrs:Amount="([^"]+)"/i)?.[1]?.trim() ?? "";
  const n = parseFloat(raw.replace(/^\+/, ""));
  if (!Number.isFinite(n)) return 1;
  return clamp01(n > 1 ? n / 100 : n);
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
  return pts.length >= 2 ? pts : null;
}

function evalCurve(pts: LrToneCurve | null, t: number): number {
  if (!pts || pts.length < 2) return t;
  const x = t * 255;
  if (x <= pts[0]!.x) return pts[0]!.y / 255;
  const last = pts[pts.length - 1]!;
  if (x >= last.x) return last.y / 255;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x <= b.x) {
      const u = (x - a.x) / (b.x - a.x || 1);
      return (a.y + (b.y - a.y) * u) / 255;
    }
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
  const temperature = crsNumber(
    xml,
    "Temperature",
    REF_TEMP + crsNumber(xml, "IncrementalTemperature"),
  );
  const tint =
    crsNumber(xml, "Tint") + crsNumber(xml, "IncrementalTint");

  return {
    name: crsName(xml),
    grayscale: crsBool(xml, "ConvertToGrayscale"),
    temperature: temperature || REF_TEMP,
    tint,
    exposure: crsNumber(xml, "Exposure2012", crsNumber(xml, "Exposure")),
    contrast: crsNumber(xml, "Contrast2012", crsNumber(xml, "Contrast")),
    highlights: crsNumber(xml, "Highlights2012"),
    shadows: crsNumber(xml, "Shadows2012"),
    whites: crsNumber(xml, "Whites2012"),
    blacks: crsNumber(xml, "Blacks2012"),
    clarity: crsNumber(xml, "Clarity2012", crsNumber(xml, "Clarity")),
    dehaze: crsNumber(xml, "Dehaze"),
    vibrance: crsNumber(xml, "Vibrance"),
    saturation: crsNumber(xml, "Saturation"),
    lookAmount: lookAmountFrom(xml),
    curve:
      parseCurve(xml, "ToneCurvePV2012") ?? parseCurve(xml, "ToneCurve"),
    curveR:
      parseCurve(xml, "ToneCurvePV2012Red") ??
      parseCurve(xml, "ToneCurveRed"),
    curveG:
      parseCurve(xml, "ToneCurvePV2012Green") ??
      parseCurve(xml, "ToneCurveGreen"),
    curveB:
      parseCurve(xml, "ToneCurvePV2012Blue") ??
      parseCurve(xml, "ToneCurveBlue"),
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
    hslHue,
    hslSat,
    hslLum,
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
    p.clarity,
    p.dehaze,
    p.vibrance,
    p.saturation,
    p.tint,
    p.splitShadowSat,
    p.splitHighlightSat,
    p.gradeShadow.s,
    p.gradeMid.s,
    p.gradeHigh.s,
    p.gradeGlobal.s,
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
  const tintF = tint / 150;
  rgb[0] *= ref[0] / (src[0] || 1e-6) * (1 - tintF * 0.25);
  rgb[1] *= ref[1] / (src[1] || 1e-6) * (1 + tintF);
  rgb[2] *= ref[2] / (src[2] || 1e-6) * (1 - tintF * 0.25);
}

function applyTone(c: number, p: LrPreset): number {
  c *= Math.pow(2, p.exposure);
  const pivot = 0.18;
  const cf = 1 + p.contrast / 140;
  c = pivot + (c - pivot) * cf;

  const hi = p.highlights / 100;
  const sh = p.shadows / 100;
  const wh = p.whites / 100;
  const bl = p.blacks / 100;
  const hiW = smoothstep(0.42, 1, c);
  const shW = 1 - smoothstep(0, 0.48, c);
  const whW = smoothstep(0.7, 1, c);
  const blW = 1 - smoothstep(0, 0.28, c);
  if (hi < 0) c *= 1 + hi * hiW * 0.55;
  else c += hi * hiW * (1 - c) * 0.35;
  if (sh < 0) c *= 1 + sh * shW * 0.45;
  else c += sh * shW * (1 - c) * 0.4;
  c += wh * whW * (wh > 0 ? 1 - c : c) * 0.35;
  c += bl * blW * (bl > 0 ? 1 - c : -c) * 0.35;

  const midW = 4 * c * (1 - c);
  c += (c - 0.5) * (p.clarity / 100) * 0.45 * midW;
  c += (c - 0.5) * (p.dehaze / 100) * 0.35 + p.dehaze / 400;
  return c;
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

function hueWeight(h: number, center: number): number {
  let d = Math.abs(h - center);
  if (d > 180) d = 360 - d;
  const width = center % 60 === 0 && (center === 0 || center >= 120) ? 40 : 28;
  return clamp01(1 - d / width);
}

function applyHsl(rgb: [number, number, number], p: LrPreset) {
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  let dh = 0;
  let ds = 0;
  let dl = 0;
  let wsum = 0;
  for (let i = 0; i < 8; i++) {
    const w = hueWeight(h, HSL_HUES[i]!);
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
    clamp01(l + dl / wsum / 200),
  );
  rgb[0] = nr;
  rgb[1] = ng;
  rgb[2] = nb;
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
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const bal = p.splitBalance / 100;
  const shW = (1 - smoothstep(0.08, 0.55 + bal * 0.2, lum)) * 0.55;
  const hiW = smoothstep(0.45 + bal * 0.2, 0.95, lum) * 0.55;
  mixColor(rgb, p.splitShadowHue, p.splitShadowSat, shW);
  mixColor(rgb, p.splitHighlightHue, p.splitHighlightSat, hiW);

  const blend = clamp01(p.gradeBlending / 100);
  const midW = 4 * lum * (1 - lum) * blend;
  mixColor(rgb, p.gradeShadow.h, p.gradeShadow.s, shW * blend);
  mixColor(rgb, p.gradeMid.h, p.gradeMid.s, midW);
  mixColor(rgb, p.gradeHigh.h, p.gradeHigh.s, hiW * blend);
  mixColor(rgb, p.gradeGlobal.h, p.gradeGlobal.s, 0.25 * blend);
  const lift = p.gradeGlobal.l / 200;
  rgb[0] += lift;
  rgb[1] += lift;
  rgb[2] += lift;
}

function processRgb(r: number, g: number, b: number, p: LrPreset): [number, number, number] {
  const src: [number, number, number] = [r, g, b];
  let rgb: [number, number, number] = [
    srgbToLinear(r),
    srgbToLinear(g),
    srgbToLinear(b),
  ];
  applyWb(rgb, p.temperature, p.tint);
  rgb[0] = applyTone(rgb[0], p);
  rgb[1] = applyTone(rgb[1], p);
  rgb[2] = applyTone(rgb[2], p);
  rgb[0] = linearToSrgb(Math.max(0, rgb[0]));
  rgb[1] = linearToSrgb(Math.max(0, rgb[1]));
  rgb[2] = linearToSrgb(Math.max(0, rgb[2]));
  rgb[0] = evalCurve(p.curveR, evalCurve(p.curve, rgb[0]));
  rgb[1] = evalCurve(p.curveG, evalCurve(p.curve, rgb[1]));
  rgb[2] = evalCurve(p.curveB, evalCurve(p.curve, rgb[2]));
  applySatVibrance(rgb, p.saturation, p.vibrance);
  applyHsl(rgb, p);
  applyGrade(rgb, p);
  if (p.grayscale) {
    const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    rgb = [y, y, y];
  }
  const a = p.lookAmount;
  return [
    clamp01(lerp(src[0], rgb[0], a)),
    clamp01(lerp(src[1], rgb[1], a)),
    clamp01(lerp(src[2], rgb[2], a)),
  ];
}

function fmt(n: number): string {
  return n.toFixed(6);
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
  const size = LUT_SIZE;
  const lines = [
    `TITLE "${(preset.name || title).replace(/"/g, "")}"`,
    "# Generated from a Lightroom / Camera Raw XMP preset",
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

export function xmpPresetName(xml: string, fallback = "Lightroom preset"): string {
  return crsName(xml) || fallback;
}
