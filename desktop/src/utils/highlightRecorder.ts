/**
 * Session highlight clips: MediaRecorder of the live camera stream for
 * the posing countdown. Prefers the real MediaStream (webcam) so every
 * frame is encoded — not a canvas copy that Chromium often starves.
 * Canon EVF stills fall back to a DOM-attached canvas.
 *
 * Recording is stopped before the on-screen last-frame freeze.
 * Clips are also written to Videos/NostalgiaPhotobooth.
 */

export const HIGHLIGHT_LEAD_MS = 10000;
export const HIGHLIGHT_PREVIEW_MS = 0;

const MAX_WIDTH = 1280;
const FPS = 30;

export type HighlightCaptureOpts = {
  /** Preferred: the live getUserMedia stream shown in the viewfinder. */
  stream?: MediaStream | null;
  video?: HTMLVideoElement | null;
  getStillUrl?: () => string | null;
  getMirror?: () => boolean;
};

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let drawTimer: ReturnType<typeof setInterval> | null = null;
let pumping = false;
let recording = false;
let frozen = false;
let sourceVideo: HTMLVideoElement | null = null;
let getStillUrl: (() => string | null) | null = null;
let getMirror: (() => boolean) | null = null;
let stillImg: HTMLImageElement | null = null;
let lastStillUrl = "";
let mimeType = "";
let startedAt = 0;
let captureTrack: MediaStreamTrack | null = null;
let usingCanvas = false;

export function isHighlightRecording(): boolean {
  return recording && recorder != null && recorder.state !== "inactive";
}

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const types = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm",
    "video/mp4",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function currentMirror(): boolean {
  return getMirror ? !!getMirror() : false;
}

function even(n: number): number {
  return Math.max(2, n & ~1);
}

function sizeFromSources(): { width: number; height: number } | null {
  if (sourceVideo && sourceVideo.readyState >= 2 && sourceVideo.videoWidth >= 2) {
    return { width: sourceVideo.videoWidth, height: sourceVideo.videoHeight };
  }
  if (stillImg && stillImg.complete && stillImg.naturalWidth >= 2) {
    return { width: stillImg.naturalWidth, height: stillImg.naturalHeight };
  }
  return null;
}

function drawCover(
  target: CanvasImageSource,
  srcW: number,
  srcH: number,
) {
  if (!canvas || !ctx || srcW < 1 || srcH < 1) return;
  const w = canvas.width;
  const h = canvas.height;
  const mirror = currentMirror();
  if (mirror) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(target, 0, 0, srcW, srcH, 0, 0, w, h);
  if (mirror) ctx.restore();
}

function pullStill() {
  const url = getStillUrl?.() || "";
  if (!url || url === lastStillUrl) return;
  lastStillUrl = url;
  if (!stillImg) stillImg = new Image();
  stillImg.src = url;
}

function videoIsLive(): boolean {
  const v = sourceVideo;
  return !!(
    v &&
    !v.paused &&
    !v.ended &&
    v.readyState >= 2 &&
    v.videoWidth >= 2
  );
}

function snapshotNow() {
  if (!canvas || !ctx) return;
  pullStill();
  if (videoIsLive() && sourceVideo) {
    drawCover(sourceVideo, sourceVideo.videoWidth, sourceVideo.videoHeight);
  } else if (stillImg && stillImg.complete && stillImg.naturalWidth >= 2) {
    drawCover(stillImg, stillImg.naturalWidth, stillImg.naturalHeight);
  }
  try {
    (captureTrack as MediaStreamTrack & { requestFrame?: () => void })?.requestFrame?.();
  } catch {
    /* Chromium-only */
  }
}

function startDrawLoop() {
  stopDrawLoop();
  pumping = true;
  snapshotNow();
  // Interval, not rAF: rAF pauses when Electron is busy and starves
  // canvas.captureStream. 30fps matches the captureStream hint.
  drawTimer = setInterval(() => {
    if (!pumping) return;
    if (!frozen) snapshotNow();
  }, Math.round(1000 / FPS));
}

