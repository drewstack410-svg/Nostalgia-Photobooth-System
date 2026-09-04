<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import type { CameraFilter } from "@/stores/photobooth";
import { loadLut, applyLutToImageData } from "@/utils/lut";
import type { ParsedLut } from "@/utils/lut";
import { applyCaptureLook, drawLookMedia } from "@/utils/applyCaptureLook";
import {
  BW_MATRIX,
  FUJIFILM_MATRIX,
  SEPIA_MATRIX,
  applyAdjustmentsToImageData,
  buildAdjustmentTable,
  buildCubePreview,
  glowPreviewSvg,
  grainCaptureIntensity,
  grainPreviewOpacity,
  vignettePreviewStyle,
} from "@/utils/filterPreview";
import type { CubePreview } from "@/utils/filterPreview";
import {
  cropBarPercentForTemplate,
  highlightedViewRect,
} from "@/utils/viewfinderCrop";
import TemplateLivePreview from "@/components/TemplateLivePreview.vue";
import FilterOverlayLayers from "@/components/FilterOverlayLayers.vue";
import {
  HIGHLIGHT_LEAD_MS,
  HIGHLIGHT_PREVIEW_MS,
  abortHighlightCapture,
  freezeHighlightCapture,
  isHighlightRecording,
  startHighlightCapture,
  stopHighlightCapture,
  waitForHighlightLead,
} from "@/utils/highlightRecorder";
import { mediaUrlToBytes } from "@/utils/mediaBytes";
import {
  openVideoStream as requestVideoStream,
  stopWebcamTracks,
  webcamErrorMessage,
} from "@/utils/openCamera";
import KioskDecor from "@/components/KioskDecor.vue";
import { useKioskScreen } from "@/composables/useKioskScreen";

const router = useRouter();
const store = usePhotoboothStore();
const { laidOut, boxStyle, textOf, textStyle, buttonLabel } =
  useKioskScreen("camera");
const { cameraFrameStyle, cameraFrameColor, cameraFrameSvgUrl } =
  storeToRefs(store);
const effectiveFrameStyle = computed(() =>
  ["wooden", "blur", "color", "svg", "none"].includes(cameraFrameStyle.value)
    ? cameraFrameStyle.value
    : "wooden",
);

// ── Live-preview crop bars ─────────────────────────────────────────
// The faded bars mark how much of the camera's 3:2 capture gets
// trimmed for the SELECTED template, so the guest poses inside what
// actually prints. The cropped still is what prints; the full frame
// is saved for the gallery download row.
const cropBarPercent = computed(() =>
  cropBarPercentForTemplate(store.sessionTemplate ?? store.selectedTemplate),
);

const videoRef = ref<HTMLVideoElement | null>(null);
const videoBlurRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const stream = ref<MediaStream | null>(null);

const isCountingDown = ref(false);
const isCapturing = ref(false);
const isReviewing = ref(false);
const highlightRecording = ref(false);
const countdownValue = ref(3);
/** Last-frame freeze after each shot — also encoded as the last 5s of the highlight. */
const SHOT_REVIEW_SECONDS = Math.round(HIGHLIGHT_PREVIEW_MS / 1000);
const freezeCountdown = ref(SHOT_REVIEW_SECONDS);
const showFlash = ref(false);
const cameraReady = ref(false);
const showInactivityWarning = ref(false);
const inactivityCountdown = ref(10);
const WARNING_COUNTDOWN = 10;
const showBackWarning = ref(false);
const showCameraError = ref(false);
const cameraErrorMessage = ref<string>('');
// A failed capture (DEVICE_BUSY, AF_NG, timeout) is NOT a disconnect, but
// the modal used to call every failure "Camera Connection Error" — which is
// why a transient shutter error read as "the camera can't be tested at all".
const cameraErrorIsConnection = ref(true);
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;

// Canon EDSDK state
const canonCameraAvailable = ref(false);
const canonCameraConnected = ref(false);
const canonCameraName = ref<string | null>(null);

// Live view
const liveViewActive = ref(false);
const liveViewFrame = ref<string | null>(null);

// Sample still used to stand in for a camera — commented out while test
// mode uses this computer's webcam instead.
// const TEST_SAMPLE_SRC = `${import.meta.env.BASE_URL}gallery/sample.png`;

// Computed
// Capture URLs in shot order. TemplateLivePreview derives the slot count
// from the template's real print grid, so this is just the photos taken
// so far — no padding to photoCount (which could disagree with
// rows x cols on a mis-configured template).
const capturedPhotoUrls = computed(() =>
  store.capturedPhotos.map((p) => p.dataUrl),
);

const currentPhotoNumber = computed(() => store.capturedPhotos.length + 1);
const totalPhotos = computed(() => store.requiredPhotos);
const freezeNextLabel = computed(() =>
  store.hasAllPhotos ? "Ending in.." : "Next shoot will start in",
);

const activeFilterOptions = computed(() => store.activeFilters);

/**
 * Per-filter colour "tone" class for the camera filter buttons, so each
 * active filter gets its exact v2 accent colour (Sepia = brown,
 * B&W = charcoal, Original = blue, Fujifilm = cream). Custom cube
 * filters fall back to the default brown tone. Keyed off effectType /
 * baseFilter first, then the name as a fallback so the built-in
 * presets always resolve even if their effectType is "cube".
 */
function filterToneClass(f: CameraFilter): string {
  const name = (f.name || "").toLowerCase();
  const type = f.effectType;
  if (type === "bw" || name.includes("b & w") || name.includes("b&w")) return "tone-bw";
  if (type === "fujifilm" || name.includes("fujifilm")) return "tone-fujifilm";
  if (type === "original" || name === "original") return "tone-original";
  if (type === "sepia" || f.baseFilter === "sepia" || name.includes("sepia")) return "tone-sepia";
  return "tone-sepia";
}

// Track selected filter by ID (unique per filter, even for multiple cube LUTs)
const selectedFilterId = ref<string>(
  store.activeFilters[0]?.id ?? "default-original",
);
const selectedFilter = computed<CameraFilter | undefined>(
  () => store.activeFilters.find((f) => f.id === selectedFilterId.value)
       ?? store.activeFilters[0],
);

/**
 * Live-preview colour, derived from the SAME definition the capture uses.
 *
 * This used to be a hand-tuned CSS chain that never applied the LUT at all,
 * so what the guest chose and what got printed were visibly different
 * colours — measured against the shipped sepia4.cube, a mean ΔRGB of 29 and
 * up to 54 on light skin. Now:
 *
 *   sepia / bw / fujifilm  are linear, so each is an EXACT feColorMatrix
 *   cube LUTs              become transfer curves sampled off the .cube
 *                          itself (ΔRGB ~4, i.e. below what an eye picks up)
 *
 * It stays an SVG filter rather than per-frame canvas work so the live view
 * costs nothing extra — the GPU composites it.
 */
const PREVIEW_FILTER_ID = "nostalgia-preview-filter";
const cubeCurves = ref<CubePreview | null>(null);
const highlightLut = ref<ParsedLut | null>(null);

const matrixFor = (kind?: string) => {
  if (kind === "sepia") return SEPIA_MATRIX;
  if (kind === "bw") return BW_MATRIX;
  if (kind === "fujifilm") return FUJIFILM_MATRIX;
  return null;
};

const previewMatrix = computed(() => {
  const f = selectedFilter.value;
  if (!f || f.effectType === "original") return null;
  if (f.effectType === "cube") {
    // The curves are indexed by LUMINANCE and already include the base
    // filter, so the matrix stage's only job is to collapse to luminance.
    // Applying the base matrix here as well would tone the image twice and
    // then sample each channel's curve at the wrong point.
    if (cubeCurves.value) return BW_MATRIX;
    // Curves still loading — show the base look meanwhile rather than
    // nothing. Transient, and closer than an unfiltered feed.
    return matrixFor(f.baseFilter);
  }
  return matrixFor(f.effectType);
});

const selectedAdjustments = computed(() =>
  selectedFilter.value
    ? store.resolvedAdjustments(selectedFilter.value)
    : store.DEFAULT_ADJUSTMENTS,
);

const adjustmentTable = computed(() =>
  buildAdjustmentTable(selectedAdjustments.value),
);

const glowSvg = computed(() => glowPreviewSvg(selectedAdjustments.value.glow));

/** True when the selected look needs the SVG filter at all. */
const hasPreviewFilter = computed(
  () =>
    !!previewMatrix.value ||
    !!cubeCurves.value ||
    !!adjustmentTable.value ||
    !!glowSvg.value,
);

const livePreviewFilter = computed(() =>
  hasPreviewFilter.value ? `url(#${PREVIEW_FILTER_ID})` : "none",
);
/** Same colour, plus the blur the "blur" frame style needs behind the window. */
const livePreviewFilterBlurred = computed(() =>
  hasPreviewFilter.value
    ? `blur(18px) url(#${PREVIEW_FILTER_ID})`
    : "blur(18px)",
);

