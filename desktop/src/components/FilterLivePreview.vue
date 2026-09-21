<script setup lang="ts">
/**
 * Live webcam preview of a camera filter — base look, overlay, grain,
 * and the advanced adjustment sliders — so the operator can tune
 * Settings → Filters without walking the guest shooting screen.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { CameraFilter } from "@/stores/photobooth";
import { usePhotoboothStore } from "@/stores/photobooth";
import {
  openVideoStream,
  stopWebcamTracks,
  webcamErrorMessage,
} from "@/utils/openCamera";
import { loadLut } from "@/utils/lut";
import type { ParsedLut } from "@/utils/lut";
import {
  applyCaptureLook,
  drawCoverMedia,
} from "@/utils/applyCaptureLook";
import {
  BW_MATRIX,
  FUJIFILM_MATRIX,
  SEPIA_MATRIX,
  applyFilmGrainToImageData,
  buildAdjustmentTable,
  glowPreviewSvg,
  grainPreviewOpacity,
  saturationPreviewAmount,
  vignettePreviewStyle,
} from "@/utils/filterPreview";
import FilterOverlayLayers from "@/components/FilterOverlayLayers.vue";
import LiveLutCanvas from "@/components/LiveLutCanvas.vue";

const props = withDefaults(
  defineProps<{
    filter: CameraFilter | null;
    /** Fill the parent instead of a fixed 3:2 box. */
    fill?: boolean;
    /** Show “Live preview” label and filter name under the frame. */
    chrome?: boolean;
  }>(),
  { fill: false, chrome: true },
);

const store = usePhotoboothStore();
const videoRef = ref<HTMLVideoElement | null>(null);
const stream = ref<MediaStream | null>(null);
const liveViewFrame = ref("");
const usingCanon = ref(false);
const cameraError = ref("");
const stillSrc = ref("");
const isCountingDown = ref(false);
const isReviewing = ref(false);
const showFlash = ref(false);
const countdownValue = ref(0);
const freezeCountdown = ref(0);
const overlayLayersRef = ref<{
  mediaEl: HTMLImageElement | HTMLVideoElement | null;
} | null>(null);
const liveImgRef = ref<HTMLImageElement | null>(null);
const FILTER_ID = "filter-studio-preview";
let shotGen = 0;

const adj = computed(() =>
  props.filter ? store.resolvedAdjustments(props.filter) : store.DEFAULT_ADJUSTMENTS,
);

const parsedLut = ref<ParsedLut | null>(null);
const lutPreviewActive = computed(
  () => props.filter?.effectType === "cube" && !!parsedLut.value,
);

const matrixFor = (kind?: string) => {
  if (kind === "sepia") return SEPIA_MATRIX;
  if (kind === "bw") return BW_MATRIX;
  if (kind === "fujifilm") return FUJIFILM_MATRIX;
  return null;
};

const previewMatrix = computed(() => {
  const f = props.filter;
  if (!f || f.effectType === "original") return null;
  if (f.effectType === "cube") {
    if (lutPreviewActive.value) return null;
    return matrixFor(f.baseFilter);
  }
  return matrixFor(f.effectType);
});

const adjustmentTable = computed(() => buildAdjustmentTable(adj.value));

const glowSvg = computed(() => glowPreviewSvg(adj.value.glow));
const saturationAmount = computed(() =>
  saturationPreviewAmount(adj.value.saturation),
);

const hasPreviewFilter = computed(
  () =>
    !!previewMatrix.value ||
    !!adjustmentTable.value ||
    !!saturationAmount.value ||
    !!glowSvg.value,
);

const liveFilter = computed(() =>
  hasPreviewFilter.value ? `url(#${FILTER_ID})` : "none",
);

const overlayStyle = computed(() => {
  const o = props.filter?.overlay;
  if (!o || o.opacity <= 0) return null;
  return {
    backgroundColor: o.color,
    mixBlendMode: o.blendMode,
    opacity: String(o.opacity),
  } as Record<string, string>;
});

const mediaRuntime = computed(() => {
  const id = props.filter?.id;
  if (!id) return null;
  return store.overlayMediaRuntime[id] ?? null;
});

