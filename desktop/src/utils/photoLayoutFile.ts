/**
 * Import / export for the photo-slot layout editor.
 * Slots stay fractional (0–1 of the print area), same as TemplateCell.
 */
import type { TemplateCell } from "@/stores/photobooth";
import type { PaperSize } from "@/utils/printLayout";

export const PHOTO_LAYOUT_KIND = "nostalgia-photo-layout";
export const PHOTO_LAYOUT_VERSION = 1;

export type PhotoLayoutFile = {
  kind: typeof PHOTO_LAYOUT_KIND;
  version: number;
  name?: string;
  photoCount?: number;
  paperSize?: PaperSize;
  cells: TemplateCell[];
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
  return {
    x: clamp(x, -0.5, 1.5),
    y: clamp(y, -0.5, 1.5),
    w: clamp(w, 0.01, 1),
    h: clamp(h, 0.01, 1),
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
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

export function serializePhotoLayout(input: {
  name?: string;
  photoCount?: number;
  paperSize?: PaperSize;
  cells: TemplateCell[];
}): PhotoLayoutFile {
  return {
    kind: PHOTO_LAYOUT_KIND,
    version: PHOTO_LAYOUT_VERSION,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    ...(input.photoCount && input.photoCount > 0
      ? { photoCount: input.photoCount }
      : {}),
    ...(input.paperSize ? { paperSize: input.paperSize } : {}),
    cells: input.cells.map((c) => ({
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      rotation: c.rotation || 0,
    })),
  };
}

export function parsePhotoLayoutFile(raw: unknown): TemplateCell[] {
  let list: unknown[] | null = null;
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
  }
  if (!list) {
    throw new Error("That file has no photo slots to import.");
  }
  const cells = list.map(parseCell).filter((c): c is TemplateCell => !!c);
  if (!cells.length) {
    throw new Error("That layout file has no valid photo slots.");
  }
  return cells;
}

export function parsePhotoLayoutJson(text: string): TemplateCell[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  return parsePhotoLayoutFile(raw);
}