// Rebuild the LUT curves whenever the chosen filter changes. loadLut is
// already cached, so switching back and forth is cheap.
watch(
  selectedFilter,
  async (f) => {
    if (!f || f.effectType !== "cube" || !f.cubeData) {
      cubeCurves.value = null;
      highlightLut.value = null;
      return;
    }
    try {
      const lut = await loadLut(f.cubeData);
      highlightLut.value = lut;
      const preview = buildCubePreview(lut, f.baseFilter);
      cubeCurves.value = preview;
      if (preview.residual > 8) {
        // A colour-grading LUT rather than a tone map: a luminance curve can
        // only get so close. Still far better than the old fixed CSS, but
        // worth knowing about if someone reports a mismatch on a custom LUT.
        console.warn(
          `[Camera] Preview for "${f.name}" approximates its LUT (ΔRGB ${preview.residual.toFixed(1)}) — non-separable grade`,
        );
      }
    } catch (e) {
      console.warn("[Camera] Could not build LUT preview, falling back:", e);
      cubeCurves.value = null;
      highlightLut.value = null;
    }
  },
  { immediate: true },
);

/**
 * The colour wash, as a layer over the live feed.
 *
 * `mix-blend-mode` and the canvas `globalCompositeOperation` used at capture
 * are the same W3C blend formulas under the same names, so this preview is
 * what actually prints — no second approximation to drift out of sync.
 */
const overlayStyle = computed(() => {
  const o = selectedFilter.value?.overlay;
  if (!o || o.opacity <= 0) return null;
  return {
    backgroundColor: o.color,
    mixBlendMode: o.blendMode,
    opacity: String(o.opacity),
  } as Record<string, string>;
});

const selectedMediaRuntime = computed(() => {
  const id = selectedFilter.value?.id;
  if (!id) return null;
  return store.overlayMediaRuntime[id] ?? null;
});

const mediaOverlayStyle = computed(() => {
  const o = selectedFilter.value?.mediaOverlay;
  if (!o || !selectedMediaRuntime.value || o.opacity <= 0) return null;
  return {
    mixBlendMode: o.blendMode,
    opacity: String(o.opacity),
  } as Record<string, string>;
});

const overlayLayersRef = ref<{
  mediaEl: HTMLImageElement | HTMLVideoElement | null;
} | null>(null);

const overlayDecodeRef = ref<HTMLImageElement | HTMLVideoElement | null>(null);

function lookMediaSource(): CanvasImageSource | null {
  const decode = overlayDecodeRef.value;
  if (decode instanceof HTMLVideoElement && decode.readyState >= 2) {
    return decode;
  }
  if (
    decode instanceof HTMLImageElement &&
    decode.complete &&
    decode.naturalWidth >= 2
  ) {
    return decode;
  }
  return overlayLayersRef.value?.mediaEl ?? null;
}

watch(selectedMediaRuntime, async () => {
  await nextTick();
  const el = overlayDecodeRef.value;
  if (el instanceof HTMLVideoElement) {
    el.muted = true;
    el.loop = true;
    await el.play().catch(() => {});
  }
});

const grainOverlayStyle = computed(() => {
  const opacity = grainPreviewOpacity(selectedAdjustments.value.grain);
  if (opacity <= 0) return null;
  return { opacity: String(opacity) };
});

const vignetteOverlayStyle = computed(() =>
  vignettePreviewStyle(selectedAdjustments.value.vignette),
);

// If selected filter is removed, fall back to first available
watch(
  () => store.activeFilters,
  (filters) => {
    const stillExists = filters.some((f) => f.id === selectedFilterId.value);
    if (!stillExists && filters.length) {
      selectedFilterId.value = filters[0].id;
    }
  },
  { deep: true },
);

// When frame style becomes blur, attach stream to the blur video (it may have just mounted)
watch(effectiveFrameStyle, async () => {
  if (!stream.value) return;
  await nextTick();
  if (videoRef.value) {
    videoRef.value.srcObject = stream.value;
    await videoRef.value.play();
  }
  if (videoBlurRef.value) {
    videoBlurRef.value.srcObject = stream.value;
    await videoBlurRef.value.play();
  }
});

// Live copy of the selected layout (cells / frame art). Fall back to
// the session snapshot so the left frame preview never disappears if
// the live lookup is briefly empty.
const liveTemplate = computed(
  () => store.sessionTemplate ?? store.selectedTemplate,
);


// Check and initialize Canon EDSDK camera
async function initCanonCamera() {
  try {
    // Check if EDSDK is available
    if (!window.electronAPI?.canonCheckAvailable) {
      console.log('[Camera] Canon EDSDK API not available');
      return false;
    }
    
    const available = await window.electronAPI.canonCheckAvailable();
    if (!available.available) {
      console.log('[Camera] Canon EDSDK not available:', available.error);
      return false;
    }
    
    console.log('[Camera] Canon EDSDK available, checking for cameras...');
    canonCameraAvailable.value = true;
    
    // List available Canon cameras
    const result = await window.electronAPI.canonListCameras();
    if (!result.success || result.cameras.length === 0) {
      console.log('[Camera] No Canon cameras found');
      return false;
    }
    
    console.log(`[Camera] Found ${result.cameras.length} Canon camera(s):`);
    result.cameras.forEach((cam: any, index: number) => {
      console.log(`[Camera]   ${index}: ${cam.name} (${cam.portName})`);
    });
    
    // Connect to first camera
    const connectResult = await window.electronAPI.canonConnect(0);
    if (!connectResult.success) {
      const errorMsg = connectResult.error || '';
      console.error('[Camera] Failed to connect to Canon camera:', errorMsg);
      
      // Check for specific errors
      if (errorMsg.includes('COMM_PORT_IS_IN_USE') || errorMsg.includes('port') || errorMsg.includes('in use')) {
        console.error('[Camera] ⚠ Camera port is in use by another application!');
        console.error('[Camera] SOLUTION:');
        console.error('[Camera]   1. Close EOS Webcam Utility (if running)');
        console.error('[Camera]   2. Close EOS Utility (if running)');
        console.error('[Camera]   3. Close any other applications using the camera');
        console.error('[Camera]   4. Disconnect and reconnect the USB cable');
        console.error('[Camera]   5. Restart this application');
        throw new Error('Camera port is in use. Please close EOS Webcam Utility, EOS Utility, or any other applications using the camera, then restart this app.');
      }
      
      if (errorMsg.includes('INVALID_DEVICEPROP_VALUE') || errorMsg.includes('INVALID')) {
        console.warn('[Camera] ⚠ Camera property configuration issue (non-critical)');
        console.warn('[Camera] Camera connection may have succeeded despite property error');
        // Try to continue - the connection handler should handle this gracefully
        // Return false to let the caller handle it, but log that it might be recoverable
      }
      
      return false;
    }
    
    canonCameraConnected.value = true;
    canonCameraName.value = connectResult.cameraName;
    
    console.log(`[Camera] ✓ Connected to Canon camera: ${connectResult.cameraName}`);
    console.log('[Camera] Using Canon EDSDK for photo capture');
    
    // Mark camera as ready (no preview available with EDSDK)
    cameraReady.value = true;
    
    return true;
  } catch (error) {
    console.error('[Camera] Error initializing Canon camera:', error);
    return false;
  }
}

async function openVideoStream(): Promise<MediaStream> {
  const media = await requestVideoStream(stream.value);
  stream.value = null;
  return media;
}

async function initWebcam() {
  const media = await openVideoStream();
  stream.value = media;
  cameraReady.value = true;
  await nextTick();
  const bind = async (el: HTMLVideoElement | null) => {
    if (!el) return;
    el.srcObject = media;
    el.muted = true;
    try {
      await el.play();
    } catch (playErr) {
      console.warn("[Camera] video.play() failed:", playErr);
    }
  };
  await bind(videoRef.value);
  await bind(videoBlurRef.value);
  console.log("[Camera] Using this computer's camera");
}

// Initialize camera - EDSDK only
async function initCamera() {
  try {
    // Camera detection turned off in admin Settings → run in test mode
    // with this computer's webcam (sample.png placeholder is commented out).
    if (!store.cameraDetectionEnabled) {
      // console.log('[Camera] Camera detection OFF — running in test mode (sample.png)');
      // liveViewFrame.value = TEST_SAMPLE_SRC;
      // cameraReady.value = true;
      // const preload = new Image();
      // preload.src = TEST_SAMPLE_SRC;
      // return;
      await initWebcam();
      return;
    }

    console.log('[Camera] Initializing Canon EDSDK camera...');

    // Initialize Canon EDSDK camera
    const canonInitialized = await initCanonCamera();
    
    if (!canonInitialized) {
      console.warn(
        "[Camera] No Canon camera — falling back to this computer's webcam",
      );
      await initWebcam();
      return;
    }

    console.log('[Camera] ✓ Camera initialization complete');
    // Start live view for preview
    await startLiveView();
  } catch (err: any) {
    console.error("[Camera] Camera initialization error:", err);

    // Show error modal to user
    cameraErrorMessage.value =
      err instanceof Error ? err.message : webcamErrorMessage(err);
    cameraErrorIsConnection.value = true;
    showCameraError.value = true;

    throw err;
  }
}

