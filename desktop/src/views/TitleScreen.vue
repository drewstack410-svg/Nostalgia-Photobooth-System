<script setup lang="ts">
import BoxButton from "@/components/BoxButton.vue";
import { computed, onMounted, ref, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";

const router = useRouter();
const store = usePhotoboothStore();

const logoSrc = computed(
  () => store.customLogoUrl || `${import.meta.env.BASE_URL}Logo.svg`,
);

// Exact "Click Here To Start" artwork from the client's Figma export.
const startBtnLabel = `${import.meta.env.BASE_URL}start-button-text.svg`;

// 1208px is the design's native wordmark width; the admin scale slider
// (Settings → Logo) multiplies it so an uploaded logo with different
// padding can be matched without re-exporting the artwork.
const logoWidth = computed(
  () => `min(90vw, ${Math.round(1208 * store.titleLogoScale)}px)`,
);

// Always true now: the client's animated background ships as the default,
// so the title screen always has background media (their own artwork)
// rather than the CSS film strips.
const hasCustomTitleBg = computed(() => !!store.effectiveTitleBackgroundUrl);

const isReady = ref(false);
const badgeClickCount = ref(0);
const badgeClickTimeout = ref<ReturnType<typeof setTimeout> | null>(null);

function startPhotobooth() {
  router.push("/templates");
}

// ── PIN gate (optional — admin sets a PIN in Settings) ─────────────
const showPinModal = ref(false);
const pinInput = ref("");
const pinError = ref(false);
let pinErrorTimeout: ReturnType<typeof setTimeout> | null = null;

function enterAdminPanel() {
  router.push("/admin");
}

function requestAdminAccess() {
  if (store.adminPin) {
    openPinModal();
  } else {
    enterAdminPanel();
  }
}

function openPinModal() {
  pinInput.value = "";
  pinError.value = false;
  showPinModal.value = true;
}

function closePinModal() {
  showPinModal.value = false;
  pinInput.value = "";
  pinError.value = false;
}

function onAdminHotkey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
    return;
  }

  if (showPinModal.value) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePinModal();
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      pressPinBackspace();
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      pressPinDigit(e.key);
    }
    return;
  }

  if (e.key === "x" || e.key === "X") {
    e.preventDefault();
    requestAdminAccess();
  }
}

function pressPinDigit(digit: string) {
  if (pinError.value) return;
  if (pinInput.value.length >= store.adminPin.length) return;
  pinInput.value += digit;
  if (pinInput.value.length === store.adminPin.length) {
    checkPin();
  }
}

function pressPinBackspace() {
  pinInput.value = pinInput.value.slice(0, -1);
}

function checkPin() {
  if (pinInput.value === store.adminPin) {
    closePinModal();
    enterAdminPanel();
  } else {
    pinError.value = true;
    if (pinErrorTimeout) clearTimeout(pinErrorTimeout);
    pinErrorTimeout = setTimeout(() => {
      pinInput.value = "";
      pinError.value = false;
    }, 600);
  }
}

/**
 * Hidden admin gesture — three taps on the invisible badge within 2
 * seconds, or pressing X on a keyboard, opens the admin panel. If an
 * admin PIN has been set in Settings, a PIN pad is shown first;
 * otherwise it goes straight through (matches the prior no-login
 * default for a booth that runs on-prem on operator-controlled
 * hardware).
 */
function handleBadgeClick() {
  badgeClickCount.value++;

  // Clear existing timeout
  if (badgeClickTimeout.value) {
    clearTimeout(badgeClickTimeout.value);
  }

  // Three taps → admin panel (PIN pad first, if one is configured).
  if (badgeClickCount.value >= 3) {
    badgeClickCount.value = 0;
    requestAdminAccess();
    return;
  }

  // Reset counter after 2 seconds of inactivity
  badgeClickTimeout.value = setTimeout(() => {
    badgeClickCount.value = 0;
  }, 2000);
}

