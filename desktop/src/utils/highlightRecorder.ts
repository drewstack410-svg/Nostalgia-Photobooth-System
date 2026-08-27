/**
 * Session highlight clips: ~15s MP4 — last 10s of live view before the
 * shutter, then 5s of the frozen last frame. Frames are drawn to a
 * canvas and encoded with WebCodecs + mp4-muxer so the freeze has real
 * duration (MediaRecorder drops identical canvas frames). Clips also
 * go to Videos/NostalgiaPhotobooth.
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export const HIGHLIGHT_LEAD_MS = 10000;
export const HIGHLIGHT_PREVIEW_MS = 5000;

const MAX_WIDTH = 1280;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const TARGET_MS = HIGHLIGHT_LEAD_MS + HIGHLIGHT_PREVIEW_MS;
/** Same 3:2 viewfinder the live crop bars are measured against. */
const VIEW_ASPECT = 3 / 2;

export type HighlightCaptureOpts = {
  stream?: MediaStream | null;
  video?: HTMLVideoElement | null;
  getStillUrl?: () => string | null;
  getMirror?: () => boolean;
  /** Percent cropped off each side of the 3:2 view (the dimmed bars). */
  getCropBarPercent?: () => number;
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
let frozen = false;
let sourceVideo: HTMLVideoElement | null = null;
let getStillUrl: (() => string | null) | null = null;
let getMirror: (() => boolean) | null = null;
let getCropBarPercent: (() => number) | null = null;
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

/** Source rectangle matching the lit center of the live preview. */
function highlightedRect(
  srcW: number,
  srcH: number,
  cropBarPct: number,
): { sx: number; sy: number; sw: number; sh: number } {
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  const srcAspect = srcW / srcH;
  if (srcAspect > VIEW_ASPECT + 0.001) {
    sw = srcH * VIEW_ASPECT;
    sx = (srcW - sw) / 2;
  } else if (srcAspect < VIEW_ASPECT - 0.001) {
    sh = srcW / VIEW_ASPECT;
    sy = (srcH - sh) / 2;
  }
  const bar = Math.max(0, Math.min(0.45, cropBarPct / 100));
  if (bar > 0) {
    sx += sw * bar;
    sw *= 1 - 2 * bar;
  }
  sx = Math.max(0, Math.round(sx));
  sy = Math.max(0, Math.round(sy));
  sw = Math.max(1, Math.min(srcW - sx, Math.round(sw)));
  sh = Math.max(1, Math.min(srcH - sy, Math.round(sh)));
  return { sx, sy, sw, sh };
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
  const crop = getCropBarPercent?.() ?? 0;
  const r = highlightedRect(srcW, srcH, crop);
  const w = canvas.width;
  const h = canvas.height;
  const mirror = currentMirror();
  if (mirror) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(target, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  if (mirror) ctx.restore();
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
    drawCover(sourceVideo, sourceVideo.videoWidth, sourceVideo.videoHeight);
  } else if (stillImg && stillImg.complete && stillImg.naturalWidth >= 2) {
    drawCover(stillImg, stillImg.naturalWidth, stillImg.naturalHeight);
  }
  if (ctx) {
    try {
      applyLook?.(ctx);
    } catch (e) {
      console.warn("[Highlight] applyLook failed:", e);
    }
  }
}

function encodeCanvasFrame() {
  if (!canvas || !encoder || encoder.state !== "configured") return;
  if (encodeError) return;
  if (!startedAt) return;
  try {
    // Wall-clock timestamps so playback speed matches real life even
    // when we capture fewer than 30fps.
    const ts = Math.max(0, Math.round((performance.now() - startedAt) * 1000));
    if (lastTimestampUs >= 0 && ts - lastTimestampUs < 500) return;
    const duration =
      lastTimestampUs >= 0
        ? Math.max(1000, ts - lastTimestampUs)
        : Math.round(FRAME_MS * 1000);
    const keyFrame =
      lastKeyframeUs < 0 || ts - lastKeyframeUs >= 1_000_000;
    const frame = new VideoFrame(canvas, { timestamp: ts, duration });
    encoder.encode(frame, { keyFrame });
    frame.close();
    lastTimestampUs = ts;
    if (keyFrame) lastKeyframeUs = ts;
    frameIndex++;
  } catch (e) {
    encodeError = e instanceof Error ? e.message : String(e);
    console.warn("[Highlight] Encode frame failed:", e);
  }
}

function snapshotNow() {
  drawLiveOrFreeze();
  encodeCanvasFrame();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pumpLoop() {
  while (pumping) {
    while (encoder && encoder.encodeQueueSize > 12) {
      await sleep(8);
    }
    snapshotNow();
    await sleep(FRAME_MS);
  }
}

function pickAvcCodec(): string {
  const codecs = [
    "avc1.42001E",
    "avc1.42001F",
    "avc1.4D001E",
    "avc1.64001E",
  ];
  return codecs[0];
}

function beginMp4Encoder(width: number, height: number): boolean {
  if (typeof VideoEncoder === "undefined") return false;
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
      codec: pickAvcCodec(),
      width,
      height,
      bitrate: 3_000_000,
      framerate: FPS,
      avc: { format: "avc" },
    });
  } catch (e) {
    console.warn("[Highlight] VideoEncoder configure failed:", e);
    try {
      encoder?.close();
    } catch {
      /* ignore */
    }
    encoder = null;
    muxer = null;
    return false;
  }
  mimeType = "video/mp4";
  startedAt = performance.now();
  recording = true;
  console.log(`[Highlight] Encoding MP4 ${width}x${height} ${FPS}fps`);
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

