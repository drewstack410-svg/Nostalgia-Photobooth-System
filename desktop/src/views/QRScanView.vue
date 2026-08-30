<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import QRCode from "qrcode";

const router = useRouter();
const store = usePhotoboothStore();
const qrDataUrl = ref("");
const isGenerating = ref(true);
const qrTargetUrl = ref("");
// True when we couldn't find any cloud URL — most likely
// R2 isn't configured or the upload failed.
const qrUnavailable = ref(false);

// Admin-configurable auto-return countdown (Settings → Timing).
const countdownSeconds = ref(store.qrCountdownSeconds);
let countdownInterval: ReturnType<typeof setInterval> | null = null;

// Guards against arming a 30s `resetSession() + push("/")` on a view the
// guest has already left. The QR generation above is async, so the user
// can tap Done (or the print-more link) before it resolves — and this
// timer's payload wipes the CURRENT session, so a stray one is exactly
// the "randomly back to title screen" the client reported.
let isUnmounted = false;

function startAutoReturnCountdown() {
  if (!store.qrAutoAdvanceEnabled || isUnmounted) return;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownSeconds.value = store.qrCountdownSeconds;
  countdownInterval = setInterval(() => {
    if (isUnmounted) {
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = null;
      return;
    }
    countdownSeconds.value--;
    if (countdownSeconds.value <= 0) {
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = null;
      returnToStart();
    }
  }, 1000);
}

/**
 * The URL the QR should encode — for THIS guest only.
 *
 * This used to read `recentStrips[0]`, i.e. whatever the newest strip on the
 * booth happened to be. That is the current guest's only once their upload
 * has completed. The guest can tap Done on the printing screen while the
 * upload is still running, and several save paths bail out before adding any
 * strip at all — in both cases the newest strip was still the PREVIOUS
 * customer's, so the new guest scanned their code and got a stranger's
 * photos.
 *
 * Now it matches on the session id claimed at the start of the save. No
 * match means the photos are not ready, and we show nothing rather than
 * someone else's — the behaviour the client asked for.
 */
function resolveShareUrl(): string | null {
  const sessionId = store.currentQrSessionId;
  if (!sessionId) return null;
  const mine = store.recentStrips.filter((s) => s.sessionId === sessionId);
  if (!mine.length) return null;
  // Only the short gallery page — never a raw R2/Cloudinary file.
  // Phones often cannot resolve r2.dev, and a lone PNG/MP4 has no GIF tab.
  const gallery = mine.find((s) => s.shareableUrl);
  return gallery?.shareableUrl || null;
}

function returnToStart() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  // A queued tick after unmount must not wipe the NEXT guest's shoot.
  if (isUnmounted) return;
  store.resetSession();
  router.push("/");
}

// NOTE: the "Print more copies" button was removed — the client's
// approved design for this screen has only the heading, the QR frame,
// THANK YOU! and Done. Reprints are still available to staff from
// Admin → Gallery → Reprint.

async function encodeQr(url: string, width: number, margin: number): Promise<string> {
  const colors = { dark: "#3d2b1f", light: "#f5f0e1" };
  try {
    return await QRCode.toDataURL(url, {
      width,
      margin,
      color: colors,
      errorCorrectionLevel: "M",
    });
  } catch {
    // Older long gallery URLs can exceed version-40 at M; L still scans.
    return await QRCode.toDataURL(url, {
      width,
      margin,
      color: colors,
      errorCorrectionLevel: "L",
    });
  }
}

async function renderQr(url: string) {
  qrTargetUrl.value = url;
  console.log("[QR] Encoding URL:", url);
  qrDataUrl.value = await encodeQr(url, 900, 1);
}

/**
 * How long to wait for this session's upload before giving up. The uploads
 * usually land before the guest even reaches this screen; this only covers a
 * slow or failed connection.
 */
const UPLOAD_WAIT_MS = 45_000;
let stopWaiting: (() => void) | null = null;

