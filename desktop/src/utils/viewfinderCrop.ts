/**
 * Shared viewfinder crop: 3:2 camera frame, then the dimmed side bars
 * that match the selected template cell. Used by still capture, strip
 * video compose, and anything else that must agree with the live preview.
 */

import {
  getPaperSizePx,
  occupancyFill,
  type TemplateLayoutSpec,
} from "./printLayout";

/** 3:2 — the photobooth capture / live-view box. */
export const VIEW_ASPECT = 3 / 2;
/** Same 3:2 as a 3600×2400 still. */
export const PHOTO_ASPECT = 3600 / 2400;

export function highlightedViewRect(
  srcW: number,
  srcH: number,
  cropBarPct: number,
): { sx: number; sy: number; sw: number; sh: number } {
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  const srcAspect = srcW / srcH;
  if (srcAspect > VIEW_ASPECT + 0.001) {
    sw = srcH * VIEW_ASPECT;
    sx = (srcW - sw) / 2;
  } else if (srcAspect < VIEW_ASPECT - 0.001) {
    sh = srcW / VIEW_ASPECT;
    sy = (srcH - sh) / 2;
  }
  const bar = Math.max(0, Math.min(0.45, cropBarPct / 100));
  if (bar > 0) {
    sx += sw * bar;
    sw *= 1 - 2 * bar;
  }
  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.max(1, Math.min(srcW - sx, Math.round(sw)));
  sh = Math.max(1, Math.min(srcH - sy, Math.round(sh)));
  return { sx, sy, sw, sh };
}

/** Percent cropped off each side of the 3:2 view for this template. */
export function cropBarPercentForTemplate(
  t: TemplateLayoutSpec | null | undefined,
): number {
  if (!t) return 16.6667;
  const sheet = getPaperSizePx(t.paperSize);
  let cellW: number;
  let cellH: number;
  if (t.cells?.[0]) {
    cellW = t.cells[0].w * sheet.width;
    cellH = t.cells[0].h * sheet.height;
  } else {
    const cols = Math.max(1, t.frameCols ?? 1);
    const rows = Math.max(1, t.frameRows ?? 1);
    const margin = t.cellMargin ?? 24;
    const gap = t.cellGap ?? 24;
    cellW = (sheet.width - margin * 2 - gap * (cols - 1)) / cols;
    cellH = (sheet.height - margin * 2 - gap * (rows - 1)) / rows;
  }
  if (cellW <= 0 || cellH <= 0) return 16.6667;
  const { zoom } = occupancyFill(t, (t.cells?.length ?? 0) > 0);
  const visibleW = Math.min(1, cellW / cellH / (PHOTO_ASPECT * zoom));
  return Math.max(0, (1 - visibleW) / 2) * 100;
}
