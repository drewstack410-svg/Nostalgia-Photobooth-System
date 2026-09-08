/**
 * Import / export for a full template package: photo slots plus the
 * PNG (or JPEG) layout overlay. Slots stay fractional (0–1 of the
 * print area), same as TemplateCell.
 */
import type { TemplateCell } from "@/stores/photobooth";
import { getFrameWindows } from "@/utils/frameWindows";
import {
  isPaperSize,
  PAPER_SIZES,
  type PaperSize,
} from "@/utils/printLayout";

export const PHOTO_LAYOUT_KIND = "nostalgia-photo-layout";
export const PHOTO_LAYOUT_VERSION = 2;

export type PhotoLayoutFile = {
  kind: typeof PHOTO_LAYOUT_KIND;
  version: number;
  name?: string;
  photoCount?: number;
  paperSize?: PaperSize;
  cells: TemplateCell[];
  /** Overlay artwork as a data URL so the package is self-contained. */
  frameImage?: string;
  layout?: "vertical" | "horizontal";
  frameRows?: number;
  frameCols?: number;
  cellMargin?: number;
  cellGap?: number;
  cellZoom?: number;
  fitMode?: "cover" | "contain";
  cellOffsetX?: number;
  cellOffsetY?: number;
  thumbnailDefault?: string;
  thumbnailActive?: string;
};

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function parseCell(raw: unknown): TemplateCell | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const x = Number(o.x);
  const y = Number(o.y);
  const w = Number(o.w);
  const h = Number(o.h);
  const rotation = Number(o.rotation ?? 0);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0 || h <= 0) return null;
  const shotRaw = Number(o.shot);
  const shot =
    Number.isFinite(shotRaw) && shotRaw >= 1 ? Math.floor(shotRaw) : undefined;
  return {
    x: clamp(x, -0.5, 1.5),
    y: clamp(y, -0.5, 1.5),
    w: clamp(w, 0.01, 1),
    h: clamp(h, 0.01, 1),
    rotation: Number.isFinite(rotation) ? rotation : 0,
    ...(shot ? { shot } : {}),
  };
}

/** The number painted on a slot — explicit `shot` wins over position. */
export function cellShotNumber(
  cell: TemplateCell | undefined,
  index: number,
  photoCount: number,
): number {
  if (typeof cell?.shot === "number" && cell.shot > 0) return Math.floor(cell.shot);
  return (index % Math.max(1, photoCount)) + 1;
}

/** 0-based capture index for compositing / live preview. */
export function cellCaptureIndex(
  cell: TemplateCell | undefined,
  index: number,
  photoCount: number,
): number {
  const n = Math.max(1, photoCount);
  return (cellShotNumber(cell, index, n) - 1) % n;
}

export function stampCellShots(
  cells: TemplateCell[],
  photoCount: number,
): TemplateCell[] {
  const n = Math.max(1, photoCount);
  return cells.map((c, i) => ({
    ...c,
    shot: cellShotNumber(c, i, n),
  }));
}

export function layoutFileSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "photo-layout"
  );
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:image\//i.test(value);
}

export async function embedImageAsDataUrl(
  url: string | undefined | null,
): Promise<string | undefined> {
  if (!url) return undefined;
  if (isImageDataUrl(url)) return url;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not read the layout image.");
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function serializePhotoLayout(input: {
  name?: string;
  photoCount?: number;
  paperSize?: PaperSize;
  cells: TemplateCell[];
  frameImage?: string;
  layout?: "vertical" | "horizontal";
  frameRows?: number;
  frameCols?: number;
  cellMargin?: number;
  cellGap?: number;
  cellZoom?: number;
  fitMode?: "cover" | "contain";
  cellOffsetX?: number;
  cellOffsetY?: number;
  thumbnailDefault?: string;
  thumbnailActive?: string;
}): PhotoLayoutFile {
  return {
    kind: PHOTO_LAYOUT_KIND,
    version: PHOTO_LAYOUT_VERSION,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.photoCount && input.photoCount > 0
      ? { photoCount: input.photoCount }
      : {}),
    ...(input.paperSize ? { paperSize: input.paperSize } : {}),
    ...(isImageDataUrl(input.frameImage)
      ? { frameImage: input.frameImage }
      : {}),
    ...(isImageDataUrl(input.thumbnailDefault)
      ? { thumbnailDefault: input.thumbnailDefault }
      : {}),
    ...(isImageDataUrl(input.thumbnailActive)
      ? { thumbnailActive: input.thumbnailActive }
      : {}),
    ...(input.layout ? { layout: input.layout } : {}),
    ...(input.frameRows && input.frameRows > 0
      ? { frameRows: input.frameRows }
      : {}),
    ...(input.frameCols && input.frameCols > 0
      ? { frameCols: input.frameCols }
      : {}),
    ...(input.cellMargin !== undefined ? { cellMargin: input.cellMargin } : {}),
    ...(input.cellGap !== undefined ? { cellGap: input.cellGap } : {}),
    ...(input.cellZoom !== undefined ? { cellZoom: input.cellZoom } : {}),
    ...(input.fitMode ? { fitMode: input.fitMode } : {}),
    ...(input.cellOffsetX !== undefined ? { cellOffsetX: input.cellOffsetX } : {}),
    ...(input.cellOffsetY !== undefined ? { cellOffsetY: input.cellOffsetY } : {}),
    cells: input.cells.map((c, i) => ({
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      rotation: c.rotation || 0,
      shot: cellShotNumber(c, i, input.photoCount || input.cells.length),
    })),
  };
}