async function startLiveView() {
  if (!window.electronAPI?.canonStartLiveView) return;
  try {
    const result = await window.electronAPI.canonStartLiveView();
    if (result.success) {
      liveViewActive.value = true;
      console.log('[Camera] Live view started');
      window.electronAPI.onLiveViewFrame((dataUrl: string) => {
        liveViewFrame.value = dataUrl;
      });
    } else {
      // Latching this silently is why the preview goes black for the rest
      // of the session after one failed restart — liveViewActive stays
      // false, so capturePhoto() stops tearing live view down before the
      // shutter too.
      liveViewActive.value = false;
      console.error('[Camera] Live view FAILED to start:', result.error);
    }
  } catch (err) {
    console.warn('[Camera] Could not start live view:', err);
  }
}

async function stopLiveView(opts?: { keepFrame?: boolean }) {
  if (!window.electronAPI?.canonStopLiveView) return;
  window.electronAPI.offLiveViewFrame?.();
  liveViewActive.value = false;
  // Webcam freeze is video.pause() — the last frame stays on screen.
  // Canon EVF is an <img :src="liveViewFrame">; clearing it here is
  // why the review after a Canon shot went blank ("Starting preview…")
  // while webcam still showed the pose.
  if (!opts?.keepFrame) {
    liveViewFrame.value = null;
  }
  try {
    await window.electronAPI.canonStopLiveView();
  } catch (_) {}
}

function retryCameraConnection() {
  showCameraError.value = false;
  cameraErrorMessage.value = '';
  stopWebcamTracks(stream.value);
  stream.value = null;
  initCamera().catch(err => {
    console.error('[Camera] Retry failed:', err instanceof Error ? err.message : err);
  });
}

function dismissCameraError() {
  showCameraError.value = false;
  router.push('/');
}

// Start capture — one tap drives the WHOLE session. After the filter is
// chosen and Start is pressed, each shot fires automatically (no need to
// tap Start again per photo) until the template's photo count is
// reached: first shot uses the admin-configured "first" countdown,
// every shot after that uses the (usually shorter) "subsequent"
// countdown, matching a real photobooth's pacing.
function startCapture() {
  if (
    isCountingDown.value ||
    isCapturing.value ||
    isReviewing.value ||
    !cameraReady.value ||
    store.hasAllPhotos
  )
    return;
  // Suspend the inactivity clock for the WHOLE multi-shot run.
  sequenceActive = true;
  resetInactivityTimer();
  void runCountdownAndCapture();
}

/** Ends the shoot and lets the inactivity clock run again. */
function endSequence() {
  sequenceActive = false;
  resetInactivityTimer();
}

let countdownSleepTimer: ReturnType<typeof setTimeout> | null = null;
/** True when EVF was torn down during countdown "1" and must come back after the shot. */
let restoreLiveViewAfterShot = false;
let isUnmounted = false;

function sleepCountdown(ms: number): Promise<void> {
  return new Promise((resolve) => {
    countdownSleepTimer = setTimeout(() => {
      countdownSleepTimer = null;
      resolve();
    }, ms);
  });
}

function cancelCountdownSleep() {
  if (countdownSleepTimer) {
    clearTimeout(countdownSleepTimer);
    countdownSleepTimer = null;
  }
}

let reviewSleepTimer: ReturnType<typeof setTimeout> | null = null;
/** Canon EVF was up for this shot — restart it after the freeze, not during. */
let restoreLiveViewAfterReview = false;
let highlightLeadTimer: ReturnType<typeof setTimeout> | null = null;

function cancelHighlightLead() {
  if (highlightLeadTimer) {
    clearTimeout(highlightLeadTimer);
    highlightLeadTimer = null;
  }
}

function applyHighlightLook(ctx: CanvasRenderingContext2D) {
  const f = selectedFilter.value;
  const media = f?.mediaOverlay;
  const mediaEl = lookMediaSource();
  applyCaptureLook(ctx, {
    effectType: f?.effectType ?? "original",
    baseFilter: f?.baseFilter,
    lut: highlightLut.value,
    overlay:
      f?.overlay && f.overlay.opacity > 0
        ? {
            color: f.overlay.color,
            blendMode: f.overlay.blendMode,
            opacity: f.overlay.opacity,
          }
        : null,
    media:
      media && mediaEl && media.opacity > 0
        ? {
            source: mediaEl,
            blendMode: media.blendMode,
            opacity: media.opacity,
          }
        : null,
    adjustments: f ? store.resolvedAdjustments(f) : null,
  });
}

/** Start streaming the live camera 10s before each shutter. */
function armHighlightRecording(countdownSeconds: number) {
  cancelHighlightLead();
  const delay = Math.max(0, countdownSeconds * 1000 - HIGHLIGHT_LEAD_MS);
  const tryStart = () => {
    highlightLeadTimer = null;
    if (isUnmounted || isHighlightRecording()) return;
    void (async () => {
      let ok = false;
      try {
        ok = await startHighlightCapture({
          stream: stream.value,
          video: videoRef.value,
          getStillUrl: () => liveViewFrame.value,
          getMirror: () => store.mirrorMode,
          applyLook: applyHighlightLook,
        });
      } catch (e) {
        console.warn("[Highlight] Start failed:", e);
      }
      if (ok) {
        highlightRecording.value = true;
        return;
      }
      if (!isUnmounted && isCountingDown.value) {
        highlightLeadTimer = setTimeout(tryStart, 200);
      }
    })();
  };
  highlightLeadTimer = setTimeout(tryStart, delay);
}

function sleepReview(ms: number): Promise<void> {
  return new Promise((resolve) => {
    reviewSleepTimer = setTimeout(() => {
      reviewSleepTimer = null;
      resolve();
    }, ms);
  });
}

function freezeLivePreview() {
  videoRef.value?.pause();
  videoBlurRef.value?.pause();
  freezeHighlightCapture();
}

async function unfreezeLivePreview() {
  if (restoreLiveViewAfterReview) {
    restoreLiveViewAfterReview = false;
    await startLiveView();
    return;
  }
  try {
    await videoRef.value?.play();
  } catch {
    /* play() rejects if the element was torn down */
  }
  try {
    await videoBlurRef.value?.play();
  } catch {
    /* same */
  }
}

async function finishHighlightClip(shotNumber: number) {
  if (!isHighlightRecording()) {
    highlightRecording.value = false;
    return;
  }
  try {
    const clip = await stopHighlightCapture();
    highlightRecording.value = false;
    if (!clip) {
      console.warn("[Highlight] Stop returned no clip");
      return;
    }
    store.addHighlightClip(clip);
    await saveHighlightLocally(clip, shotNumber);
  } catch (e) {
    highlightRecording.value = false;
    console.warn("[Highlight] Stop failed:", e);
    abortHighlightCapture();
  }
}

