<script setup lang="ts">
import { onMounted, ref, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import WelcomeStage from "@/components/WelcomeStage.vue";

const router = useRouter();
const store = usePhotoboothStore();

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

onMounted(() => {
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
    <WelcomeStage @start="startPhotobooth" />

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
