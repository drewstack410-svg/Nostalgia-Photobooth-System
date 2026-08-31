<script setup lang="ts">
/**
 * Colour wash + image/video overlay + vignette + grain, stacked in the
 * same order capture bakes them (tone/LUT is on the feed underneath).
 * Isolation on the parent (.camera-feed / .flp-frame) is what keeps
 * mix-blend-mode blending against the photo, not the page behind it.
 */
import { nextTick, ref, watch } from "vue";
import type { OverlayMediaKind } from "@/stores/photobooth";

const props = defineProps<{
  overlayStyle?: Record<string, string> | null;
  mediaUrl?: string | null;
  mediaKind?: OverlayMediaKind | null;
  mediaStyle?: Record<string, string> | null;
  vignetteStyle?: Record<string, string> | null;
  grainStyle?: Record<string, string> | null;
}>();

const mediaEl = ref<HTMLImageElement | HTMLVideoElement | null>(null);

function bindMediaEl(el: Element | null) {
  mediaEl.value = el as HTMLImageElement | HTMLVideoElement | null;
}

async function playOverlayVideo() {
  await nextTick();
  const el = mediaEl.value;
  if (el instanceof HTMLVideoElement) {
    el.muted = true;
    el.loop = true;
    await el.play().catch(() => {});
  }
}

watch(
  () => [props.mediaUrl, props.mediaKind] as const,
  () => {
    void playOverlayVideo();
  },
  { immediate: true },
);

defineExpose({ mediaEl });
</script>

<template>
  <div
    v-if="overlayStyle"
    class="filter-stack-color"
    :style="overlayStyle"
    aria-hidden="true"
  />
  <img
    v-if="mediaUrl && mediaKind === 'image' && mediaStyle"
    :ref="bindMediaEl"
    class="filter-stack-media"
    :src="mediaUrl"
    :style="mediaStyle"
    alt=""
    aria-hidden="true"
  />
  <video
    v-else-if="mediaUrl && mediaKind === 'video' && mediaStyle"
    :ref="bindMediaEl"
    class="filter-stack-media"
    :src="mediaUrl"
    :style="mediaStyle"
    autoplay
    muted
    loop
    playsinline
    aria-hidden="true"
  />
  <div
    v-if="vignetteStyle"
    class="filter-stack-vignette"
    :style="vignetteStyle"
    aria-hidden="true"
  />
  <div
    v-if="grainStyle"
    class="filter-stack-grain"
    :style="grainStyle"
    aria-hidden="true"
  />
</template>

<style scoped>
.filter-stack-color,
.filter-stack-media,
.filter-stack-vignette,
.filter-stack-grain {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.filter-stack-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.filter-stack-grain {
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 140px 140px;
}
</style>
