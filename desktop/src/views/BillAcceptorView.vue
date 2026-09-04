<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { usePaymentStore } from "@/stores/payment";
import { usePhotoboothStore } from "@/stores/photobooth";
import { useDashboardStore } from "@/stores/dashboard";
import {
  createBillAcceptorAdapter,
  type BillAcceptorAdapter,
} from "@/services/billAcceptor";
import KioskDecor from "@/components/KioskDecor.vue";
import { useKioskScreen } from "@/composables/useKioskScreen";

const router = useRouter();

// ── Payment wiring ───────────────────────────────────────────────
// This screen runs the payment state machine. The actual money-in
// signal comes from a bill-acceptor adapter — in production the
// LumaBooth Middleware (a separate app driving the physical bill
// acceptor + PayMongo QR payments), which reports a completed sale by
// calling the LumaBooth API our Electron main process impersonates
// (see electron/main.js `startLumaMiddlewareListener`). The screen
// itself never talks to hardware: it only reads the store and, in
// dev, can inject fake credit through the adapter's simulateCredit().
//
// Price shown/required comes from the ADMIN-CONFIGURED per-template
// price (Dashboard → Sales by Template → Edit), keyed by whichever
// template the customer just picked on the previous screen. This is
// our side of "the two apps' payment gateway working together": the
// middleware decides WHEN a sale is complete (it owns cash/QR
// handling and never tells us an amount), so the number that actually
// has to match between the two systems is what we ADVERTISE here —
// it must equal what the middleware is configured to charge. Falls
// back to the global VITE_SESSION_PRICE default when a template has
// no price configured yet, so an unconfigured template never
// silently becomes free.
const paymentStore = usePaymentStore();
const photoboothStore = usePhotoboothStore();
const dashboardStore = useDashboardStore();
const { laidOut, boxStyle, textOf, textStyle, buttonLabel } =
  useKioskScreen("payment");
const { status, amountReceived, amountRequired, remaining, isPaid, currency, lastError } =
  storeToRefs(paymentStore);

const selectedTemplateName = computed(
  () => photoboothStore.selectedTemplate?.name ?? "",
);

const logoSrc = computed(
  () => photoboothStore.customLogoUrl || `${import.meta.env.BASE_URL}Logo.svg`,
);

// Operator-uploaded payment QR (Settings → Payment). Already a data: URL,
// so no BASE_URL prefix — that rule only governs bundled public/ assets.
const paymentQrSrc = computed(() => photoboothStore.paymentQrUrl);

let billAcceptor: BillAcceptorAdapter | null = null;

// Show the dev "simulate payment" controls in the Vite dev server, OR
// in a packaged build when VITE_ENABLE_PAYMENT_SIMULATOR=true is baked
// in at build time (an explicit opt-in for client trial/demo builds
// that don't have the LumaBooth Middleware / bill acceptor hardware
// wired up yet — leave this unset for real production builds).
// Deliberately adapter-agnostic: it credits the payment store DIRECTLY
// rather than going through the bill-acceptor adapter's
// simulateCredit(), because inside the real Electron window
// `createBillAcceptorAdapter()` correctly picks the IPC adapter (so
// real LumaBooth Middleware signals still work) — and
// IpcBillAcceptorAdapter has no simulateCredit method, only
// MockBillAcceptorAdapter (browser tabs without electronAPI) does.
// Gating on the adapter meant this button silently never rendered in
// the one place devs actually test against the real app (the Electron
// window) — only in a plain browser tab.
const isDevBuild = import.meta.env.DEV;
const simulatorForced = import.meta.env.VITE_ENABLE_PAYMENT_SIMULATOR === "true";
const canSimulate = computed(() => isDevBuild || simulatorForced);

function simulateBill(amount: number) {
  paymentStore.addCredit(amount);
}

// ── "U" test bypass ──────────────────────────────────────────────
// Pressing U skips payment so the rest of the flow (shooting, printing,
// QR landing page) can be exercised without feeding real bills. It
// credits the payment store with the full remaining amount rather than
// routing around it, so `isPaid` flips and the normal onPaid() path runs
// — the session ends up in exactly the state a real payment produces.
//
// NOTE FOR PRODUCTION: this is deliberately always-on so it works in the
// client's packaged test build. Set PAYMENT_BYPASS_KEY_ENABLED = false
// before the live event so a stray USB keyboard can't hand out free
// sessions.
const PAYMENT_BYPASS_KEY_ENABLED = true;

