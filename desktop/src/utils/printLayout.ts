export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface Grid {
  rows: number;
  cols: number;
}

export interface ImageDataLike extends Size {
  data: ArrayLike<number>;
}

export type PrintCutMode = "standard" | "dnp-2-inch-cut";

// ─────────────────────────────────────────────────────────────────────
// PAPER SIZES (300 DPI native print area)
// ─────────────────────────────────────────────────────────────────────
// Every template declares which paper size it was DESIGNED for, and
// the print canvas is sized to those exact pixel dimensions. This is
// the convention every established photobooth app follows
// (LumaBooth, dslrBooth, Darkroom Booth, Sparkbooth): render at
// native, don't stretch a landscape composite onto portrait paper
// and pray the driver does the right thing.
//
// Dimensions come from the DNP DS-RX1's documented Print Area table
// (DNP-DS-RX1_DS-RX1HS_Manual_English.pdf, p.22) — these are the
// REAL printable areas, not the nominal "1800×1200" everyone reaches
// for. Matching them eliminates the ~22 px scale the driver
// otherwise applies, which is the source of "white gutter on one
// edge" complaints in DNP forum threads.
export type PaperSize =
  | "4x6-landscape" // (4x6) — 6×4 native landscape, the default
  | "4x6-portrait" //  (4x6) printed portrait
  | "2x6-portrait" //  PR(4x6) cut to 2×6 strip, or designed-for-strip
  | "6x8-portrait" //  6×8 native portrait (DS620-class media)
  | "6x8-landscape"; // 6×8 printed landscape (8×6)

export interface PaperSizeSpec extends Size {
  /** Logical inch dimensions for diagnostics / driver paper-size mapping. */
  inchesWide: number;
  inchesTall: number;
  /** Friendly label for UI. */
  label: string;
  /**
   * Which `paperLayout` to pass the printer driver. The driver flips
   * `PageSettings.Landscape` based on this — if the canvas is
   * portrait but Landscape is left true, the driver rotates the
   * image 90° and we get a sideways print.
   */
  driverLayout: "landscape" | "portrait";
}

export const PAPER_SIZES: Record<PaperSize, PaperSizeSpec> = {
  // Dimensions are the DS-RX1's TRUE imageable area: 1844×1240 for a
  // 4×6 at 300 DPI (confirmed against both the DNP Print Area table
  // and the upstream PhotoboothProject pipeline, which renders to the
  // exact driver imageable area to avoid the residual fit-to-page
  // scale that causes one-edge white gutters on dye-subs). NOT the
  // nominal 1800×1200.
  "4x6-landscape": {
    width: 1844,
    height: 1240,
    inchesWide: 6,
    inchesTall: 4,
    label: "4×6 landscape",
    driverLayout: "landscape",
  },
  "4x6-portrait": {
    width: 1240,
    height: 1844,
    inchesWide: 4,
    inchesTall: 6,
    label: "4×6 portrait",
    driverLayout: "portrait",
  },
  "2x6-portrait": {
    // Single-strip DESIGN size — one half of a 4×6 portrait sheet
    // (1240 ÷ 2 = 620 wide) at full height. The 2-inch cut slices the
    // 1240×1844 sheet at x = 620, so each physical strip is 620×1844
    // ≈ 2.07" × 6.15". The print composite renders on the full 4×6
    // portrait sheet and duplicates this strip into both halves.
    width: 620,
    height: 1844,
    inchesWide: 2,
    inchesTall: 6,
    label: "2×6 strip",
    driverLayout: "portrait",
  },
  // 6×8 media (DNP DS620-class). Nominal 300 DPI area — 1800×2400
  // portrait / 2400×1800 landscape. The operator must load 6×8 media
  // and set the driver's paper size to 6×8 for these to print at the
  // right size (same operator step as the DNP 2-inch cut).
  "6x8-portrait": {
    width: 1800,
    height: 2400,
    inchesWide: 6,
    inchesTall: 8,
    label: "6×8 portrait",
    driverLayout: "portrait",
  },
  "6x8-landscape": {
    width: 2400,
    height: 1800,
    inchesWide: 8,
    inchesTall: 6,
    label: "8×6 landscape",
    driverLayout: "landscape",
  },
};

/**
 * Look up a paper size's pixel canvas. Returns 4×6-landscape as a
 * safe default if the spec is missing — same behaviour as the old
 * `getPrintCanvasSize()` it replaces.
 */
