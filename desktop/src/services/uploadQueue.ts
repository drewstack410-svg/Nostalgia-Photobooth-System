/**
 * Guest QR media queue: persist pending R2 uploads, resume when the
 * booth is back online, and let Admin retry failed sessions.
 *
 * Jobs store file paths / publicIds only — never the photo bytes —
 * so localStorage stays small. Bytes are re-read from the session
 * folder (or used from memory on the first attempt).
 */
import { getR2Status, uploadBytesToR2, uploadToR2 } from "@/services/r2";
import { usePhotoboothStore } from "@/stores/photobooth";
import type { MediaUploadStatus } from "@/stores/photobooth";
import {
  makeGalleryShortCode,
  publishGallerySession,
  type GalleryLayoutMeta,
} from "@/utils/gallerySession";

const STORAGE_KEY = "nostalgia-pending-uploads";
const PING_TIMEOUT_MS = 4_000;
const FILE_UPLOAD_TIMEOUT_MS = 90_000;
const AUTO_RESUME_MS = 20_000;

export type GalleryAssetKind =
  | "photo"
  | "print"
  | "highlight-strip"
  | "highlight-full";

export type GalleryUploadAsset = {
  kind: GalleryAssetKind;
  filename: string;
  publicId: string;
  mime: string;
  captureIndex?: number;
  /** In-memory only — stripped before persist. */
  dataUrl?: string;
  bytes?: Uint8Array;
};

export type GalleryUploadJob = {
  sessionId: string;
  sessionTs: number;
  sessionFolder: string | null;
  shortCode: string;
  templateId?: string;
  status: MediaUploadStatus;
  error?: string;
  assets: GalleryUploadAsset[];
  layout?: GalleryLayoutMeta;
  updatedAt: number;
};

type PersistableJob = Omit<GalleryUploadJob, "assets"> & {
  assets: Array<Omit<GalleryUploadAsset, "dataUrl" | "bytes">>;
};

let jobs: GalleryUploadJob[] = loadJobs();
let processing = false;
let watcherStarted = false;
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function loadJobs(): GalleryUploadJob[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistableJob[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((j) => j && typeof j.sessionId === "string")
      .map((j) => ({
        ...j,
        status: j.status === "uploading" ? "pending" : j.status,
        assets: Array.isArray(j.assets) ? j.assets : [],
      }));
  } catch {
    return [];
  }
}