function startCanvasCapture(opts: HighlightCaptureOpts): boolean {
  sourceVideo = opts.video ?? null;
  getStillUrl = opts.getStillUrl ?? null;
  getMirror = opts.getMirror ?? null;
  getCropBarPercent = opts.getCropBarPercent ?? null;
  applyLook = opts.applyLook ?? null;
  pullStill();

  const size = sizeFromSources();
  if (!size) {
    console.warn("[Highlight] No live video to record yet");
    sourceVideo = null;
    getStillUrl = null;
    getMirror = null;
    getCropBarPercent = null;
    applyLook = null;
    return false;
  }

  const crop = getCropBarPercent?.() ?? 0;
  const vis = highlightedRect(size.width, size.height, crop);
  const scale = Math.min(1, MAX_WIDTH / Math.max(vis.sw, vis.sh));
  canvas = document.createElement("canvas");
  canvas.width = even(Math.round(vis.sw * scale));
  canvas.height = even(Math.round(vis.sh * scale));
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.02;pointer-events:none;z-index:0";
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return false;

  frozen = false;
  freezeCanvas = null;
  pumping = true;
  drawLiveOrFreeze();

  if (!beginMp4Encoder(canvas.width, canvas.height)) {
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

export function startHighlightCapture(opts: HighlightCaptureOpts): boolean {
  if (recording) return true;
  return startCanvasCapture(opts);
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
  frozen = false;
  sourceVideo = null;
  getStillUrl = null;
  getMirror = null;
  getCropBarPercent = null;
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
  try {
    if (encoder && encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
  encoder = null;
  muxer = null;
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

async function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
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

  // Keep encoding the freeze at real time until the clip is 15s.
  while (
    encoder &&
    encoder.state === "configured" &&
    performance.now() - startedAt < TARGET_MS
  ) {
    snapshotNow();
    await sleep(FRAME_MS);
  }

  console.log(
    `[Highlight] Stopping after ${Math.round(performance.now() - startedAt)}ms (${frameIndex} frames)`,
  );

  if (encoder && muxer && encoder.state === "configured") {
    try {
      await encoder.flush();
    } catch (e) {
      console.warn("[Highlight] Encoder flush failed:", e);
    }
    try {
      muxer.finalize();
    } catch (e) {
      console.warn("[Highlight] Mux finalize failed:", e);
    }
    const buffer = muxer.target.buffer;
    resetState();
    if (!buffer || buffer.byteLength < 100) {
      console.warn("[Highlight] MP4 empty");
      return null;
    }
    const blob = new Blob([buffer], { type: "video/mp4" });
    const url = await blobToDataUrl(blob);
    console.log(`[Highlight] Clip ready ${Math.round(blob.size / 1024)}KB video/mp4`);
    return url;
  }

  const rec = recorder;
  if (!rec || rec.state === "inactive") {
    abortHighlightCapture();
    return null;
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || "video/mp4";
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
  const type = blob?.type || mimeType || "video/mp4";
  resetState();
  if (!blob) {
    console.warn("[Highlight] Clip empty");
    return null;
  }
  const url = await blobToDataUrl(blob);
  console.log(`[Highlight] Clip ready ${Math.round(blob.size / 1024)}KB ${type}`);
  return url;
}
