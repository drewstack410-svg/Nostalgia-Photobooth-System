<script setup lang="ts">
import { computed, ref, watch } from "vue";
import CornerOrnament from "@/components/CornerOrnament.vue";

const props = withDefaults(
  defineProps<{
    showFrame?: boolean;
    hideWoodenFrame?: boolean;
    showVintageBg?: boolean;
    showFilmRoll?: boolean;
    /**
     * Which decorative film-strip arrangement to use:
     *  - "home"    → the two parallel diagonal strips (title screen)
     *  - "payment" → symmetric "V": both strips angle inward from the
     *    bottom corners, matching the v2 Payment design.
     */
    filmRollVariant?: "home" | "payment";
  }>(),
  { filmRollVariant: "home" },
);

const filmRollReady = ref(false);

// The decorative film strips scroll a fixed, curated set of sepia sample
// photos (bundled in public/home-strip/) taken from the client's "Pic
// scroll" animation — NOT live customer captures.
//
// GEOMETRY, measured off that source video at 1920x1080:
//   • frames are PORTRAIT 5:6 (~251 x 300 px) — NOT 4:3 landscape
//   • strip is 251px wide perpendicular (281px of on-screen width)
//   • strip is tilted 27deg from vertical, constant width (no taper)
// The CSS below reproduces those numbers. Rendering these portrait
// photos in landscape frames is what read as "compressed".
// To swap the imagery, replace 1.jpg … N.jpg (keep them 5:6) and
// update PHOTO_COUNT.
const PHOTO_COUNT = 8;
const CURATED_PHOTOS = Array.from(
  { length: PHOTO_COUNT },
  (_, i) => `${import.meta.env.BASE_URL}home-strip/${i + 1}.jpg`,
);

const leftFilmPhotos = computed(() =>
  CURATED_PHOTOS.map((url, i) => ({
    id: `curated-left-${i}`,
    dataUrl: url,
    timestamp: new Date(),
  })),
);

// Right strip uses the same set in reverse order so the two strips
// don't look identical as they scroll.
const rightFilmPhotos = computed(() =>
  [...CURATED_PHOTOS].reverse().map((url, i) => ({
    id: `curated-right-${i}`,
    dataUrl: url,
    timestamp: new Date(),
  })),
);

// Start animation when film roll becomes visible (on title screen), including when navigating to title
watch(
  () => props.showFilmRoll,
  (show) => {
    if (show) {
      const t = setTimeout(() => {
        filmRollReady.value = true;
      }, 100);
      return () => clearTimeout(t);
    }
  },
  { immediate: true },
);
</script>

