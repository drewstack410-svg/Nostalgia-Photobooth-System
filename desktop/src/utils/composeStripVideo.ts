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

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
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
  media: CanvasImageSource & {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  },
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

function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const types = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1.4D401F",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function pickAvcCodec(
  width: number,
  height: number,
): Promise<string | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const codecs = [
    "avc1.4D401F",
    "avc1.42001F",
    "avc1.64001F",
    "avc1.640028",
    "avc1.42001E",
  ];
  for (const codec of codecs) {
    try {
      const probe = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: 3_500_000,
        framerate: FPS,
        avc: { format: "avc" },
      });
      if (probe.supported) return codec;
    } catch {
      /* try next */
    }
  }
  return codecs[0];
}

/**
 * Encode a full-strip highlight: printed template with clips playing
 * in every photo window. Returns a `data:video/mp4` (or webm) URL.
 */
export async function composeStripVideo(opts: {
  frameDataUrl: string;
  clipDataUrls: string[];
  slots: StripSlot[];
}): Promise<string | null> {
  const clips = opts.clipDataUrls.filter(Boolean);
  if (!opts.frameDataUrl || !clips.length) {
    console.warn("[StripVideo] Missing frame or clips");
    return null;
  }
  if (!opts.slots.length) {
    console.warn("[StripVideo] No layout slots — cannot place clips on the strip");
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
  const ctx = canvas.getContext("2d", {
    alpha: true,
    colorSpace: "srgb",
    willReadFrequently: true,
  });
  if (!ctx) {
    host.remove();
    return null;
  }

  let videos: HTMLVideoElement[] = [];
  try {
    videos = await Promise.all(clips.map(loadVideo));
  } catch (e) {
    console.warn("[StripVideo] Clip load failed:", errText(e));
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

  console.log(
    `[StripVideo] Encoding ${width}x${height} for ~${Math.round(durationMs)}ms, ${slots.length} slot(s)`,
  );

  let dataUrl: string | null = null;
  try {
    dataUrl = await encodeWithVideoEncoder(canvas, paint, width, height, durationMs);
  } catch (e) {
    console.warn("[StripVideo] VideoEncoder path failed:", errText(e));
  }
  if (!dataUrl) {
    try {
      dataUrl = await encodeWithMediaRecorder(canvas, paint, durationMs);
    } catch (e) {
      console.warn("[StripVideo] MediaRecorder path failed:", errText(e));
    }
  }

  videos.forEach((v) => {
    v.pause();
    v.removeAttribute("src");
    v.load();
  });
  host.remove();
  return dataUrl;
}

async function encodeWithVideoEncoder(
  canvas: HTMLCanvasElement,
  paint: () => void,
  width: number,
  height: number,
  durationMs: number,
): Promise<string | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const codec = await pickAvcCodec(width, height);
  if (!codec) return null;

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
        console.warn("[StripVideo] Mux chunk failed:", errText(e));
      }
    },
    error: (e) => {
      encodeError = errText(e);
      console.warn("[StripVideo] VideoEncoder error:", encodeError);
    },
  });

  try {
    encoder.configure({
      codec,
      width,
      height,
      bitrate: 3_500_000,
      framerate: FPS,
      avc: { format: "avc" },
    });
  } catch (e) {
    console.warn("[StripVideo] VideoEncoder configure failed:", errText(e));
    try {
      encoder.close();
    } catch {
      /* ignore */
    }
    return null;
  }
  console.log(`[StripVideo] VideoEncoder ${codec} ${width}x${height}`);

  const startedAt = performance.now();
  while (performance.now() - startedAt < durationMs) {
    if (encodeError || encoder.state !== "configured") break;
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
        const bmp = await createImageBitmap(canvas);
        const vf = new VideoFrame(bmp, { timestamp: ts, duration });
        bmp.close();
        encoder.encode(vf, { keyFrame });
        vf.close();
        lastTimestampUs = ts;
        if (keyFrame) lastKeyframeUs = ts;
      } catch (e) {
        encodeError = errText(e);
        console.warn("[StripVideo] Encode frame failed:", encodeError);
        break;
      }
    }
    await sleep(FRAME_MS);
  }

  try {
    if (encoder.state === "configured") await encoder.flush();
  } catch (e) {
    console.warn("[StripVideo] Flush failed:", errText(e));
  }
  try {
    if (encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
  try {
    muxer.finalize();
  } catch (e) {
    console.warn("[StripVideo] Mux finalize failed:", errText(e));
    return null;
  }

  const bytes = target.buffer;
  if (!bytes || bytes.byteLength < 1000) {
    console.warn("[StripVideo] Empty mux output");
    return null;
  }
  const blob = new Blob([bytes], { type: "video/mp4" });
  const dataUrl = await blobToDataUrl(blob);
  console.log(`[StripVideo] Ready ${Math.round(blob.size / 1024)}KB video/mp4`);
  return dataUrl;
}

async function encodeWithMediaRecorder(
  canvas: HTMLCanvasElement,
  paint: () => void,
  durationMs: number,
): Promise<string | null> {
  const mime = pickRecorderMime();
  if (!mime || typeof canvas.captureStream !== "function") return null;

  paint();
  const stream = canvas.captureStream(FPS);
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 3_500_000,
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  console.log(`[StripVideo] MediaRecorder fallback ${mime}`);
  rec.start(200);
  const startedAt = performance.now();
  while (performance.now() - startedAt < durationMs) {
    paint();
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & {
      requestFrame?: () => void;
    };
    try {
      track.requestFrame?.();
    } catch {
      /* ignore */
    }
    await sleep(FRAME_MS);
  }

  await new Promise<void>((resolve, reject) => {
    rec.onerror = () => reject(new Error("MediaRecorder error"));
    rec.onstop = () => resolve();
    try {
      rec.stop();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  stream.getTracks().forEach((t) => t.stop());

  if (!chunks.length) {
    console.warn("[StripVideo] MediaRecorder produced no data");
    return null;
  }
  const blob = new Blob(chunks, { type: mime });
  const dataUrl = await blobToDataUrl(blob);
  console.log(
    `[StripVideo] Ready ${Math.round(blob.size / 1024)}KB ${mime}`,
  );
  return dataUrl;
}