export function downloadPhotoLayoutFile(
  payload: PhotoLayoutFile,
  filename: string,
) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export type PhotoLayoutDocument = {
  cells: TemplateCell[];
  photoCount?: number;
  name?: string;
  paperSize?: PaperSize;
  frameImage?: string;
  layout?: "vertical" | "horizontal";
  frameRows?: number;
  frameCols?: number;
  cellMargin?: number;
  cellGap?: number;
  cellZoom?: number;
  fitMode?: "cover" | "contain";
  cellOffsetX?: number;
  cellOffsetY?: number;
  thumbnailDefault?: string;
  thumbnailActive?: string;
};

function parseOptionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parsePhotoLayoutDocument(raw: unknown): PhotoLayoutDocument {
  let list: unknown[] | null = null;
  let photoCount: number | undefined;
  let name: string | undefined;
  let paperSize: PaperSize | undefined;
  let frameImage: string | undefined;
  let layout: "vertical" | "horizontal" | undefined;
  let frameRows: number | undefined;
  let frameCols: number | undefined;
  let cellMargin: number | undefined;
  let cellGap: number | undefined;
  let cellZoom: number | undefined;
  let fitMode: "cover" | "contain" | undefined;
  let cellOffsetX: number | undefined;
  let cellOffsetY: number | undefined;
  let thumbnailDefault: string | undefined;
  let thumbnailActive: string | undefined;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (
      o.kind != null &&
      o.kind !== PHOTO_LAYOUT_KIND &&
      o.kind !== "photo-layout"
    ) {
      throw new Error("That file is not a Nostalgia photo layout.");
    }
    if (Array.isArray(o.cells)) list = o.cells;
    else if (Array.isArray(o.slots)) list = o.slots;
    const n = Number(o.photoCount);
    if (Number.isFinite(n) && n >= 1) photoCount = Math.floor(n);
    if (typeof o.name === "string" && o.name.trim()) name = o.name.trim();
    if (isPaperSize(o.paperSize)) paperSize = o.paperSize;
    if (isImageDataUrl(o.frameImage)) frameImage = o.frameImage;
    else if (isImageDataUrl(o.frameImageUrl)) frameImage = o.frameImageUrl;
    if (o.layout === "vertical" || o.layout === "horizontal") layout = o.layout;
    const rows = parseOptionalNumber(o.frameRows);
    if (rows && rows >= 1) frameRows = Math.floor(rows);
    const cols = parseOptionalNumber(o.frameCols);
    if (cols && cols >= 1) frameCols = Math.floor(cols);
    const margin = parseOptionalNumber(o.cellMargin);
    if (margin !== undefined && margin >= 0) cellMargin = margin;
    const gap = parseOptionalNumber(o.cellGap);
    if (gap !== undefined && gap >= 0) cellGap = gap;
    const zoom = parseOptionalNumber(o.cellZoom);
    if (zoom !== undefined && zoom > 0) cellZoom = zoom;
    if (o.fitMode === "cover" || o.fitMode === "contain") fitMode = o.fitMode;
    const ox = parseOptionalNumber(o.cellOffsetX);
    if (ox !== undefined) cellOffsetX = ox;
    const oy = parseOptionalNumber(o.cellOffsetY);
    if (oy !== undefined) cellOffsetY = oy;
    if (isImageDataUrl(o.thumbnailDefault)) thumbnailDefault = o.thumbnailDefault;
    else if (isImageDataUrl(o.thumbnailDefaultUrl)) {
      thumbnailDefault = o.thumbnailDefaultUrl;
    }
    if (isImageDataUrl(o.thumbnailActive)) thumbnailActive = o.thumbnailActive;
    else if (isImageDataUrl(o.thumbnailActiveUrl)) {
      thumbnailActive = o.thumbnailActiveUrl;
    }
  }
  const cells = list
    ? list.map(parseCell).filter((c): c is TemplateCell => !!c)
    : [];
  if (!cells.length && !frameImage) {
    throw new Error("That file has no photo slots or layout image to import.");
  }
  const count =
    photoCount ||
    (cells.length
      ? Math.max(cells.length, ...cells.map((c) => c.shot || 0), 1)
      : undefined);
  return {
    cells: cells.length && count ? stampCellShots(cells, count) : cells,
    photoCount: count,
    name,
    paperSize,
    frameImage,
    layout,
    frameRows,
    frameCols,
    cellMargin,
    cellGap,
    cellZoom,
    fitMode,
    cellOffsetX,
    cellOffsetY,
    thumbnailDefault,
    thumbnailActive,
  };
}

