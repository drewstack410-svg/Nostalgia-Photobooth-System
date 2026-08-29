<script setup lang="ts">
/**
 * TemplatePreview – Renders a single photo-strip template as thumbnail, frame overlay, or built-in strip.
 * Used in template picker (full size), admin settings (mini), and anywhere a template needs to be shown.
 */
import { computed, ref, watch } from "vue";
import type { Template } from "@/stores/photobooth";
import { prepareFrameDataUrl } from "@/utils/pngAlpha";

const props = defineProps<{
  template: Template;
  /** "full" for picker/carousel, "mini" for admin list. */
  size?: "full" | "mini";
  /** Highlights the preview (e.g. selected template in picker). */
  active?: boolean;
  /** Use active thumbnail when true (e.g. admin list); otherwise default thumbnail. */
  preferActiveThumbnail?: boolean;
}>();

const isVertical = computed(() => props.template.layout === "vertical");
const isHorizontal = computed(() => props.template.layout === "horizontal");

/** Resolves which image to show: custom default/active thumbnails, or null for frame/strip fallback. */
const thumbnailUrl = computed(() => {
  if (props.template.thumbnailDefaultUrl ?? props.template.thumbnailActiveUrl) {
    const useActive =
      (props.active && props.size === "full") || props.preferActiveThumbnail;
    return useActive && props.template.thumbnailActiveUrl
      ? props.template.thumbnailActiveUrl
      : (props.template.thumbnailDefaultUrl ??
          props.template.thumbnailActiveUrl ??
          "");
  }
  return null;
});

const displayFrameUrl = ref("");
watch(
  () => props.template.frameImageUrl,
  async (url) => {
    displayFrameUrl.value = url || "";
    if (!url) return;
    try {
      displayFrameUrl.value = await prepareFrameDataUrl(url);
    } catch {
      /* keep the original src */
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="template-preview-root" :class="`template-preview-root--${size}`">
    <!-- 1. Custom thumbnails (template selection / admin) -->
    <div
      v-if="thumbnailUrl"
      class="preview-thumbnail"
      :class="[
        size === 'mini' ? 'preview-thumbnail--mini' : 'preview-thumbnail--full',
        isVertical
          ? 'preview-thumbnail--vertical'
          : 'preview-thumbnail--horizontal',
        { 'preview-thumbnail--active': active && size === 'full' },
      ]"
    >
      <img :src="thumbnailUrl" :alt="template.name" />
    </div>

    <!-- 2. Custom frame image (no thumbnails; frame only) -->
    <div
      v-else-if="displayFrameUrl"
      class="preview-frame-overlay"
      :class="[
        size === 'mini'
          ? 'preview-frame-overlay--mini'
          : 'preview-frame-overlay--full',
        isVertical
          ? 'preview-frame-overlay--vertical'
          : 'preview-frame-overlay--horizontal',
        { 'preview-frame-overlay--active': active && size === 'full' },
      ]"
    >
      <img :src="displayFrameUrl" alt="Frame" />
      <span v-if="size === 'mini'" class="preview-frame-overlay-badge"
        >{{ template.photoCount }} photos</span
      >
    </div>

    <!-- 3. Fallback: vertical strip (placeholder frames) -->
    <div
      v-else-if="isVertical"
      :class="[
        size === 'mini'
          ? 'preview-strip preview-strip--mini'
          : 'preview-strip preview-strip--full',
        { 'preview-strip--active': active && size === 'full' },
      ]"
    >
      <div v-for="n in template.photoCount" :key="n" class="preview-frame" />
    </div>

    <!-- 4. Fallback: horizontal strip (placeholder frames) -->
    <div
      v-else-if="isHorizontal"
      :class="[
        size === 'mini'
          ? 'preview-strip preview-strip--horizontal preview-strip--mini'
          : 'preview-strip preview-strip--horizontal preview-strip--full',
        { 'preview-strip--active': active && size === 'full' },
      ]"
    >
      <div v-for="n in template.photoCount" :key="n" class="preview-frame" />
    </div>
  </div>
</template>

