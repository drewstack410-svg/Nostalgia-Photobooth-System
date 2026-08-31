/**
 * Session highlight clips: ~15s MP4 — last 10s of live view before the
 * shutter, then 5s of the frozen last frame. Encoded at the FULL camera
 * frame (not the viewfinder crop). Strip compose cover-fits these clips
 * into print windows. Clips also go to Videos/NostalgiaPhotobooth.
 *
 * Packaged kiosks often lack a working hardware H.264 encoder (missing
 * GPU drivers, GPU blocklist, software canvas). VideoEncoder.configure()
 * can succeed then fail asynchronously — we probe, encode a test frame,
 * and fall back to MediaRecorder so other PCs still get a file.
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { objectUrlFromBlob } from "./mediaBytes";

export const HIGHLIGHT_LEAD_MS = 10000;
export const HIGHLIGHT_PREVIEW_MS = 5000;

const MAX_WIDTH = 1280;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const TARGET_MS = HIGHLIGHT_LEAD_MS + HIGHLIGHT_PREVIEW_MS;

type AvcHwAccel = "no-preference" | "prefer-hardware" | "prefer-software";

export type HighlightCaptureOpts = {
  stream?: MediaStream | null;
  video?: HTMLVideoElement | null;
  getStillUrl?: () => string | null;
  getMirror?: () => boolean;
  /** Bake the booth filter onto each live frame (not the freeze blit). */
  applyLook?: (ctx: CanvasRenderingContext2D) => void;
};

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let freezeCanvas: HTMLCanvasElement | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let pumping = false;
let recording = false;
let starting = false;
let frozen = false;
let sourceVideo: HTMLVideoElement | null = null;
let getStillUrl: (() => string | null) | null = null;
let getMirror: (() => boolean) | null = null;
let applyLook: ((ctx: CanvasRenderingContext2D) => void) | null = null;
let stillImg: HTMLImageElement | null = null;
let lastStillUrl = "";
let mimeType = "video/mp4";
let startedAt = 0;
let encoder: VideoEncoder | null = null;
let muxer: Muxer<ArrayBufferTarget> | null = null;
let frameIndex = 0;
let lastTimestampUs = -1;
let lastKeyframeUs = -1;
let encodeError: string | null = null;

export function isHighlightRecording(): boolean {
  if (starting) return true;
  if (!recording) return false;
  if (encoder && encoder.state === "configured") return true;
  return recorder != null && recorder.state !== "inactive";
}

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const types = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1.4D401E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function currentMirror(): boolean {
  return getMirror ? !!getMirror() : false;
}