export function parsePhotoLayoutFile(raw: unknown): TemplateCell[] {
  return parsePhotoLayoutDocument(raw).cells;
}

export function parsePhotoLayoutJson(text: string): TemplateCell[] {
  return parsePhotoLayoutDocumentJson(text).cells;
}

export function parsePhotoLayoutDocumentJson(text: string): PhotoLayoutDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  return parsePhotoLayoutDocument(raw);
}

function loadImageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    img.onerror = () => reject(new Error("Could not read that layout image."));
    img.src = src;
  });
}

function guessPaperSize(width: number, height: number): PaperSize {
  const aspect = width / Math.max(1, height);
  let best: PaperSize = height >= width ? "4x6-portrait" : "4x6-landscape";
  let bestDiff = Infinity;
  for (const key of Object.keys(PAPER_SIZES) as PaperSize[]) {
    const spec = PAPER_SIZES[key];
    const d = Math.abs(spec.width / spec.height - aspect);
    if (d < bestDiff) {
      bestDiff = d;
      best = key;
    }
  }
  return best;
}

function inferGrid(count: number, landscape: boolean): { rows: number; cols: number } {
  const n = Math.max(1, count);
  const known: [number, number][] = [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
    [3, 2],
    [2, 3],
    [4, 2],
    [2, 4],
    [3, 3],
    [4, 3],
    [3, 4],
    [4, 4],
  ];
  const match = known.find(([r, c]) => r * c === n);
  if (match) {
    const [rows, cols] = landscape && match[0] > match[1] ? [match[1], match[0]] : match;
    return { rows, cols };
  }
  const a = Math.ceil(Math.sqrt(n));
  const b = Math.ceil(n / a);
  return landscape ? { rows: Math.min(a, b), cols: Math.max(a, b) } : { rows: Math.max(a, b), cols: Math.min(a, b) };
}

export type LayoutPngTemplateDraft = {
  name: string;
  photoCount: number;
  paperSize: PaperSize;
  frameImageUrl: string;
  frameRows: number;
  frameCols: number;
  layout: "vertical" | "horizontal";
  cells?: TemplateCell[];
  cellMargin: number;
  cellGap: number;
  fitMode: "cover" | "contain";
};

/** Build a new template from a layout PNG (windows detected when possible). */
export async function draftTemplateFromLayoutPng(
  dataUrl: string,
  name: string,
): Promise<LayoutPngTemplateDraft> {
  const { w, h } = await loadImageSize(dataUrl);
  const paperSize = guessPaperSize(w, h);
  const landscape = w > h;
  const detected = await getFrameWindows(dataUrl);
  const windowCount = detected?.length ?? 0;
  const photoCount = windowCount > 0 ? windowCount : 4;
  const grid = inferGrid(photoCount, landscape);
  const cells =
    detected && detected.length
      ? stampCellShots(
          detected.map((r) => ({
            x: r.x / w,
            y: r.y / h,
            w: r.width / w,
            h: r.height / h,
            rotation: 0,
          })),
          photoCount,
        )
      : undefined;
  return {
    name,
    photoCount,
    paperSize,
    frameImageUrl: dataUrl,
    frameRows: grid.rows,
    frameCols: grid.cols,
    layout: landscape ? "horizontal" : "vertical",
    cells,
    cellMargin: 0,
    cellGap: 0,
    fitMode: "contain",
  };
}
