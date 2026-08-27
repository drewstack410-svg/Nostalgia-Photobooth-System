/**
 * Session highlight clips: record the live view from 7.5s before the
 * shutter through 4s of the frozen post-shot preview.
 *
 * Frames are drawn to a canvas (so a paused <video> actually freezes)
 * and encoded to H.264 MP4 via WebCodecs + mp4-muxer — iOS Safari will
 * not play the WebM MediaRecorder would otherwise emit on Chromium.
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export const HIGHLIGHT_LEAD_MS = 7500;
export const HIGHLIGHT_PREVIEW_MS = 4000;

const MAX_WIDTH = 1280;
const FPS = 30;
const BITRATE = 2_500_000;
const AVC_CODECS = [
  "avc1.42001E",
  "avc1.42001F",
  "avc1.4D001E",
  "avc1.64001E",
];

export type HighlightCaptureOpts = {
  video?: HTMLVideoElement | null;
  getStillUrl?: () => string | null;
  getMirror?: () => boolean;
};

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let rafId = 0;
let frozen = false;
let recording = false;
let sourceVideo: HTMLVideoElement | null = null;
let getStillUrl: (() => string | null) | null = null;
let getMirror: (() => boolean) | null = null;
let stillImg: HTMLImageElement | null = null;
let lastStillUrl = "";
let encoder: VideoEncoder | null = null;
let muxer: Muxer<ArrayBufferTarget> | null = null;
let startMs = 0;
let frameCount = 0;
let encodeFailed = false;

export function isHighlightRecording(): boolean {
  return recording && !encodeFailed;
}

function currentMirror(): boolean {
  return getMirror ? !!getMirror() : false;
}

function even(n: number): number {
  return Math.max(2, n & ~1);
}

function sizeFromSources(
  video: HTMLVideoElement | null,
  still: HTMLImageElement | null,
): { width: number; height: number } | null {
  if (video && video.readyState >= 2 && video.videoWidth >= 2) {
    return { width: video.videoWidth, height: video.videoHeight };
  }
  if (still && still.complete && still.naturalWidth >= 2) {
    return { width: still.naturalWidth, height: still.naturalHeight };
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

function snapshotNow() {
  if (!canvas || !ctx) return;
  pullStill();
  if (sourceVideo && sourceVideo.readyState >= 2 && sourceVideo.videoWidth >= 2) {
    drawCover(sourceVideo, sourceVideo.videoWidth, sourceVideo.videoHeight);
  } else if (stillImg && stillImg.complete && stillImg.naturalWidth >= 2) {
    drawCover(stillImg, stillImg.naturalWidth, stillImg.naturalHeight);
  }
}

function encodeCanvasFrame() {
  if (!encoder || !canvas || encodeFailed) return;
  if (encoder.state !== "configured") return;
  if (encoder.encodeQueueSize > 8) return;
  const timestamp = Math.max(0, Math.round((performance.now() - startMs) * 1000));
  try {
    const frame = new VideoFrame(canvas, {
      timestamp,
      alpha: "discard",
    });
    encoder.encode(frame, { keyFrame: frameCount % FPS === 0 });
    frame.close();
    frameCount++;
  } catch (e) {
    console.warn("[Highlight] Frame encode failed:", e);
  }
}

function drawFrame() {
  if (!canvas || !ctx || !recording) return;
  if (!frozen) snapshotNow();
  encodeCanvasFrame();
  rafId = requestAnimationFrame(drawFrame);
}

function pickAvcCodec(width: number, height: number): string | null {
  if (typeof VideoEncoder === "undefined") return null;
  for (const codec of AVC_CODECS) {
    try {
      const encoder = new VideoEncoder({
        output: () => {},
        error: () => {},
      });
      encoder.configure({
        codec,
        width,
        height,
        bitrate: BITRATE,
        framerate: FPS,
        avc: { format: "avc" },
      });
      encoder.close();
      return codec;
    } catch {
      /* try next profile */
    }
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () =>
      resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export function startHighlightCapture(opts: HighlightCaptureOpts): boolean {
  if (recording) return true;
  if (typeof VideoEncoder === "undefined") {
    console.warn("[Highlight] WebCodecs VideoEncoder is not available");
    return false;
  }

  sourceVideo = opts.video ?? null;
  getStillUrl = opts.getStillUrl ?? null;
  getMirror = opts.getMirror ?? null;
  pullStill();

  const size = sizeFromSources(sourceVideo, stillImg);
  if (!size) {
    console.warn("[Highlight] No live video to record");
    sourceVideo = null;
    getStillUrl = null;
    getMirror = null;
    return false;
  }

  const scale = Math.min(1, MAX_WIDTH / size.width);
  canvas = document.createElement("canvas");
  canvas.width = even(Math.round(size.width * scale));
  canvas.height = even(Math.round(size.height * scale));
  ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) return false;

  const codec = pickAvcCodec(canvas.width, canvas.height);
  if (!codec) {
    console.warn("[Highlight] No H.264 encoder available for MP4");
    canvas = null;
    ctx = null;
    return false;
  }

  const target = new ArrayBufferTarget();
  muxer = new Muxer({
    target,
    video: {
      codec: "avc",
      width: canvas.width,
      height: canvas.height,
      frameRate: FPS,
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  encodeFailed = false;
  encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer?.addVideoChunk(chunk, meta);
      } catch (e) {
        console.warn("[Highlight] Mux failed:", e);
        encodeFailed = true;
      }
    },
    error: (e) => {
      console.warn("[Highlight] Encoder error:", e);
      encodeFailed = true;
    },
  });
  encoder.configure({
    codec,
    width: canvas.width,
    height: canvas.height,
    bitrate: BITRATE,
    framerate: FPS,
    avc: { format: "avc" },
    latencyMode: "realtime",
  });

  frozen = false;
  frameCount = 0;
  startMs = performance.now();
  recording = true;
  snapshotNow();
  drawFrame();
  console.log(
    `[Highlight] Recording MP4 ${canvas.width}x${canvas.height} ${codec}`,
  );
  return true;
}

