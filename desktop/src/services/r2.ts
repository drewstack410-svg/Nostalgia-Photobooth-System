/**
 * Cloudflare R2 upload from the renderer.
 *
 * Secrets never enter this file. Electron signs the PutObject in main
 * (`r2:upload` IPC). Vite-only `npm run dev` posts to `/api/r2-upload`,
 * which uses the same Node uploader.
 */

export interface CloudUploadResult {
  success: boolean;
  url?: string;
  publicId?: string;
  error?: string;
}

export interface R2Status {
  configured: boolean;
  connected?: boolean;
  apiOk?: boolean;
  publicOk?: boolean;
  bucket?: string;
  publicUrl?: string;
  missing?: string[];
  error?: string;
}

export async function checkR2Connection(): Promise<boolean> {
  const publicHint =
    import.meta.env.VITE_R2_PUBLIC_URL || "Cloudflare R2";
  console.log(`[R2] Checking connection to ${publicHint} ...`);
  try {
    const status = await getR2Status();
    if (status.connected && status.apiOk) {
      console.log(
        `[R2] Connected. Cloudflare API healthy (bucket ${status.bucket || "?"}) — public ${status.publicUrl || ""}`,
      );
      return true;
    }
    if (status.apiOk && !status.publicOk) {
      console.warn(
        `[R2] API connected, but public URL is not readable. ${status.error || "Enable Public development URL on the bucket."}`,
      );
      return false;
    }
    if (!status.configured) {
      console.warn(
        `[R2] Not connected — missing ${(status.missing || []).join(", ") || "credentials"}. Guest QR uploads will be skipped.`,
      );
      return false;
    }
    console.error(
      `[R2] Not connected to Cloudflare. ${status.error || "HeadBucket failed."}`,
    );
    return false;
  } catch (err) {
    console.error("[R2] Status check failed:", err);
    return false;
  }
}

export async function getR2Status(): Promise<R2Status> {
  if (window.electronAPI?.getR2Status) {
    return window.electronAPI.getR2Status();
  }
  try {
    const res = await fetch("/api/r2-status");
    if (!res.ok) {
      return { configured: false, missing: ["R2 proxy unavailable"] };
    }
    return (await res.json()) as R2Status;
  } catch {
    const publicUrl = import.meta.env.VITE_R2_PUBLIC_URL;
    return {
      configured: false,
      publicUrl,
      missing: publicUrl
        ? ["R2 upload proxy (run via Vite or Electron)"]
        : ["VITE_R2_PUBLIC_URL", "R2 credentials"],
    };
  }
}

/**
 * Same call shape as the old Cloudinary helper so PrintingView can swap
 * providers without changing session/publicId bookkeeping.
 */
export async function uploadToR2(
  imageDataUrl: string,
  folder: string = "nostalgia-photobooth",
  publicId?: string,
  _tags?: string | string[],
): Promise<CloudUploadResult> {
  console.log("[R2] Starting upload...", { folder, publicId });

  if (window.electronAPI?.uploadToR2) {
    const result = await window.electronAPI.uploadToR2({
      imageData: imageDataUrl,
      folder,
      publicId,
    });
    if (result.success) {
      console.log("[R2] Upload successful:", result.url);
    } else {
      console.warn("[R2] Upload failed:", result.error);
    }
    return result;
  }

  try {
    const res = await fetch("/api/r2-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl, folder, publicId }),
    });
    const result = (await res.json().catch(() => ({}))) as CloudUploadResult;
    if (!res.ok || !result.success) {
      const error = result.error || `R2 upload failed (HTTP ${res.status})`;
      console.warn("[R2] Upload failed:", error);
      return { success: false, error };
    }
    console.log("[R2] Upload successful:", result.url);
    return result;
  } catch (err) {
    const error =
      err instanceof Error
        ? err.message
        : "R2 upload failed (is Vite / Electron running?)";
    console.error("[R2] Upload error:", err);
    return { success: false, error };
  }
}

function ipcBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/**
 * Upload a video/binary without routing it through a giant data URL.
 * Used for highlight clips (blob: URLs → bytes → R2).
 */
export async function uploadBytesToR2(
  bytes: Uint8Array,
  contentType: string,
  folder: string = "nostalgia-photobooth",
  publicId?: string,
): Promise<CloudUploadResult> {
  const type = contentType || "application/octet-stream";
  console.log("[R2] Starting bytes upload...", {
    folder,
    publicId,
    bytes: bytes.byteLength,
    type,
  });

  if (window.electronAPI?.uploadToR2Bytes) {
    const result = await window.electronAPI.uploadToR2Bytes({
      bytes: ipcBytes(bytes),
      contentType: type,
      folder,
      publicId,
    });
    if (result.success) {
      console.log("[R2] Bytes upload successful:", result.url);
    } else {
      console.warn("[R2] Bytes upload failed:", result.error);
    }
    return result;
  }

  try {
    return await uploadToR2(
      `data:${type};base64,${uint8ToBase64(bytes)}`,
      folder,
      publicId,
    );
  } catch (err) {
    const error =
      err instanceof Error ? err.message : "R2 bytes upload failed";
    console.error("[R2] Bytes upload error:", err);
    return { success: false, error };
  }
}