onMounted(() => {
  setTimeout(() => {
    isReady.value = true;
  }, 100);
  window.addEventListener("keydown", onAdminHotkey);
});

onUnmounted(() => {
  if (badgeClickTimeout.value) {
    clearTimeout(badgeClickTimeout.value);
  }
  window.removeEventListener("keydown", onAdminHotkey);
});
</script>

<template>
  <div class="title-screen">
    <!-- Custom background (image or video) -->
    <div v-if="hasCustomTitleBg" class="title-screen-bg">
      <img
        v-if="store.effectiveTitleBackgroundType === 'image'"
        :src="store.effectiveTitleBackgroundUrl"
        alt=""
        class="title-screen-bg-media"
      />
      <video
        v-else
        :src="store.effectiveTitleBackgroundUrl"
        class="title-screen-bg-media"
        autoplay
        muted
        loop
        playsinline
      />
    </div>

    <!-- Center Content -->
    <div class="title-content" :class="{ show: isReady }">
      <div class="title-logo" :style="{ width: logoWidth }">
        <img :src="logoSrc" alt="Nostalgia Photobooth" />
      </div>
      <!-- The label is the client's own exported artwork (332x29), which
           carries the design's exact typeface, weight and warm-brown fill.
           Rendering it as text used Playfair Display, a high-contrast
           serif, where the design uses a bold grotesque. -->
      <BoxButton
        class="title-start-btn"
        :margin-top="`${Math.round(77 * store.startButtonScale)}px`"
        :style="{ '--start-btn-scale': store.startButtonScale }"
        :svg-src="`${startBtnLabel}`"
        @click="startPhotobooth"
      />
    </div>

    <!-- Hidden admin tap zone (Top Right) — no visible icon at all, just an
         invisible 3-tap target that opens the PIN pad. -->
    <div
      class="admin-badge"
      role="presentation"
      aria-hidden="true"
      @click="handleBadgeClick"
    ></div>

    <!-- Admin PIN pad -->
    <div v-if="showPinModal" class="pin-modal-overlay" @click="closePinModal">
      <div class="pin-modal" :class="{ 'pin-modal--error': pinError }" @click.stop>
        <h2 class="pin-modal-title">Enter Admin PIN</h2>
        <div class="pin-dots">
          <span
            v-for="i in store.adminPin.length"
            :key="i"
            class="pin-dot"
            :class="{ 'pin-dot--filled': i <= pinInput.length }"
          ></span>
        </div>
        <p v-if="pinError" class="pin-error-text">Incorrect PIN</p>
        <div class="pin-keypad">
          <button
            v-for="digit in ['1', '2', '3', '4', '5', '6', '7', '8', '9']"
            :key="digit"
            type="button"
            class="pin-key"
            @click="pressPinDigit(digit)"
          >
            {{ digit }}
          </button>
          <button type="button" class="pin-key pin-key--muted" @click="closePinModal">
            Cancel
          </button>
          <button type="button" class="pin-key" @click="pressPinDigit('0')">0</button>
          <button type="button" class="pin-key pin-key--muted" @click="pressPinBackspace">
            ⌫
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title-screen {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.title-screen-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.title-screen-bg-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Center Content */
.title-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  /* Figma puts the block's centre at 51.06% of canvas height (11.5px
     BELOW dead centre), wordmark top at 28.80%. */
  margin-top: -17px;
  z-index: 10;
  opacity: 0;
  transform: translateY(20px);
  transition: all 0.8s ease;
}

.title-content.show {
  opacity: 1;
  transform: translateY(0);
}

/* Start button — Figma: gold face 398.0 x 70.2 inside an 8.4px bezel
   (total 414.8 x 86.9), label ink 331.3 x 27.9 with 33.3px side padding.
   The `small` variant was rendering the whole thing 219 x 48. */
/* --start-btn-scale (Admin → Settings → Start button) multiplies the
   design metrics. The client found the full-size Figma button too large
   on the real 24" screen, so it defaults to 0.8. */