function stopDrawLoop() {
  pumping = false;
  if (drawTimer != null) {
    clearInterval(drawTimer);
    drawTimer = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function liveVideoTrack(stream: MediaStream | null | undefined): MediaStreamTrack | null {
  const track = stream?.getVideoTracks().find((t) => t.readyState === "live");
  return track ?? null;
}

function recordStreamFromOpts(opts: HighlightCaptureOpts): MediaStream | null {
  const fromOpt = liveVideoTrack(opts.stream ?? null);
  if (fromOpt && opts.stream) return opts.stream;

  const src = opts.video?.srcObject;
  if (src instanceof MediaStream && liveVideoTrack(src)) return src;

  const video = opts.video as
    | (HTMLVideoElement & { captureStream?: () => MediaStream })
    | null
    | undefined;
  if (video && video.readyState >= 2 && typeof video.captureStream === "function") {
    try {
      const captured = video.captureStream();
      if (liveVideoTrack(captured)) return captured;
    } catch {
      /* captureStream can throw if the element has no frame yet */
    }
  }
  return null;
}

function beginRecorder(recStream: MediaStream, label: string): boolean {
  mimeType = pickRecorderMime();
  if (!mimeType) {
    console.warn("[Highlight] MediaRecorder not supported");
    return false;
  }
  try {
    recorder = new MediaRecorder(recStream, {
      mimeType,
      videoBitsPerSecond: 4_000_000,
    });
  } catch (e) {
    console.warn("[Highlight] MediaRecorder failed:", e);
    return false;
  }
  chunks = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  recorder.start(200);
  startedAt = performance.now();
  recording = true;
  const settings = recStream.getVideoTracks()[0]?.getSettings() ?? {};
  console.log(
    `[Highlight] Streaming ${label} ${settings.width || "?"}x${settings.height || "?"} ${mimeType}`,
  );
  return true;
}

function startCanvasFallback(opts: HighlightCaptureOpts): boolean {
  sourceVideo = opts.video ?? null;
  getStillUrl = opts.getStillUrl ?? null;
  getMirror = opts.getMirror ?? null;
  pullStill();

  const size = sizeFromSources();
  if (!size) {
    console.warn("[Highlight] No live video to record yet");
    sourceVideo = null;
    getStillUrl = null;
    getMirror = null;
    return false;
  }

  const scale = Math.min(1, MAX_WIDTH / size.width);
  canvas = document.createElement("canvas");
  canvas.width = even(Math.round(size.width * scale));
  canvas.height = even(Math.round(size.height * scale));
  canvas.setAttribute("aria-hidden", "true");
  // Must be in the document or Chromium skips captureStream frames.
  canvas.style.cssText =
    "position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.02;pointer-events:none;z-index:0";
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return false;

  frozen = false;
  usingCanvas = true;
  startDrawLoop();

  const recStream = canvas.captureStream(FPS);
  captureTrack = recStream.getVideoTracks()[0] || null;
  if (!beginRecorder(recStream, `${canvas.width}x${canvas.height} canvas`)) {
    stopDrawLoop();
    canvas.remove();
    canvas = null;
    ctx = null;
    captureTrack = null;
    usingCanvas = false;
    return false;
  }
  return true;
}

export function startHighlightCapture(opts: HighlightCaptureOpts): boolean {
  if (recording) return true;

  const live = recordStreamFromOpts(opts);
  if (live) {
    usingCanvas = false;
    // Record the live camera track itself (not a canvas copy, not a
    // cloned track — clones can emit no frames until attached to a sink).
    if (!beginRecorder(live, "camera stream")) {
      return startCanvasFallback(opts);
    }
    return true;
  }

  return startCanvasFallback(opts);
}

export function freezeHighlightCapture() {
  if (!usingCanvas) return;
  snapshotNow();
  frozen = true;
}

function resetState() {
  stopDrawLoop();
  recording = false;
  frozen = false;
  sourceVideo = null;
  getStillUrl = null;
  getMirror = null;
  stillImg = null;
  lastStillUrl = "";
  recorder = null;
  chunks = [];
  if (canvas?.parentNode) canvas.remove();
  canvas = null;
  ctx = null;
  mimeType = "";
  startedAt = 0;
  captureTrack = null;
  usingCanvas = false;
}

export function abortHighlightCapture() {
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  }
  resetState();
}

export async function stopHighlightCapture(): Promise<string | null> {
  const rec = recorder;
  if (!recording || !rec || rec.state === "inactive") {
    abortHighlightCapture();
    return null;
  }
  recording = false;

  const elapsed = performance.now() - startedAt;
  const remain = HIGHLIGHT_LEAD_MS - elapsed;
  if (remain > 50) {
    const wait = Math.min(remain, HIGHLIGHT_LEAD_MS);
    console.log(
      `[Highlight] Waiting ${Math.round(wait)}ms to complete 10s (elapsed ${Math.round(elapsed)}ms)`,
    );
    await sleep(wait);
  }
  console.log(
    `[Highlight] Stopping after ${Math.round(performance.now() - startedAt)}ms`,
  );

  const blob = await new Promise<Blob | null>((resolve) => {
    rec.onstop = () => {
      stopDrawLoop();
      const type = rec.mimeType || mimeType || "video/webm";
      const out = new Blob(chunks, { type });
      resolve(out.size >= 100 ? out : null);
    };
    try {
      rec.requestData?.();
      rec.stop();
    } catch {
      resolve(null);
    }
  });

  const type = blob?.type || mimeType || "video/webm";
  resetState();
  if (!blob) {
    console.warn("[Highlight] Clip empty");
    return null;
  }

  const url = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
  console.log(
    `[Highlight] Clip ready ${Math.round(blob.size / 1024)}KB ${type}`,
  );
  return url;
}
