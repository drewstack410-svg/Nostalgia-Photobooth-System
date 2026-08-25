<script setup lang="ts">
/**
 * TemplateLivePreview — renders the ACTUAL selected template: real
 * paper aspect, real cell grid, real frame artwork, with the captured
 * photos filling their own print cells as they are taken (slot 1 after
 * shot 1, and so on) and numbered placeholders for pending slots.
 *
 * Cell geometry comes from `getTemplateCellRects`, the same math
 * PrintingView.vue composites with, so the shooting screen shows what
 * actually comes out of the printer. Sibling to TemplatePreview.vue,
 * which renders the picker/admin *representations* (thumbnail art,
 * frame art, empty placeholder strip) and has no photo layer.
 */
import { computed, ref, watch } from "vue";
import type { Template } from "@/stores/photobooth";
import { getPaperSizePx, getTemplateCellRects } from "@/utils/printLayout";
import { getFrameWindows } from "@/utils/frameWindows";
import type { WindowRect } from "@/utils/frameWindows";

const props = withDefaults(
  defineProps<{
    template: Template;
    /**
     * Captured photo data URLs in capture order; shorter than the cell
     * count while the session is still shooting.
     */
    photos?: string[];
    /** Cell being shot right now (gold ring). Out of range hides it. */
    activeIndex?: number;
    /** Box the real sheet is contain-fit into, in px. Ignored when `fluid`. */
    maxWidth?: number;
    maxHeight?: number;
    /**
     * Contain-fit into the parent (which must be a CSS size container)
     * instead of a fixed pixel box, so the sheet scales with the layout.
     */
    fluid?: boolean;
  }>(),
  { photos: () => [], activeIndex: -1, maxWidth: 420, maxHeight: 620, fluid: false },
);

const sheet = computed(() => getPaperSizePx(props.template.paperSize));

// Contain-fit the native sheet into the allowed box so every paper size
// keeps its true aspect instead of being forced into one hardcoded
// ratio (the flaw in the old 4:3 placeholder frames). Fluid mode uses
// container query units against the parent instead of a px box.
const boxStyle = computed(() => {
  const s = sheet.value;
  if (props.fluid) {
    return { "--sheet-ar": String(s.width / s.height) };
  }
  const scale = Math.min(props.maxWidth / s.width, props.maxHeight / s.height);
  return {
    width: `${Math.round(s.width * scale)}px`,
    height: `${Math.round(s.height * scale)}px`,
  };
});

// The frame's REAL photo windows, read off its alpha channel. Same
// source of truth the print composite uses, so the guest sees exactly
// what comes out of the printer. Null until loaded / when unavailable.
const frameWindows = ref<WindowRect[] | null>(null);
const frameSize = ref<{ w: number; h: number } | null>(null);

watch(
  () => props.template.frameImageUrl,
  async (url) => {
    frameWindows.value = null;
    frameSize.value = null;
    if (!url) return;
    const expected =
      Math.max(1, props.template.frameRows ?? 0) *
      Math.max(1, props.template.frameCols ?? 0);
    const found = await getFrameWindows(url, expected > 1 ? expected : undefined);
    if (!found) return;
    // Window rects are in the frame's pixel space; record its size so
    // they can be expressed as percentages of the sheet below.
    const img = new Image();
    img.onload = () => {
      frameSize.value = { w: img.naturalWidth, h: img.naturalHeight };
      frameWindows.value = found;
    };
    img.src = url;
  },
  { immediate: true },
);

// Cell rects -> percentages of the sheet, so the layout is
// resolution-independent and the box above can be any size.
const cells = computed(() => {
  const s = sheet.value;
  const fw = frameWindows.value;
  const fs = frameSize.value;
  // Hand-placed slots from the layout editor outrank everything —
  // same precedence as PrintingView's composite, so what the guest
  // sees while shooting is what prints. Rotating the CELL (not just
  // the photo) rotates its overflow clip too, matching the canvas
  // rotating its clip path.
  const placed = props.template.cells;
  if (placed?.length) {
    return placed.map((c) => ({
      left: `${c.x * 100}%`,
      top: `${c.y * 100}%`,
      width: `${c.w * 100}%`,
      height: `${c.h * 100}%`,
      transform: c.rotation ? `rotate(${c.rotation}deg)` : undefined,
    }));
  }
  if (fw && fs) {
    return fw.map((r) => ({
      left: `${(r.x / fs.w) * 100}%`,
      top: `${(r.y / fs.h) * 100}%`,
      width: `${(r.width / fs.w) * 100}%`,
      height: `${(r.height / fs.h) * 100}%`,
    }));
  }
  return getTemplateCellRects(props.template).map((r) => ({
    left: `${(r.x / s.width) * 100}%`,
    top: `${(r.y / s.height) * 100}%`,
    width: `${(r.width / s.width) * 100}%`,
    height: `${(r.height / s.height) * 100}%`,
  }));
});

