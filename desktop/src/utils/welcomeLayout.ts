/** Welcome-screen layout as fractions of a 1920×1080 canvas. */

export const WELCOME_CANVAS_W = 1920;
export const WELCOME_CANVAS_H = 1080;
export const WELCOME_LOGO_NATIVE_W = 1208;
export const WELCOME_LOGO_NATIVE_H = 317;
export const WELCOME_START_NATIVE_W = 414.8;
export const WELCOME_START_NATIVE_H = 86.9;

export type WelcomeFixedId = "logo" | "start";
export type WelcomeItemId = WelcomeFixedId | string;
export type WelcomeLayer = "background" | WelcomeItemId;

export type WelcomeBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type WelcomeAssetKind = "image" | "video" | "text";
export type WelcomeTextAlign = "left" | "center" | "right";
export type WelcomeTextVAlign = "top" | "middle" | "bottom";

export type WelcomeTextStyle = {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  underline: boolean;
  color: string;
  align: WelcomeTextAlign;
  valign: WelcomeTextVAlign;
  letterSpacing: number;
  lineHeight: number;
  opacity: number;
};

export type WelcomeAsset = WelcomeBox & {
  id: string;
  src: string;
  name: string;
  kind?: WelcomeAssetKind;
  text?: WelcomeTextStyle;
};