function even(n: number): number {
  return Math.max(2, n & ~1);
}

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Draw the entire source onto the canvas (no viewfinder crop). */
function drawFull(
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

function sizeFromSources(): { width: number; height: number } | null {
  if (sourceVideo && sourceVideo.readyState >= 2 && sourceVideo.videoWidth >= 2) {
    return { width: sourceVideo.videoWidth, height: sourceVideo.videoHeight };
  }
  if (stillImg && stillImg.complete && stillImg.naturalWidth >= 2) {
    return { width: stillImg.naturalWidth, height: stillImg.naturalHeight };
  }
  return null;
}

function pullStill() {
  const url = getStillUrl?.() || "";
  if (!url || url === lastStillUrl) return;
  lastStillUrl = url;
  if (!stillImg) stillImg = new Image();
  stillImg.src = url;
}

function drawLiveOrFreeze() {
  if (!canvas || !ctx) return;
  if (frozen && freezeCanvas) {
    ctx.drawImage(freezeCanvas, 0, 0, canvas.width, canvas.height);
    return;
  }
  pullStill();
  if (sourceVideo && sourceVideo.readyState >= 2 && sourceVideo.videoWidth >= 2) {
    drawFull(sourceVideo, sourceVideo.videoWidth, sourceVideo.videoHeight);
  } else if (stillImg && stillImg.complete && stillImg.naturalWidth >= 2) {
    drawFull(stillImg, stillImg.naturalWidth, stillImg.naturalHeight);
  }
  if (ctx) {
    try {
      applyLook?.(ctx);
    } catch (e) {
      console.warn("[Highlight] applyLook failed:", e);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function encodeCanvasFrame() {
  if (!canvas || !encoder || encoder.state !== "configured") return;
  if (encodeError) return;
  if (!startedAt) return;
  try {
    const ts = Math.max(0, Math.round((performance.now() - startedAt) * 1000));
    if (lastTimestampUs >= 0 && ts - lastTimestampUs < 500) return;
    const duration =
      lastTimestampUs >= 0
        ? Math.max(1000, ts - lastTimestampUs)
        : Math.round(FRAME_MS * 1000);
    const keyFrame =
      lastKeyframeUs < 0 || ts - lastKeyframeUs >= 1_000_000;
    // createImageBitmap works on software canvases; VideoFrame(canvas)
    // often throws "unaccelerated" on kiosks without a working GPU.
    const bmp = await createImageBitmap(canvas);
    const frame = new VideoFrame(bmp, { timestamp: ts, duration });
    bmp.close();
    encoder.encode(frame, { keyFrame });
    frame.close();
    lastTimestampUs = ts;
    if (keyFrame) lastKeyframeUs = ts;
    frameIndex++;
  } catch (e) {
    encodeError = errText(e);
    console.warn("[Highlight] Encode frame failed:", encodeError);
  }
}

function requestRecorderFrame() {
  if (recorder && recorder.state === "recording") {
    try {
      (
        recorder.stream.getVideoTracks()[0] as MediaStreamTrack & {
          requestFrame?: () => void;
        }
      )?.requestFrame?.();
    } catch {
      /* ignore */
    }
  }
}

async function pumpLoop() {
  while (pumping) {
    while (encoder && encoder.encodeQueueSize > 12) {
      await sleep(8);
    }
    drawLiveOrFreeze();
    await encodeCanvasFrame();
    requestRecorderFrame();
    await sleep(FRAME_MS);
  }
}

async function pickAvcCodec(
  width: number,
  height: number,
): Promise<{ codec: string; hardwareAcceleration: AvcHwAccel } | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const codecs = [
    "avc1.4D401F",
    "avc1.42001F",
    "avc1.42001E",
    "avc1.4D001E",
    "avc1.64001F",
  ];
  const modes: AvcHwAccel[] = ["prefer-hardware", "prefer-software", "no-preference"];
  for (const hardwareAcceleration of modes) {
    for (const codec of codecs) {
      try {
        const probe = await VideoEncoder.isConfigSupported({
          codec,
          width,
          height,
          bitrate: 3_000_000,
          framerate: FPS,
          avc: { format: "avc" },
          hardwareAcceleration,
        });
        if (probe.supported) return { codec, hardwareAcceleration };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function closeEncoder() {
  try {
    if (encoder && encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
  encoder = null;
  muxer = null;
}

async function beginMp4Encoder(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") {
    console.warn("[Highlight] VideoEncoder API missing");
    return false;
  }
  const picked = await pickAvcCodec(width, height);
  if (!picked) {
    console.warn("[Highlight] No H.264 VideoEncoder config is supported on this PC");
    return false;
  }

  encodeError = null;
  frameIndex = 0;
  lastTimestampUs = -1;
  lastKeyframeUs = -1;
  const target = new ArrayBufferTarget();
  muxer = new Muxer({
    target,
    video: {
      codec: "avc",
      width,
      height,
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  try {
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer?.addVideoChunk(chunk, meta);
        } catch (e) {
          console.warn("[Highlight] Mux chunk failed:", e);
        }
      },
      error: (e) => {
        encodeError = e.message;
        console.warn("[Highlight] VideoEncoder error:", e);
      },
    });
    encoder.configure({
      codec: picked.codec,
      width,
      height,
      bitrate: 3_000_000,
      framerate: FPS,
      avc: { format: "avc" },
      hardwareAcceleration: picked.hardwareAcceleration,
    });
  } catch (e) {
    console.warn("[Highlight] VideoEncoder configure failed:", errText(e));
    closeEncoder();
    return false;
  }

  mimeType = "video/mp4";
  startedAt = performance.now();
  drawLiveOrFreeze();
  await encodeCanvasFrame();
  await sleep(40);
  if (encodeError || !encoder || encoder.state !== "configured") {
    console.warn(
      "[Highlight] VideoEncoder rejected the first frame:",
      encodeError || encoder?.state,
    );
    closeEncoder();
    encodeError = null;
    frameIndex = 0;
    lastTimestampUs = -1;
    lastKeyframeUs = -1;
    startedAt = 0;
    return false;
  }

  recording = true;
  console.log(
    `[Highlight] Encoding MP4 ${picked.codec} ${picked.hardwareAcceleration} ${width}x${height} ${FPS}fps`,
  );
  return true;
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
  console.log(`[Highlight] Recording ${label} ${mimeType}`);
  return true;
}

async function waitForSourceSize(timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    pullStill();
    const size = sizeFromSources();
    if (size) return size;
    await sleep(50);
  }
  pullStill();
  return sizeFromSources();
}

async function startCanvasCapture(opts: HighlightCaptureOpts): Promise<boolean> {
  sourceVideo = opts.video ?? null;
  getStillUrl = opts.getStillUrl ?? null;
  getMirror = opts.getMirror ?? null;
  applyLook = opts.applyLook ?? null;

  const size = await waitForSourceSize();
  if (!size) {
    console.warn("[Highlight] No live video to record yet");
    sourceVideo = null;
    getStillUrl = null;
    getMirror = null;
    applyLook = null;
    return false;
  }

  const scale = Math.min(1, MAX_WIDTH / Math.max(size.width, size.height));
  canvas = document.createElement("canvas");
  canvas.width = even(Math.round(size.width * scale));
  canvas.height = even(Math.round(size.height * scale));
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.02;pointer-events:none;z-index:0";
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!ctx) return false;

  frozen = false;
  freezeCanvas = null;
  pumping = true;
  drawLiveOrFreeze();

  if (!(await beginMp4Encoder(canvas.width, canvas.height))) {
    const recStream = canvas.captureStream(FPS);
    if (!beginRecorder(recStream, `${canvas.width}x${canvas.height}`)) {
      pumping = false;
      canvas.remove();
      canvas = null;
      ctx = null;
      return false;
    }
  }

  void pumpLoop();
  return true;
}

export async function startHighlightCapture(
  opts: HighlightCaptureOpts,
): Promise<boolean> {
  if (recording) return true;
  if (starting) return false;
  starting = true;
  try {
    return await startCanvasCapture(opts);
  } finally {
    starting = false;
  }
}

export function freezeHighlightCapture() {
  drawLiveOrFreeze();
  if (canvas && ctx) {
    if (!freezeCanvas) freezeCanvas = document.createElement("canvas");
    freezeCanvas.width = canvas.width;
    freezeCanvas.height = canvas.height;
    const fctx = freezeCanvas.getContext("2d", { alpha: false });
    fctx?.drawImage(canvas, 0, 0);
  }
  frozen = true;
  console.log("[Highlight] Freeze locked for 5s tail");
}

/** Hold live recording until the 10s pre-shutter lead is in the file. */
export async function waitForHighlightLead(): Promise<void> {
  if (!recording || !startedAt) return;
  const remain = HIGHLIGHT_LEAD_MS - (performance.now() - startedAt);
  if (remain > 50) {
    console.log(`[Highlight] Finishing live lead ${Math.round(remain)}ms`);
    await sleep(Math.min(remain, HIGHLIGHT_LEAD_MS));
  }
}

function resetState() {
  pumping = false;
  recording = false;
  starting = false;
  frozen = false;
  sourceVideo = null;
  getStillUrl = null;
  getMirror = null;
  applyLook = null;
  stillImg = null;
  lastStillUrl = "";
  recorder = null;
  chunks = [];
  if (canvas?.parentNode) canvas.remove();
  canvas = null;
  ctx = null;
  freezeCanvas = null;
  mimeType = "video/mp4";
  startedAt = 0;
  closeEncoder();
  frameIndex = 0;
  lastTimestampUs = -1;
  lastKeyframeUs = -1;
  encodeError = null;
}

export function abortHighlightCapture() {
  pumping = false;
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  }
  resetState();
}

function blobToObjectUrl(blob: Blob): string {
  return objectUrlFromBlob(blob);
}

export async function stopHighlightCapture(): Promise<string | null> {
  if (!recording) {
    abortHighlightCapture();
    return null;
  }
  recording = false;
  pumping = false;
  if (!freezeCanvas && canvas) {
    freezeHighlightCapture();
  }
  frozen = true;

  while (
    encoder &&
    encoder.state === "configured" &&
    !encodeError &&
    performance.now() - startedAt < TARGET_MS
  ) {
    drawLiveOrFreeze();
    await encodeCanvasFrame();
    await sleep(FRAME_MS);
  }

  console.log(
    `[Highlight] Stopping after ${Math.round(performance.now() - startedAt)}ms (${frameIndex} frames)`,
  );

  const rec = recorder;
  const usedEncoder = !!(encoder && muxer);

  if (usedEncoder) {
    try {
      if (encoder && encoder.state === "configured") await encoder.flush();
    } catch (e) {
      console.warn("[Highlight] Encoder flush failed:", e);
    }
    try {
      muxer?.finalize();
    } catch (e) {
      console.warn("[Highlight] Mux finalize failed:", e);
    }
    const buffer = muxer?.target.buffer;
    const frames = frameIndex;
    const err = encodeError;
    resetState();
    if (buffer && buffer.byteLength >= 100 && frames > 0) {
      const blob = new Blob([buffer], { type: "video/mp4" });
      const url = blobToObjectUrl(blob);
      console.log(
        `[Highlight] Clip ready ${Math.round(blob.size / 1024)}KB video/mp4 (${frames} frames)`,
      );
      return url;
    }
    console.warn("[Highlight] Encoder produced no usable file:", err || "empty mux");
    return null;
  }

  if (!rec || rec.state === "inactive") {
    abortHighlightCapture();
    return null;
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    rec.onstop = () => {
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
  const url = blobToObjectUrl(blob);
  console.log(`[Highlight] Clip ready ${Math.round(blob.size / 1024)}KB ${type}`);
  return url;
}
