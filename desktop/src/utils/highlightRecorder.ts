/**
 * Session highlight clips: record the live view from 7.5s before the
 * shutter through 4s of the frozen post-shot preview. Canvas +
 * MediaRecorder so pausing the <video> also freezes the file (the
 * camera MediaStream would keep moving).
 *
 * Webcam frames come from the <video> element; Canon EVF frames come
 * from the JPEG data-URL stream (`getStillUrl`).
 */

export const HIGHLIGHT_LEAD_MS = 7500;
export const HIGHLIGHT_PREVIEW_MS = 4000;

const MAX_WIDTH = 1280;

export type HighlightCaptureOpts = {
  video?: HTMLVideoElement | null;
  getStillUrl?: () => string | null;
  getMirror?: () => boolean;
};

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let rafId = 0;
let frozen = false;
let sourceVideo: HTMLVideoElement | null = null;
let getStillUrl: (() => string | null) | null = null;
let getMirror: (() => boolean) | null = null;
let stillImg: HTMLImageElement | null = null;
let lastStillUrl = "";
let mimeType = "";

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const types = [
    "video/mp4;codecs=avc1.42001E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

export function isHighlightRecording(): boolean {
  return recorder != null && recorder.state !== "inactive";
}

function currentMirror(): boolean {
  return getMirror ? !!getMirror() : false;
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

function drawFrame() {
  if (!canvas || !ctx) return;
  if (!frozen) snapshotNow();
  rafId = requestAnimationFrame(drawFrame);
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

export function startHighlightCapture(opts: HighlightCaptureOpts): boolean {
  if (recorder) return true;

  mimeType = pickRecorderMime();
  if (!mimeType) {
    console.warn("[Highlight] MediaRecorder not supported");
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
  canvas.width = Math.max(2, Math.round(size.width * scale));
  canvas.height = Math.max(2, Math.round(size.height * scale));
  ctx = canvas.getContext("2d");
  if (!ctx) return false;

  frozen = false;
  chunks = [];
  snapshotNow();
  drawFrame();

  const recStream = canvas.captureStream(30);
  try {
    recorder = new MediaRecorder(recStream, {
      mimeType,
      videoBitsPerSecond: 2_500_000,
    });
  } catch (e) {
    console.warn("[Highlight] MediaRecorder failed:", e);
    stopLoop();
    return false;
  }
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  recorder.start(400);
  console.log(
    `[Highlight] Recording ${canvas.width}x${canvas.height} ${mimeType}`,
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
  frozen = false;
  sourceVideo = null;
  getStillUrl = null;
  getMirror = null;
  stillImg = null;
  lastStillUrl = "";
  recorder = null;
  chunks = [];
  canvas = null;
  ctx = null;
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

export function stopHighlightCapture(): Promise<string | null> {
  return new Promise((resolve) => {
    const rec = recorder;
    if (!rec || rec.state === "inactive") {
      abortHighlightCapture();
      resolve(null);
      return;
    }
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunks, { type });
      resetState();
      if (blob.size < 100) {
        console.warn("[Highlight] Clip empty");
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const url = typeof reader.result === "string" ? reader.result : null;
        console.log(
          `[Highlight] Clip ready ${Math.round(blob.size / 1024)}KB`,
        );
        resolve(url);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    };
    try {
      rec.stop();
    } catch {
      abortHighlightCapture();
      resolve(null);
    }
  });
}