<template>
  <!-- Wooden border as main background/frame (hidden when title has custom bg) -->
  <div
    class="vintage-theme wooden-frame"
    :class="{ 'wooden-frame--hidden': hideWoodenFrame }"
  >
    <!-- Vintage bg container inset 10px - main content area (film rolls inside so they don't overlap wood border) -->
    <div
      class="app-container"
      :class="[{ 'vintage-bg': showVintageBg }, `film-variant-${filmRollVariant}`]"
    >
      <!-- Left Film Roll -->
      <div v-if="showFilmRoll" class="film-roll film-roll-left">
        <div class="film-roll-inner" :class="{ animate: filmRollReady }">
          <div
            v-for="(photo, index) in leftFilmPhotos"
            :key="photo.id"
            class="film-frame"
            :style="{ animationDelay: `${index * 0.1}s` }"
          >
            <div class="film-photo">
              <img
                v-if="photo.dataUrl"
                :src="photo.dataUrl"
                alt="Recent photo"
              />
              <div v-else class="film-placeholder"></div>
            </div>
          </div>
          <div
            v-for="photo in leftFilmPhotos"
            :key="'dup-' + photo.id"
            class="film-frame"
          >
            <div class="film-photo">
              <img
                v-if="photo.dataUrl"
                :src="photo.dataUrl"
                alt="Recent photo"
              />
              <div v-else class="film-placeholder"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Right Film Roll -->
      <div v-if="showFilmRoll" class="film-roll film-roll-right">
        <div
          class="film-roll-inner reverse"
          :class="{ animate: filmRollReady }"
        >
          <div
            v-for="photo in rightFilmPhotos"
            :key="photo.id"
            class="film-frame"
          >
            <div class="film-photo">
              <img
                v-if="photo.dataUrl"
                :src="photo.dataUrl"
                alt="Recent photo"
              />
              <div v-else class="film-placeholder"></div>
            </div>
          </div>
          <div
            v-for="photo in rightFilmPhotos"
            :key="'dup-' + photo.id"
            class="film-frame"
          >
            <div class="film-photo">
              <img
                v-if="photo.dataUrl"
                :src="photo.dataUrl"
                alt="Recent photo"
              />
              <div v-else class="film-placeholder"></div>
            </div>
          </div>
        </div>
      </div>

      <slot />
    </div>

    <!-- Resizable border overlay - hidden on admin panel -->
    <div v-if="showFrame" class="frame-border" aria-hidden="true">
      <div class="frame-edge frame-edge-top"></div>
      <div class="frame-edge frame-edge-right"></div>
      <div class="frame-edge frame-edge-bottom"></div>
      <div class="frame-edge frame-edge-left"></div>
    </div>

    <!-- Corner ornaments - hidden on admin panel -->
    <CornerOrnament v-if="showFrame" position="top-left" />
    <CornerOrnament v-if="showFrame" position="top-right" />
    <CornerOrnament v-if="showFrame" position="bottom-left" />
    <CornerOrnament v-if="showFrame" position="bottom-right" />
  </div>
</template>

<style scoped>
/* Wooden frame - full viewport with wood.svg as background; app text color */
.wooden-frame {
  height: 100vh;
  width: 100vw;
  background: url("/wood.svg") center/cover no-repeat;
  padding: 10px;
  box-sizing: border-box;
  position: relative;
  color: var(--color-brown-dark);
}

.wooden-frame--hidden {
  padding: 0;
  background: transparent;
}

/* App content area: default background and text color (vintage theme) */
.app-container {
  height: 100%;
  width: 100%;
  overflow: hidden;
  position: relative;
  background-color: var(--color-cream);
  color: var(--color-brown-dark);
}

/* Vintage paper texture - when showVintageBg is true */
.app-container.vintage-bg {
  background-color: var(--color-cream);
  background-image:
    linear-gradient(rgba(245, 240, 225, 0.9), rgba(245, 240, 225, 0.9)),
    radial-gradient(
      ellipse at 20% 30%,
      rgba(139, 115, 85, 0.05) 0%,
      transparent 50%
    ),
    radial-gradient(
      ellipse at 80% 70%,
      rgba(139, 115, 85, 0.05) 0%,
      transparent 50%
    ),
    linear-gradient(rgba(255, 248, 220, 0.85), rgba(255, 248, 220, 0.85));
  background-size: auto, auto, auto;
  background-position:
    0 0,
    0 0,
    0 0;
  background-repeat: repeat, repeat, repeat;
}

.app-container.vintage-bg::before {
  content: "";
  position: absolute;
  inset: 0;
  background: url("/background-texture.svg") center / cover no-repeat;
  mix-blend-mode: soft-light;
  pointer-events: none;
  z-index: 0;
}

/* Resizable border overlay - 4 separate edges, corners left open for ornaments */
.frame-border {
  --frame-inset-top: 26px;
  --frame-inset-right: 26px;
  --frame-inset-bottom: 26px;
  --frame-inset-left: 25px;
  --frame-corner-gap: 150px; /* gap at corners - adjust to align with ornaments */
  --frame-width-top-bottom: 4px;
  --frame-width-left-right: 5px;
  position: absolute;
  top: var(--frame-inset-top);
  right: var(--frame-inset-right);
  bottom: var(--frame-inset-bottom);
  left: var(--frame-inset-left);
  pointer-events: none;
  z-index: 5;
}

.frame-edge {
  position: absolute;
  background: var(--color-cream-dark);
  border-radius: 9999px;
}

.frame-edge-top {
  top: 0;
  left: var(--frame-corner-gap);
  right: var(--frame-corner-gap);
  height: var(--frame-width-top-bottom);
}

.frame-edge-right {
  top: var(--frame-corner-gap);
  right: 0;
  bottom: var(--frame-corner-gap);
  width: var(--frame-width-left-right);
}

.frame-edge-bottom {
  bottom: 0;
  left: var(--frame-corner-gap);
  right: var(--frame-corner-gap);
  height: var(--frame-width-top-bottom);
}

.frame-edge-left {
  top: var(--frame-corner-gap);
  bottom: var(--frame-corner-gap);
  left: 0;
  width: var(--frame-width-left-right);
}

/* Film Rolls */
.film-roll {
  position: absolute;
  top: 0;
  bottom: 0;
  /* Exactly the source animation's strip: 251px perpendicular (281px of
     on-screen width once tilted 27deg) on a 1920-wide screen. With the
     3px rails below this yields a 245x294 photo inside a 251x300 frame —
     the source's measured numbers. */
  width: 251px;
  overflow: hidden;
  z-index: 6;
}

/* -27deg matches the source animation exactly: both strips there run at
   a slope of 0.507 px across per px down (atan = 27deg from vertical),
   with constant width. The previous -35deg was 8deg too steep. */
.film-roll-left {
  bottom: -100px;
  left: 450px;
  transform: rotate(-27deg) translateX(-100px);
  transform-origin: bottom left;
}

.film-roll-right {
  top: -250px;
  right: 300px;
  transform: rotate(-27deg) translateX(-100px);
  transform-origin: top right;
}

/* Payment variant — symmetric "V": each strip is anchored at a TOP
   corner and angled inward toward the bottom-centre, so together they
   frame the content in a wide-top funnel (mirrors the v2 Payment
   design). The strips run past the bottom edge; the app-container
   clips the overflow. */
/* Payment deliberately has NO overrides: it uses the exact same parallel
   -27deg arrangement as Home, because that is what the client's source
   animation does — both strips lean the same way.
   This previously mirrored them into a symmetric "V" (left +24deg,
   right -24deg), which put the left strip at the opposite tilt to the
   source. That was the "mali orientation" the client reported. */

.film-roll-inner {
  display: flex;
  flex-direction: column;
}

.film-roll-inner.animate {
  animation: filmScroll 30s linear infinite;
}

.film-roll-inner.reverse.animate {
  animation: filmScrollReverse 30s linear infinite;
}

@keyframes filmScroll {
  0% {
    transform: translateY(0);
  }
  100% {
    transform: translateY(-50%);
  }
}

@keyframes filmScrollReverse {
  0% {
    transform: translateY(-50%);
  }
  100% {
    transform: translateY(0);
  }
}

.film-frame {
  display: flex;
  align-items: stretch;
  background: var(--color-brown-light);
  /* Hairline rails: in the source the photos very nearly fill the strip
     width and butt together with only a thin line between them. 3px all
     round gives a 245x294 photo in a 251x300 frame. */
  padding: 3px;
}

.film-photo {
  flex: 1;
  /* PORTRAIT 5:6 — measured off the source animation (frames are
     ~251 x 300 px). This was previously 4:3 landscape, which squashed
     and cropped the portrait source photos: the "compressed" look.
     NOTE: no min-height — it silently overrode aspect-ratio on any
     strip narrower than 168px. */
  aspect-ratio: 5/6;
  background: var(--color-cream);
  overflow: hidden;
}

.film-photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* The bundled curated photos are already sepia-toned, so no extra
     colour filter is applied here. */
}

.film-placeholder {
  width: 100%;
  height: 100%;
  background: var(--color-cream);
}

@media (max-width: 1200px) {
  .film-roll {
    /* Scaled down proportionally from 251px; aspect-ratio keeps the
       frames 5:6 so nothing is cropped at any size. */
    width: 190px;
  }
}
</style>