function onBypassKey(e: KeyboardEvent) {
  if (!PAYMENT_BYPASS_KEY_ENABLED) return;
  if (e.key !== "u" && e.key !== "U") return;
  // Ignore while typing in a field, and don't double-fire once paid.
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  if (isPaid.value) return;
  e.preventDefault();
  console.log("[Payment] 'U' bypass — crediting remaining", remaining.value);
  paymentStore.addCredit(remaining.value);
}

// Auto-advance once paid. `consume()` clears the credit so a
// back-navigation can't reuse the same payment. NOTE: the capture
// flow is currently orphaned from this screen (TemplateSelect still
// routes straight to /camera) — this navigation is here so the
// screen is testable in isolation and ready for when the flow is
// wired up later.
function onPaid() {
  resetInactivityTimer();
  paymentStore.consume();
  void window.electronAPI?.notifyPaymentSession?.({ phase: "consume" });
  router.push("/camera");
}

watch(isPaid, (paid) => {
  if (paid) onPaid();
});

const showInactivityWarning = ref(false);
const inactivityCountdown = ref(10);
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let warningTimer: ReturnType<typeof setTimeout> | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let eventListeners: Array<{ event: string; handler: () => void }> = [];
let isUnmounted = false;

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

  if (isUnmounted) return;

  // Start new inactivity timer
  inactivityTimer = setTimeout(() => {
    if (isUnmounted) return;
    showInactivityWarning.value = true;
    inactivityCountdown.value = WARNING_COUNTDOWN;

    // Start countdown after a small delay to ensure UI is updated
    warningTimer = setTimeout(() => {
      warningTimer = null;
      if (isUnmounted) return;
      countdownInterval = setInterval(() => {
        if (isUnmounted) {
          if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          return;
        }
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
  if (isUnmounted) return;
  resetInactivityTimer();
  router.push("/");
}

function cancelInactivityWarning() {
  resetInactivityTimer();
}

function goBack() {
  // Cancelling the sale clears any inserted credit.
  resetInactivityTimer();
  paymentStore.reset();
  void window.electronAPI?.notifyPaymentSession?.({ phase: "reset" });
  router.push("/templates");
}

onMounted(() => {
  resetInactivityTimer();

  // Arm the payment state machine + bill-acceptor adapter for a new
  // sale, at THIS template's configured price. `priceByTemplateId`
  // only ever holds explicit, non-zero prices (setPricePerTemplate
  // treats 0 as "clear") — so an absent key means "never configured",
  // not "free". Pass `undefined` in that case so beginSession() falls
  // back to its own default (env VITE_SESSION_PRICE) instead of
  // arming a free session. The adapter only forwards credit into the
  // store — it never drives navigation.
  const templateId = photoboothStore.selectedTemplate?.id;
  const configuredPrice = templateId
    ? dashboardStore.priceByTemplateId[templateId]
    : undefined;
  paymentStore.beginSession(configuredPrice);
  billAcceptor = createBillAcceptorAdapter();
  billAcceptor.start(paymentStore);
  // templateId lets the middleware attribute the sale to a template
  // (per-template pricing + reporting on their side).
  void window.electronAPI?.notifyPaymentSession?.({
    phase: "begin",
    required: amountRequired.value,
    templateId: templateId ?? null,
  });

  // Track user interactions
  const events = ["click", "touchstart", "keydown", "mousemove"];
  events.forEach((event) => {
    const handler = resetInactivityTimer;
    eventListeners.push({ event, handler });
    document.addEventListener(event, handler, { passive: true });
  });

  // Registered separately from `eventListeners` above: that array is typed
  // `handler: () => void` and can't carry a KeyboardEvent handler, and this
  // one must not be passive (it calls preventDefault).
  window.addEventListener("keydown", onBypassKey);
});

onUnmounted(() => {
  isUnmounted = true;
  // Detach the bill-acceptor adapter so it stops forwarding credit
  // once we've left the screen.
  billAcceptor?.stop();
  billAcceptor = null;

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
  // Without this the handler survives navigation and "U" would fire the
  // bypass from the camera/printing screens too.
  window.removeEventListener("keydown", onBypassKey);

  // Reset state
  showInactivityWarning.value = false;
  inactivityCountdown.value = WARNING_COUNTDOWN;
});
</script>

<template>
  <div class="bill-acceptor-screen" :class="{ 'kiosk-laid-out': laidOut }">
    <KioskDecor screen-id="payment" />
    <!-- Operator-uploaded background (Settings → Payment screen
         background). When a Screen Editor layout is saved, KioskDecor
         owns the background instead. -->
    <div
      v-if="!laidOut && photoboothStore.effectivePaymentBackgroundUrl"
      class="pay-screen-bg"
    >
      <img
        v-if="photoboothStore.effectivePaymentBackgroundType === 'image'"
        :src="photoboothStore.effectivePaymentBackgroundUrl"
        alt=""
        class="pay-screen-bg-media"
      />
      <video
        v-else
        :src="photoboothStore.effectivePaymentBackgroundUrl"
        class="pay-screen-bg-media"
        autoplay
        muted
        loop
        playsinline
      />
    </div>

    <!-- Back Button — bottom-left, cream/ghost style (v2). -->
    <button
      class="ghost-btn kiosk-action-btn back-btn"
      :style="laidOut ? boxStyle('backBtn') : undefined"
      @click="goBack"
    >
      {{ buttonLabel("backBtn", "Back") }}
    </button>

    <!-- Main Content -->
    <div class="bill-acceptor-content">
      <img
        :src="logoSrc"
        alt="Nostalgia Photobooth"
        class="pay-wordmark"
        :style="laidOut ? boxStyle('logo') : undefined"
      />

      <h1
        class="pay-instruction"
        :style="laidOut ? { ...boxStyle('instruction'), ...textStyle('instruction') } : undefined"
      >
        <template v-if="laidOut">{{
          textOf("instruction").content.replaceAll(
            "{amount}",
            `${currency}${amountRequired}`,
          )
        }}</template>
        <template v-else>
          Please Insert a {{ currency }}{{ amountRequired }} Bill to Operate<br />
          or Scan the QR Code for Online Payment
        </template>
      </h1>

      <div
        class="pay-frame"
        :class="{ 'is-paid': isPaid, 'is-error': status === 'error' }"
        :style="laidOut ? boxStyle('qrFrame') : undefined"
      >
        <div class="pay-frame-inner">
          <p v-if="status === 'error'" class="pay-frame-message">
            Payment Error<br />
            <span class="pay-frame-sub">{{ lastError }}</span>
          </p>
          <p v-else-if="isPaid" class="pay-frame-message">
            Payment Received<br />
            <span class="pay-frame-sub">Starting your session…</span>
          </p>
          <!-- Operator-uploaded payment QR (Settings → Payment → Payment
               QR code). Falls back to the amount + hint when none is set. -->
          <img
            v-else-if="paymentQrSrc"
            :src="paymentQrSrc"
            alt="Scan to pay"
            class="pay-frame-qr"
            :style="{ transform: `scale(${photoboothStore.paymentQrScale})` }"
          />
          <template v-else>
            <div class="pay-frame-amount">{{ currency }}{{ amountRequired }}</div>
            <p class="pay-frame-sub">Insert bill or scan QR to continue</p>
          </template>
        </div>
      </div>

      <!-- Insert progress sits BELOW the frame: the instruction above
           already states the amount, and the frame's interior belongs to
           the QR. -->
      <div
        v-if="!isPaid && status !== 'error'"
        class="payment-progress"
        :style="laidOut ? boxStyle('progress') : undefined"
      >
        <div class="payment-progress-bar">
          <div
            class="payment-progress-fill"
            :style="{
              width:
                amountRequired > 0
                  ? Math.min(100, (amountReceived / amountRequired) * 100) + '%'
                  : '0%',
            }"
          ></div>
        </div>
        <!-- Only show a running total once something has actually been
             credited. The LumaBooth middleware reports a single "paid in
             full" signal and never reports individual notes, so until it
             posts per-bill amounts to /api/payment this counter cannot
             move — and a frozen "PHP0 / PHP300" reads as a broken screen
             while the guest is feeding money in. The amount due is already
             stated above. The moment per-bill credit arrives, the real
             total appears here on its own. -->
        <p class="payment-progress-text">
          <template v-if="amountReceived > 0">
            {{ currency }}{{ amountReceived }} / {{ currency }}{{ amountRequired }}
            <span v-if="remaining > 0"> · {{ currency }}{{ remaining }} more</span>
          </template>
          <template v-else>Waiting for payment…</template>
        </p>
      </div>

      <!-- DEV-ONLY: simulate bill insertion. Hidden in packaged
           kiosk builds (import.meta.env.DEV is false there). Lets
           the screen be tested before the LumaBooth / hardware
           adapter exists. -->
      <div v-if="canSimulate" class="bill-acceptor-actions dev-controls">
        <p class="dev-controls-label">DEV — simulate bill</p>
        <div class="dev-buttons">
          <button class="proceed-btn dev" @click="simulateBill(20)">
            + {{ currency }} 20
          </button>
          <button class="proceed-btn dev" @click="simulateBill(50)">
            + {{ currency }} 50
          </button>
          <button class="proceed-btn dev" @click="simulateBill(100)">
            + {{ currency }} 100
          </button>
        </div>
      </div>
    </div>

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
            No activity detected. Returning to home screen in
            <strong>{{ inactivityCountdown }}</strong> seconds.
          </p>
          <button class="modal-button" @click="cancelInactivityWarning">
            Continue
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bill-acceptor-screen {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

.kiosk-laid-out .bill-acceptor-content {
  display: contents;
}

.kiosk-laid-out .pay-wordmark,
.kiosk-laid-out .pay-instruction,
.kiosk-laid-out .pay-frame,
.kiosk-laid-out .payment-progress,
.kiosk-laid-out .back-btn {
  position: absolute;
  margin: 0;
}

.kiosk-laid-out .pay-instruction {
  white-space: pre-wrap;
}

.kiosk-laid-out .pay-wordmark {
  width: 100%;
  height: 100%;
}

.kiosk-laid-out .pay-frame {
  width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
}

/* Operator-uploaded payment background — sits behind everything; the
   content block already carries z-index:20. */
.pay-screen-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.pay-screen-bg-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Placement only — size comes from .kiosk-action-btn (same as editor). */
.back-btn {
  position: absolute;
  /* Inset past the corner ornaments (~170px) so it never overlaps them. */
  bottom: 3rem;
  left: 7rem;
  /* MUST stay above .bill-acceptor-content (z-index:20). That block is
     `flex: 1`, so it fills the whole screen and overlaps this button —
     at a lower z-index the click lands on the content div and the Back
     button silently does nothing even though it looks normal. Other
     screens use 10 because they have no z-index:20 content block. */
  z-index: 30;
}

.bill-acceptor-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 2rem;
  gap: 1.75rem;
  /* Sit above the decorative film strips (z-index 6 in VintageTheme). */
  position: relative;
  z-index: 20;
}

/* Nostalgia wordmark, top-centered (v2). */
.pay-wordmark {
  width: min(28vw, 320px);
  height: auto;
  object-fit: contain;
}

.pay-instruction {
  text-align: center;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 2.4rem;
  line-height: 1.35;
  color: var(--color-brown-dark);
  margin: 0;
}

/* Wooden picture-frame (matches the thick, rounded QR frame in the
   design): wood-grain border, rounded, cream interior. */
.pay-frame {
  width: min(38vh, 360px);
  aspect-ratio: 1 / 1;
  border-radius: 22px;
  padding: 16px;
  background:
    repeating-linear-gradient(
      92deg,
      #6b4326 0px,
      #7c5233 2px,
      #6b4326 4px,
      #5a381f 6px
    );
  box-shadow:
    0 10px 30px rgba(61, 43, 31, 0.35),
    inset 0 0 0 2px rgba(0, 0, 0, 0.25);
}

.pay-frame-inner {
  width: 100%;
  height: 100%;
  border-radius: 12px;
  background: #f2efe9;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1.5rem;
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.12);
}

.pay-frame.is-paid .pay-frame-inner {
  background: #eaf5ec;
}

.pay-frame.is-error .pay-frame-inner {
  background: #f8ecea;
}

.pay-frame-amount {
  font-family: var(--font-display);
  font-size: 3.25rem;
  font-weight: 800;
  color: var(--color-brown-dark);
  line-height: 1;
}

/* Operator-uploaded payment QR. The frame is a fixed 1:1 box, so
   `contain` keeps a non-square QR export undistorted — a stretched QR
   can fail to scan. */
.pay-frame-qr {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.pay-frame-message {
  font-family: var(--font-display);
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  text-align: center;
  margin: 0;
  line-height: 1.35;
}

.pay-frame-sub {
  font-family: var(--font-body);
  font-size: 1rem;
  font-weight: 500;
  color: var(--color-brown-light);
  display: block;
  margin-top: 0.35rem;
}

/* Payment progress — now a sibling BELOW .pay-frame (the frame interior
   belongs to the QR, and the instruction above already states the
   amount). Width tracks the frame so their edges line up. */
.payment-progress {
  width: min(38vh, 360px);
  max-width: 100%;
  margin-top: 0;
}

.payment-progress-bar {
  width: 100%;
  height: 12px;
  background: rgba(139, 115, 85, 0.2);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
}

/* A slow travelling highlight over the empty track. The booth is waiting
   on the acceptor and a completely static bar reads as a hung screen. */
.payment-progress-bar::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(139, 115, 85, 0.28) 50%,
    transparent 100%
  );
  transform: translateX(-100%);
  animation: paymentWaiting 1.9s ease-in-out infinite;
  pointer-events: none;
}

@keyframes paymentWaiting {
  to {
    transform: translateX(100%);
  }
}

.payment-progress-fill {
  height: 100%;
  background: linear-gradient(135deg, #8b7355 0%, #6b5a45 100%);
  border-radius: 999px;
  transition: width 0.35s ease;
}

.payment-progress-text {
  margin: 0.6rem 0 0;
  text-align: center;
  font-size: 1.05rem;
  font-weight: 600;
  color: #5a4a3a;
}

/* DEV-only simulate controls */
.dev-controls {
  flex-direction: column;
  gap: 0.6rem;
}

.dev-controls-label {
  margin: 0;
  font-size: 0.8rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #b08;
  opacity: 0.7;
}

.dev-buttons {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
  justify-content: center;
}

.proceed-btn.dev {
  padding: 0.8rem 1.4rem;
  font-size: 1rem;
  background: linear-gradient(135deg, #6a5acd 0%, #483d8b 100%);
  box-shadow: 0 4px 8px rgba(72, 61, 139, 0.3);
}

.proceed-btn.dev:hover {
  background: linear-gradient(135deg, #7a6add 0%, #584d9b 100%);
}

.bill-acceptor-actions {
  width: 100%;
  max-width: 400px;
  display: flex;
  justify-content: center;
}

.proceed-btn {
  background: linear-gradient(135deg, #8b7355 0%, #6b5a45 100%);
  color: white;
  border: none;
  border-radius: 16px;
  padding: 1.5rem 3rem;
  font-size: 1.5rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 6px 12px rgba(139, 115, 85, 0.3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.proceed-btn:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 16px rgba(139, 115, 85, 0.4);
  background: linear-gradient(135deg, #9b8365 0%, #7b6a55 100%);
}

.proceed-btn:active {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(139, 115, 85, 0.3);
}

/* Inactivity Warning Modal */
.inactivity-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.inactivity-modal {
  background: white;
  border-radius: 20px;
  padding: 0;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  animation: modalSlideIn 0.3s ease-out;
}

@keyframes modalSlideIn {
  from {
    opacity: 0;
    transform: translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.modal-content {
  padding: 2.5rem;
  text-align: center;
}

.modal-title {
  font-size: 2rem;
  font-weight: 700;
  color: #5a4a3a;
  margin: 0 0 1rem 0;
}

.modal-message {
  font-size: 1.125rem;
  color: #8b7355;
  margin: 0 0 2rem 0;
  line-height: 1.6;
}

.modal-message strong {
  color: #5a4a3a;
  font-weight: 700;
}

.modal-button {
  background: linear-gradient(135deg, #8b7355 0%, #6b5a45 100%);
  color: white;
  border: none;
  border-radius: 12px;
  padding: 1rem 2.5rem;
  font-size: 1.125rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 4px 8px rgba(139, 115, 85, 0.3);
}

.modal-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 12px rgba(139, 115, 85, 0.4);
}

.modal-button:active {
  transform: translateY(0);
}

/* Responsive adjustments */
@media (max-width: 900px) {
  .pay-instruction {
    font-size: 1.8rem;
  }

  .pay-frame {
    width: min(46vw, 300px);
  }

  .proceed-btn {
    font-size: 1.25rem;
    padding: 1.25rem 2.5rem;
  }
}
</style>