async function saveHighlightLocally(clipUrl: string, shot: number) {
  const api = window.electronAPI;
  if (!api?.saveHighlightVideo) {
    console.warn("[Highlight] saveHighlightVideo is not available — restart Electron");
    return;
  }
  const parsed = await mediaUrlToBytes(clipUrl);
  if (!parsed) {
    console.warn("[Highlight] Could not read clip bytes (blob URL?)");
    return;
  }
  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getFullYear()).slice(-2)}`;
  const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const filename = `${stamp}/highlight-${shot}-${time}.${parsed.ext}`;
  try {
    const r = await api.saveHighlightVideo({
      bytes: parsed.bytes,
      filename,
    });
    if (r.success) console.log("[Highlight] Saved locally:", r.path);
    else console.warn("[Highlight] Local save failed:", r.error);
  } catch (e) {
    console.warn("[Highlight] Local save error:", e);
  }
}

/** Hold the last shutter frame on screen, then continue. */
async function showShotReview() {
  isReviewing.value = true;
  for (let n = SHOT_REVIEW_SECONDS; n >= 1; n--) {
    if (isUnmounted) return;
    freezeCountdown.value = n;
    await sleepReview(1000);
  }
  freezeCountdown.value = SHOT_REVIEW_SECONDS;
  isReviewing.value = false;
}

async function runCountdownAndCapture() {
  if (isUnmounted) return;

  const isFirstShot = store.capturedPhotos.length === 0;
  // Posing timer only. The freeze after a capture is extra and is
  // awaited in showShotReview before this function runs again.
  const seconds = isFirstShot
    ? store.shootingFirstCountdownSeconds
    : store.shootingSubsequentCountdownSeconds;

  isCountingDown.value = true;
  armHighlightRecording(seconds);

  for (let n = seconds; n >= 1; n--) {
    if (isUnmounted) return;
    countdownValue.value = n;
    // Keep live view running through the last second so the highlight
    // file gets a full 10s of motion. capturePhoto() still stops EVF
    // right before the shutter.
    if (n === 1 && liveViewActive.value) {
      restoreLiveViewAfterShot = true;
    }
    await sleepCountdown(1000);
  }

  if (isUnmounted) return;
  isCountingDown.value = false;
  isCapturing.value = true;
  const shotNumber = store.capturedPhotos.length + 1;
  if (isHighlightRecording()) {
    await waitForHighlightLead();
    freezeLivePreview();
  }
  const success = await capturePhoto();
  isCapturing.value = false;

  if (success && !isUnmounted) {
    await showShotReview();
    await finishHighlightClip(shotNumber);
    if (!isUnmounted) await unfreezeLivePreview();
  } else {
    cancelHighlightLead();
    abortHighlightCapture();
    highlightRecording.value = false;
    if (!isUnmounted) await unfreezeLivePreview();
  }

  if (isUnmounted) return;
  if (success && !store.hasAllPhotos) {
    // Live feed is already unfrozen. Next posing countdown is a full
    // 15s (or whatever admin set) — the freeze is not subtracted.
    await runCountdownAndCapture();
  } else {
    endSequence();
    if (success && store.hasAllPhotos) {
      router.push("/printing");
    }
  }
}

// Capture photo - Canon EDSDK only. Resolves true on success, false on
// failure (after showing the retry modal) so the auto-shoot chain
// above knows whether to continue to the next shot.
async function capturePhoto(): Promise<boolean> {
  const restoreLiveView = liveViewActive.value || restoreLiveViewAfterShot;
  restoreLiveViewAfterShot = false;
  console.log(
    `[Camera] capture ${store.capturedPhotos.length + 1}/${store.requiredPhotos} — ` +
      `liveViewActive=${liveViewActive.value}, restoreLiveView=${restoreLiveView}, canonConnected=${canonCameraConnected.value}`,
  );
  if (liveViewActive.value) await stopLiveView({ keepFrame: true });

  try {
    await capturePhotoInner(restoreLiveView);
    return true;
  } catch (error) {
    console.error('[Camera] Capture failed, restoring live view:', error);
    restoreLiveViewAfterReview = false;
    if (restoreLiveView) void startLiveView();
    else void unfreezeLivePreview();
    cameraErrorMessage.value =
      error instanceof Error ? error.message : 'Failed to capture photo. Please try again.';
    cameraErrorIsConnection.value = false;
    showCameraError.value = true;
    return false;
  }
}

async function capturePhotoInner(hadLiveView: boolean) {
  // Flash effect
  showFlash.value = true;
  setTimeout(() => {
    showFlash.value = false;
  }, 150);

  let sourceSrc: string | null = null;
  let sourceVideo: HTMLVideoElement | null = null;

  if (canonCameraConnected.value && window.electronAPI?.canonTakePhoto) {
    try {
      console.log("[Camera] Taking photo with Canon EDSDK...");
      const result = await window.electronAPI.canonTakePhoto();

      if (!result.success || !result.imageData) {
        console.error("[Camera] Canon photo capture failed:", result.error);
        throw new Error(result.error || "Failed to capture photo from Canon camera");
      }

      sourceSrc = result.imageData;
      console.log(
        `[Camera] ✓ Photo captured from Canon camera: ${result.fileName}, imageData length=${result.imageData.length}, prefix="${result.imageData.slice(0, 40)}"`,
      );
    } catch (error) {
      console.error("[Camera] Error capturing with Canon camera:", error);
      throw error;
    }
  } else {
    sourceVideo = videoRef.value;
    if (!sourceVideo || sourceVideo.readyState < 2) {
      throw new Error("Camera is not ready. Allow camera access and try again.");
    }
    console.log(
      `[Camera] Capturing webcam frame ${sourceVideo.videoWidth}x${sourceVideo.videoHeight}`,
    );
    // Freeze the viewfinder on this last live frame (the guest preview).
    // Highlight recording stays on this frame for the 5s tail.
    sourceVideo.pause();
    videoBlurRef.value?.pause();
    freezeHighlightCapture();
  }

  try {
        // Always process through canvas: resize to print-safe size + apply mirror/filter
        let source: CanvasImageSource;
        let srcW: number;
        let srcH: number;

        if (sourceVideo) {
          source = sourceVideo;
          srcW = sourceVideo.videoWidth;
          srcH = sourceVideo.videoHeight;
        } else {
          if (!sourceSrc) {
            throw new Error("No capture source");
          }
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => {
              console.log(`[Camera] Image loaded: ${img.width}x${img.height}`);
              resolve();
            };
            img.onerror = (err) => {
              console.error(`[Camera] Image failed to load:`, err);
              reject(err);
            };
            img.src = sourceSrc;
          });
          source = img;
          srcW = img.width;
          srcH = img.height;
        }

        if (!canvasRef.value) return;
        const canvas = canvasRef.value;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Resize to max 3600px wide — gives 3600×2400 at the camera's
        // native 3:2 aspect (Canon outputs 6000×4000, so this is a 0.6×
        // downsample). Doubles the print-time pixel headroom over the
        // old 1800-wide cap so Cloudinary copies and any future larger
        // print sizes (5×7, 6×8) keep their detail. Memory cost: each
        // capture is ~35 MB as a raw RGBA bitmap, but after JPEG
        // encoding at q=0.92 it's only a few MB on disk/upload.
        const MAX_W = 3600;
        const scale = Math.min(1, MAX_W / srcW);
        canvas.width = Math.round(srcW * scale);
        canvas.height = Math.round(srcH * scale);

        if (store.mirrorMode) {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        if (canvas.width === 0 || canvas.height === 0) {
          throw new Error(`Canvas is ${canvas.width}x${canvas.height} — image did not load correctly (source was ${srcW}x${srcH})`);
        }

        // Unfiltered full frame for the local session folder only.
        const originalImageData = canvas.toDataURL("image/jpeg", 0.92);

        // Apply colour filter
        const filter = selectedFilter.value;
        const effectType = filter?.effectType ?? "original";

        /**
         * Apply a named pixel-level colour effect to whatever is currently on
         * the canvas. Extracted so it can be called both as a standalone filter
         * and as the "base" step before a cube LUT.
         */
        function applyPixelFilter(type: string) {
          const imageData = ctx!.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          if (type === "sepia") {
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i], g = data[i + 1], b = data[i + 2];
              data[i]     = Math.min(255, r * 0.393 + g * 0.769 + b * 0.189);
              data[i + 1] = Math.min(255, r * 0.349 + g * 0.686 + b * 0.168);
              data[i + 2] = Math.min(255, r * 0.272 + g * 0.534 + b * 0.131);
            }
          } else if (type === "bw") {
            for (let i = 0; i < data.length; i += 4) {
              const gray = Math.min(255, 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
              data[i] = data[i + 1] = data[i + 2] = gray;
            }
          } else if (type === "fujifilm") {
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i], g = data[i + 1], b = data[i + 2];
              const gray = 0.299 * r + 0.587 * g + 0.114 * b;
              data[i]     = Math.min(255, (r + gray * 0.4) * 0.9);
              data[i + 1] = Math.min(255, (g + gray * 0.35) * 0.92);
              data[i + 2] = Math.min(255, (b + gray * 0.2) * 0.85);
            }
          }
          ctx!.putImageData(imageData, 0, 0);
        }

        // Film grain: per-pixel monochrome noise (same offset on R/G/B
        // so it reads as luminance grain rather than colour static),
        // baked into the capture for Sepia/B&W/Fujifilm — the same three
        // filters that get the CSS grain overlay in the live preview
        // (see hasGrainOverlay). `intensity` is the max +/- offset —
        // bumped from 14 (barely visible on a full-res 3600×2400 photo)
        // to a clearly-visible level.
        function applyGrain(intensity = 34) {
          const imageData = ctx!.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 4) {
            const noise = (Math.random() - 0.5) * intensity;
            data[i] = Math.min(255, Math.max(0, data[i] + noise));
            data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
            data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
          }
          ctx!.putImageData(imageData, 0, 0);
        }

        if (effectType === "sepia" || effectType === "bw" || effectType === "fujifilm") {
          applyPixelFilter(effectType);
        } else if (effectType === "cube" && filter?.cubeData) {
          // Step 1 — base colour preset (e.g. sepia), if specified
          if (filter.baseFilter && filter.baseFilter !== "original") {
            console.log(`[Camera] Applying base filter: ${filter.baseFilter}`);
            applyPixelFilter(filter.baseFilter);
          }
          // Step 2 — cube LUT on top of the base-filtered result
          console.log(`[Camera] Applying LUT: ${filter.name}`);
          const lut = await loadLut(filter.cubeData);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          applyLutToImageData(imageData, lut);
          ctx.putImageData(imageData, 0, 0);
          console.log(`[Camera] LUT applied: ${filter.name}`);
        }

        // Composite the colour wash (Settings → Filters → Overlay), the
        // equivalent of a Photoshop fill layer set to a blend mode. It goes
        // on AFTER the tone/LUT and BEFORE grain, which is the same order
        // the live preview stacks its layers in — see `overlayStyle`.
        //
        // globalCompositeOperation takes the very same blend-mode names as
        // CSS mix-blend-mode and implements the same W3C formulas, so the
        // preview and the print agree without any conversion.
        const overlay = filter?.overlay;
        if (overlay && overlay.opacity > 0) {
          console.log(
            `[Camera] Applying overlay ${overlay.color} ${overlay.blendMode} @ ${Math.round(overlay.opacity * 100)}%`,
          );
          ctx.save();
          ctx.globalCompositeOperation =
            overlay.blendMode as GlobalCompositeOperation;
          ctx.globalAlpha = overlay.opacity;
          ctx.fillStyle = overlay.color;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }

        const mediaLayer = filter?.mediaOverlay;
        const mediaEl = lookMediaSource();
        if (mediaLayer && mediaEl && mediaLayer.opacity > 0) {
          console.log(
            `[Camera] Applying media overlay ${mediaLayer.mediaName} ${mediaLayer.blendMode} @ ${Math.round(mediaLayer.opacity * 100)}%`,
          );
          drawLookMedia(ctx, mediaEl, mediaLayer.blendMode, mediaLayer.opacity);
        }

        // Bake levels / contrast / shadows / glow / vignette AFTER overlay
        // and BEFORE grain — same stack as the live preview.
        if (filter) {
          const adj = store.resolvedAdjustments(filter);
          const adjusted = ctx.getImageData(0, 0, canvas.width, canvas.height);
          applyAdjustmentsToImageData(adjusted, adj);
          ctx.putImageData(adjusted, 0, 0);

          if (adj.grain > 0) {
            console.log("[Camera] Applying film grain", adj.grain);
            applyGrain(grainCaptureIntensity(adj.grain));
          }
        }

        // Full uncropped frame (filters already baked) for local/cloud
        // gallery downloads. Print / left strip still use the lit center.
        const fullImageData = canvas.toDataURL("image/jpeg", 0.92);
        const fullW = canvas.width;
        const fullH = canvas.height;
        cropCanvasToHighlightedView(canvas, ctx, cropBarPercent.value);
        const croppedImageData =
          canvas.width === fullW && canvas.height === fullH
            ? fullImageData
            : canvas.toDataURL("image/jpeg", 0.92);
        console.log(
          `[Camera] Image processed: cropped ${Math.round(croppedImageData.length / 1024)}KB (${canvas.width}x${canvas.height}), full ${Math.round(fullImageData.length / 1024)}KB (${fullW}x${fullH})`,
        );
        store.addPhoto(croppedImageData, fullImageData, originalImageData);

        // Do not restart Canon EVF here — that would un-freeze the
        // viewfinder. Restore after the 5s pause in showShotReview.
        if (hadLiveView && !store.hasAllPhotos) {
          restoreLiveViewAfterReview = true;
        }
  } catch (error) {
    console.error("[Camera] Error processing capture:", error);
    throw error;
  }
}

/**
 * Crop the processed capture to the same window the live-view bars
 * highlight. The viewfinder is a 3:2 box with object-fit:cover, then
 * left/right bars of `cropBarPct`% each. Result aspect matches the
 * template cell so the left strip shows that framed shot, not the
 * full wide feed.
 */
function cropCanvasToHighlightedView(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  cropBarPct: number,
) {
  const srcW = canvas.width;
  const srcH = canvas.height;
  if (srcW < 2 || srcH < 2) return;

  const r = highlightedViewRect(srcW, srcH, cropBarPct);
  if (r.sw >= srcW && r.sh >= srcH) return;

  const cropped = ctx.getImageData(r.sx, r.sy, r.sw, r.sh);
  canvas.width = r.sw;
  canvas.height = r.sh;
  ctx.putImageData(cropped, 0, 0);
  console.log(
    `[Camera] Cropped to highlighted view ${r.sw}x${r.sh} (bars ${cropBarPct.toFixed(1)}% / side)`,
  );
}

function setFilter(filter: CameraFilter) {
  resetInactivityTimer();
  selectedFilterId.value = filter.id;
}

// Toggle mirror mode
function toggleMirror() {
  resetInactivityTimer();
  store.setMirror(!store.mirrorMode);
}

function stopCameraStream() {
  stopLiveView();
  if (stream.value) {
    stream.value.getTracks().forEach((track) => track.stop());
    stream.value = null;
  }
  // Disconnect Canon camera if connected
  if (canonCameraConnected.value && window.electronAPI?.canonDisconnect) {
    window.electronAPI.canonDisconnect().catch((err) => {
      console.error('[Camera] Error disconnecting Canon camera:', err);
    });
  }
}

// True from the moment Start is pressed until the last shot is stored.
// The guest deliberately does NOT touch the screen during a shoot (they
// are posing), so an inactivity timer must not run at all — relying on
// resetInactivityTimer() being called from inside the countdown tick
// left gaps during the shutter, the image processing and the live-view
// restart, any of which could exceed the timeout on a slow capture.
let sequenceActive = false;
// The 100ms hand-off between the warning appearing and its countdown
// starting was untracked, so it could fire after teardown.
let warningStartTimer: ReturnType<typeof setTimeout> | null = null;

function clearInactivityTimers() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  if (warningStartTimer) {
    clearTimeout(warningStartTimer);
    warningStartTimer = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function resetInactivityTimer() {
  clearInactivityTimers();

  showInactivityWarning.value = false;
  inactivityCountdown.value = WARNING_COUNTDOWN;

  // The shooting screen must never auto-return. Guests (and operators
  // lining up a shot) stand in front of the live view without touching
  // anything — the 60s idle clock kept sending them home mid-compose.
  // Sequence / countdown / shutter guards were not enough: the timer
  // still fired before Start, after a failed frame, and during review.
}

function returnToHome() {
  if (isUnmounted) return;
  if (
    sequenceActive ||
    isCountingDown.value ||
    isCapturing.value ||
    isReviewing.value
  ) {
    console.warn("[Camera] Ignored auto-return — shoot is in progress");
    return;
  }
  resetInactivityTimer();
  stopCameraStream();

  // Clear captured photos
  store.resetSession();

  // Return to home
  router.push("/");
}

function cancelInactivityWarning() {
  resetInactivityTimer();
}

// Go back to template selection.
// Locked while a countdown or shutter is in progress: the client runs a
// no-retake policy, so a guest must not be able to bail out mid-shot
// ("kapag on going na yung timer hindi nadin dapat maciclick yung back
// button kasi no retake kami"). The button is also visually disabled.
function goBack() {
  if (isCountingDown.value || isCapturing.value || isReviewing.value) return;
  resetInactivityTimer();

  // Check if there are captured photos
  if (store.capturedPhotos.length > 0) {
    // Show custom warning modal
    showBackWarning.value = true;
  } else {
    // No photos, go back immediately
    router.push("/templates");
  }
}

function confirmGoBack() {
  // Clear all timers before navigating
  resetInactivityTimer();

  // Clear captured photos before going back
  store.resetSession();
  showBackWarning.value = false;
  router.push("/templates");
}

function cancelGoBack() {
  showBackWarning.value = false;
}

// Watch for all photos captured
watch(
  () => store.hasAllPhotos,
  (allCaptured) => {
    if (allCaptured) {
      // Disconnect camera after all photos are captured
      if (canonCameraConnected.value && window.electronAPI?.canonDisconnect) {
        window.electronAPI.canonDisconnect();
      }
    }
  },
);

onMounted(() => {
  if (!store.selectedTemplate) {
    router.push("/templates");
    return;
  }
  initCamera();
  resetInactivityTimer();
});

onUnmounted(() => {
  // Stop the capture chain dead: without this, a mid-countdown unmount
  // leaves an interval that keeps firing and re-arming the sequence on a
  // component that no longer exists.
  isUnmounted = true;
  sequenceActive = false;
  cancelCountdownSleep();
  cancelHighlightLead();
  abortHighlightCapture();
  highlightRecording.value = false;
  if (reviewSleepTimer) {
    clearTimeout(reviewSleepTimer);
    reviewSleepTimer = null;
  }
  clearInactivityTimers();
  stopLiveView();
  window.electronAPI?.offLiveViewFrame?.();
  stopCameraStream();

  // Disconnect Canon camera if connected
  if (canonCameraConnected.value && window.electronAPI?.canonDisconnect) {
    window.electronAPI.canonDisconnect().then(() => {
      console.log('[Camera] Canon camera disconnected');
    }).catch((err) => {
      console.error('[Camera] Error disconnecting Canon camera:', err);
    });
  }

  // Reset state
  showInactivityWarning.value = false;
  showBackWarning.value = false;
  inactivityCountdown.value = WARNING_COUNTDOWN;
});
</script>

<template>
  <div class="camera-screen" :class="{ 'kiosk-laid-out': laidOut }">
    <KioskDecor screen-id="camera" />
    <!-- The live preview's colour, built from the same definition the
         capture uses (see filterPreview.ts). Zero-sized and hidden: it only
         carries the filter definition the feed elements reference.
         color-interpolation-filters="sRGB" is essential — the SVG default is
         linearRGB, which would shift every value. -->
    <svg
      class="preview-filter-defs"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
    >
      <filter
        :id="PREVIEW_FILTER_ID"
        x="-30%"
        y="-30%"
        width="160%"
        height="160%"
        color-interpolation-filters="sRGB"
      >
        <feColorMatrix
          v-if="previewMatrix"
          type="matrix"
          :values="previewMatrix"
        />
        <feComponentTransfer v-if="cubeCurves">
          <feFuncR type="table" :tableValues="cubeCurves.r" />
          <feFuncG type="table" :tableValues="cubeCurves.g" />
          <feFuncB type="table" :tableValues="cubeCurves.b" />
        </feComponentTransfer>
        <feComponentTransfer v-if="adjustmentTable">
          <feFuncR type="table" :tableValues="adjustmentTable" />
          <feFuncG type="table" :tableValues="adjustmentTable" />
          <feFuncB type="table" :tableValues="adjustmentTable" />
        </feComponentTransfer>
        <feOffset v-if="glowSvg" dx="0" dy="0" result="preGlow" />
        <feColorMatrix
          v-if="glowSvg"
          in="preGlow"
          type="matrix"
          :values="glowSvg.extract"
          result="glowHi"
        />
        <feGaussianBlur
          v-if="glowSvg"
          in="glowHi"
          :stdDeviation="glowSvg.blur"
          result="glowBlur"
        />
        <feComponentTransfer v-if="glowSvg" in="glowBlur" result="glowAmt">
          <feFuncR type="linear" :slope="glowSvg.slopeR" intercept="0" />
          <feFuncG type="linear" :slope="glowSvg.slopeG" intercept="0" />
          <feFuncB type="linear" :slope="glowSvg.slopeB" intercept="0" />
        </feComponentTransfer>
        <feBlend v-if="glowSvg" in="preGlow" in2="glowAmt" mode="screen" />
      </filter>
    </svg>

    <!-- Back Button — bottom-left, cream/ghost style (v2). -->
    <button
      class="ghost-btn kiosk-action-btn back-btn"
      :disabled="isCountingDown || isCapturing || isReviewing"
      :style="laidOut ? boxStyle('backBtn') : undefined"
      @click="goBack"
    >
      {{ buttonLabel("backBtn", "Back") }}
    </button>

    <!-- Left: live preview of the ACTUAL selected template — real paper
         aspect, real cell grid and frame artwork, filling in as each
         shot lands (same geometry the print composite uses). -->
    <div class="strip-preview" :style="laidOut ? boxStyle('strip') : undefined">
      <div class="strip-preview-tilt">
        <div class="strip-preview-cq">
          <TemplateLivePreview
            v-if="liveTemplate"
            :template="liveTemplate"
            :photos="capturedPhotoUrls"
            :active-index="store.capturedPhotos.length"
            fluid
          />
        </div>
      </div>
    </div>

    <!-- Center: Camera Feed -->
    <div class="camera-container">
      <div class="camera-stage" :style="laidOut ? boxStyle('viewfinder') : undefined">
        <div
          class="camera-frame"
          :class="{
            'camera-frame--wooden': effectiveFrameStyle === 'wooden',
            'camera-frame--blur': effectiveFrameStyle === 'blur',
            'camera-frame--color': effectiveFrameStyle === 'color',
            'camera-frame--svg': effectiveFrameStyle === 'svg',
            'camera-frame--none': effectiveFrameStyle === 'none',
          }"
          :style="
            effectiveFrameStyle === 'color'
              ? { '--camera-frame-color': cameraFrameColor }
              : effectiveFrameStyle === 'svg' && cameraFrameSvgUrl
                ? { '--camera-frame-bg-image': `url(${cameraFrameSvgUrl})` }
                : {}
          "
        >
        <!-- Blur style: full-size blurred layer (Canon live view).
             Tone/LUT lives on the feed pixels only so the PNG/MOV overlay
             can sit ON TOP of the filter, matching capture. -->
        <div
          v-if="effectiveFrameStyle === 'blur'"
          class="camera-feed camera-feed-blur"
        >
          <video
            v-if="stream"
            ref="videoBlurRef"
            class="liveview-img"
            :class="{ mirror: store.mirrorMode }"
            :srcObject="stream"
            :style="{ filter: livePreviewFilter }"
            autoplay
            muted
            playsinline
          />
          <img
            v-else-if="liveViewFrame"
            :src="liveViewFrame"
            class="liveview-img"
            :class="{ mirror: store.mirrorMode }"
            :style="{ filter: livePreviewFilter }"
          />
        </div>
        <!-- Blur style: sharp feed in centered window with white border -->
        <template v-if="effectiveFrameStyle === 'blur'">
          <div class="camera-feed-sharp-wrap">
            <div class="camera-feed camera-feed-sharp camera-feed-liveview">
              <video
                v-if="stream"
                ref="videoRef"
                class="liveview-img"
                :class="{ mirror: store.mirrorMode }"
                :srcObject="stream"
                :style="{ filter: livePreviewFilter }"
                autoplay
                muted
                playsinline
              />
              <img
                v-else-if="liveViewFrame"
                :src="liveViewFrame"
                class="liveview-img"
                :class="{ mirror: store.mirrorMode }"
                :style="{ filter: livePreviewFilter }"
              />
              <!-- Crop indicator: faded bars marking how much of the
                   3:2 capture the SELECTED template trims off each
                   side (see `cropBarPercent`). The lit central window
                   is what actually prints — the guest composes inside
                   it. Bar width updates per template. -->
              <div
                class="liveview-crop-bars"
                aria-hidden="true"
                :style="{ '--crop-bar-w': cropBarPercent + '%' }"
              >
                <div class="liveview-crop-bar liveview-crop-bar--left"></div>
                <div class="liveview-crop-bar liveview-crop-bar--right"></div>
              </div>
              <FilterOverlayLayers
                ref="overlayLayersRef"
                :overlay-style="overlayStyle"
                :media-url="selectedMediaRuntime?.url"
                :media-kind="selectedMediaRuntime?.type"
                :media-style="mediaOverlayStyle"
                :vignette-style="vignetteOverlayStyle"
                :grain-style="grainOverlayStyle"
              />
            </div>
          </div>
        </template>
        <!-- Non-blur: Canon live view or placeholder -->
        <div v-else class="camera-feed camera-feed-liveview">
          <video
            v-if="stream"
            ref="videoRef"
            class="liveview-img"
            :class="{ mirror: store.mirrorMode }"
            :srcObject="stream"
            :style="{ filter: livePreviewFilter }"
            autoplay
            muted
            playsinline
          />
          <img
            v-else-if="liveViewFrame"
            :src="liveViewFrame"
            class="liveview-img"
            :class="{ mirror: store.mirrorMode }"
            :style="{ filter: livePreviewFilter }"
          />
          <div v-else class="liveview-placeholder">
            <div class="liveview-placeholder-text">{{ !store.cameraDetectionEnabled ? "Test mode — starting camera..." : cameraReady ? 'Starting preview...' : 'Connecting camera...' }}</div>
          </div>
          <!-- Same crop indicator as the blur-style variant — bars
               cover the parts of the 3:2 capture trimmed off for the
               selected template's cell. Width comes from the
               --crop-bar-w custom property (set per template). -->
          <div
            class="liveview-crop-bars"
            aria-hidden="true"
            :style="{ '--crop-bar-w': cropBarPercent + '%' }"
          >
            <div class="liveview-crop-bar liveview-crop-bar--left"></div>
            <div class="liveview-crop-bar liveview-crop-bar--right"></div>
          </div>
          <FilterOverlayLayers
            ref="overlayLayersRef"
            :overlay-style="overlayStyle"
            :media-url="selectedMediaRuntime?.url"
            :media-kind="selectedMediaRuntime?.type"
            :media-style="mediaOverlayStyle"
            :vignette-style="vignetteOverlayStyle"
            :grain-style="grainOverlayStyle"
          />
        </div>

        <!-- Decodes the overlay file so capture/highlight can sample it
             even if the visible layer has not painted yet. -->
        <video
          v-if="selectedMediaRuntime?.type === 'video'"
          ref="overlayDecodeRef"
          class="overlay-media-decode"
          :src="selectedMediaRuntime.url"
          autoplay
          muted
          loop
          playsinline
        />
        <img
          v-else-if="selectedMediaRuntime?.type === 'image'"
          ref="overlayDecodeRef"
          class="overlay-media-decode"
          :src="selectedMediaRuntime.url"
          alt=""
        />

        <!-- Hidden canvas for capture -->
        <canvas ref="canvasRef" class="capture-canvas"></canvas>

        <!-- Flash Effect -->
        <div v-if="showFlash" class="flash-overlay"></div>

        <div
          v-if="highlightRecording"
          class="rec-indicator"
          aria-live="polite"
        >
          <span class="rec-dot"></span>
          REC
        </div>

        <div v-if="isCountingDown" class="countdown-overlay">
          <div class="countdown-number">{{ countdownValue }}</div>
        </div>

        <div v-if="isReviewing" class="preview-countdown">
          <p class="preview-countdown-label">{{ freezeNextLabel }}</p>
          <div class="preview-countdown-number">{{ freezeCountdown }}</div>
        </div>
        </div>
      </div>

      <!-- Filter Controls -->
      <div class="filter-controls" :style="laidOut ? boxStyle('filters') : undefined">
        <div class="filter-buttons">
          <button
            v-for="opt in activeFilterOptions"
            :key="opt.id"
            type="button"
            class="filter-btn"
            :class="[
              filterToneClass(opt),
              { active: selectedFilterId === opt.id },
            ]"
            @click="setFilter(opt)"
          >
            {{ opt.name }}
          </button>
        </div>

        <div class="mirror-toggle" @click="toggleMirror">
          <div
            class="toggle-track-simple"
            :class="{ active: store.mirrorMode }"
          >
            <div class="toggle-thumb-simple"></div>
          </div>
          <span class="mirror-label">Mirror</span>
        </div>
      </div>
    </div>

    <!-- Right: Start Button -->
    <div class="action-area">
      <button
        class="start-btn"
        :class="{ capturing: isCountingDown || isCapturing || isReviewing }"
        :disabled="isCountingDown || isCapturing || isReviewing || !cameraReady || store.hasAllPhotos"
        :style="laidOut ? boxStyle('startBtn') : undefined"
        @click="startCapture"
      >
        {{ buttonLabel("startBtn", "Start") }}
      </button>

      <div
        class="photo-counter"
        :style="laidOut ? { ...boxStyle('counter'), ...textStyle('counter') } : undefined"
      >
        {{
          laidOut
            ? textOf("counter")
                .content.replaceAll("{n}", String(currentPhotoNumber))
                .replaceAll("{total}", String(totalPhotos))
            : `Photo ${currentPhotoNumber} of ${totalPhotos}`
        }}
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
            The photobooth will return to the home page due to inactivity.
          </p>
          <p v-if="store.capturedPhotos.length > 0" class="modal-warning">
            ⚠️ <strong>Warning:</strong> Any captured photos will be deleted.
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

    <!-- Back Warning Modal -->
    <div
      v-if="showBackWarning"
      class="inactivity-modal-overlay"
      @click="cancelGoBack"
    >
      <div class="inactivity-modal" @click.stop>
        <div class="modal-content">
          <h2 class="modal-title">⚠️ Delete Captured Photos?</h2>
          <p class="modal-message">
            You have <strong>{{ store.capturedPhotos.length }}</strong> captured
            photo(s).
          </p>
          <p class="modal-warning">
            ⚠️ <strong>Warning:</strong> Going back will delete all captured
            photos.
          </p>
          <div class="modal-buttons">
            <button
              class="modal-button modal-button-secondary"
              @click="cancelGoBack"
            >
              Cancel
            </button>
            <button
              class="modal-button modal-button-danger"
              @click="confirmGoBack"
            >
              Delete & Go Back
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Camera Error Modal -->
    <div
      v-if="showCameraError"
      class="inactivity-modal-overlay"
      @click="dismissCameraError"
    >
      <div class="inactivity-modal" @click.stop>
        <div class="modal-content">
          <h2 class="modal-title">
            ⚠️ {{ cameraErrorIsConnection ? "Camera Connection Error" : "Photo Capture Failed" }}
          </h2>
          <p class="modal-message">
            {{ cameraErrorMessage }}
          </p>
          <p class="modal-warning" v-if="cameraErrorMessage.includes('port is in use')">
            <strong>Solution:</strong><br>
            1. Close EOS Webcam Utility (if running)<br>
            2. Close EOS Utility (if running)<br>
            3. Close any other applications using the camera<br>
            4. Disconnect and reconnect the USB cable<br>
            5. Click "Retry" below
          </p>
          <div class="modal-buttons">
            <button
              class="modal-button modal-button-secondary"
              @click="dismissCameraError"
            >
              Go Back
            </button>
            <button
              class="modal-button"
              @click="retryCameraConnection"
            >
              Retry Connection
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.camera-screen {
  height: 100%;
  width: 100%;
  display: grid;
  /* Side columns share leftover space; the viewfinder takes the majority. */
  grid-template-columns: minmax(0, 1fr) minmax(0, 2.4fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  align-items: stretch;
  /* Bottom padding clears the absolutely-positioned Back button. */
  padding: 2.25rem 3rem 6.75rem;
  gap: 1.5rem 2rem;
  position: relative;
  box-sizing: border-box;
}

.kiosk-laid-out {
  display: block;
  padding: 0;
}

.kiosk-laid-out .camera-container,
.kiosk-laid-out .action-area {
  display: contents;
}

.kiosk-laid-out .strip-preview,
.kiosk-laid-out .camera-stage,
.kiosk-laid-out .filter-controls,
.kiosk-laid-out .start-btn,
.kiosk-laid-out .photo-counter,
.kiosk-laid-out .back-btn {
  position: absolute;
  margin: 0;
}

.kiosk-laid-out .camera-stage {
  display: flex;
  align-items: center;
  justify-content: center;
}

.kiosk-laid-out .camera-frame {
  width: 100%;
  height: 100%;
}

/* Greyed out while a countdown/shutter is running — no retakes. */
.back-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

/* Placement only — size comes from .kiosk-action-btn (same as editor). */
.back-btn {
  position: absolute;
  /* Inset past the corner ornaments (~170px) so it never overlaps them. */
  bottom: 3rem;
  left: 7rem;
  z-index: 10;
}

/* Strip Preview — the frame/cell/photo styling now lives inside
   TemplateLivePreview.vue, which derives it from the real template
   instead of the old hardcoded 4:3 placeholder boxes. */
.strip-preview {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.strip-preview-tilt {
  width: 88%;
  height: 92%;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  /* Carries the vintage tilt the old placeholder card had.
     Keep transform OFF the size-container — CQ on a transformed
     element can collapse to 0×0 and hide the frame preview. */
  transform: rotate(-3deg);
}

.strip-preview-cq {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  container-type: size;
}

/* Camera Container */
.camera-container {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.25rem;
}

.camera-stage {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  container-type: size;
}

.camera-frame {
  /* Contain-fit a 3:2 viewfinder (Canon native) into the center column. */
  width: min(100cqw, calc(100cqh * 3 / 2));
  height: min(100cqh, calc(100cqw * 2 / 3));
  box-sizing: border-box;
  padding: 16px;
  border-radius: 8px;
  box-shadow: var(--shadow-hard);
  position: relative;
  overflow: hidden;
}

/* No border: just the feed, no frame */
.camera-frame--none {
  padding: 0;
  background: transparent;
  box-shadow: none;
}

/* Wooden: default texture */
.camera-frame--wooden {
  background: url("/wood.svg") repeat;
  background-color: var(--color-wood);
}

/* Blur: live feed as border — blurred full-size layer + sharp centered window */
.camera-frame--blur {
  padding: 0;
  background: #1a1a1a;
}

.camera-feed-blur {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  filter: blur(18px);
  transform: scale(1.08);
  pointer-events: none;
}

.camera-feed-sharp-wrap {
  position: absolute;
  inset: 8%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  z-index: 1;
}

.camera-feed-sharp {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Color: solid border color */
.camera-frame--color {
  background-color: var(--camera-frame-color, #8b7355);
}

/* Custom: tiled background image */
.camera-frame--svg {
  background-image: var(--camera-frame-bg-image);
  background-repeat: repeat;
  background-color: var(--color-wood);
}

.camera-feed {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #1a1a1a;
  display: block;
}

/* The per-filter CSS approximations that used to live here are gone. They
   were a second, hand-tuned definition of each look that never matched the
   capture — the cube rule openly admitted it ("actual LUT applied at
   capture"), and against the shipped sepia4.cube the two disagreed by a
   mean ΔRGB of 29. Preview colour is now derived from the capture's own
   maths and applied as an SVG filter; see filterPreview.ts and
   `livePreviewFilter` above. The blur radius moved into that binding too,
   so there is exactly one place that decides how the feed looks. */

/* The colour wash (Settings → Filters → Overlay). Sits above the feed and
   below the grain, mirroring the order capturePhoto composites in.
   `isolation: isolate` on .camera-feed is what keeps mix-blend-mode blending
   against the photo rather than punching through to the page behind it. */
.filter-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.liveview-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.camera-feed {
  isolation: isolate;
}

/* Zero-sized carrier for the generated filter definition. */
.preview-filter-defs {
  position: absolute;
  width: 0;
  height: 0;
  pointer-events: none;
}

.camera-feed-liveview {
  position: relative;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.liveview-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Mirror the live preview to match what gets baked into the capture
   (see capturePhotoInner's ctx.translate/scale) — without this the
   toggle visibly does nothing while the saved/printed/QR photo still
   flips, which is the exact mismatch this was fixed for. */
.liveview-img.mirror {
  transform: scaleX(-1);
}

/* Blur background layer keeps its extra bleed scale alongside the flip. */
.camera-feed-blur .liveview-img.mirror {
  transform: scale(1.08) scaleX(-1);
}

.liveview-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: rgba(255,255,255,0.5);
}

.liveview-placeholder-text {
  font-size: 1rem;
  letter-spacing: 0.05em;
}

/* Crop-region indicator overlay: faded black bars on the left and
 * right edges of the live preview marking the parts of the 3:2
 * capture that get cropped out for the 1:1 square print cell.
 * Each bar covers 16.67% of the container width — mirrors the
 * (3-2)/3/2 = 1/6 trim applied at print time. The center "lit"
 * window between the bars is the area the user should pose inside.
 *
 * pointer-events: none so the bars don't block any future tap/click
 * targets layered behind. Intentionally not animated — this is a
 * framing aid, not a visual flourish. */
.liveview-crop-bars {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}

.liveview-crop-bar {
  position: absolute;
  top: 0;
  bottom: 0;
  /* Per-template width, set live via the --crop-bar-w custom property
   * on the parent (.liveview-crop-bars). Falls back to the old fixed
   * 1:1-square value if no template is selected yet. */
  width: var(--crop-bar-w, 16.6667%);
  background: rgba(0, 0, 0, 0.55);
  /* Soft inner edge so the boundary between "in print" and
   * "cropped out" reads as a vignette rather than a hard line.
   * The shadow points INWARD so the dimming fades past the bar
   * edge — clarifies which side is the kept area. */
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.4);
}

.liveview-crop-bar--left {
  left: 0;
  /* Subtle gradient so the dimming is darkest at the very edge
   * and softens toward the kept-area boundary. */
  background: linear-gradient(
    to right,
    rgba(0, 0, 0, 0.7),
    rgba(0, 0, 0, 0.5)
  );
}

.liveview-crop-bar--right {
  right: 0;
  background: linear-gradient(
    to left,
    rgba(0, 0, 0, 0.7),
    rgba(0, 0, 0, 0.5)
  );
}

/* Film-grain preview: a tiled fractal-noise texture, blended over the
 * live feed for Sepia/B&W/Fujifilm so what the guest sees roughly
 * matches the grain baked into the actual capture (see applyGrain()
 * in capturePhoto). Static (no animation) — a kiosk preview doesn't
 * need moving grain, and it keeps this cheap on modest hardware. */
.film-grain-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* Bumped up from 0.22 — plain fractalNoise at low opacity read as
   * basically invisible. feColorMatrix (saturate=0) desaturates the
   * turbulence into true monochrome grain instead of colour static;
   * the visible strength comes from THIS opacity + overlay blend, not
   * from stretching the filter's own contrast (a fancier
   * feComponentTransfer contrast curve rendered inconsistently
   * outside real browser engines when spot-checked, so kept this to
   * the standard, well-supported recipe). Tune visibility by moving
   * this opacity value. */
  opacity: 0.55;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 140px 140px;
}

.capture-canvas {
  display: none;
}

.overlay-media-decode {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
}

/* Flash */
.flash-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: white;
  animation: flash 0.15s ease-out;
  pointer-events: none;
}

@keyframes flash {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

.rec-indicator {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.8rem 0.4rem 0.65rem;
  border-radius: 999px;
  background: rgba(20, 10, 8, 0.78);
  color: #fff8ee;
  font-family: var(--font-display);
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  pointer-events: none;
}

.rec-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e23d3d;
  box-shadow: 0 0 8px rgba(226, 61, 61, 0.9);
  animation: recPulse 1s ease-in-out infinite;
}

@keyframes recPulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.86);
  }
}

/* Posing countdown — original centered overlay, number only. */
.countdown-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  pointer-events: none;
}

.countdown-number {
  font-family: var(--font-display);
  font-size: 12rem;
  font-weight: 700;
  color: white;
  text-shadow: 0 0 60px rgba(201, 162, 39, 0.8);
  animation: countPulse 1s ease-in-out infinite;
}

@keyframes countPulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.8;
  }
}

/* Last-frame freeze — only while the snapshot is held on screen. */
.preview-countdown {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 18px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  pointer-events: none;
}

.preview-countdown-label {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: #f4e6c3;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.85);
}

.preview-countdown-number {
  font-family: var(--font-display);
  font-size: 3.25rem;
  font-weight: 700;
  line-height: 1;
  color: white;
  text-shadow:
    0 2px 10px rgba(0, 0, 0, 0.85),
    0 0 28px rgba(201, 162, 39, 0.55);
  animation: countPulse 1s ease-in-out infinite;
}

/* Filter Controls: 4 buttons */
.filter-controls {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.85rem;
  width: 100%;
}

.filter-buttons {
  display: flex;
  align-items: center;
  gap: 2rem;
  flex-wrap: wrap;
  justify-content: center;
}

/* Filter buttons — v2 spec (see Milanote "Filter Buttons"): a light
   grey pill by default, and a per-filter accent colour when active:
   Sepia = brown, B&W = charcoal, Original = blue, Fujifilm = cream. */
.filter-btn {
  font-family: var(--font-display);
  font-size: 1.05rem;
  font-weight: 700;
  padding: 0.85rem 1.9rem;
  min-width: 6.5rem;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  touch-action: manipulation;
  transition:
    box-shadow 0.15s ease,
    background 0.15s ease,
    color 0.15s ease,
    transform 0.1s ease;
  /* Inactive: flat light-grey pill (#d9d9d9), muted grey label */
  background: #d9d9d9;
  color: #7a7a7a;
  box-shadow: 0 2px 3px rgba(0, 0, 0, 0.18);
}

.filter-btn:active {
  transform: translateY(1px);
}

/* Active base: white bold label + subtle inner press shadow. The fill
   colour is supplied per-tone below. */
.filter-btn.active {
  color: #ffffff;
  box-shadow:
    0 2px 4px rgba(0, 0, 0, 0.25),
    inset 0 2px 5px rgba(0, 0, 0, 0.18);
}

.filter-btn.tone-sepia.active {
  background: #b17c45;
}

.filter-btn.tone-bw.active {
  background: #575757;
}

.filter-btn.tone-original.active {
  background: linear-gradient(180deg, #3a80c0 0%, #152652 100%);
}

.filter-btn.tone-fujifilm.active {
  /* Pale cream — needs dark text for contrast (per v2). */
  background: #fff3b2;
  color: #6f583d;
}

.mirror-toggle {
  display: flex;
  align-items: center;
  gap: 1rem;
  cursor: pointer;
  touch-action: manipulation;
}

/* Mirror toggle — v2: dark-brown track, gold knob. */
.toggle-track-simple {
  width: 60px;
  height: 32px;
  background: #cbb9a3;
  border-radius: 16px;
  position: relative;
  transition: background 0.2s ease;
}

.toggle-track-simple.active {
  background: #683017;
}

.toggle-thumb-simple {
  width: 26px;
  height: 26px;
  background: #c2822e;
  border-radius: 50%;
  position: absolute;
  top: 3px;
  left: 3px;
  transition: transform 0.2s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.toggle-track-simple.active .toggle-thumb-simple {
  transform: translateX(28px);
}

.mirror-label {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

/* Action Area */
.action-area {
  grid-column: 3;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  container-type: inline-size;
}

.start-btn {
  width: clamp(150px, 52cqi, 220px);
  height: clamp(150px, 52cqi, 220px);
  border-radius: 50%;
  font-family: var(--font-display);
  font-size: clamp(1.5rem, 6.5cqi, 2rem);
  font-weight: 700;
  /* v2 gold face (#fed582 → #fdc66c) inside a wood-brown ring. */
  background: radial-gradient(circle at 50% 38%, #fee2a0 0%, #fed582 38%, #fdc66c 100%);
  color: var(--color-brown-dark);
  border: 8px solid #9c6b3f;
  box-shadow:
    0 8px 0 var(--color-wood-dark),
    0 12px 40px rgba(61, 43, 31, 0.4),
    inset 0 2px 15px rgba(255, 255, 255, 0.45);
  cursor: pointer;
  transition: all 0.15s ease;
  touch-action: manipulation;
}

.start-btn:active:not(:disabled) {
  box-shadow:
    0 4px 0 var(--color-wood-dark),
    0 6px 20px rgba(61, 43, 31, 0.4),
    inset 0 2px 15px rgba(255, 255, 255, 0.3);
  transform: translateY(4px);
}

.start-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.start-btn.capturing {
  animation: btnPulse 1s ease-in-out infinite;
}

@keyframes btnPulse {
  0%,
  100% {
    box-shadow:
      0 8px 0 var(--color-wood-dark),
      0 0 0 0 rgba(201, 162, 39, 0.7);
  }
  50% {
    box-shadow:
      0 8px 0 var(--color-wood-dark),
      0 0 0 20px rgba(201, 162, 39, 0);
  }
}

.photo-counter {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-brown);
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
  margin-bottom: 1rem;
  line-height: 1.5;
}

.modal-warning {
  font-family: var(--font-display);
  font-size: 1.1rem;
  color: #d32f2f;
  margin-bottom: 1rem;
  font-weight: 600;
  padding: 0.75rem;
  background: rgba(211, 47, 47, 0.1);
  border-radius: 8px;
}

.modal-warning strong {
  font-weight: 700;
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

.modal-buttons {
  display: flex;
  gap: 1rem;
  justify-content: center;
  margin-top: 1rem;
}

.modal-button-secondary {
  background: linear-gradient(
    180deg,
    #e0e0e0 0%,
    #c0c0c0 30%,
    #a0a0a0 70%,
    #808080 100%
  );
  color: var(--color-brown-dark);
  border-color: #808080;
}

.modal-button-danger {
  background: linear-gradient(
    180deg,
    #ff6b6b 0%,
    #ee5a5a 30%,
    #dc4c4c 70%,
    #c43c3c 100%
  );
  color: white;
  border-color: #c43c3c;
}

.modal-button-danger:active {
  box-shadow:
    0 2px 0 #c43c3c,
    0 3px 8px rgba(196, 60, 60, 0.3);
}
</style>
