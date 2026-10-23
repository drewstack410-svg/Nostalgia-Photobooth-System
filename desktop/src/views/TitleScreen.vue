<script setup lang="ts">
import { onMounted, ref, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import { useGalleryEventsStore } from "@/stores/galleryEvents";
import WelcomeStage from "@/components/WelcomeStage.vue";

/** Once per app launch — send operator to Gallery to Launch an event. */
const BOOT_EVENT_REDIRECT_KEY = "nostalgia-boot-event-redirected";

/** How long the live-event reminder banner stays on the title screen. */
const EVENT_BANNER_MS = 2000;

const router = useRouter();
const store = usePhotoboothStore();
const eventsStore = useGalleryEventsStore();

const bannerDismissed = ref(false);
let bannerAutoHideTimeout: ReturnType<typeof setTimeout> | null = null;

function clearBannerAutoHide() {
  if (bannerAutoHideTimeout) {
    clearTimeout(bannerAutoHideTimeout);
    bannerAutoHideTimeout = null;
  }
}

function endLaunchedEvent() {
  clearBannerAutoHide();
  eventsStore.stopActiveEvent();
  bannerDismissed.value = false;
}

function dismissEventBanner() {
  clearBannerAutoHide();
  bannerDismissed.value = true;
}

function scheduleBannerAutoHide() {
  clearBannerAutoHide();
  bannerDismissed.value = false;
  bannerAutoHideTimeout = setTimeout(() => {
    bannerDismissed.value = true;
    bannerAutoHideTimeout = null;
  }, EVENT_BANNER_MS);
}

watch(
  () => eventsStore.activeEvent?.id ?? null,
  (id) => {
    if (id) scheduleBannerAutoHide();
    else {
      clearBannerAutoHide();
      bannerDismissed.value = false;
    }
  },
  { immediate: true },
);

const badgeClickCount = ref(0);
const badgeClickTimeout = ref<ReturnType<typeof setTimeout> | null>(null);

function startPhotobooth() {
  router.push("/templates");
}

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

  if (badgeClickTimeout.value) {
    clearTimeout(badgeClickTimeout.value);
  }

  if (badgeClickCount.value >= 3) {
    badgeClickCount.value = 0;
    requestAdminAccess();
    return;
  }

  badgeClickTimeout.value = setTimeout(() => {
    badgeClickCount.value = 0;
  }, 2000);
}

function redirectToEventPageOnBoot() {
  let already = false;
  try {
    already = sessionStorage.getItem(BOOT_EVENT_REDIRECT_KEY) === "1";
  } catch {
    already = false;
  }
  if (already) return;
  try {
    sessionStorage.setItem(BOOT_EVENT_REDIRECT_KEY, "1");
  } catch {
    /* ignore */
  }
  // Operator picks an event and taps Launch on the gallery page.
  void router.replace({ path: "/admin", query: { tab: "gallery" } });
}

onMounted(() => {
  window.addEventListener("keydown", onAdminHotkey);
  eventsStore.load();
  redirectToEventPageOnBoot();
});

onUnmounted(() => {
  if (badgeClickTimeout.value) {
    clearTimeout(badgeClickTimeout.value);
  }
  clearBannerAutoHide();
  window.removeEventListener("keydown", onAdminHotkey);
});
</script>

<template>
  <div class="title-screen">
    <WelcomeStage @start="startPhotobooth" />

    <div
      v-if="eventsStore.activeEvent && !bannerDismissed"
      class="event-launch-banner"
      role="status"
    >
      <span class="event-launch-banner__text">
        Live event:
        <strong>{{ eventsStore.activeEvent.name }}</strong>
        — new shots go here
      </span>
      <button
        type="button"
        class="event-launch-banner__end"
        @click="endLaunchedEvent"
      >
        End
      </button>
      <button
        type="button"
        class="event-launch-banner__close"
        aria-label="Hide reminder"
        title="Hide reminder"
        @click="dismissEventBanner"
      >
        ×
      </button>
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
  position: relative;
  overflow: hidden;
}

.event-launch-banner {
  position: absolute;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: min(92vw, 36rem);
  padding: 0.55rem 0.75rem 0.55rem 1rem;
  border-radius: 999px;
  background: rgba(59, 42, 20, 0.92);
  color: #f4e6c3;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
  font-family: var(--font-display);
  font-size: 0.95rem;
}

.event-launch-banner__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-launch-banner__text strong {
  font-weight: 700;
  color: #fee2a0;
}

.event-launch-banner__end {
  flex: 0 0 auto;
  padding: 0.3rem 0.75rem;
  border: none;
  border-radius: 999px;
  background: #c2822e;
  color: #3b2a14;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 0.85rem;
  cursor: pointer;
}

.event-launch-banner__close {
  flex: 0 0 auto;
  width: 1.85rem;
  height: 1.85rem;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(244, 230, 195, 0.18);
  color: #f4e6c3;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.event-launch-banner__close:hover {
  background: rgba(244, 230, 195, 0.32);
}

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

@media (max-width: 1200px) {
  .admin-badge {
    width: 40px;
    height: 40px;
    top: 1rem;
    right: 1rem;
  }
}
</style>