const mediaStyle = computed(() => {
  const o = props.filter?.mediaOverlay;
  if (!o || !mediaRuntime.value || o.opacity <= 0) return null;
  return {
    mixBlendMode: o.blendMode,
    opacity: String(o.opacity),
  } as Record<string, string>;
});

const grainStyle = computed(() => {
  if (lutPreviewActive.value) return null;
  const opacity = grainPreviewOpacity(adj.value.grain);
  if (opacity <= 0) return null;
  return { opacity: String(opacity) };
});

const vignetteStyle = computed(() =>
  lutPreviewActive.value ? null : vignettePreviewStyle(adj.value.vignette),
);

watch(
  () => props.filter,
  async (f) => {
    if (!f || f.effectType !== "cube") {
      parsedLut.value = null;
      return;
    }
    const cubeData = await store.ensureFilterCubeData(f);
    if (!cubeData) {
      parsedLut.value = null;
      return;
    }
    try {
      parsedLut.value = await loadLut(cubeData);
    } catch {
      parsedLut.value = null;
    }
  },
  { immediate: true, deep: true },
);

async function startCanonPreview(): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.canonCheckAvailable || !store.cameraDetectionEnabled) return false;
  try {
    const available = await api.canonCheckAvailable();
    if (!available.available) return false;
    const listed = await api.canonListCameras();
    if (!listed.success || !listed.cameras?.length) {
      console.log("[FilterPreview] No Canon cameras found");
      return false;
    }
    const connected = await api.canonConnect(0);
    if (!connected.success) {
      console.warn("[FilterPreview] Canon connect failed:", connected.error);
      return false;
    }
    const live = await api.canonStartLiveView();
    if (!live.success) {
      console.warn("[FilterPreview] Canon live view failed:", live.error);
      return false;
    }
    api.onLiveViewFrame((dataUrl: string) => {
      liveViewFrame.value = dataUrl;
    });
    usingCanon.value = true;
    console.log("[FilterPreview] Canon live view:", connected.cameraName);
    return true;
  } catch (err) {
    console.warn("[FilterPreview] Canon detection failed:", err);
    return false;
  }
}

async function startWebcamPreview() {
  const media = await openVideoStream(stream.value);
  stream.value = media;
  await nextTick();
  if (videoRef.value) {
    videoRef.value.srcObject = media;
    videoRef.value.muted = true;
    await videoRef.value.play().catch(() => {});
  }
}

async function startPreview() {
  cameraError.value = "";
  liveViewFrame.value = "";
  usingCanon.value = false;
  if (store.cameraDetectionEnabled) {
    if (await startCanonPreview()) return;
    console.log("[FilterPreview] No Canon camera — falling back to webcam");
  }
  try {
    await startWebcamPreview();
  } catch (err) {
    cameraError.value = webcamErrorMessage(err);
  }
}

const testShotBusy = computed(
  () => isCountingDown.value || isReviewing.value,
);

const canTestShot = computed(
  () => !!(stream.value || liveViewFrame.value),
);

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function captureSource(): CanvasImageSource | null {
  if (videoRef.value && videoRef.value.readyState >= 2) return videoRef.value;
  if (liveImgRef.value && liveImgRef.value.naturalWidth >= 2) {
    return liveImgRef.value;
  }
  return null;
}

function lookMediaSource(): CanvasImageSource | null {
  const el = overlayLayersRef.value?.mediaEl;
  if (el instanceof HTMLVideoElement && el.readyState >= 2) return el;
  if (el instanceof HTMLImageElement && el.complete && el.naturalWidth >= 2) {
    return el;
  }
  return null;
}