.title-start-btn :deep(.box-button) {
  /* 20.65 not 21.4: the exported label SVG carries ~1px of slack around
     the 27.94px ink, so trim the padding to land the gold face on 70.2. */
  padding: calc(20.65px * var(--start-btn-scale, 1))
    calc(33.35px * var(--start-btn-scale, 1));
}

.title-start-btn :deep(.box-button-svg) {
  width: calc(331.33px * var(--start-btn-scale, 1));
  height: auto;
}

.title-start-btn {
  padding: calc(8.4px * var(--start-btn-scale, 1));
  border-radius: calc(5.5px * var(--start-btn-scale, 1));
}

/* Sized from the client's Figma export (Home.svg, 1920x1080 canvas):
   the wordmark measures 1207 x 316 px = 62.9% of canvas width, centred
   horizontally, with its top at 28.9% of canvas height. It was rendering
   at 882px wide (45.9%) — 27% smaller than the design, which is what the
   client kept flagging as "hindi nasusunod yung UI". */
.title-logo {
  /* Logo.svg's viewBox is exactly 1208x317 and the design places it at
     that native size — so no scaling, no guesswork. */
  width: min(90vw, 1208px);
  max-width: 100%;
  margin: 0 auto;
}

.title-logo img {
  width: 100%;
  height: auto;
  display: block;
  object-fit: contain;
}

/* Admin tap zone — fully invisible, same location/size as before. No
   icon, no hover/active reveal: the whole point is guests can't find it. */
.admin-badge {
  position: absolute;
  top: 1.5rem;
  right: 1.5rem;
  width: 48px;
  height: 48px;
  cursor: pointer;
  z-index: 15;
  opacity: 0;
}

/* Admin PIN pad */
.pin-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.pin-modal {
  background: var(--color-cream);
  border: 3px solid var(--color-brown-dark);
  border-radius: 16px;
  padding: 2rem;
  width: 320px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
}

.pin-modal--error {
  animation: pinShake 0.4s ease;
}

@keyframes pinShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-8px); }
  75% { transform: translateX(8px); }
}

.pin-modal-title {
  font-family: var(--font-display);
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  text-align: center;
  margin: 0 0 1.25rem;
}

.pin-dots {
  display: flex;
  justify-content: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.pin-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--color-brown);
  background: transparent;
  transition: background 0.15s ease;
}

.pin-dot--filled {
  background: var(--color-brown-dark);
}

.pin-error-text {
  text-align: center;
  color: #b23b3b;
  font-family: var(--font-body);
  font-size: 0.85rem;
  margin: 0.5rem 0 0;
  min-height: 1.1rem;
}

.pin-keypad {
  margin-top: 1.25rem;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.6rem;
}

.pin-key {
  padding: 0.9rem 0;
  font-family: var(--font-body);
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  background: white;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
  transition: all 0.15s ease;
}

.pin-key:active {
  transform: scale(0.95);
  background: var(--color-cream-dark);
}

.pin-key--muted {
  font-size: 0.9rem;
  background: var(--color-cream-dark);
}

.secondary-buttons {
  margin-top: 2rem;
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  justify-content: center;
}

.secondary-btn {
  padding: 0.5rem 1rem;
  font-family: var(--font-body);
  font-size: 0.875rem;
  color: var(--color-brown);
  background: transparent;
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 0.2s,
    background 0.2s,
    border-color 0.2s;
}

.secondary-btn:hover {
  color: var(--color-brown-dark);
  background: var(--color-cream-dark);
  border-color: var(--color-brown);
}

/* Responsive */
@media (max-width: 1200px) {
  .title-logo {
    width: min(80vw, 700px);
  }

  .admin-badge {
    width: 40px;
    height: 40px;
    top: 1rem;
    right: 1rem;
  }
}

@media (max-width: 768px) {
  .title-logo {
    width: min(90vw, 400px);
  }
}

@media (max-width: 480px) {
  .title-logo {
    width: min(92vw, 320px);
  }
}
</style>
