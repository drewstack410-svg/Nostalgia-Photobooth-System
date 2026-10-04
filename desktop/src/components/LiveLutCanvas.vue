<script setup lang="ts">
/**
 * Live camera feed with the capture LUT / tone. GPU atlas when possible
 * so the viewfinder can stay near 60fps; CPU applyCaptureLook otherwise.
 */
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { ParsedLut } from "@/utils/lut";
import {
  applyCaptureLook,
  drawCoverMedia,
} from "@/utils/applyCaptureLook";
import { createLiveLutGl, type LiveLutGl } from "@/utils/liveLutGl";
import type { FilterAdjustments } from "@/utils/filterPreview";
import type { LrSpatialLook } from "@/utils/lightroomSpatial";

const props = withDefaults(
  defineProps<{
    lut: ParsedLut | null;
    effectType?: string;
    baseFilter?: string;
    video?: HTMLVideoElement | null;
    frameSrc?: string | null;
    cssFilter?: string;
    mirror?: boolean;
    adjustments?: FilterAdjustments | null;
    lrSpatial?: LrSpatialLook | null;
    maxEdge?: number;
  }>(),
  { cssFilter: "none", mirror: false, maxEdge: 960, effectType: "original" },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const frameImg = ref<HTMLImageElement | null>(null);
let raf = 0;
let running = false;
let drawing = false;
let gpu: LiveLutGl | null = null;
let gpuTried = false;
const gpuReady = ref(false);
let ctx2d: CanvasRenderingContext2D | null = null;

watch(
  () => props.frameSrc,
  (src) => {
    if (!src) return;
    const img = frameImg.value;
    if (img && img.src !== src) img.src = src;
  },
);

function pushFrame(src: string) {
  const img = frameImg.value;
  if (img && img.src !== src) img.src = src;
}

function source(): {
  media: CanvasImageSource;
  w: number;
  h: number;
} | null {
  const video = props.video;
  if (video && video.readyState >= 2 && video.videoWidth >= 2) {
    return { media: video, w: video.videoWidth, h: video.videoHeight };
  }
  const img = frameImg.value;
  if (img && img.complete && img.naturalWidth >= 2) {
    return { media: img, w: img.naturalWidth, h: img.naturalHeight };
  }
  return null;
}

function destSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(1.25, window.devicePixelRatio || 1);
  let w = Math.max(2, Math.round(rect.width * dpr));
  let h = Math.max(2, Math.round(rect.height * dpr));
  const cap = props.maxEdge ?? 960;
  const edge = Math.max(w, h);
  if (edge > cap) {
    const s = cap / edge;
    w = Math.max(2, Math.round(w * s));
    h = Math.max(2, Math.round(h * s));
  }
  return { w, h };
}

function ensureGpu(canvas: HTMLCanvasElement): LiveLutGl | null {
  if (gpu) return gpu;
  if (gpuTried) return null;
  gpuTried = true;
  gpu = createLiveLutGl(canvas);
  gpuReady.value = !!gpu;
  return gpu;
}

function paintCpu(
  canvas: HTMLCanvasElement,
  src: { media: CanvasImageSource; w: number; h: number },
  w: number,
  h: number,
) {
  if (!ctx2d) {
    ctx2d = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }
  if (!ctx2d) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx2d.save();
  if (props.mirror) {
    ctx2d.translate(w, 0);
    ctx2d.scale(-1, 1);
  }
  drawCoverMedia(ctx2d, src.media, w, h);
  ctx2d.restore();
  const adj = props.adjustments;
  applyCaptureLook(ctx2d, {
    effectType: props.effectType || "original",
    baseFilter: props.baseFilter,
    lut: props.lut,
    overlay: null,
    adjustments: adj ? { ...adj, grain: 0 } : null,
    lrSpatial: props.lrSpatial,
    skipSpatial: true,
  });
}

function tick() {
  if (!running) return;
  raf = requestAnimationFrame(tick);
  if (drawing) return;
  const canvas = canvasRef.value;
  const src = source();
  if (!canvas || !src) return;
  const { w, h } = destSize(canvas);
  drawing = true;
  try {
    const useLut = !!(props.lut && props.lut.size > 1);
    const gl = useLut && !ctx2d ? ensureGpu(canvas) : null;
    if (gl) {
      const ok = gl.draw(
        src.media as TexImageSource,
        src.w,
        src.h,
        w,
        h,
        useLut ? props.lut : null,
        !!props.mirror,
      );
      if (ok) {
        gpuReady.value = true;
        return;
      }
      gpuReady.value = false;
    }
    paintCpu(canvas, src, w, h);
  } finally {
    drawing = false;
  }
}

onMounted(() => {
  running = true;
  raf = requestAnimationFrame(tick);
});

onUnmounted(() => {
  running = false;
  cancelAnimationFrame(raf);
  gpu?.destroy();
  gpu = null;
  gpuTried = false;
  gpuReady.value = false;
  ctx2d = null;
});

defineExpose({ pushFrame });
</script>

<template>
  <canvas
    ref="canvasRef"
    class="live-lut-canvas"
    :style="{
      filter:
        gpuReady && cssFilter && cssFilter !== 'none' ? cssFilter : undefined,
    }"
  />
  <img
    v-if="frameSrc"
    ref="frameImg"
    class="live-lut-src js-canon-evf"
    :src="frameSrc"
    alt=""
  />
</template>

<style scoped>
.live-lut-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  z-index: 0;
  background: #000;
}
.live-lut-src {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
</style>
