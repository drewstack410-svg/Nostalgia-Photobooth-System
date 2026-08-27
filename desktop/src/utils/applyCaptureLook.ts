/**
 * Bake a camera look onto a canvas — same order as still capture:
 * tone/LUT → overlay → levels/vignette. Used by highlight clips so
 * the video matches the live preview / print filter.
 */

import { applyLutToImageData } from "./lut";
import type { ParsedLut } from "./lut";
import {
  applyAdjustmentsToImageData,
  type FilterAdjustments,
} from "./filterPreview";

export type LookOverlay = {
  color: string;
  blendMode: string;
  opacity: number;
};

export type CaptureLook = {
  effectType: string;
  baseFilter?: string;
  lut: ParsedLut | null;
  overlay: LookOverlay | null;
  adjustments: FilterAdjustments | null;
};

function applyPixelFilter(imageData: ImageData, type: string): void {
  const data = imageData.data;
  if (type === "sepia") {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      data[i] = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
      data[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
      data[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
    }
    return;
  }
  if (type === "bw") {
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.min(
        255,
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2],
      );
      data[i] = data[i + 1] = data[i + 2] = gray;
    }
    return;
  }
  if (type === "fujifilm") {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      data[i] = Math.min(255, (r + gray * 0.4) * 0.9);
      data[i + 1] = Math.min(255, (g + gray * 0.35) * 0.92);
      data[i + 2] = Math.min(255, (b + gray * 0.2) * 0.85);
    }
  }
}

export function applyCaptureLook(
  ctx: CanvasRenderingContext2D,
  look: CaptureLook,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (w < 2 || h < 2) return;

  const effect = look.effectType;
  const tone =
    effect === "sepia" || effect === "bw" || effect === "fujifilm";
  const cube = effect === "cube" && look.lut;
  if (tone || cube) {
    const imageData = ctx.getImageData(0, 0, w, h);
    if (tone) {
      applyPixelFilter(imageData, effect);
    } else if (look.lut) {
      if (look.baseFilter && look.baseFilter !== "original") {
        applyPixelFilter(imageData, look.baseFilter);
      }
      applyLutToImageData(imageData, look.lut);
    }
    ctx.putImageData(imageData, 0, 0);
  }

  const overlay = look.overlay;
  if (overlay && overlay.opacity > 0) {
    ctx.save();
    ctx.globalCompositeOperation =
      overlay.blendMode as GlobalCompositeOperation;
    ctx.globalAlpha = overlay.opacity;
    ctx.fillStyle = overlay.color;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  if (look.adjustments) {
    const adj = look.adjustments;
    if (adj.levels || adj.contrast || adj.shadows || adj.vignette) {
      const adjusted = ctx.getImageData(0, 0, w, h);
      applyAdjustmentsToImageData(adjusted, adj);
      ctx.putImageData(adjusted, 0, 0);
    }
  }
}