export function freezeHighlightCapture() {
  snapshotNow();
  frozen = true;
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function resetState() {
  stopLoop();
  recording = false;
  frozen = false;
  encodeFailed = false;
  sourceVideo = null;
  getStillUrl = null;
  getMirror = null;
  stillImg = null;
  lastStillUrl = "";
  frameCount = 0;
  if (encoder && encoder.state !== "closed") {
    try {
      encoder.close();
    } catch {
      /* already closed */
    }
  }
  encoder = null;
  muxer = null;
  canvas = null;
  ctx = null;
}

export function abortHighlightCapture() {
  recording = false;
  resetState();
}

export async function stopHighlightCapture(): Promise<string | null> {
  if (!recording || !encoder || !muxer) {
    abortHighlightCapture();
    return null;
  }
  recording = false;
  stopLoop();
  snapshotNow();
  encodeCanvasFrame();

  const enc = encoder;
  const mx = muxer;
  try {
    if (enc.state === "configured") await enc.flush();
  } catch (e) {
    console.warn("[Highlight] Encoder flush failed:", e);
  }
  try {
    if (enc.state !== "closed") enc.close();
  } catch {
    /* already closed */
  }
  encoder = null;

  try {
    mx.finalize();
  } catch (e) {
    console.warn("[Highlight] Mux finalize failed:", e);
    resetState();
    return null;
  }

  const buffer = mx.target.buffer;
  muxer = null;
  resetState();
  if (!buffer || buffer.byteLength < 100) {
    console.warn("[Highlight] Clip empty");
    return null;
  }
  const blob = new Blob([buffer], { type: "video/mp4" });
  const url = await blobToDataUrl(blob);
  console.log(`[Highlight] MP4 ready ${Math.round(blob.size / 1024)}KB`);
  return url;
}
