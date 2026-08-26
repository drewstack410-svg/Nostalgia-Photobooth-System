<script setup lang="ts">
/**
 * Live webcam preview of a camera filter — base look, overlay, grain,
 * and the advanced adjustment sliders — so the operator can tune
 * Settings → Filters without walking the guest shooting screen.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { CameraFilter } from "@/stores/photobooth";
import { usePhotoboothStore } from "@/stores/photobooth";
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

const props = defineProps<{
  filter: CameraFilter | null;
}>();

const store = usePhotoboothStore();
const videoRef = ref<HTMLVideoElement | null>(null);
const stream = ref<MediaStream | null>(null);
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

const grainStyle = computed(() => {
  const opacity = grainPreviewOpacity(adj.value.grain);
  if (opacity <= 0) return null;
  return { opacity: String(opacity) };
});

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

onMounted(async () => {
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    stream.value = media;
    await nextTick();
    if (videoRef.value) {
      videoRef.value.srcObject = media;
      await videoRef.value.play();
    }
  } catch (err) {
    cameraError.value =
      err instanceof Error ? err.message : "Could not open the camera.";
  }
});

onUnmounted(() => {
  stream.value?.getTracks().forEach((t) => t.stop());
  stream.value = null;
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
      <video
        v-if="stream"
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
      <div v-if="overlayStyle" class="flp-overlay" :style="overlayStyle" />
      <div v-if="grainStyle" class="flp-grain" :style="grainStyle" />
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

.flp-overlay,
.flp-grain {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.flp-grain {
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 140px 140px;
}

.flp-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-brown);
  text-align: center;
}
</style>