function persistJobs() {
  const slim: PersistableJob[] = jobs.map((j) => ({
    ...j,
    assets: j.assets.map(({ dataUrl: _d, bytes: _b, ...rest }) => rest),
  }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch (e) {
    console.warn("[UploadQueue] Failed to persist jobs:", e);
  }
  listeners.forEach((cb) => cb());
}

export function onUploadQueueChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function listUploadJobs(): GalleryUploadJob[] {
  return jobs.map((j) => ({ ...j, assets: [...j.assets] }));
}

export function pendingUploadCount(): number {
  return jobs.filter((j) => j.status === "pending" || j.status === "failed")
    .length;
}

export function jobForSession(sessionId?: string): GalleryUploadJob | undefined {
  if (!sessionId) return undefined;
  return jobs.find((j) => j.sessionId === sessionId);
}

function upsertJob(next: GalleryUploadJob) {
  const i = jobs.findIndex((j) => j.sessionId === next.sessionId);
  if (i >= 0) jobs[i] = next;
  else jobs.unshift(next);
  if (jobs.length > 80) {
    const keep = jobs.filter((j) => j.status !== "done");
    const done = jobs.filter((j) => j.status === "done").slice(0, 20);
    jobs = [...keep, ...done];
  }
  persistJobs();
}

function patchJob(sessionId: string, patch: Partial<GalleryUploadJob>) {
  const i = jobs.findIndex((j) => j.sessionId === sessionId);
  if (i < 0) return;
  jobs[i] = { ...jobs[i]!, ...patch, updatedAt: Date.now() };
  persistJobs();
}

function stampStrips(sessionId: string, status: MediaUploadStatus, shareableUrl?: string) {
  const store = usePhotoboothStore();
  store.patchRecentStripSession(sessionId, {
    uploadStatus: status,
    ...(shareableUrl ? { shareableUrl } : {}),
  });
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export type UploadRetryResult = {
  ok: boolean;
  uploaded?: number;
  noConnection?: boolean;
};

export async function cloudIsReady(timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  if (isBrowserOffline()) {
    return false;
  }
  try {
    const status = await Promise.race([
      getR2Status(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("R2 ping timed out")), timeoutMs),
      ),
    ]);
    return !!(status.configured && status.apiOk);
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ]);
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function toUint8(bytes: Uint8Array | ArrayBuffer | number[] | { type?: string; data?: number[] } | null | undefined): Uint8Array | null {
  if (!bytes) return null;
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (Array.isArray(bytes)) return new Uint8Array(bytes);
  if (typeof bytes === "object" && Array.isArray((bytes as { data?: number[] }).data)) {
    return new Uint8Array((bytes as { data: number[] }).data);
  }
  return new Uint8Array(bytes as ArrayBuffer);
}

async function loadAssetPayload(
  job: GalleryUploadJob,
  asset: GalleryUploadAsset,
): Promise<{ dataUrl?: string; bytes?: Uint8Array; mime: string } | null> {
  if (asset.dataUrl) return { dataUrl: asset.dataUrl, mime: asset.mime };
  if (asset.bytes && asset.bytes.byteLength) {
    return { bytes: asset.bytes, mime: asset.mime };
  }
  const api = window.electronAPI;
  if (!api?.readSessionFile || !job.sessionFolder) return null;
  const rel = `${job.sessionFolder}/${asset.filename}`.replace(/\\/g, "/");
  const read = await api.readSessionFile(rel);
  if (!read?.success || !read.bytes) return null;
  const bytes = toUint8(read.bytes);
  if (!bytes) return null;
  const mime = read.mime || asset.mime;
  return { bytes, mime };
}

async function uploadAsset(
  payload: { dataUrl?: string; bytes?: Uint8Array; mime: string },
  publicId: string,
): Promise<{ url?: string; publicId?: string } | null> {
  const isVideo = payload.mime.startsWith("video/");
  if (isVideo) {
    let bytes = payload.bytes;
    if (!bytes && payload.dataUrl) {
      const comma = payload.dataUrl.indexOf(",");
      if (comma < 0) return null;
      const bin = atob(payload.dataUrl.slice(comma + 1));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    if (!bytes) return null;
    const cr = await withTimeout(
      uploadBytesToR2(bytes, payload.mime, "nostalgia-photobooth", publicId),
      FILE_UPLOAD_TIMEOUT_MS,
      publicId,
    );
    if (cr.success && cr.publicId) return { url: cr.url, publicId: cr.publicId };
    throw new Error(cr.error || `Upload failed: ${publicId}`);
  }

  let dataUrl = payload.dataUrl;
  if (!dataUrl && payload.bytes) {
    dataUrl = bytesToDataUrl(payload.bytes, payload.mime);
  }
  if (!dataUrl) return null;
  const cr = await withTimeout(
    uploadToR2(dataUrl, "nostalgia-photobooth", publicId),
    FILE_UPLOAD_TIMEOUT_MS,
    publicId,
  );
  if (cr.success && cr.publicId) return { url: cr.url, publicId: cr.publicId };
  throw new Error(cr.error || `Upload failed: ${publicId}`);
}

export function enqueueGalleryUpload(job: GalleryUploadJob): GalleryUploadJob {
  const next: GalleryUploadJob = {
    ...job,
    status: "pending",
    error: undefined,
    updatedAt: Date.now(),
  };
  upsertJob(next);
  stampStrips(next.sessionId, "pending");
  return next;
}

export async function processSessionUpload(sessionId: string): Promise<boolean> {
  const job = jobs.find((j) => j.sessionId === sessionId);
  if (!job) return false;
  if (job.status === "done") return true;
  if (inFlight.has(sessionId)) return false;
  inFlight.add(sessionId);

  patchJob(sessionId, { status: "uploading", error: undefined });
  stampStrips(sessionId, "uploading");

  try {
    const photoIds: string[] = [];
    const photoMeta: Array<{ url: string; publicId: string }> = [];
    let printId: string | undefined;
    const stripIds: string[] = [];
    const fullVids: string[] = [];

    for (const asset of job.assets) {
      const payload = await loadAssetPayload(job, asset);
      if (!payload) {
        throw new Error(`Missing local file: ${asset.filename}`);
      }
      const uploaded = await uploadAsset(payload, asset.publicId);
      if (!uploaded?.publicId) {
        throw new Error(`Upload produced no id: ${asset.filename}`);
      }
      if (asset.kind === "photo") {
        photoIds.push(uploaded.publicId);
        if (uploaded.url) {
          photoMeta.push({ url: uploaded.url, publicId: uploaded.publicId });
        }
      } else if (asset.kind === "print") {
        printId = uploaded.publicId;
      } else if (asset.kind === "highlight-strip") {
        stripIds.push(uploaded.publicId);
      } else {
        fullVids.push(uploaded.publicId);
      }
    }

    const shareableUrl = await withTimeout(
      publishGallerySession({
        shortCode: job.shortCode,
        publicIds: photoIds,
        printId,
        videoIds: stripIds.length ? stripIds : undefined,
        fullIds: photoIds.length ? photoIds : undefined,
        fullVids: fullVids.length ? fullVids : undefined,
        layout: job.layout,
      }),
      FILE_UPLOAD_TIMEOUT_MS,
      "gallery manifest",
    );
    if (!shareableUrl) {
      throw new Error("Gallery manifest upload failed");
    }

    const store = usePhotoboothStore();
    store.patchRecentStripSession(sessionId, {
      uploadStatus: "done",
      shareableUrl,
      cloudinaryPhotos: photoMeta.length ? photoMeta : undefined,
      cloudinaryUrl: photoMeta[0]?.url,
      cloudinaryPublicId: photoMeta[0]?.publicId,
    });
    patchJob(sessionId, { status: "done", error: undefined });
    console.log("[UploadQueue] Session uploaded:", sessionId, shareableUrl);
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[UploadQueue] Session upload failed:", sessionId, error);
    patchJob(sessionId, { status: "failed", error });
    stampStrips(sessionId, "failed");
    return false;
  } finally {
    inFlight.delete(sessionId);
  }
}

export async function submitGalleryUpload(job: GalleryUploadJob): Promise<boolean> {
  enqueueGalleryUpload(job);
  const ready = await cloudIsReady();
  if (!ready) {
    console.warn(
      "[UploadQueue] Offline or slow R2 — session left pending:",
      job.sessionId,
    );
    return false;
  }
  return processSessionUpload(job.sessionId);
}

export async function processPendingUploads(): Promise<number> {
  if (processing) return 0;
  const due = jobs.filter((j) => j.status === "pending" || j.status === "failed");
  if (!due.length) return 0;
  if (!(await cloudIsReady())) return 0;

  processing = true;
  let ok = 0;
  try {
    for (const job of due) {
      const done = await processSessionUpload(job.sessionId);
      if (done) ok += 1;
    }
  } finally {
    processing = false;
  }
  return ok;
}

export async function retrySessionUpload(
  sessionId: string,
): Promise<UploadRetryResult> {
  let job: GalleryUploadJob | undefined = jobs.find(
    (j) => j.sessionId === sessionId,
  );
  if (!job) {
    const rebuilt = await reconstructJobFromDisk(sessionId);
    if (!rebuilt) return { ok: false };
    job = rebuilt;
    enqueueGalleryUpload(job);
  } else if (job.status === "done") {
    return { ok: true };
  } else {
    patchJob(sessionId, { status: "pending", error: undefined });
    stampStrips(sessionId, "pending");
  }
  if (isBrowserOffline() || !(await cloudIsReady())) {
    return { ok: false, noConnection: true };
  }
  const ok = await processSessionUpload(sessionId);
  return { ok };
}

export async function retryPendingUploads(): Promise<UploadRetryResult> {
  for (const job of jobs) {
    if (job.status === "failed") {
      patchJob(job.sessionId, { status: "pending", error: undefined });
      stampStrips(job.sessionId, "pending");
    }
  }
  if (isBrowserOffline()) {
    return { ok: false, uploaded: 0, noConnection: true };
  }
  if (processing) return { ok: true, uploaded: 0 };
  const due = jobs.filter((j) => j.status === "pending" || j.status === "failed");
  if (!due.length) return { ok: true, uploaded: 0 };
  if (!(await cloudIsReady())) {
    return { ok: false, uploaded: 0, noConnection: true };
  }
  processing = true;
  let uploaded = 0;
  try {
    for (const job of due) {
      if (await processSessionUpload(job.sessionId)) uploaded += 1;
    }
  } finally {
    processing = false;
  }
  return { ok: uploaded > 0, uploaded };
}

function sessionFolderFromPath(filePath?: string): string | null {
  if (!filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  const m = norm.match(/(\d{2}-\d{2}-\d{2}\/Session \d+)/i);
  return m ? m[1] : null;
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "mp4" || ext === "m4v" || ext === "mov") return "video/mp4";
  if (ext === "webm") return "video/webm";
  return "application/octet-stream";
}

async function reconstructJobFromDisk(
  sessionId: string,
): Promise<GalleryUploadJob | null> {
  const store = usePhotoboothStore();
  const strips = store.recentStrips.filter((s) => s.sessionId === sessionId);
  const folder =
    strips.map((s) => sessionFolderFromPath(s.path)).find(Boolean) || null;
  if (!folder || !window.electronAPI?.listSessionFiles) return null;

  const files = await window.electronAPI.listSessionFiles(folder);
  if (!files?.length) return null;

  const sessionTs = Number(sessionId.replace(/^session_/, "")) || Date.now();
  const assets: GalleryUploadAsset[] = [];
  for (const file of files) {
    const name = file.name;
    if (/^photo-\d+\.jpe?g$/i.test(name)) {
      const n = Number(name.match(/\d+/)?.[0] || "1") - 1;
      assets.push({
        kind: "photo",
        filename: name,
        publicId: `nostalgia_${sessionTs}_${n}`,
        mime: mimeFromName(name),
        captureIndex: n,
      });
    } else if (/^strip\.png$/i.test(name)) {
      assets.push({
        kind: "print",
        filename: name,
        publicId: `nostalgia_${sessionTs}_print`,
        mime: "image/png",
      });
    } else if (/^highlight-strip\./i.test(name)) {
      assets.push({
        kind: "highlight-strip",
        filename: name,
        publicId: `nostalgia_${sessionTs}_highlight-strip`,
        mime: mimeFromName(name),
      });
    } else if (/^highlight-\d+\./i.test(name)) {
      const n = name.match(/highlight-(\d+)/i)?.[1] || "1";
      assets.push({
        kind: "highlight-full",
        filename: name,
        publicId: `nostalgia_${sessionTs}_highlight-${n}`,
        mime: mimeFromName(name),
      });
    }
  }
  if (!assets.length) return null;

  return {
    sessionId,
    sessionTs,
    sessionFolder: folder,
    shortCode: makeGalleryShortCode(),
    templateId: strips.find((s) => s.templateId)?.templateId,
    status: "pending",
    assets,
    updatedAt: Date.now(),
  };
}

export function startUploadQueueWatcher(): void {
  if (watcherStarted || typeof window === "undefined") return;
  watcherStarted = true;
  window.addEventListener("online", () => {
    console.log("[UploadQueue] Connection restored — resuming pending uploads");
    void processPendingUploads();
  });
  window.setInterval(() => {
    if (pendingUploadCount() > 0) void processPendingUploads();
  }, AUTO_RESUME_MS);
  void processPendingUploads();
}