export function defaultWelcomeText(): WelcomeTextStyle {
  return {
    content: "Add a heading",
    fontFamily: '"Playfair Display", Georgia, serif',
    fontSize: 72,
    fontWeight: 700,
    italic: false,
    underline: false,
    color: "#3d2b1f",
    align: "center",
    valign: "middle",
    letterSpacing: 0,
    lineHeight: 1.15,
    opacity: 1,
  };
}

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function parseHexColor(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim();
  if (/^#([0-9a-f]{3})$/i.test(t)) {
    const h = t.slice(1);
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  if (/^#([0-9a-f]{6})$/i.test(t)) return t.toLowerCase();
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(parseHexColor(a, "#000000"));
  const [br, bg, bb] = hexToRgb(parseHexColor(b, "#ffffff"));
  const amt = Math.min(1, Math.max(0, t));
  const mix = (x: number, y: number) => Math.round(x + (y - x) * amt);
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(mix(ar, br))}${to(mix(ag, bg))}${to(mix(ab, bb))}`;
}

export function lightenHex(hex: string, amount: number): string {
  return mixHex(hex, "#ffffff", amount);
}

/** Figma gold/brown start button. Empty label keeps the original SVG artwork. */
export type WelcomeStartButtonStyle = {
  label: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  labelColor: string;
  faceColor: string;
  bezelColor: string;
  shadowColor: string;
  radius: number;
};

export function defaultStartButtonStyle(): WelcomeStartButtonStyle {
  return {
    label: "",
    fontFamily: "var(--font-display)",
    fontSize: 22,
    fontWeight: 700,
    italic: false,
    labelColor: "#3d2b1f",
    faceColor: "#fcaf4a",
    bezelColor: "#6b3b11",
    shadowColor: "#301207",
    radius: 5.5,
  };
}

export function parseStartButtonStyle(raw: unknown): WelcomeStartButtonStyle {
  const d = defaultStartButtonStyle();
  if (!raw || typeof raw !== "object") return d;
  const t = raw as Partial<WelcomeStartButtonStyle>;
  return {
    label: typeof t.label === "string" ? t.label : d.label,
    fontFamily:
      typeof t.fontFamily === "string" && t.fontFamily.trim()
        ? t.fontFamily
        : d.fontFamily,
    fontSize: clampNum(t.fontSize, d.fontSize, 10, 64),
    fontWeight: clampNum(t.fontWeight, d.fontWeight, 100, 900),
    italic: !!t.italic,
    labelColor: parseHexColor(t.labelColor, d.labelColor),
    faceColor: parseHexColor(t.faceColor, d.faceColor),
    bezelColor: parseHexColor(t.bezelColor, d.bezelColor),
    shadowColor: parseHexColor(t.shadowColor, d.shadowColor),
    radius: clampNum(t.radius, d.radius, 0, 24),
  };
}

export function startButtonCssVars(
  style: WelcomeStartButtonStyle,
  scale: number,
): Record<string, string> {
  const s = Math.max(0.2, scale);
  return {
    "--start-btn-scale": String(s),
    "--btn-bezel-from": style.bezelColor,
    "--btn-bezel-to": lightenHex(style.bezelColor, 0.22),
    "--btn-face-from": style.faceColor,
    "--btn-face-mid": lightenHex(style.faceColor, 0.45),
    "--btn-face-to": style.faceColor,
    "--btn-shadow": style.shadowColor,
    "--btn-label-color": style.labelColor,
    "--btn-radius": `${style.radius * s}px`,
    "--btn-inner-radius": `${Math.max(0, style.radius * 0.36 * s)}px`,
    "--btn-font": style.fontFamily,
    "--btn-font-size": `${style.fontSize * s}px`,
    "--btn-font-weight": String(style.fontWeight),
    "--btn-font-style": style.italic ? "italic" : "normal",
  };
}

export function parseTextStyle(raw: unknown): WelcomeTextStyle {
  const d = defaultWelcomeText();
  if (!raw || typeof raw !== "object") return d;
  const t = raw as Partial<WelcomeTextStyle>;
  return {
    content: typeof t.content === "string" ? t.content : d.content,
    fontFamily:
      typeof t.fontFamily === "string" && t.fontFamily.trim()
        ? t.fontFamily
        : d.fontFamily,
    fontSize: clampNum(t.fontSize, d.fontSize, 8, 400),
    fontWeight: clampNum(t.fontWeight, d.fontWeight, 100, 900),
    italic: !!t.italic,
    underline: !!t.underline,
    color:
      typeof t.color === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t.color)
        ? t.color
        : d.color,
    align: t.align === "left" || t.align === "right" ? t.align : "center",
    valign: t.valign === "top" || t.valign === "bottom" ? t.valign : "middle",
    letterSpacing: clampNum(t.letterSpacing, d.letterSpacing, -20, 80),
    lineHeight: clampNum(t.lineHeight, d.lineHeight, 0.7, 3),
    opacity: clampNum(t.opacity, d.opacity, 0, 1),
  };
}

export type WelcomeLayout = {
  logo: WelcomeBox;
  start: WelcomeBox;
  assets: WelcomeAsset[];
  /** Back → front. Background is always behind this list. */
  order: string[];
};

export function isAssetId(id: string): boolean {
  return id.startsWith("asset:");
}

export function assetItemId(id: string): string {
  return id.startsWith("asset:") ? id : `asset:${id}`;
}

export function assetKey(id: string): string {
  return id.startsWith("asset:") ? id.slice(6) : id;
}

export function isMovableLayer(id: string): id is WelcomeItemId {
  return id === "logo" || id === "start" || isAssetId(id);
}

export function clampBox(box: WelcomeBox): WelcomeBox {
  const w = Math.min(0.95, Math.max(0.05, box.w));
  const h = Math.min(0.95, Math.max(0.04, box.h));
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, box.x)),
    y: Math.min(1 - h, Math.max(0, box.y)),
  };
}

export function defaultWelcomeLayout(
  logoScale = 1,
  btnScale = 0.8,
): WelcomeLayout {
  const logoW = (WELCOME_LOGO_NATIVE_W * logoScale) / WELCOME_CANVAS_W;
  const logoH = (WELCOME_LOGO_NATIVE_H * logoScale) / WELCOME_CANVAS_H;
  const logo = clampBox({
    x: (1 - logoW) / 2,
    y: 0.288,
    w: logoW,
    h: logoH,
  });
  const btnW = (WELCOME_START_NATIVE_W * btnScale) / WELCOME_CANVAS_W;
  const btnH = (WELCOME_START_NATIVE_H * btnScale) / WELCOME_CANVAS_H;
  const gap = (77 * btnScale) / WELCOME_CANVAS_H;
  const start = clampBox({
    x: (1 - btnW) / 2,
    y: logo.y + logo.h + gap,
    w: btnW,
    h: btnH,
  });
  return normalizeWelcomeLayout({ logo, start, assets: [], order: ["logo", "start"] });
}

function isBox(v: unknown): v is WelcomeBox {
  if (!v || typeof v !== "object") return false;
  const b = v as WelcomeBox;
  return [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && isFinite(n));
}

function parseAssets(raw: unknown): WelcomeAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: WelcomeAsset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Partial<WelcomeAsset>;
    if (typeof a.id !== "string" || !a.id) continue;
    const kind: WelcomeAssetKind =
      a.kind === "video" ? "video" : a.kind === "text" ? "text" : "image";
    if (kind !== "text" && (typeof a.src !== "string" || !a.src)) continue;
    if (!isBox(a)) continue;
    const fallbackName =
      kind === "video" ? "Video" : kind === "text" ? "Text" : "Image";
    out.push({
      id: a.id,
      src: typeof a.src === "string" ? a.src : "",
      name:
        typeof a.name === "string" && a.name.trim() ? a.name : fallbackName,
      kind,
      ...(kind === "text" ? { text: parseTextStyle(a.text) } : {}),
      ...clampBox(a),
    });
  }
  return out;
}

export function knownItemIds(layout: Pick<WelcomeLayout, "assets">): string[] {
  return ["logo", "start", ...layout.assets.map((a) => assetItemId(a.id))];
}

export function normalizeOrder(layout: WelcomeLayout): string[] {
  const ids = knownItemIds(layout);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of layout.order || []) {
    if (ids.includes(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

export function normalizeWelcomeLayout(layout: WelcomeLayout): WelcomeLayout {
  const assets = layout.assets || [];
  const next = {
    logo: clampBox(layout.logo),
    start: clampBox(layout.start),
    assets,
    order: layout.order || [],
  };
  return { ...next, order: normalizeOrder(next) };
}

export function parseWelcomeLayout(raw: unknown): WelcomeLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<WelcomeLayout>;
  if (!isBox(o.logo) || !isBox(o.start)) return null;
  return normalizeWelcomeLayout({
    logo: o.logo,
    start: o.start,
    assets: parseAssets(o.assets),
    order: Array.isArray(o.order) ? o.order.filter((id) => typeof id === "string") : [],
  });
}

export function getItemBox(
  layout: WelcomeLayout,
  id: WelcomeItemId,
): WelcomeBox | null {
  if (id === "logo" || id === "start") return layout[id];
  if (!isAssetId(id)) return null;
  const a = layout.assets.find((x) => x.id === assetKey(id));
  return a ? { x: a.x, y: a.y, w: a.w, h: a.h } : null;
}

export function allItemBoxes(
  layout: WelcomeLayout,
): { id: WelcomeItemId; box: WelcomeBox }[] {
  return [
    { id: "logo", box: layout.logo },
    { id: "start", box: layout.start },
    ...layout.assets.map((a) => ({
      id: assetItemId(a.id),
      box: { x: a.x, y: a.y, w: a.w, h: a.h },
    })),
  ];
}

export function layerZ(order: string[], id: string): number {
  const i = order.indexOf(id);
  return 10 + (i < 0 ? 0 : i);
}

/** `order` is back→front. `fromId` is placed where `toId` sits in the front-first list. */
export function reorderVisualLayers(
  order: string[],
  fromId: string,
  toId: string,
): string[] {
  const visual = [...order].reverse();
  const from = visual.indexOf(fromId);
  const to = visual.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return order;
  visual.splice(from, 1);
  visual.splice(to, 0, fromId);
  return visual.reverse();
}

export function moveLayerOrder(
  order: string[],
  id: string,
  dir: "back" | "front" | "backward" | "forward",
): string[] {
  const next = [...order];
  const i = next.indexOf(id);
  if (i < 0) return next;
  if (dir === "back") {
    next.splice(i, 1);
    next.unshift(id);
    return next;
  }
  if (dir === "front") {
    next.splice(i, 1);
    next.push(id);
    return next;
  }
  const j = dir === "backward" ? i - 1 : i + 1;
  if (j < 0 || j >= next.length) return next;
  const tmp = next[i]!;
  next[i] = next[j]!;
  next[j] = tmp;
  return next;
}

export function layerLabel(id: string, layout?: WelcomeLayout | null): string {
  if (id === "background") return "Background";
  if (id === "logo") return "Logo";
  if (id === "start") return "Start button";
  if (isAssetId(id) && layout) {
    const a = layout.assets.find((x) => x.id === assetKey(id));
    if (a?.kind === "text") {
      const line = (a.text?.content || "").split("\n")[0].trim();
      return line.slice(0, 28) || a.name || "Text";
    }
    if (a?.name) return a.name;
    return a?.kind === "video" ? "Video" : "Image";
  }
  return "Image";
}

export function resizeBox(
  start: WelcomeBox,
  handle: "nw" | "ne" | "sw" | "se",
  dx: number,
  dy: number,
  lockAspect = true,
): WelcomeBox {
  const aspect = start.w / start.h || 1;
  let { x, y, w, h } = start;

  if (handle.includes("e")) w = start.w + dx;
  if (handle.includes("w")) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (handle.includes("s")) h = start.h + dy;
  if (handle.includes("n")) {
    h = start.h - dy;
    y = start.y + dy;
  }

  w = Math.max(0.05, w);
  h = lockAspect ? w / aspect : Math.max(0.04, h);

  if (handle.includes("n")) y = start.y + start.h - h;
  if (handle.includes("w")) x = start.x + start.w - w;

  return clampBox({ x, y, w, h });
}

/** Canvas / sibling alignment lines, same idea as Canva and Photoshop guides. */
export type SnapLine = {
  axis: "x" | "y";
  at: number;
};

/** ~23px on a 1920-wide stage — close enough to "clip" without feeling sticky. */
export const SNAP_THRESHOLD = 12 / WELCOME_CANVAS_W;

function uniquePositions(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (!out.some((x) => Math.abs(x - v) < 1e-6)) out.push(v);
  }
  return out;
}

function pickSnap(
  candidates: { value: number; set: (target: number) => void }[],
  targets: number[],
  threshold: number,
): { lineAt: number; apply: () => void } | null {
  let bestDist = threshold;
  let best: { lineAt: number; apply: () => void } | null = null;
  for (const c of candidates) {
    for (const t of targets) {
      const d = Math.abs(c.value - t);
      if (d < bestDist) {
        bestDist = d;
        best = { lineAt: t, apply: () => c.set(t) };
      }
    }
  }
  return best;
}

/**
 * Snap a box to the canvas centre/edges and to other boxes' edges/centres.
 * Returns the clipped box plus the guides that caught it.
 */
export function snapBoxToGuides(
  box: WelcomeBox,
  others: WelcomeBox[],
  threshold = SNAP_THRESHOLD,
): { box: WelcomeBox; lines: SnapLine[] } {
  const xs = uniquePositions([
    0,
    0.5,
    1,
    ...others.flatMap((b) => [b.x, b.x + b.w / 2, b.x + b.w]),
  ]);
  const ys = uniquePositions([
    0,
    0.5,
    1,
    ...others.flatMap((b) => [b.y, b.y + b.h / 2, b.y + b.h]),
  ]);

  let { x, y, w, h } = box;
  const lines: SnapLine[] = [];

  const sx = pickSnap(
    [
      { value: x, set: (t) => { x = t; } },
      { value: x + w / 2, set: (t) => { x = t - w / 2; } },
      { value: x + w, set: (t) => { x = t - w; } },
    ],
    xs,
    threshold,
  );
  if (sx) {
    sx.apply();
    lines.push({ axis: "x", at: sx.lineAt });
  }

  const sy = pickSnap(
    [
      { value: y, set: (t) => { y = t; } },
      { value: y + h / 2, set: (t) => { y = t - h / 2; } },
      { value: y + h, set: (t) => { y = t - h; } },
    ],
    ys,
    threshold,
  );
  if (sy) {
    sy.apply();
    lines.push({ axis: "y", at: sy.lineAt });
  }

  return { box: clampBox({ x, y, w, h }), lines };
}
