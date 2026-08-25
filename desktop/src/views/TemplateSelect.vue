<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import TemplatePreview from "@/components/TemplatePreview.vue";

const router = useRouter();
const store = usePhotoboothStore();

const currentIndex = ref(0);
const templates = computed(() => store.activeTemplates);
const showInactivityWarning = ref(false);
const inactivityCountdown = ref(10);
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let warningTimer: ReturnType<typeof setTimeout> | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let eventListeners: Array<{ event: string; handler: () => void }> = [];

const currentTemplate = computed(() => templates.value[currentIndex.value]);
const hasMultipleTemplates = computed(() => templates.value.length > 1);
const prevTemplate = computed(
  () =>
    templates.value[
      (currentIndex.value - 1 + templates.value.length) % templates.value.length
    ],
);
const nextTemplate = computed(
  () => templates.value[(currentIndex.value + 1) % templates.value.length],
);

// Inactivity timer: 1 minute (60000ms)
const INACTIVITY_TIMEOUT = 60000;
const WARNING_COUNTDOWN = 10; // seconds before auto-return

function resetInactivityTimer() {
  // Clear existing timers
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  if (warningTimer) {
    clearTimeout(warningTimer);
    warningTimer = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  // Hide warning if shown
  showInactivityWarning.value = false;
  inactivityCountdown.value = WARNING_COUNTDOWN;

  // Start new inactivity timer
  inactivityTimer = setTimeout(() => {
    showInactivityWarning.value = true;
    inactivityCountdown.value = WARNING_COUNTDOWN;

    // Start countdown after a small delay to ensure UI is updated
    warningTimer = setTimeout(() => {
      warningTimer = null;
      countdownInterval = setInterval(() => {
        inactivityCountdown.value--;

        if (inactivityCountdown.value <= 0) {
          if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          returnToHome();
        }
      }, 1000);
    }, 100);
  }, INACTIVITY_TIMEOUT);
}

function returnToHome() {
  // Clear all timers before navigating
  resetInactivityTimer();
  router.push("/");
}

function cancelInactivityWarning() {
  resetInactivityTimer();
}

function goToPrev() {
  resetInactivityTimer();
  currentIndex.value =
    (currentIndex.value - 1 + templates.value.length) % templates.value.length;
}

function goToNext() {
  resetInactivityTimer();
  currentIndex.value = (currentIndex.value + 1) % templates.value.length;
}

function selectTemplate() {
  // Clear all timers before navigating
  resetInactivityTimer();
  store.selectTemplate(currentTemplate.value);
  // Payment gates the camera when it's switched on: BillAcceptorView
  // arms the sale using THIS template's admin-configured price
  // (Dashboard → Sales by Template → Edit), then forwards to /camera
  // once the middleware reports it paid in full.
  //
  // With payment switched OFF (Admin → Settings → Payment → "Charge for
  // sessions"), the booth is free — skip straight to shooting.
  router.push(store.paymentEnabled ? "/bill-acceptor" : "/camera");
}

function goBack() {
  // Clear all timers before navigating
  resetInactivityTimer();
  router.push("/");
}

// Watch templates to reset index if out of bounds
watch(
  templates,
  (newTemplates) => {
    if (currentIndex.value >= newTemplates.length) {
      currentIndex.value = 0;
    }
  },
  { immediate: true },
);

onMounted(() => {
  resetInactivityTimer();

  // Track user interactions
  const events = ["click", "touchstart", "keydown", "mousemove"];
  events.forEach((event) => {
    const handler = resetInactivityTimer;
    eventListeners.push({ event, handler });
    document.addEventListener(event, handler, { passive: true });
  });
});

onUnmounted(() => {
  // Clear all timers immediately
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  if (warningTimer) {
    clearTimeout(warningTimer);
    warningTimer = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  // Remove all event listeners
  eventListeners.forEach(({ event, handler }) => {
    document.removeEventListener(event, handler);
  });
  eventListeners = [];

  // Reset state
  showInactivityWarning.value = false;
  inactivityCountdown.value = WARNING_COUNTDOWN;
});
</script>

<template>
  <div
    class="template-screen"
    :class="{ 'template-screen--empty': templates.length === 0 }"
  >
    <header class="template-header">
      <h1 class="screen-title">Choose Your<br />Template</h1>
      <div
        v-if="templates.length > 0"
        class="template-indicator"
        role="tablist"
        :aria-label="`${templates.length} templates, ${currentIndex + 1} of ${templates.length} selected`"
      >
        <span
          v-for="(t, i) in templates"
          :key="t.id"
          class="indicator-dot"
          :class="{ 'indicator-dot--active': i === currentIndex }"
        />
      </div>
    </header>
    <div class="template-content">
      <div v-if="templates.length === 0" class="template-empty">
        <p>No templates available.</p>
      </div>

      <div
        v-else
        class="template-carousel"
        :class="{ 'single-template': !hasMultipleTemplates }"
      >
        <!-- Previous Template (Left) - Only show if multiple templates -->
        <div
          v-if="hasMultipleTemplates"
          class="template-preview template-side"
          @click="goToPrev"
        >
          <TemplatePreview :template="prevTemplate" size="full" />
          <p class="template-name">{{ prevTemplate.name }}</p>
        </div>

        <!-- Navigation Arrow Left - Only show if multiple templates -->
        <button
          v-if="hasMultipleTemplates"
          class="nav-arrow nav-arrow-left"
          @click="goToPrev"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <!-- Current Template (Center) -->
        <div class="template-preview template-center" @click="selectTemplate">
          <TemplatePreview
            :template="currentTemplate"
            size="full"
            :active="true"
          />
          <p class="template-name-center">{{ currentTemplate.name }}</p>
        </div>

        <!-- Navigation Arrow Right - Only show if multiple templates -->
        <button
          v-if="hasMultipleTemplates"
          class="nav-arrow nav-arrow-right"
          @click="goToNext"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        <!-- Next Template (Right) - Only show if multiple templates -->
        <div
          v-if="hasMultipleTemplates"
          class="template-preview template-side"
          @click="goToNext"
        >
          <TemplatePreview :template="nextTemplate" size="full" />
          <p class="template-name">{{ nextTemplate.name }}</p>
        </div>
      </div>
    </div>

    <!-- Bottom action row — v2: Back (cream outline) bottom-left,
         Select (gold) bottom-right. -->
    <button type="button" class="ghost-btn tpl-back-btn" @click="goBack">Back</button>
    <button
      v-if="templates.length > 0"
      type="button"
      class="wood-btn tpl-select-btn"
      @click="selectTemplate"
    >
      Select
    </button>

    <!-- Inactivity Warning Modal -->
    <div
      v-if="showInactivityWarning"
      class="inactivity-modal-overlay"
      @click="cancelInactivityWarning"
    >
      <div class="inactivity-modal" @click.stop>
        <div class="modal-content">
          <h2 class="modal-title">⚠️ Inactivity Detected</h2>
          <p class="modal-message">
            The photobooth will return to the home page due to inactivity.
          </p>
          <p class="modal-countdown">
            Returning in <strong>{{ inactivityCountdown }}</strong> seconds...
          </p>
          <button class="modal-button" @click="cancelInactivityWarning">
            Continue Session
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.template-screen {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Header pins to the top rail; the carousel centres in what's left
     (see .template-content). */
  justify-content: flex-start;
  /* Same rails every other screen uses: 2.5rem top (QR/Printing Done),
     7rem sides (every Back/Done button — clears the 150px corner
     ornaments), 9rem bottom to reserve the Back/Select action row
     (bottom:3rem + ~4.8rem button height). At the old uniform 5rem the
     heading and progress bars started at x=90px, i.e. underneath the
     corner ornament. */
  padding: 2.5rem 7rem 9rem;
  position: relative;
}

.template-screen--empty {
  align-items: stretch;
  justify-content: flex-start;
}

.template-content {
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
}

.template-screen--empty .template-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.template-empty {
  text-align: center;
  width: 100%;
}

.template-empty p {
  font-family: var(--font-display);
  font-size: 1.5rem;
  color: var(--color-brown);
  margin: 0;
}

/* v2: title top-left, progress bars top-right. */
.template-header {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
  gap: 1.5rem;
}

.template-indicator {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  /* Optically centres the 16px bars on the title's first line box
     (2.5rem x 1.3 = 52px -> (52-16)/2 = 18px). */
  margin-top: 1.1rem;
}

/* Segmented progress bars (v2) — thin rounded bars, current one filled. */
.indicator-dot {
  width: 54px;
  height: 16px;
  box-shadow: 0 0 0 2px var(--color-brown-light) inset;
  border-radius: 4px;
  background: transparent;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.indicator-dot--active {
  background: var(--color-brown-light);
}

/* v2 bottom-corner buttons — appearance comes from the shared .ghost-btn
   / .wood-btn classes. Back (left) and Select (right) share the SAME
   size so the pair is balanced. */
.tpl-back-btn,
.tpl-select-btn {
  position: absolute;
  /* Inset past the 150px corner ornaments (which sit 20px from each
     corner, so occupy ~170px) so the buttons never overlap them. */
  bottom: 3rem;
  font-size: 1.7rem;
  padding: 0.95rem 3.4rem;
  z-index: 10;
}

.tpl-back-btn {
  left: 7rem;
}

.tpl-select-btn {
  right: 7rem;
}

.screen-title {
  font-family: var(--font-display);
  /* App heading scale: QRScanView .qr-title 2.5rem/1.3,
     BillAcceptorView .pay-instruction 2.4rem/1.35. The line-height was
     dropped in an earlier commit, so this two-line title fell back to
     the body's 1.5 while every other heading sat at 1.3–1.35. */
  font-size: 2.5rem;
  font-weight: 700;
  line-height: 1.3;
  color: var(--color-brown-dark);
  text-align: left;
  margin: 0;
}

.template-carousel {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2rem;
  width: 100%;
}

.template-carousel.single-template {
  gap: 0;
}

.template-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  transition: all 0.3s ease;
}

.template-side {
  opacity: 0.5;
  transform: scale(0.8);
}

.template-side:hover {
  opacity: 0.7;
}

.template-center {
  transform: scale(1);
}

.template-name {
  font-family: var(--font-display);
  font-size: 1rem;
  font-style: italic;
  color: var(--color-brown-light);
  margin-top: 1rem;
  text-align: center;
}

.template-name-center {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin-top: 1.5rem;
  text-align: center;
}

/* Navigation Arrows */
.nav-arrow {
  flex-shrink: 0;
  min-width: 50px;
  min-height: 50px;
  width: 50px;
  height: 50px;
  border: none;
  background: transparent;
  color: var(--color-brown-light);
  cursor: pointer;
  transition: all 0.2s ease;
  touch-action: manipulation;
}

.nav-arrow:active {
  transform: scale(0.9);
  color: var(--color-brown-dark);
}

.nav-arrow svg {
  width: 100%;
  height: 100%;
}

/* Inactivity Warning Modal */
.inactivity-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.inactivity-modal {
  background: var(--color-cream);
  border: 4px solid var(--color-brown-dark);
  border-radius: 16px;
  padding: 2rem;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  animation: slideUp 0.3s ease;
}

@keyframes slideUp {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.modal-content {
  text-align: center;
}

.modal-title {
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin-bottom: 1rem;
}

.modal-message {
  font-family: var(--font-display);
  font-size: 1.2rem;
  color: var(--color-brown);
  margin-bottom: 1.5rem;
  line-height: 1.5;
}

.modal-countdown {
  font-family: var(--font-display);
  font-size: 1.1rem;
  color: var(--color-brown-dark);
  margin-bottom: 2rem;
}

.modal-countdown strong {
  font-size: 1.5rem;
  color: var(--color-brown-dark);
  font-weight: 700;
}

.modal-button {
  flex-shrink: 0;
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: 1.3rem;
  font-weight: 600;
  padding: 1rem 2.5rem;
  background: linear-gradient(
    180deg,
    #f5d77a 0%,
    #e8c44d 30%,
    #c9a227 70%,
    #a68520 100%
  );
  color: var(--color-brown-dark);
  border: 3px solid var(--color-brown);
  border-radius: 30px;
  cursor: pointer;
  box-shadow:
    0 4px 0 var(--color-brown),
    0 6px 15px rgba(61, 43, 31, 0.3);
  transition: all 0.15s ease;
  touch-action: manipulation;
}

.modal-button:active {
  box-shadow:
    0 2px 0 var(--color-brown),
    0 3px 8px rgba(61, 43, 31, 0.3);
  transform: translateY(2px);
}
</style>