function grabTestStill(): string | null {
  const src = captureSource();
  if (!src) return null;
  let sw = 1280;
  let sh = 720;
  if (src instanceof HTMLVideoElement) {
    sw = src.videoWidth;
    sh = src.videoHeight;
  } else if (src instanceof HTMLImageElement) {
    sw = src.naturalWidth;
    sh = src.naturalHeight;
  }
  if (sw < 2 || sh < 2) return null;
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * scale));
  const h = Math.max(2, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawCoverMedia(ctx, src, w, h);
  const f = props.filter;
  const media = f?.mediaOverlay;
  const mediaEl = lookMediaSource();
  applyCaptureLook(ctx, {
    effectType: f?.effectType ?? "original",
    baseFilter: f?.baseFilter,
    lut: parsedLut.value,
    overlay:
      f?.overlay && f.overlay.opacity > 0
        ? {
            color: f.overlay.color,
            blendMode: f.overlay.blendMode,
            opacity: f.overlay.opacity,
          }
        : null,
    media:
      media && mediaEl && media.opacity > 0
        ? {
            source: mediaEl,
            blendMode: media.blendMode,
            opacity: media.opacity,
          }
        : null,
    adjustments: f ? store.resolvedAdjustments(f) : null,
    lrSpatial: f?.lrSpatial,
  });
  if (f) {
    const a = store.resolvedAdjustments(f);
    if (a.grain > 0) {
      const imageData = ctx.getImageData(0, 0, w, h);
      applyFilmGrainToImageData(
        imageData,
        a.grain,
        f.lrSpatial?.grainSize ?? 25,
        f.lrSpatial?.grainFreq ?? 50,
      );
      ctx.putImageData(imageData, 0, 0);
    }
  }
  return canvas.toDataURL("image/jpeg", 0.92);
}

async function runTestShot() {
  if (testShotBusy.value || !canTestShot.value) return;
  const gen = ++shotGen;
  const poseSeconds = store.shootingFirstCountdownSeconds;
  stillSrc.value = "";
  isReviewing.value = false;
  isCountingDown.value = true;
  for (let n = poseSeconds; n >= 1; n--) {
    if (gen !== shotGen) return;
    countdownValue.value = n;
    await sleepMs(1000);
  }
  if (gen !== shotGen) return;
  isCountingDown.value = false;
  showFlash.value = true;
  await sleepMs(120);
  showFlash.value = false;
  if (gen !== shotGen) return;
  const shot = grabTestStill();
  if (gen !== shotGen) return;
  if (!shot) return;
  stillSrc.value = shot;
  isReviewing.value = true;
  const previewSeconds = store.shootingPreviewCountdownSeconds;
  for (let n = previewSeconds; n >= 1; n--) {
    if (gen !== shotGen) return;
    freezeCountdown.value = n;
    await sleepMs(1000);
  }
  if (gen !== shotGen) return;
  isReviewing.value = false;
  stillSrc.value = "";
}

onMounted(() => {
  void startPreview();
});

onUnmounted(() => {
  shotGen += 1;
  stopWebcamTracks(stream.value);
  stream.value = null;
  if (usingCanon.value) {
    window.electronAPI?.offLiveViewFrame?.();
    void window.electronAPI?.canonStopLiveView?.();
  }
});

defineExpose({
  runTestShot,
  testShotBusy,
  canTestShot,
});
</script>