onMounted(async () => {
  const ready = resolveShareUrl();

  if (ready) {
    try {
      await renderQr(ready);
    } catch (error) {
      console.error("[QR] Failed to generate QR code:", error);
    }
    if (isUnmounted) return;
    isGenerating.value = false;
    startAutoReturnCountdown();
    return;
  }

  // Photos aren't uploaded yet. Show the waiting state — deliberately NOT
  // the previous guest's code — and swap in the real one the moment this
  // session's strip appears.
  console.log("[QR] This session's upload isn't ready — waiting");
  const stop = watch(
    () => [store.recentStrips.length, store.currentQrSessionId] as const,
    async () => {
      if (isUnmounted) return;
      const url = resolveShareUrl();
      if (!url) return;
      stopWaiting?.();
      try {
        await renderQr(url);
      } catch (error) {
        console.error("[QR] Failed to generate QR code:", error);
      }
      if (isUnmounted) return;
      isGenerating.value = false;
      startAutoReturnCountdown();
    },
  );

  const timer = setTimeout(() => {
    if (isUnmounted || qrDataUrl.value) return;
    stopWaiting?.();
    // Never fall back to another strip here: no QR at all is the correct
    // outcome, and the guest is told their photos are safe locally.
    qrUnavailable.value = true;
    isGenerating.value = false;
    console.warn(
      `[QR] No upload for session ${store.currentQrSessionId} after ${UPLOAD_WAIT_MS}ms`,
    );
    startAutoReturnCountdown();
  }, UPLOAD_WAIT_MS);

  stopWaiting = () => {
    stop();
    clearTimeout(timer);
    stopWaiting = null;
  };
});

onUnmounted(() => {
  isUnmounted = true;
  stopWaiting?.();
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
});
</script>

<template>
  <div class="qr-scan-screen">
    <button type="button" class="wood-btn done-btn" @click="returnToStart">
      Done
    </button>

    <div class="qr-content">
      <h1 class="qr-title">
        SCAN THIS QR CODE<br />
        TO GET YOUR DIGITAL COPIES
      </h1>

      <!-- QR Code Display -->
      <div class="qr-placeholder">
        <div v-if="isGenerating" class="qr-box qr-loading">
          <div class="loading-spinner"></div>
        </div>
        <div v-else-if="qrDataUrl" class="qr-box">
          <img :src="qrDataUrl" alt="QR Code" class="qr-image" />
        </div>
        <div v-else-if="qrUnavailable" class="qr-box qr-error">
          <span class="qr-error-icon">📡</span>
          <span class="qr-error-text">
            Cloud upload didn't complete.<br />
            Your photos are safe locally — ask staff for a copy.
          </span>
        </div>
        <div v-else class="qr-box qr-error">
          <span>⚠️</span>
        </div>
      </div>

      <div class="qr-footer">THANK YOU!</div>
    </div>
  </div>
</template>

<style scoped>
/* ─────────────────────────────────────────────────────────────────
 * SIZING MODEL — read this before changing any number below.
 *
 * Every size on this screen is a FRACTION of the cream panel, not a
 * fixed pixel value. The fractions are measured off the client's
 * reference artwork (p6_11.png, 1816x1024; its cream panel is
 * 1778x991) and are listed next to each rule as `design px / 991`.
 *
 * Why: the previous version used absolute pixels converted for a
 * 1920x1080 canvas. That is only correct when the CSS viewport really
 * is 1080px tall. On the client's kiosk Windows display scaling makes
 * the viewport shorter (e.g. 125% → 864px), so the same pixel values
 * filled ~25% more of the screen — which is exactly the "font is a bit
 * big / doesn't match the reference" report. Expressed as fractions,
 * the screen now matches the artwork at ANY resolution or scaling, and
 * the old `max-height: 820px` breakpoint (which papered over one
 * specific case) is no longer needed.
 *
 * The panel is VintageTheme's .app-container: the 100vw x 100vh wooden
 * frame minus its 10px padding on each side.
 *
 * Note the reference was set in real Helvetica Bold; Windows renders
 * Arial Bold, which is ~5% wider at the same cap height. The slight
 * negative tracking below closes most of that gap.
 * ───────────────────────────────────────────────────────────────── */
.qr-scan-screen {
  --panel-h: calc(100vh - 20px);
  --panel-w: calc(100vw - 20px);

  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* No padding: the vertical rhythm below already reproduces the
     design's margins, and padding would fight it. */
  padding: 0;
  background-color: var(--color-cream);
  position: relative;
}

.qr-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Gaps are per-item (below) because the design's title→frame and
     frame→THANK YOU gaps differ. */
  gap: 0;
  /* "TO GET YOUR DIGITAL COPIES" needs ~86% of the panel height in
     width at this font size; 96% leaves room for a wider fallback font
     without wrapping to a third line. */
  max-width: calc(var(--panel-h) * 0.96);
  width: 100%;
}

