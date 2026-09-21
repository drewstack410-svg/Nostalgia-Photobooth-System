<script setup lang="ts">
/**
 * Live camera feed with the same 3D LUT / vignette / grain path as capture.
 * SVG 1D curves cannot show Lightroom mixer, split-tone, or film grain.
 */
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { ParsedLut } from "@/utils/lut";
import {
  applyCaptureLook,
  drawCoverMedia,
} from "@/utils/applyCaptureLook";
import {
  applyFilmGrainToImageData,
  type FilterAdjustments,
} from "@/utils/filterPreview";
import type { LrSpatialLook } from "@/utils/lightroomSpatial";

const MAX_EDGE = 960;

const props = withDefaults(
  defineProps<{
    lut: ParsedLut | null;
    baseFilter?: string;
    video?: HTMLVideoElement | null;
    frameSrc?: string | null;
    cssFilter?: string;
    mirror?: boolean;
    adjustments?: FilterAdjustments | null;
    lrSpatial?: LrSpatialLook | null;
  }>(),
  { cssFilter: "none", mirror: false },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const frameImg = ref<HTMLImageElement | null>(null);
let raf = 0;
let running = false;

watch(
  () => props.frameSrc,
  (src) => {
    if (!src) return;
    const img = frameImg.value;
    if (img && img.src !== src) img.src = src;
  },
);

function source(): CanvasImageSource | null {
  const video = props.video;
  if (video && video.readyState >= 2 && video.videoWidth >= 2) return video;
  const img = frameImg.value;
  if (img && img.naturalWidth >= 2) return img;
  return null;
}

function tick() {
  if (!running) return;
  const canvas = canvasRef.value;
  const src = source();
  if (canvas && src && props.lut) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      let w = Math.max(2, Math.round(rect.width * dpr));
      let h = Math.max(2, Math.round(rect.height * dpr));
      const edge = Math.max(w, h);
      if (edge > MAX_EDGE) {
        const s = MAX_EDGE / edge;
        w = Math.max(2, Math.round(w * s));
        h = Math.max(2, Math.round(h * s));
      }
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      ctx.save();
      if (props.mirror) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      drawCoverMedia(ctx, src, w, h);
      ctx.restore();

      const adj = props.adjustments;
      applyCaptureLook(ctx, {
        effectType: "cube",
        baseFilter: props.baseFilter,
        lut: props.lut,
        overlay: null,
        adjustments: adj ? { ...adj, grain: 0 } : null,
        lrSpatial: props.lrSpatial,
        skipSpatial: true,
      });
      if (adj && adj.grain > 0) {
        const imageData = ctx.getImageData(0, 0, w, h);
        applyFilmGrainToImageData(
          imageData,
          adj.grain,
          props.lrSpatial?.grainSize ?? 25,
          props.lrSpatial?.grainFreq ?? 50,
        );
        ctx.putImageData(imageData, 0, 0);
      }
    }
  }
  raf = requestAnimationFrame(tick);
}

onMounted(() => {
  running = true;
  raf = requestAnimationFrame(tick);
});

onUnmounted(() => {
  running = false;
  cancelAnimationFrame(raf);
});
</script>

<template>
  <canvas
    ref="canvasRef"
    class="live-lut-canvas"
    :style="{ filter: cssFilter && cssFilter !== 'none' ? cssFilter : undefined }"
  />
  <img
    v-if="frameSrc"
    ref="frameImg"
    class="live-lut-src"
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
}
.live-lut-src {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
</style>