<template>
  <div class="flp" :class="{ 'flp--fill': fill, 'flp--bare': !chrome }">
    <p v-if="chrome" class="flp-label">Live preview</p>
    <div class="flp-frame">
      <svg class="flp-defs" aria-hidden="true" focusable="false" width="0" height="0">
        <filter
          :id="FILTER_ID"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          color-interpolation-filters="sRGB"
        >
          <feColorMatrix
            v-if="previewMatrix"
            type="matrix"
            :values="previewMatrix"
          />
          <feComponentTransfer v-if="adjustmentTable">
            <feFuncR type="table" :tableValues="adjustmentTable" />
            <feFuncG type="table" :tableValues="adjustmentTable" />
            <feFuncB type="table" :tableValues="adjustmentTable" />
          </feComponentTransfer>
          <feColorMatrix
            v-if="saturationAmount"
            type="saturate"
            :values="saturationAmount"
          />
          <feOffset v-if="glowSvg" dx="0" dy="0" result="preGlow" />
          <feColorMatrix
            v-if="glowSvg"
            in="preGlow"
            type="matrix"
            :values="glowSvg.extract"
            result="glowHi"
          />
          <feGaussianBlur
            v-if="glowSvg"
            in="glowHi"
            :stdDeviation="glowSvg.blur"
            result="glowBlur"
          />
          <feComponentTransfer v-if="glowSvg" in="glowBlur" result="glowAmt">
            <feFuncR type="linear" :slope="glowSvg.slopeR" intercept="0" />
            <feFuncG type="linear" :slope="glowSvg.slopeG" intercept="0" />
            <feFuncB type="linear" :slope="glowSvg.slopeB" intercept="0" />
          </feComponentTransfer>
          <feBlend v-if="glowSvg" in="preGlow" in2="glowAmt" mode="screen" />
        </filter>
      </svg>
      <img
        v-if="liveViewFrame"
        ref="liveImgRef"
        class="flp-video"
        :class="{ 'flp-video--hidden': lutPreviewActive }"
        :src="liveViewFrame"
        :style="{ filter: lutPreviewActive ? 'none' : liveFilter }"
        alt=""
      />
      <video
        v-else-if="stream"
        ref="videoRef"
        class="flp-video"
        :class="{ 'flp-video--hidden': lutPreviewActive }"
        :srcObject="stream"
        :style="{ filter: lutPreviewActive ? 'none' : liveFilter }"
        autoplay
        muted
        playsinline
      />
      <LiveLutCanvas
        v-if="lutPreviewActive"
        :lut="parsedLut"
        :base-filter="filter?.baseFilter"
        :video="stream ? videoRef : null"
        :frame-src="stream ? null : liveViewFrame || null"
        :css-filter="'none'"
        :adjustments="adj"
        :lr-spatial="filter?.lrSpatial"
      />
      <p v-if="!liveViewFrame && !stream" class="flp-placeholder">
        {{ cameraError || "Opening camera…" }}
      </p>
      <FilterOverlayLayers
        ref="overlayLayersRef"
        :overlay-style="isReviewing ? null : overlayStyle"
        :media-url="isReviewing ? null : mediaRuntime?.url"
        :media-kind="mediaRuntime?.type"
        :media-style="isReviewing ? null : mediaStyle"
        :vignette-style="isReviewing ? null : vignetteStyle"
        :grain-style="isReviewing ? null : grainStyle"
      />
      <img
        v-if="stillSrc"
        class="flp-still"
        :src="stillSrc"
        alt=""
      />
      <div v-if="showFlash" class="flp-flash" />
      <div v-if="isCountingDown" class="flp-countdown" aria-live="assertive">
        <div class="flp-countdown-number">{{ countdownValue }}</div>
      </div>
      <div v-if="isReviewing" class="flp-preview-cd">
        <p class="flp-preview-cd-label">Preview</p>
        <div class="flp-preview-cd-number">{{ freezeCountdown }}</div>
      </div>
    </div>
    <p v-if="chrome" class="flp-hint">
      {{ filter ? filter.name : "Select a filter" }}
    </p>
  </div>
</template>

<style scoped>
.flp {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.flp--fill {
  flex: 1;
  min-height: 0;
  height: 100%;
}

.flp--fill .flp-label,
.flp--fill .flp-hint {
  font-size: 0.75rem;
}

.flp--fill .flp-frame,
.flp--bare .flp-frame {
  flex: 1;
  min-height: 0;
  aspect-ratio: auto;
}

.flp--bare {
  gap: 0;
}

.flp--bare .flp-frame {
  border-radius: 0;
  box-shadow: none;
}

.flp-label {
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0;
}

.flp-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 2;
  background: #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
  isolation: isolate;
  box-shadow: var(--shadow-medium);
}

.flp-defs {
  position: absolute;
  width: 0;
  height: 0;
  pointer-events: none;
}

.flp-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.flp-video--hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.flp-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 1rem;
  text-align: center;
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.85rem;
}

.flp-still {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  z-index: 2;
}

.flp-flash {
  position: absolute;
  inset: 0;
  z-index: 4;
  background: #fff;
  pointer-events: none;
}

.flp-countdown {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}

.flp-countdown-number {
  font-family: var(--font-display);
  font-size: clamp(4rem, 22vw, 9rem);
  font-weight: 700;
  color: #fff;
  text-shadow: 0 0 48px rgba(201, 162, 39, 0.8);
  animation: flpCountPulse 1s ease-in-out infinite;
}

@keyframes flpCountPulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.08);
    opacity: 0.85;
  }
}

.flp-preview-cd {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 3.4rem;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  pointer-events: none;
}

.flp-preview-cd-label {
  margin: 0;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: #f4e6c3;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.85);
}

.flp-preview-cd-number {
  font-family: var(--font-display);
  font-size: 2.4rem;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.9);
}

.flp-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-brown);
  text-align: center;
}
</style>