/* Title Text — upright bold grotesque, two lines, hard <br /> break. */
.qr-title {
  font-family: Arial, Helvetica, "Segoe UI", sans-serif;
  font-size: calc(var(--panel-h) * 0.0568); /* cap height 40.5 / 991 */
  font-weight: 700;
  font-style: normal;
  color: #2c140a;
  text-align: center;
  line-height: calc(var(--panel-h) * 0.0636); /* line pitch 63 / 991 */
  letter-spacing: -0.02em;
  text-transform: uppercase;
  margin: 0;
}

/* QR Placeholder Container. The margin is the design's title→frame
   gap, measured between the element boxes rather than the ink. */
.qr-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: calc(var(--panel-h) * 0.0421);
}

/* QR Box — v2 wooden picture-frame: thick wood-grain border, rounded,
   cream interior (matches the thick, rounded QR frame in the design). */
.qr-box {
  /* Design: 425.5 square outer, 17.5 wood border, ~35 corner radius. */
  width: calc(var(--panel-h) * 0.4294); /* 425.5 / 991 */
  height: calc(var(--panel-h) * 0.4294);
  border-radius: 8.2%; /* 35 / 425.5 */
  padding: calc(var(--panel-h) * 0.0177); /* 17.5 / 991 */
  background:
    repeating-linear-gradient(
      92deg,
      #4e3121 0px,
      #5c3b28 2px,
      #4e3121 4px,
      #402719 6px
    );
  /* The design has essentially no drop shadow — the heavy one made the
     frame read as a floating card rather than part of the panel. */
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.22);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Inner cream "photo" surface the QR/spinner/message sits on. */
.qr-box::before {
  content: "";
  position: absolute;
  inset: calc(var(--panel-h) * 0.0177);
  border-radius: 7.7%; /* 30 / 391 inner */
  /* Flat neutral grey in the design, not white, and no inner shadow. */
  background: #f1f2f2;
  z-index: 0;
}

.qr-box > * {
  position: relative;
  z-index: 1;
}

/* Footer Text */
.qr-footer {
  font-family: Arial, Helvetica, "Segoe UI", sans-serif;
  font-size: calc(var(--panel-h) * 0.1212); /* cap height 86.5 / 991 */
  font-weight: 700;
  line-height: 1;
  color: #2c140a;
  text-align: center;
  letter-spacing: -0.02em;
  text-transform: uppercase;
  /* Design's frame→THANK YOU gap, box to box. */
  margin-top: calc(var(--panel-h) * 0.0462);
}

/* QR Image */
.qr-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* The code sits directly on the cream plate (.qr-box::before), and that
     plate has a 7.7% radius — so its rounded corners cut roughly
     0.0089 × panel-h off each corner of a square that fills it. At 0.25rem
     the corner finder patterns ran into that curve, which is the code
     "spilling over the border". This clears the curve with room to spare
     while still being far tighter than the original 1rem. Expressed against
     --panel-h like every other size here, so it holds at any panel height. */
  padding: calc(var(--panel-h) * 0.012);
}

/* Loading State */
.qr-loading {
  display: flex;
  align-items: center;
  justify-content: center;
}

.loading-spinner {
  width: calc(var(--panel-h) * 0.057);
  height: calc(var(--panel-h) * 0.057);
  border: calc(var(--panel-h) * 0.0057) solid var(--color-cream-dark);
  border-top-color: var(--color-brown);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Error State */
.qr-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 4rem;
  padding: 1.5rem;
  gap: 0.75rem;
}

.qr-error-icon {
  font-size: 4rem;
  line-height: 1;
}

.qr-error-text {
  font-family: var(--font-display);
  font-size: 1rem;
  color: var(--color-brown-dark);
  text-align: center;
  line-height: 1.4;
}

/* Same placement as PrintingView so it clears the corner ornament. */
.done-btn {
  position: absolute;
  top: 2.5rem;
  right: 7rem;
  font-size: 1.5rem;
  padding: 0.65rem 2.4rem;
  z-index: 10;
}

/* No short-viewport breakpoint any more — the fractions above already
   scale the whole screen with the panel, so 1080p, 864p (125% display
   scaling) and 720p (150%) all reproduce the reference proportions. */
</style>