export function getPaperSizePx(paperSize?: PaperSize): PaperSizeSpec {
  return PAPER_SIZES[paperSize ?? "4x6-landscape"] ?? PAPER_SIZES["4x6-landscape"];
}

/**
 * Deprecated — kept so any old call sites still compile. New code
 * should consult the template's `paperSize` and call
 * `getPaperSizePx()` instead. Returns just `{ width, height }` to
 * preserve the original contract (its older callers destructured
 * those two fields).
 *
 * @deprecated Use `getPaperSizePx(template.paperSize)`.
 */
export function getPrintCanvasSize(_mode: PrintCutMode): Size {
  const spec = getPaperSizePx("4x6-landscape");
  return { width: spec.width, height: spec.height };
}

/**
 * Minimal structural shape of a Template needed to lay its cells out.
 * Declared here rather than importing the store's `Template` so this
 * module stays dependency-free (the store already type-imports
 * `PaperSize` from here). `Template` is structurally assignable.
 */
export interface TemplateLayoutSpec {
  paperSize?: PaperSize;
  photoCount?: number;
  frameRows?: number;
  frameCols?: number;
  cellMargin?: number;
  cellGap?: number;
  cellZoom?: number;
  frameImageUrl?: string;
}

/**
 * Fallback grid for legacy templates that never got explicit
 * rows/cols. Mirrors PrintingView.vue's `bestLandscapeGrid` so a
 * template with no grid previews exactly the way it prints.
 */
function bestLandscapeGrid(n: number): Grid {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: 2 };
}

/** Explicit frameRows/frameCols win; otherwise derive from photoCount. */
export function getTemplateGrid(t: TemplateLayoutSpec): Grid {
  const hasGrid =
    t.frameRows != null &&
    t.frameCols != null &&
    t.frameRows > 0 &&
    t.frameCols > 0;
  return hasGrid
    ? { rows: t.frameRows as number, cols: t.frameCols as number }
    : bestLandscapeGrid(Math.max(1, t.photoCount ?? 1));
}

/**
 * Photo-cell rectangles for ONE print area of a template, in the paper
 * size's native pixels, row-major (cell i holds capture i).
 *
 * Mirrors PrintingView.vue's composite math — including the default
 * margin/gap split, which differs by path: the frame-PNG branch
 * defaults to 24 while the frameless branch defaults to 0.
 *
 * Deliberately models ONE print area, not the 2x6 cut sheet's
 * duplicated halves — a preview should show the single strip the
 * customer walks away with.
 */
export function getTemplateCellRects(t: TemplateLayoutSpec): Rect[] {
  const sheet = getPaperSizePx(t.paperSize);
  const { rows, cols } = getTemplateGrid(t);
  const dflt = t.frameImageUrl ? 24 : 0;
  const margin = t.cellMargin ?? dflt;
  const gap = t.cellGap ?? dflt;
  const innerW = sheet.width - margin * 2 - gap * (cols - 1);
  const innerH = sheet.height - margin * 2 - gap * (rows - 1);
  if (innerW <= 0 || innerH <= 0) return [];
  const cellW = innerW / cols;
  const cellH = innerH / rows;
  const rects: Rect[] = [];
  for (let i = 0; i < rows * cols; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    rects.push({
      x: margin + col * (cellW + gap),
      y: margin + row * (cellH + gap),
      width: cellW,
      height: cellH,
    });
  }
  return rects;
}

export function getDnpTwoInchCutPanelRects(canvas: Size): Rect[] {
  // Two strip panels SIDE-BY-SIDE (left and right), each 900×1200 px.
  // The DNP cutter slices VERTICALLY at x = canvas.width / 2 so the
  // left half becomes one physical strip and the right half becomes the
  // other. Each panel is portrait-oriented (900×1200 = 3:4), so photos
  // can be drawn stacked top-to-bottom in the natural reading order —
  // no post-blit rotation is required. The user then views each cut
  // strip in its native portrait orientation with subjects heads-up.
  const panelWidth = canvas.width / 2;
  return [
    { x: 0, y: 0, width: panelWidth, height: canvas.height },
    { x: panelWidth, y: 0, width: panelWidth, height: canvas.height },
  ];
}

export function fitRectContain(source: Size, container: Rect): Rect {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    container.width <= 0 ||
    container.height <= 0
  ) {
    return { x: container.x, y: container.y, width: 0, height: 0 };
  }

  const scale = Math.min(
    container.width / source.width,
    container.height / source.height,
  );
  const width = source.width * scale;
  const height = source.height * scale;

  return {
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    width,
    height,
  };
}

