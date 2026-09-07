/**
 * Guest-gallery videos must be a real H.264 MP4 with ftyp + moov + mdat.
 * Chromium MediaRecorder "video/mp4" is fragmented and iPhone/Safari
 * reports those files as corrupted. WebM also will not save to Camera Roll.
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { mediaUrlToBytes, objectUrlFromBlob } from "./mediaBytes";

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const MAX_WIDTH = 1280;
const MAX_MS = 16000;

type AvcHwAccel = "no-preference" | "prefer-hardware" | "prefer-software";

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

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4] || 0,
    bytes[offset + 5] || 0,
    bytes[offset + 6] || 0,
    bytes[offset + 7] || 0,
  );
}

function boxSize(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] || 0) << 24) |
    ((bytes[offset + 1] || 0) << 16) |
    ((bytes[offset + 2] || 0) << 8) |
    (bytes[offset + 3] || 0)
  );
}

function hasBox(bytes: Uint8Array, name: string): boolean {
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    if (boxType(bytes, offset) === name) return true;
    const size = boxSize(bytes, offset);
    if (size < 8) break;
    offset += size;
  }
  return false;
}

/** True when the file is a progressive MP4 phones can save and play. */
export function isPlayableMp4(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 64) return false;
  if (!hasBox(bytes, "ftyp") || !hasBox(bytes, "moov") || !hasBox(bytes, "mdat")) {
    return false;
  }
  return true;
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

export async function encodeCanvasToMp4(
  canvas: HTMLCanvasElement,
  paint: () => void | Promise<void>,
  durationMs: number,
): Promise<Blob | null> {
  const width = even(canvas.width);
  const height = even(canvas.height);
  if (width < 2 || height < 2) return null;
  canvas.width = width;
  canvas.height = height;

  const picked = await pickAvcCodec(width, height);
  if (!picked) return null;

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
  let frames = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (e) {
        encodeError = errText(e);
      }
    },
    error: (e) => {
      encodeError = errText(e);
    },
  });

  try {
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
    console.warn("[GuestMp4] configure failed:", errText(e));
    try {
      encoder.close();
    } catch {
      /* ignore */
    }
    return null;
  }

  const startedAt = performance.now();
  const limit = Math.min(MAX_MS, Math.max(1000, durationMs));
  while (performance.now() - startedAt < limit) {
    if (encodeError || encoder.state !== "configured") break;
    while (encoder.encodeQueueSize > 12) await sleep(8);
    await paint();
    const ts = Math.max(0, Math.round((performance.now() - startedAt) * 1000));
    if (lastTimestampUs >= 0 && ts - lastTimestampUs < 500) {
      await sleep(FRAME_MS);
      continue;
    }
    const duration =
      lastTimestampUs >= 0
        ? Math.max(1000, ts - lastTimestampUs)
        : Math.round(FRAME_MS * 1000);
    const keyFrame = lastKeyframeUs < 0 || ts - lastKeyframeUs >= 1_000_000;
    try {
      const bmp = await createImageBitmap(canvas);
      const frame = new VideoFrame(bmp, { timestamp: ts, duration });
      bmp.close();
      encoder.encode(frame, { keyFrame });
      frame.close();
      lastTimestampUs = ts;
      if (keyFrame) lastKeyframeUs = ts;
      frames++;
    } catch (e) {
      encodeError = errText(e);
      break;
    }
    await sleep(FRAME_MS);
  }

  try {
    if (encoder.state === "configured") await encoder.flush();
  } catch (e) {
    console.warn("[GuestMp4] flush failed:", errText(e));
  }
  await sleep(40);
  try {
    if (encoder.state !== "closed") encoder.close();
  } catch {
    /* ignore */
  }
  try {
    muxer.finalize();
  } catch (e) {
    console.warn("[GuestMp4] finalize failed:", errText(e));
    return null;
  }

  const buffer = target.buffer;
  const bytes = buffer ? new Uint8Array(buffer) : null;
  if (!bytes || frames < 8 || !isPlayableMp4(bytes)) {
    console.warn(
      "[GuestMp4] Rejected mux",
      encodeError || `${frames} frames / ${bytes?.byteLength || 0} bytes`,
    );
    return null;
  }
  console.log(`[GuestMp4] Ready ${Math.round(bytes.byteLength / 1024)}KB (${frames} frames)`);
  return new Blob([bytes], { type: "video/mp4" });
}

async function loadVideo(src: string): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.preload = "auto";
  v.src = src;
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error("clip failed to load"));
  });
  return v;
}

/** Re-encode any playable clip into a guest-safe MP4. */
export async function remuxToGuestMp4(url: string): Promise<string | null> {
  if (!url) return null;
  const parsed = await mediaUrlToBytes(url);
  if (parsed && isPlayableMp4(parsed.bytes)) return url;

  let video: HTMLVideoElement | null = null;
  try {
    video = await loadVideo(url);
    const srcW = video.videoWidth || 1280;
    const srcH = video.videoHeight || 720;
    if (srcW < 2 || srcH < 2) return null;
    const scale = Math.min(1, MAX_WIDTH / Math.max(srcW, srcH));
    const canvas = document.createElement("canvas");
    canvas.width = even(Math.round(srcW * scale));
    canvas.height = even(Math.round(srcH * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;

    try {
      video.currentTime = 0;
    } catch {
      /* ignore */
    }
    await video.play().catch(() => {});

    const durationMs = Math.min(
      MAX_MS,
      Math.max(
        1000,
        isFinite(video.duration) && video.duration > 0
          ? video.duration * 1000
          : 15000,
      ),
    );
    const blob = await encodeCanvasToMp4(
      canvas,
      () => {
        if (video && video.readyState >= 2) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
      },
      durationMs,
    );
    if (!blob) return null;
    return objectUrlFromBlob(blob);
  } catch (e) {
    console.warn("[GuestMp4] Remux failed:", errText(e));
    return null;
  } finally {
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }
}