<style scoped>
/* ---- Root ---- */
.template-preview-root {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* ---- Thumbnail mode (custom default/active images) ---- */
.preview-thumbnail {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}

.preview-thumbnail img {
  width: 100%;
  height: 100%;
  display: block;
}

.preview-thumbnail--full.preview-thumbnail--vertical {
  transition: all 0.3s ease;
  height: 500px;
  width: 100%;
  max-width: 200px;
  aspect-ratio: 2/3;
}

.preview-thumbnail--full.preview-thumbnail--vertical.preview-thumbnail--active {
  max-width: 280px;
  aspect-ratio: 2/3;
}

.preview-thumbnail--full.preview-thumbnail--horizontal {
  transition: all 0.3s ease;
  width: 100%;
  max-width: 360px;
  aspect-ratio: 16/9;
}

.preview-thumbnail--full.preview-thumbnail--horizontal.preview-thumbnail--active {
  max-width: 440px;
  aspect-ratio: 16/9;
}

.preview-thumbnail--mini.preview-thumbnail--vertical {
  width: 100%;
  max-width: 88px;
  aspect-ratio: 2/3;
}

.preview-thumbnail--mini.preview-thumbnail--horizontal {
  width: 100%;
  max-width: 116px;
  aspect-ratio: 16/9;
}

/* ---- Frame overlay (custom frame image, no placeholders) ---- */
.preview-frame-overlay {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}

.preview-frame-overlay img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.preview-frame-overlay--full.preview-frame-overlay--vertical {
  width: 100%;
  max-width: 180px;
  aspect-ratio: 2/3;
  transition: all 0.3s ease;
}

.preview-frame-overlay--full.preview-frame-overlay--vertical.preview-frame-overlay--active {
  max-width: 280px;
  aspect-ratio: 2/3;
}

.preview-frame-overlay--full.preview-frame-overlay--horizontal {
  width: 100%;
  max-width: 240px;
  aspect-ratio: 16/9;
  transition: all 0.3s ease;
}

.preview-frame-overlay--full.preview-frame-overlay--horizontal.preview-frame-overlay--active {
  max-width: 440px;
  aspect-ratio: 16/9;
}

.preview-frame-overlay--mini.preview-frame-overlay--vertical {
  width: 100%;
  max-width: 88px;
  aspect-ratio: 2/3;
}

.preview-frame-overlay--mini.preview-frame-overlay--horizontal {
  width: 100%;
  max-width: 116px;
  aspect-ratio: 16/9;
}

.preview-frame-overlay-badge {
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--font-body);
  font-size: 0.7rem;
  color: var(--color-brown-dark);
  background: var(--color-cream);
  padding: 2px 6px;
  border-radius: 4px;
}

/* ---- Strip layout (full: TemplateSelect carousel; compact, viewport-scaled) ---- */
.preview-strip--full {
  --full-frame-w: clamp(118px, 14vmin, 260px);
  --full-frame-h: clamp(151px, 18vmin, 340px);
  --full-gap: clamp(24px, 4vmin, 56px);
  --full-pad-vert: clamp(16px, 2.5vmin, 36px);
  --full-pad-horz: clamp(10px, 1.5vmin, 24px);
  padding-left: var(--full-pad-horz);
  padding-right: var(--full-pad-horz);
  padding-top: var(--full-pad-vert);
  padding-bottom: var(--full-pad-vert);
  background: var(--color-cream-dark);
  border: 2px solid var(--color-brown-light);
  display: flex;
  flex-direction: column;
  gap: var(--full-gap);
  transition: all 0.3s ease;
}

.preview-strip--horizontal.preview-strip--full {
  flex-direction: row;
  width: max-content;
  min-width: min-content;
  --full-frame-w: clamp(92px, 13vmin, 230px);
  --full-frame-h: clamp(72px, 10vmin, 180px);
  width: clamp(140px, 20vmin, 340px) !important;
  padding-left: var(--full-pad-vert);
  padding-right: var(--full-pad-vert);
  padding-top: var(--full-pad-horz);
  padding-bottom: var(--full-pad-horz);
}

.preview-strip--horizontal.preview-strip--full.preview-strip--active {
  --full-frame-w: clamp(160px, 22vmin, 380px);
  --full-frame-h: clamp(120px, 16vmin, 280px);
  width: clamp(220px, 32vmin, 480px) !important;
  padding-left: clamp(16px, 2.5vmin, 36px);
  padding-right: clamp(16px, 2.5vmin, 36px);
  padding-top: clamp(12px, 2vmin, 28px);
  padding-bottom: clamp(12px, 2vmin, 28px);
}

.preview-strip--full.preview-strip--active {
  --full-frame-w: clamp(140px, 18vmin, 280px);
  --full-frame-h: clamp(178px, 24vmin, 360px);
  --full-gap: clamp(20px, 3vmin, 44px);
  --full-pad-vert: clamp(16px, 2.5vmin, 36px);
  --full-pad-horz: clamp(12px, 1.5vmin, 24px);
  padding-left: var(--full-pad-horz);
  padding-right: var(--full-pad-horz);
  padding-top: var(--full-pad-vert);
  padding-bottom: var(--full-pad-vert);
  border-color: var(--color-brown-dark);
  box-shadow: var(--shadow-medium);
}

.preview-strip--full .preview-frame {
  width: var(--full-frame-w);
  height: var(--full-frame-h);
  background: var(--color-cream);
  border: 1px solid var(--color-brown-light);
}

/* ---- Strip layout (mini: admin panel list, compact) ---- */
.template-preview-root--mini {
  --mini-frame-w: 38px;
  --mini-frame-h: 28px;
  --mini-gap: 4px;
  --mini-pad: 5px;
  width: fit-content;
}

.preview-strip--mini {
  display: flex;
  flex-direction: column;
  gap: var(--mini-gap);
  padding: var(--mini-pad);
  background: var(--color-cream-dark);
  border: 1px solid var(--color-brown-light);
}

.preview-strip--horizontal.preview-strip--mini {
  flex-direction: row;
}

.preview-strip--mini .preview-frame {
  width: var(--mini-frame-w);
  height: var(--mini-frame-h);
  background: var(--color-cream);
  border: 1px solid var(--color-brown-light);
}
</style>