export function fitImageContain(image: Size, slot: Rect): Rect {
  return fitRectContain(image, slot);
}

export function mapRectToTarget(
  rect: Rect,
  source: Size,
  target: Rect,
): Rect {
  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;
  return {
    x: target.x + rect.x * scaleX,
    y: target.y + rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

export function mapRectsToTarget(
  rects: Rect[],
  source: Size,
  target: Rect,
): Rect[] {
  return rects.map((rect) => mapRectToTarget(rect, source, target));
}

export function insetRect(rect: Rect, inset: number): Rect {
  const xInset = Math.min(Math.max(inset, 0), rect.width / 2);
  const yInset = Math.min(Math.max(inset, 0), rect.height / 2);
  return {
    x: rect.x + xInset,
    y: rect.y + yInset,
    width: rect.width - xInset * 2,
    height: rect.height - yInset * 2,
  };
}

export function gridSlotRects(
  frameRect: Rect,
  grid: Grid,
  options: {
    outerInsetRatio?: number;
    gapRatio?: number;
  } = {},
): Rect[] {
  const rows = Math.max(1, Math.floor(grid.rows));
  const cols = Math.max(1, Math.floor(grid.cols));
  const outerInsetRatio = options.outerInsetRatio ?? 0.08;
  const gapRatio = options.gapRatio ?? 0.045;
  const insetX = frameRect.width * outerInsetRatio;
  const insetY = frameRect.height * outerInsetRatio;
  const gapX = frameRect.width * gapRatio;
  const gapY = frameRect.height * gapRatio;
  const contentX = frameRect.x + insetX;
  const contentY = frameRect.y + insetY;
  const contentW = Math.max(0, frameRect.width - insetX * 2);
  const contentH = Math.max(0, frameRect.height - insetY * 2);
  const slotW = Math.max(0, (contentW - gapX * (cols - 1)) / cols);
  const slotH = Math.max(0, (contentH - gapY * (rows - 1)) / rows);
  const rects: Rect[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      rects.push({
        x: contentX + col * (slotW + gapX),
        y: contentY + row * (slotH + gapY),
        width: slotW,
        height: slotH,
      });
    }
  }

  return rects;
}

export function findLightSlotRects(
  imageData: ImageDataLike,
  grid: Grid,
  options: {
    threshold?: number;
    minAreaRatio?: number;
  } = {},
): Rect[] {
  const { width, height, data } = imageData;
  // Default threshold is 215 (was 242) so common cream/eggshell slot
  // placeholders register as "light". Real frames often use warm cream
  // like #FBF2DE (251,242,222) — a 242 cutoff fails on the 222 blue
  // channel, so the probe returned 0 slots and the photo got fitted to a
  // slightly-too-small grid rect, leaving a thin white halo around each
  // image. 215 still rejects typical tan/beige borders (e.g. #BFB49D =
  // 191,180,157) because every channel must be ≥ threshold.
  const threshold = options.threshold ?? 215;
  const minArea = width * height * (options.minAreaRatio ?? 0.01);
  const expectedCount = Math.max(1, Math.floor(grid.rows) * Math.floor(grid.cols));
  const visited = new Uint8Array(width * height);
  const components: Array<Rect & { area: number; touchesEdge: boolean }> = [];

  const isLight = (pixelIndex: number) => {
    const i = pixelIndex * 4;
    const alpha = data[i + 3] ?? 255;
    return (
      alpha > 180 &&
      (data[i] ?? 0) >= threshold &&
      (data[i + 1] ?? 0) >= threshold &&
      (data[i + 2] ?? 0) >= threshold
    );
  };

  for (let start = 0; start < width * height; start++) {
    if (visited[start] || !isLight(start)) continue;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    let touchesEdge = false;
    const queue = [start];
    visited[start] = 1;

    for (let q = 0; q < queue.length; q++) {
      const idx = queue[q];
      const x = idx % width;
      const y = Math.floor(idx / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      area++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesEdge = true;
      }

      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];

      for (const next of neighbors) {
        if (next < 0 || visited[next] || !isLight(next)) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    if (!touchesEdge && area >= minArea) {
      components.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        area,
        touchesEdge,
      });
    }
  }

  return components
    .sort((a, b) => b.area - a.area)
    .slice(0, expectedCount)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
    .map(({ x, y, width, height }) => ({ x, y, width, height }));
}
