/**
 * Bake highlight clips into the printed strip: one MP4 of the full
 * template with each shot playing in its photo window. Saved locally
 * and uploaded so the guest gallery never has to place clips itself.
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export type StripSlot = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
};

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const MAX_EDGE = 1080;
const MAX_MS = 16000;

function even(n: number): number {
  return Math.max(2, n & ~1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("strip frame failed to load"));
    img.src = src;
  });
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.preload = "auto";
    v.src = src;
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error("highlight clip failed to load"));
  });
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  media: CanvasImageSource & { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number },
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = media.videoWidth || media.naturalWidth || 0;
  const ih = media.videoHeight || media.naturalHeight || 0;
  if (!iw || !ih || w <= 0 || h <= 0) return;
  const imgAspect = iw / ih;
  const cellAspect = w / h;
  let sx = 0;
  let sy = 0;
  let sw = iw;
  let sh = ih;
  if (imgAspect > cellAspect) {
    sw = ih * cellAspect;
    sx = (iw - sw) / 2;
  } else {
    sh = iw / cellAspect;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(media, sx, sy, sw, sh, x, y, w, h);
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

/**
 * Encode a full-strip highlight: printed template with clips playing
 * in every photo window. Returns a `data:video/mp4` URL, or null.
 */
export async function composeStripVideo(opts: {
  frameDataUrl: string;
  clipDataUrls: string[];
  slots: StripSlot[];
}): Promise<string | null> {
  const clips = opts.clipDataUrls.filter(Boolean);
  if (!opts.frameDataUrl || !clips.length || !opts.slots.length) return null;
  if (typeof VideoEncoder === "undefined") {
    console.warn("[StripVideo] VideoEncoder unavailable");
    return null;
  }

  const frame = await loadImage(opts.frameDataUrl);
  const srcW = frame.naturalWidth;
  const srcH = frame.naturalHeight;
  if (srcW < 2 || srcH < 2) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
  const width = even(Math.round(srcW * scale));
  const height = even(Math.round(srcH * scale));

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:0;bottom:0;width:8px;height:8px;overflow:hidden;opacity:0.04;pointer-events:none;z-index:-1";
  document.body.appendChild(host);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    host.remove();
    return null;
  }

  let videos: HTMLVideoElement[] = [];
  try {
    videos = await Promise.all(clips.map(loadVideo));
  } catch (e) {
    console.warn("[StripVideo] Clip load failed:", e);
    host.remove();
    return null;
  }
  videos.forEach((v) => {
    v.width = 8;
    v.height = 8;
    host.appendChild(v);
  });

  const slots = opts.slots;
  const paint = () => {
    ctx.drawImage(frame, 0, 0, width, height);
    slots.forEach((slot, i) => {
      const v = videos[i % videos.length];
      const x = slot.x * width;
      const y = slot.y * height;
      const w = slot.w * width;
      const h = slot.h * height;
      ctx.save();
      if (slot.rotation) {
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate((slot.rotation * Math.PI) / 180);
        ctx.translate(-(x + w / 2), -(y + h / 2));
      }
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      drawCover(ctx, v, x, y, w, h);
      ctx.restore();
    });
  };

  const durationMs = Math.min(
    MAX_MS,
    Math.max(
      4000,
      ...videos.map((v) =>
        isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : 15000,
      ),
    ),
  );

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let encodeError: string | null = null;
  let lastTimestampUs = -1;
  let lastKeyframeUs = -1;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (e) {
        console.warn("[StripVideo] Mux chunk failed:", e);
      }
    },
    error: (e) => {
      encodeError = e.message;
      console.warn("[StripVideo] VideoEncoder error:", e);
    },
  });

  try {
    encoder.configure({
      codec: "avc1.42001E",
      width,
      height,
      bitrate: 3_500_000,
      framerate: FPS,
      avc: { format: "avc" },
    });
  } catch (e) {
    console.warn("[StripVideo] VideoEncoder configure failed:", e);
    try {
      encoder.close();
    } catch {
      /* ignore */
    }
    host.remove();
    return null;
  }

  await Promise.all(
    videos.map((v) => {
      try {
        v.currentTime = 0;
      } catch {
        /* ignore */
      }
      return v.play().catch(() => {});
    }),
  );

  const startedAt = performance.now();
  console.log(`[StripVideo] Encoding ${width}x${height} for ~${Math.round(durationMs)}ms`);

  while (performance.now() - startedAt < durationMs) {
    if (encodeError) break;
    while (encoder.encodeQueueSize > 12) await sleep(8);
    paint();
    const ts = Math.max(0, Math.round((performance.now() - startedAt) * 1000));
    if (lastTimestampUs < 0 || ts - lastTimestampUs >= 500) {
      const duration =
        lastTimestampUs >= 0
          ? Math.max(1000, ts - lastTimestampUs)
          : Math.round(FRAME_MS * 1000);
      const keyFrame = lastKeyframeUs < 0 || ts - lastKeyframeUs >= 1_000_000;
      try {
        const vf = new VideoFrame(canvas, { timestamp: ts, duration });
        encoder.encode(vf, { keyFrame });
        vf.close();
        lastTimestampUs = ts;
        if (keyFrame) lastKeyframeUs = ts;
      } catch (e) {
        encodeError = e instanceof Error ? e.message : String(e);
        console.warn("[StripVideo] Encode frame failed:", e);
        break;
      }
    }
    await sleep(FRAME_MS);
  }

  videos.forEach((v) => {
    v.pause();
    v.removeAttribute("src");
    v.load();
  });
  host.remove();

  try {
    await encoder.flush();
  } catch (e) {
    console.warn("[StripVideo] Flush failed:", e);
  }
  try {
    if (encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
  muxer.finalize();

  const bytes = target.buffer;
  if (!bytes || bytes.byteLength < 100) {
    console.warn("[StripVideo] Empty mux output");
    return null;
  }
  const blob = new Blob([bytes], { type: "video/mp4" });
  const dataUrl = await blobToDataUrl(blob);
  console.log(
    `[StripVideo] Ready ${Math.round(blob.size / 1024)}KB video/mp4`,
  );
  return dataUrl;
}
