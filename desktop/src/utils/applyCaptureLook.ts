/**
 * Bake a camera look onto a canvas — same order as still capture:
 * tone/LUT → colour wash → media overlay → levels/vignette. Used by
 * highlight clips so the video matches the live preview / print filter.
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

export type LookMedia = {
  source: CanvasImageSource;
  blendMode: string;
  opacity: number;
};

export type CaptureLook = {
  effectType: string;
  baseFilter?: string;
  lut: ParsedLut | null;
  overlay: LookOverlay | null;
  media?: LookMedia | null;
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

function mediaSourceSize(
  source: CanvasImageSource,
): { w: number; h: number } | null {
  if (source instanceof HTMLVideoElement) {
    if (source.readyState < 2 || source.videoWidth < 2) return null;
    return { w: source.videoWidth, h: source.videoHeight };
  }
  if (source instanceof HTMLImageElement) {
    if (!source.complete || source.naturalWidth < 2) return null;
    return { w: source.naturalWidth, h: source.naturalHeight };
  }
  if (source instanceof HTMLCanvasElement) {
    if (source.width < 2 || source.height < 2) return null;
    return { w: source.width, h: source.height };
  }
  return null;
}

/** object-fit: cover — fills the canvas, cropping overflow. */
export function drawCoverMedia(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  destW: number,
  destH: number,
): boolean {
  const size = mediaSourceSize(source);
  if (!size) return false;
  const scale = Math.max(destW / size.w, destH / size.h);
  const dw = size.w * scale;
  const dh = size.h * scale;
  ctx.drawImage(source, (destW - dw) / 2, (destH - dh) / 2, dw, dh);
  return true;
}

export function drawLookMedia(
  ctx: CanvasRenderingContext2D,
  media: CanvasImageSource,
  blendMode: string,
  opacity: number,
): void {
  if (opacity <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = (
    blendMode === "normal" ? "source-over" : blendMode
  ) as GlobalCompositeOperation;
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  drawCoverMedia(ctx, media, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
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

  if (look.media && look.media.opacity > 0) {
    drawLookMedia(
      ctx,
      look.media.source,
      look.media.blendMode || "normal",
      look.media.opacity,
    );
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
