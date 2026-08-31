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
import {
  BW_MATRIX,
  FUJIFILM_MATRIX,
  SEPIA_MATRIX,
  buildAdjustmentTable,
  buildCubePreview,
  grainPreviewOpacity,
  vignettePreviewStyle,
} from "@/utils/filterPreview";
import type { CubePreview } from "@/utils/filterPreview";
import FilterOverlayLayers from "@/components/FilterOverlayLayers.vue";

const props = defineProps<{
  filter: CameraFilter | null;
}>();

const store = usePhotoboothStore();
const videoRef = ref<HTMLVideoElement | null>(null);
const stream = ref<MediaStream | null>(null);
const liveViewFrame = ref("");
const usingCanon = ref(false);
const cameraError = ref("");
const FILTER_ID = "filter-studio-preview";

const adj = computed(() =>
  props.filter ? store.resolvedAdjustments(props.filter) : store.DEFAULT_ADJUSTMENTS,
);

const cubeCurves = ref<CubePreview | null>(null);

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
    if (cubeCurves.value) return BW_MATRIX;
    return matrixFor(f.baseFilter);
  }
  return matrixFor(f.effectType);
});

const adjustmentTable = computed(() => buildAdjustmentTable(adj.value));

const hasPreviewFilter = computed(
  () => !!previewMatrix.value || !!cubeCurves.value || !!adjustmentTable.value,
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
  const opacity = grainPreviewOpacity(adj.value.grain);
  if (opacity <= 0) return null;
  return { opacity: String(opacity) };
});

const vignetteStyle = computed(() => vignettePreviewStyle(adj.value.vignette));

watch(
  () => props.filter,
  async (f) => {
    if (!f || f.effectType !== "cube" || !f.cubeData) {
      cubeCurves.value = null;
      return;
    }
    try {
      const lut = await loadLut(f.cubeData);
      cubeCurves.value = buildCubePreview(lut, f.baseFilter);
    } catch {
      cubeCurves.value = null;
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

onMounted(() => {
  void startPreview();
});

onUnmounted(() => {
  stopWebcamTracks(stream.value);
  stream.value = null;
  if (usingCanon.value) {
    window.electronAPI?.offLiveViewFrame?.();
    void window.electronAPI?.canonStopLiveView?.();
  }
});
</script>

<template>
  <div class="flp">
    <p class="flp-label">Live preview</p>
    <div class="flp-frame">
      <svg class="flp-defs" aria-hidden="true" focusable="false" width="0" height="0">
        <filter :id="FILTER_ID" color-interpolation-filters="sRGB">
          <feColorMatrix
            v-if="previewMatrix"
            type="matrix"
            :values="previewMatrix"
          />
          <feComponentTransfer v-if="cubeCurves">
            <feFuncR type="table" :tableValues="cubeCurves.r" />
            <feFuncG type="table" :tableValues="cubeCurves.g" />
            <feFuncB type="table" :tableValues="cubeCurves.b" />
          </feComponentTransfer>
          <feComponentTransfer v-if="adjustmentTable">
            <feFuncR type="table" :tableValues="adjustmentTable" />
            <feFuncG type="table" :tableValues="adjustmentTable" />
            <feFuncB type="table" :tableValues="adjustmentTable" />
          </feComponentTransfer>
        </filter>
      </svg>
      <img
        v-if="liveViewFrame"
        class="flp-video"
        :src="liveViewFrame"
        :style="{ filter: liveFilter }"
        alt=""
      />
      <video
        v-else-if="stream"
        ref="videoRef"
        class="flp-video"
        :srcObject="stream"
        :style="{ filter: liveFilter }"
        autoplay
        muted
        playsinline
      />
      <p v-else class="flp-placeholder">
        {{ cameraError || "Opening camera…" }}
      </p>
      <FilterOverlayLayers
        :overlay-style="overlayStyle"
        :media-url="mediaRuntime?.url"
        :media-kind="mediaRuntime?.type"
        :media-style="mediaStyle"
        :vignette-style="vignetteStyle"
        :grain-style="grainStyle"
      />
    </div>
    <p class="flp-hint">
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

.flp-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-brown);
  text-align: center;
}
</style>