// object-fit:cover gives the cover-fit base size; scale() applies
// cellZoom about the centre — together identical to PrintingView's
// baseW/baseH x cellZoom, centred and clipped to the cell.
const photoStyle = computed(() => {
  // Mirrors the print composite exactly: zoom applies on both paths, and
  // the offset nudges the photo within its window (percentage of the
  // window, so it scales with the preview size).
  const t = props.template;
  const zoom = t.cellZoom ?? 1;
  const ox = t.cellOffsetX ?? 0;
  const oy = t.cellOffsetY ?? 0;
  return {
    transform: `translate(${ox}%, ${oy}%) scale(${zoom})`,
    objectFit: t.fitMode ?? "contain",
  };
});

// Shots the guest takes. A sheet may hold MORE cells than shots, in
// which case the captures repeat across it ("4 shots, 3 copies") —
// mirroring PrintingView's `loadedImages[i % count]`.
const shots = computed(() => {
  const t = props.template;
  if (t.photoCount != null && t.photoCount > 0) return t.photoCount;
  return Math.max(1, cells.value.length);
});

function photoFor(i: number): string | undefined {
  const s = shots.value;
  return s > 0 ? props.photos[i % s] : undefined;
}

// The next shot lands in EVERY cell that maps to it, so on a
// multi-copy sheet all of its copies pulse together.
const activeCells = computed(() => {
  const s = shots.value;
  if (props.activeIndex < 0 || props.activeIndex >= s) return [];
  return cells.value.filter((_, i) => i % s === props.activeIndex);
});
</script>

<template>
  <div class="tlp" :class="{ 'tlp--fluid': fluid }" :style="boxStyle">
    <!-- 1. One layer per print cell: the capture, or a numbered slot. -->
    <div
      v-for="(cell, i) in cells"
      :key="i"
      class="tlp-cell"
      :class="{ 'tlp-cell--empty': !photos[i] }"
      :style="cell"
    >
      <img
        v-if="photoFor(i)"
        class="tlp-photo"
        :src="photoFor(i)"
        :style="photoStyle"
        alt=""
      />
      <span v-else class="tlp-slot-num">{{ (i % shots) + 1 }}</span>
    </div>

    <!-- 2. Frame artwork on top — its transparent windows reveal the
            photos beneath, exactly as the print composite draws it
            (stretched to the print area, NOT contain-fit). -->
    <img
      v-if="template.frameImageUrl"
      class="tlp-frame"
      :src="template.frameImageUrl"
      alt=""
      aria-hidden="true"
    />

    <!-- 3. "Next shot lands here" ring, ABOVE the frame so an opaque
            frame border can't swallow it. -->
    <div
      v-for="(cell, i) in activeCells"
      :key="'active-' + i"
      class="tlp-active"
      :style="cell"
      aria-hidden="true"
    ></div>
  </div>
</template>

<style scoped>
.tlp {
  position: relative;
  /* White sheet, same as the print canvas's background fill. */
  background: #ffffff;
  overflow: hidden;
  box-shadow: var(--shadow-medium);
}

/* Largest size that fits the parent while keeping the real sheet aspect. */
.tlp--fluid {
  width: min(100cqw, calc(100cqh * var(--sheet-ar)));
  height: min(100cqh, calc(100cqw / var(--sheet-ar)));
}

.tlp-cell {
  position: absolute;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Pending slot: cream so it reads as an empty frame window. */
.tlp-cell--empty {
  background: var(--color-cream);
}

/* object-fit is bound from the template's fitMode so the shooting
   screen shows exactly what prints — contain (whole photo, letterboxed)
   by default, matching the print composite. */
.tlp-photo {
  width: 100%;
  height: 100%;
  object-position: center;
  display: block;
}

.tlp-slot-num {
  font-family: var(--font-display);
  font-size: 1.6rem;
  color: var(--color-brown-light);
}

.tlp-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}

.tlp-active {
  position: absolute;
  pointer-events: none;
  box-shadow:
    0 0 0 3px var(--color-gold),
    0 0 14px rgba(201, 162, 39, 0.7);
  animation: tlpPulse 1.4s ease-in-out infinite;
}

@keyframes tlpPulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
</style>
