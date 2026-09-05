<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import type { MediaUploadStatus } from "@/stores/photobooth";
import { useDashboardStore } from "@/stores/dashboard";
import QRCode from "qrcode";
import {
  isBrowserOffline,
  jobForSession,
  onUploadQueueChange,
  pendingUploadCount,
  retryPendingUploads,
  retrySessionUpload,
} from "@/services/uploadQueue";

interface GalleryPhoto {
  id: string;
  src: string;
  name: string;
  timestamp: Date;
  path?: string;
  isLocal?: boolean;
  // Session metadata (present for "session"-view photos that came
  // from recent strips). Needed to rebuild the templated print for
  // a real reprint. "saved"-view raw files won't have these.
  sessionId?: string;
  templateId?: string;
  sessionIndex?: number;
  /** True for the finished templated print (frame applied), shown
   *  alongside the individual captures. */
  isComposite?: boolean;
  /** Unfiltered local copy — admin gallery only, never uploaded. */
  isOriginal?: boolean;
  /**
   * The public gallery link this session's QR encodes. It was already
   * stamped onto every recent-strip entry by PrintingView but discarded
   * when mapping into the view, so staff had no way to re-show a QR the
   * guest missed.
   */
  shareUrl?: string;
  uploadStatus?: MediaUploadStatus;
}

const router = useRouter();
const store = usePhotoboothStore();
const dashboardStore = useDashboardStore();
const savedPhotos = ref<GalleryPhoto[]>([]);
const isLoading = ref(false);
const selectedPhoto = ref<GalleryPhoto | null>(null);
const viewMode = ref<"session" | "saved">("session");
/** When set, checkboxes are shown and user can select photos for reprint or delete */
const selectionMode = ref<"reprint" | "delete" | null>(null);
const selectedIds = ref<Set<string>>(new Set());
/** Confirmation modal: 'reprint' | 'delete' | null */
const confirmAction = ref<"reprint" | "delete" | null>(null);
/** Number of reprint copies to make (when confirmAction === 'reprint') */
const reprintCount = ref(1);

const isElectron = computed(() => !!window.electronAPI);
const selectedCount = computed(() => selectedIds.value.size);
const hasSelection = computed(() => selectedCount.value > 0);
const allSelected = computed(
  () =>
    displayPhotos.value.length > 0 &&
    selectedIds.value.size === displayPhotos.value.length,
);

function looksLikeOriginalFile(nameOrPath?: string): boolean {
  return /-original\.(jpe?g|png)$/i.test(nameOrPath || "");
}

const displayPhotos = computed(() => {
  if (viewMode.value === "session") {
    return store.recentStrips
      .map((p) => ({
        id: p.id,
        src: p.dataUrl,
        name: p.isComposite
          ? "Printed strip"
          : p.isOriginal
            ? `Original photo ${(p.sessionIndex ?? 0) + 1}`
            : `Photo ${(p.sessionIndex ?? 0) + 1}`,
        timestamp: p.timestamp,
        path: p.path,
        isLocal: true,
        sessionId: p.sessionId,
        templateId: p.templateId,
        sessionIndex: p.sessionIndex,
        isComposite: p.isComposite,
        isOriginal: p.isOriginal,
        // Same resolution order QRScanView uses. The composite "Printed
        // strip" entry carries shareableUrl but no per-capture
        // cloudinaryUrl, so both fallbacks are needed.
        shareUrl:
          p.shareableUrl || p.cloudinaryUrl || p.cloudinaryPhotos?.[0]?.url || "",
        uploadStatus: p.isOriginal ? undefined : p.uploadStatus,
      }))
      .slice()
      .sort((a, b) => {
        if (a.isComposite !== b.isComposite) return a.isComposite ? 1 : -1;
        const ai = a.sessionIndex ?? 0;
        const bi = b.sessionIndex ?? 0;
        if (ai !== bi) return ai - bi;
        if (a.isOriginal !== b.isOriginal) return a.isOriginal ? 1 : -1;
        return 0;
      });
  }
  return savedPhotos.value.map((p) => ({
    ...p,
    isOriginal: p.isOriginal || looksLikeOriginalFile(p.name) || looksLikeOriginalFile(p.path),
  }));
});

async function loadSavedPhotos() {
  if (!window.electronAPI) return;

  isLoading.value = true;
  try {
    const photos = await window.electronAPI.listSavedPhotos();

    // Load each photo's data
    savedPhotos.value = await Promise.all(
      photos.map(async (photo) => {
        const src = await window.electronAPI!.readPhoto(photo.path);
        const folder = sessionFolderOf(photo.path);
        const sib = store.recentStrips.find(
          (s) =>
            !!s.shareableUrl &&
            (s.path === photo.path || sessionFolderOf(s.path) === folder),
        );
        return {
          id: photo.path,
          src: src || "",
          name: looksLikeOriginalFile(photo.name)
            ? photo.name.replace(/.*\//, "").replace(/-original/i, " (original)")
            : photo.name,
          timestamp: new Date(photo.created),
          path: photo.path,
          isLocal: false,
          isOriginal: looksLikeOriginalFile(photo.name) || looksLikeOriginalFile(photo.path),
          shareUrl: sib?.shareableUrl || "",
        };
      }),
    );
  } catch (err) {
    console.error("Failed to load photos:", err);
  } finally {
    isLoading.value = false;
  }
}

function openPhoto(photo: GalleryPhoto) {
  if (selectionMode.value) return;
  selectedPhoto.value = photo;
}

function closePhoto() {
  selectedPhoto.value = null;
}

// ── Re-show a session's QR ─────────────────────────────────────────
// For when the guest missed it on the QR screen, or the upload finished
// after they walked away. qrcode is already a dependency (used by
// QRScanView), so nothing new is installed.
const qrPhoto = ref<GalleryPhoto | null>(null);
const qrDataUrl = ref("");
const qrBusy = ref(false);

function sessionFolderOf(filePath?: string): string {
  if (!filePath) return "";
  return filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "").toLowerCase();
}

function resolveShareUrl(photo: GalleryPhoto): string {
  if (photo.shareUrl) return photo.shareUrl;
  const strips = store.recentStrips;
  if (photo.sessionId) {
    const sib = strips.find((s) => s.sessionId === photo.sessionId && s.shareableUrl);
    if (sib?.shareableUrl) return sib.shareableUrl;
  }
  const folder = sessionFolderOf(photo.path);
  if (folder) {
    const sib = strips.find(
      (s) => s.shareableUrl && sessionFolderOf(s.path) === folder,
    );
    if (sib?.shareableUrl) return sib.shareableUrl;
  }
  return "";
}

async function encodeQr(url: string): Promise<string> {
  const colors = { dark: "#3d2b1f", light: "#f5f0e1" };
  try {
    return await QRCode.toDataURL(url, {
      width: 600,
      margin: 2,
      color: colors,
      errorCorrectionLevel: "M",
    });
  } catch {
    return await QRCode.toDataURL(url, {
      width: 600,
      margin: 2,
      color: colors,
      errorCorrectionLevel: "L",
    });
  }
}

async function showQr(photo: GalleryPhoto) {
  qrPhoto.value = photo;
  qrDataUrl.value = "";
  const url = resolveShareUrl(photo);
  if (url && !photo.shareUrl) photo.shareUrl = url;
  if (!url) return;
  qrBusy.value = true;
  try {
    qrDataUrl.value = await encodeQr(url);
  } catch (err) {
    console.error("[Gallery] Failed to build QR:", err);
  } finally {
    qrBusy.value = false;
  }
}

function closeQr() {
  qrPhoto.value = null;
  qrDataUrl.value = "";
}

function startSelectionMode(mode: "reprint" | "delete") {
  selectionMode.value = mode;
  selectedIds.value = new Set();
}

function cancelSelectionMode() {
  selectionMode.value = null;
  selectedIds.value = new Set();
}

function toggleSelected(photo: GalleryPhoto, e?: Event) {
  if (!selectionMode.value) return;
  e?.preventDefault();
  e?.stopPropagation();
  const next = new Set(selectedIds.value);
  if (next.has(photo.id)) next.delete(photo.id);
  else next.add(photo.id);
  selectedIds.value = next;
}

function isSelected(photo: GalleryPhoto) {
  return selectedIds.value.has(photo.id);
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(displayPhotos.value.map((p) => p.id));
  }
}

function openConfirmModal(action: "reprint" | "delete") {
  if (!hasSelection.value) return;
  confirmAction.value = action;
  if (action === "reprint") reprintCount.value = 1;
}

function openReprintForPhoto(photo: GalleryPhoto, e?: Event) {
  e?.stopPropagation();
  selectedIds.value = new Set([photo.id]);
  reprintCount.value = 1;
  confirmAction.value = "reprint";
  closePhoto();
}

function openDeleteForPhoto(photo: GalleryPhoto, e?: Event) {
  e?.stopPropagation();
  selectedIds.value = new Set([photo.id]);
  confirmAction.value = "delete";
  closePhoto();
}

function closeConfirmModal() {
  confirmAction.value = null;
}

function incrementReprintCount() {
  reprintCount.value = Math.min(99, reprintCount.value + 1);
}

function decrementReprintCount() {
  reprintCount.value = Math.max(1, reprintCount.value - 1);
}

function getSelectedPhotos(): GalleryPhoto[] {
  return displayPhotos.value.filter((p) => selectedIds.value.has(p.id));
}

async function confirmReprint() {
  const photos = getSelectedPhotos();
  const count = reprintCount.value;

  // A real reprint rebuilds the templated print sheet from the
  // ORIGINAL session captures and sends it to the printer — it must
  // match a fresh print exactly. That requires the session metadata
  // (sessionId + templateId) carried on recent strips, so reprint
  // works from the "Session" view. Raw "Saved"-tab files don't have
  // the template they were shot with, so they can't be re-framed.
  const seed = photos.find((p) => p.sessionId && p.templateId);
  if (!seed) {
    alert(
      photos.length === 0
        ? "Select a photo to reprint first."
        : "These photos have no session info, so the original template can't be rebuilt. Reprint from the Session tab instead.",
    );
    return;
  }

  // Gather every capture from that session, ordered by the index
  // they were taken in, so the rebuilt sheet matches the original.
  // Skip the composite "printed strip" entry — reprint re-renders the
  // sheet from the raw captures, so feeding the composite back in would
  // wrongly treat it as an extra photo.
  const sessionStrips = store.recentStrips
    .filter((s) => s.sessionId === seed.sessionId && !s.isComposite && !s.isOriginal)
    .slice()
    .sort((a, b) => (a.sessionIndex ?? 0) - (b.sessionIndex ?? 0));

  // Prefer the FULL-RESOLUTION capture from disk: recent-strip entries
  // persist only a downscaled preview (localStorage quota), while the
  // original PNG lives at `path`. Fall back to the stored preview if
  // the file is gone — a soft reprint beats a failed one.
  const captures: { id: string; dataUrl: string }[] = [];
  for (const s of sessionStrips) {
    let dataUrl = s.dataUrl;
    if (s.path && window.electronAPI) {
      try {
        const printCrop = s.path.replace(
          /photo-(\d+)\.jpg$/i,
          "photo-$1-print.jpg",
        );
        const full =
          (printCrop !== s.path
            ? await window.electronAPI.readPhoto(printCrop)
            : null) || (await window.electronAPI.readPhoto(s.path));
        if (full) dataUrl = full;
      } catch {
        /* fall back to the stored preview */
      }
    }
    if (dataUrl) captures.push({ id: s.id, dataUrl });
  }

  const ok = store.loadSessionForReprint(
    captures,
    seed.templateId,
    count,
  );
  if (!ok) {
    alert(
      "Couldn't rebuild this reprint — the template may have been removed.",
    );
    return;
  }

  // Record the sale up-front (same accounting as before). Quantity is
  // copies × 1 strip; price falls back to the per-template price then
  // the global reprint price.
  const price =
    seed.templateId != null &&
    dashboardStore.priceByTemplateId[seed.templateId] !== undefined
      ? dashboardStore.priceByTemplateId[seed.templateId]
      : dashboardStore.reprintPricePerUnit;
  dashboardStore.recordReprintSale(count, price);

  closeConfirmModal();
  cancelSelectionMode();

  // Hand off to the existing print pipeline. PrintingView sees
  // store.reprintMode in onMounted, rebuilds + prints `count` copies
  // with NO save/upload/recent-strip/QR side-effects, then returns
  // here to /admin.
  router.push("/printing");
}

async function confirmDelete() {
  const photos = getSelectedPhotos();
  for (const photo of photos) {
    if (photo.isLocal) {
      store.removeRecentStrip(photo.id);
    } else if (window.electronAPI && photo.path) {
      const result = await window.electronAPI.deletePhoto(photo.path);
      if (result.success) {
        savedPhotos.value = savedPhotos.value.filter((p) => p.id !== photo.id);
      }
    }
    if (selectedPhoto.value?.id === photo.id) closePhoto();
  }
  closeConfirmModal();
  cancelSelectionMode();
}

async function downloadPhoto(photo: GalleryPhoto) {
  // Session-tab entries hold only a downscaled JPEG preview (the
  // localStorage budget) — the original full-res PNG lives on disk at
  // `path`. Re-read it for the download when possible; fall back to
  // the preview if the file is gone.
  let href = photo.src;
  if (photo.path && window.electronAPI) {
    try {
      const full = await window.electronAPI.readPhoto(photo.path);
      if (full) href = full;
    } catch {
      /* preview fallback */
    }
  }
  const ext = href.startsWith("data:image/jpeg") ? "jpg" : "png";
  const base = photo.name || `photobooth_${Date.now()}`;
  const link = document.createElement("a");
  link.href = href;
  link.download = /\.(png|jpe?g)$/i.test(base) ? base : `${base}.${ext}`;
  link.click();
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const retryBusy = ref(false);
const retryNotice = ref("");
const NO_CONNECTION_MSG = "No internet connection.";
const queuePending = ref(pendingUploadCount());
let stopQueueWatch: (() => void) | null = null;

function sessionUploadStatus(photo: GalleryPhoto): MediaUploadStatus | "" {
  if (photo.isOriginal) return "";
  if (resolveShareUrl(photo)) return "done";
  const job = jobForSession(photo.sessionId);
  return photo.uploadStatus || job?.status || "";
}

function sessionNeedsRetry(photo: GalleryPhoto): boolean {
  if (photo.isOriginal) return false;
  if (!photo.sessionId) return false;
  if (resolveShareUrl(photo)) return false;
  return true;
}

const canRetryUploads = computed(
  () =>
    queuePending.value > 0 ||
    store.recentStrips.some(
      (s) => s.uploadStatus === "pending" || s.uploadStatus === "failed",
    ),
);

async function retryUploads(sessionId?: string) {
  if (retryBusy.value) return;
  retryNotice.value = "";
  if (isBrowserOffline()) {
    retryNotice.value = NO_CONNECTION_MSG;
    return;
  }
  retryBusy.value = true;
  try {
    if (sessionId) {
      const result = await retrySessionUpload(sessionId);
      if (result.noConnection) {
        retryNotice.value = NO_CONNECTION_MSG;
      } else if (!result.ok) {
        console.warn("[Gallery] Retry upload failed for", sessionId);
      } else if (qrPhoto.value?.sessionId === sessionId) {
        const url = resolveShareUrl(qrPhoto.value);
        if (url) {
          qrPhoto.value.shareUrl = url;
          qrDataUrl.value = await encodeQr(url);
        }
      }
    } else {
      const result = await retryPendingUploads();
      if (result.noConnection) {
        retryNotice.value = NO_CONNECTION_MSG;
      }
    }
    queuePending.value = pendingUploadCount();
  } finally {
    retryBusy.value = false;
  }
}

function clearRetryNoticeOnOnline() {
  retryNotice.value = "";
}

onMounted(() => {
  stopQueueWatch = onUploadQueueChange(() => {
    queuePending.value = pendingUploadCount();
  });
  window.addEventListener("online", clearRetryNoticeOnOnline);
  if (isElectron.value) {
    loadSavedPhotos();
  }
});

onUnmounted(() => {
  window.removeEventListener("online", clearRetryNoticeOnOnline);
  stopQueueWatch?.();
  stopQueueWatch = null;
});
</script>

<template>
  <div class="gallery-view">
    <div class="gallery-header">
      <div class="gallery-header-left">
        <div class="view-toggle" v-if="isElectron">
          <button
            class="toggle-btn"
            :class="{ active: viewMode === 'session' }"
            @click="viewMode = 'session'"
          >
            Session ({{ store.recentStrips.length }})
          </button>
          <button
            class="toggle-btn"
            :class="{ active: viewMode === 'saved' }"
            @click="
              viewMode = 'saved';
              loadSavedPhotos();
            "
          >
            Saved ({{ savedPhotos.length }})
          </button>
        </div>
      </div>
      <div class="gallery-header-right" v-if="displayPhotos.length > 0 || canRetryUploads">
        <template v-if="!selectionMode">
          <button
            type="button"
            class="btn btn-reprint"
            :disabled="retryBusy || !canRetryUploads"
            @click="retryUploads()"
          >
            {{ retryBusy ? "Uploading…" : "Retry Upload" }}
          </button>
          <button
            v-if="displayPhotos.length > 0"
            type="button"
            class="btn btn-reprint"
            @click="startSelectionMode('reprint')"
          >
            Reprint
          </button>
          <button
            v-if="displayPhotos.length > 0"
            type="button"
            class="btn btn-danger"
            @click="startSelectionMode('delete')"
          >
            Delete
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            class="btn btn-secondary"
            @click="cancelSelectionMode"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            @click="toggleSelectAll"
          >
            {{ allSelected ? "Deselect all" : "Select all" }}
          </button>
          <button
            v-if="selectionMode === 'reprint'"
            type="button"
            class="btn btn-reprint"
            :disabled="!hasSelection"
            @click="openConfirmModal('reprint')"
          >
            Reprint {{ selectedCount }} selected
          </button>
          <button
            v-else
            type="button"
            class="btn btn-danger"
            :disabled="!hasSelection"
            @click="openConfirmModal('delete')"
          >
            Delete {{ selectedCount }} selected
          </button>
        </template>
      </div>
    </div>
    <p
      v-if="retryNotice"
      class="gallery-retry-notice"
      role="status"
    >
      {{ retryNotice }}
    </p>

    <!-- Loading State -->
    <div v-if="isLoading" class="loading-state">
      <div class="spinner"></div>
      <p>Loading photos...</p>
    </div>

    <!-- Empty State -->
    <div v-else-if="displayPhotos.length === 0" class="empty-state">
      <h2>No Photos Yet</h2>
      <p v-if="viewMode === 'session'">Take some photos to see them here!</p>
      <p v-else>Photos you save will appear here.</p>
      <RouterLink to="/camera" class="btn btn-primary">
        Start Camera
      </RouterLink>
    </div>

    <!-- Photo Grid -->
    <div v-else class="photo-grid">
      <div
        v-for="photo in displayPhotos"
        :key="photo.id"
        class="photo-card"
        :class="{
          'photo-card--selected': isSelected(photo),
          'photo-card--selection-mode': selectionMode,
        }"
        @click="
          selectionMode ? toggleSelected(photo, $event) : openPhoto(photo)
        "
      >
        <input
          v-if="selectionMode"
          type="checkbox"
          class="photo-card-checkbox"
          :checked="isSelected(photo)"
          @click.stop="toggleSelected(photo, $event)"
        />
        <img :src="photo.src" :alt="photo.name" class="photo-thumb" />
        <span
          v-if="sessionUploadStatus(photo) === 'pending' || sessionUploadStatus(photo) === 'uploading'"
          class="photo-badge photo-badge--pending"
        >Pending upload</span>
        <span
          v-else-if="sessionUploadStatus(photo) === 'failed'"
          class="photo-badge photo-badge--failed"
        >Upload failed</span>
        <span v-else-if="photo.isOriginal" class="photo-badge photo-badge--original">Original</span>
        <span v-else-if="photo.isComposite" class="photo-badge">Printed</span>
        <div class="photo-overlay">
          <span class="photo-date">{{ formatDate(photo.timestamp) }}</span>
        </div>
      </div>
    </div>

    <!-- Photo Viewer Modal -->
    <div v-if="selectedPhoto" class="photo-modal" @click="closePhoto">
      <div class="modal-content" @click.stop>
        <button class="close-btn" @click="closePhoto">✕</button>

        <img
          :src="selectedPhoto.src"
          :alt="selectedPhoto.name"
          class="modal-image"
        />

        <div class="modal-info">
          <p class="modal-date">{{ formatDate(selectedPhoto.timestamp) }}</p>
          <p v-if="selectedPhoto.isOriginal" class="modal-original-note">
            Unfiltered original — saved locally, not uploaded.
          </p>
          <p v-if="selectedPhoto.path" class="modal-path">
            {{ selectedPhoto.path }}
          </p>
        </div>

        <p
          v-if="retryNotice"
          class="gallery-retry-notice gallery-retry-notice--modal"
          role="status"
        >
          {{ retryNotice }}
        </p>
        <div class="modal-actions">
          <button
            v-if="!selectedPhoto.isOriginal"
            type="button"
            class="btn btn-reprint"
            @click="openReprintForPhoto(selectedPhoto)"
          >
            Reprint
          </button>
          <!-- Re-show the digital-copies QR. Tap-reachable rather than
               hover-only, since this runs on a touchscreen. -->
          <button
            v-if="!selectedPhoto.isOriginal"
            type="button"
            class="btn btn-secondary"
            @click="showQr(selectedPhoto)"
          >
            Show QR
          </button>
          <button
            v-if="sessionNeedsRetry(selectedPhoto)"
            type="button"
            class="btn btn-reprint"
            :disabled="retryBusy"
            @click="retryUploads(selectedPhoto.sessionId)"
          >
            {{ retryBusy ? "Uploading…" : "Retry Upload" }}
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            @click="downloadPhoto(selectedPhoto)"
          >
            Download
          </button>
          <button
            type="button"
            class="btn btn-danger"
            @click="openDeleteForPhoto(selectedPhoto)"
          >
            Delete
          </button>
        </div>
      </div>
    </div>

    <!-- Digital-copies QR for a past session -->
    <div v-if="qrPhoto" class="photo-modal confirm-modal" @click="closeQr">
      <div class="modal-content confirm-content" @click.stop>
        <h2 class="confirm-title">Digital copies</h2>
        <template v-if="qrDataUrl">
          <img :src="qrDataUrl" alt="QR code for the digital copies" class="gallery-qr" />
          <p class="gallery-qr-hint">Scan to open this session's photos.</p>
          <p class="gallery-qr-url">{{ qrPhoto.shareUrl }}</p>
        </template>
        <p v-else-if="qrBusy" class="gallery-qr-hint">Building QR…</p>
        <p v-else class="gallery-qr-hint">
          No online link for this session — the upload is pending or didn't
          complete (the booth may have been offline). Photos are still here:
          tap Retry Upload, or use Download / Reprint.
        </p>
        <p
          v-if="retryNotice"
          class="gallery-retry-notice gallery-retry-notice--modal"
          role="status"
        >
          {{ retryNotice }}
        </p>
        <div class="modal-actions">
          <button
            v-if="qrPhoto && sessionNeedsRetry(qrPhoto)"
            type="button"
            class="btn btn-reprint"
            :disabled="retryBusy"
            @click="retryUploads(qrPhoto.sessionId)"
          >
            {{ retryBusy ? "Uploading…" : "Retry Upload" }}
          </button>
          <button type="button" class="btn btn-secondary" @click="closeQr">Close</button>
        </div>
      </div>
    </div>

    <!-- Confirmation Modal (Reprint / Delete) -->
    <div
      v-if="confirmAction"
      class="photo-modal confirm-modal"
      @click="closeConfirmModal"
    >
      <div class="modal-content confirm-content" @click.stop>
        <h2 class="confirm-title">
          {{
            confirmAction === "reprint" ? "Reprint photos?" : "Delete photos?"
          }}
        </h2>
        <p class="confirm-message">
          <template v-if="confirmAction === 'reprint'">
            Reprint {{ selectedCount }} photo(s). How many copies of each?
          </template>
          <template v-else>
            Permanently delete {{ selectedCount }} photo(s)? This cannot be
            undone.
          </template>
        </p>
        <div v-if="confirmAction === 'reprint'" class="confirm-reprint-stepper">
          <span class="confirm-reprint-label">Number of reprints</span>
          <div class="confirm-reprint-controls">
            <button
              type="button"
              class="stepper-btn"
              aria-label="Decrease"
              @click="decrementReprintCount"
            >
              −
            </button>
            <span class="stepper-value">{{ reprintCount }}</span>
            <button
              type="button"
              class="stepper-btn"
              aria-label="Increase"
              @click="incrementReprintCount"
            >
              +
            </button>
          </div>
        </div>
        <div class="confirm-actions">
          <button
            type="button"
            class="btn btn-secondary"
            @click="closeConfirmModal"
          >
            Cancel
          </button>
          <button
            v-if="confirmAction === 'reprint'"
            type="button"
            class="btn btn-reprint"
            @click="confirmReprint"
          >
            Reprint
          </button>
          <button
            v-else
            type="button"
            class="btn btn-danger"
            @click="confirmDelete"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gallery-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
  padding: 1.5rem;
  overflow-y: auto;
}

.gallery-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 1rem;
  width: 100%;
}

.gallery-header-left {
  display: flex;
  align-items: center;
}

.gallery-header-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.gallery-retry-notice {
  margin: 0 0 1rem;
  color: #8a2b2b;
  font-size: 0.95rem;
  font-weight: 600;
}

.gallery-retry-notice--modal {
  text-align: center;
  margin: 0 0 0.75rem;
}

.gallery-header h1 {
  font-family: var(--font-display);
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0;
}

.view-toggle {
  display: flex;
  background: var(--color-cream-dark);
  border: 2px solid var(--color-brown-light);
  border-radius: 10px;
  padding: 4px;
}

.toggle-btn {
  padding: 0.5rem 1rem;
  border: none;
  background: transparent;
  color: var(--color-brown);
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.2s ease;
  font-size: 0.95rem;
  font-family: var(--font-display);
  font-weight: 600;
}

.toggle-btn:hover {
  color: var(--color-brown-dark);
}

.toggle-btn.active {
  background: var(--color-brown-dark);
  color: var(--color-cream);
}

/* Loading State */
.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-brown-light);
  font-family: var(--font-body);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--color-cream-dark);
  border-top-color: var(--color-brown-dark);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Empty State */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--color-brown-light);
  font-family: var(--font-body);
}

.empty-state h2 {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin-bottom: 0.5rem;
}

.empty-state p {
  margin-bottom: 1.5rem;
}

/* Photo Grid */
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
}

.photo-card {
  position: relative;
  aspect-ratio: 4/3;
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  border: 3px solid transparent;
  transition: all 0.2s ease;
}

.photo-card:hover {
  transform: scale(1.02);
  box-shadow: var(--shadow-medium);
}

.photo-card--selection-mode {
  cursor: default;
}

.photo-card--selection-mode:hover {
  transform: none;
}

.photo-card--selected {
  border-color: var(--color-brown-dark);
  box-shadow:
    0 0 0 2px var(--color-cream),
    var(--shadow-medium);
}

.photo-card-checkbox {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  z-index: 2;
  width: 1.25rem;
  height: 1.25rem;
  margin: 0;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  border: 2px solid var(--color-brown-dark);
  border-radius: 4px;
  background: var(--color-cream);
  flex-shrink: 0;
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.photo-card-checkbox:hover {
  border-color: var(--color-brown);
  background: var(--color-cream-dark);
}

.photo-card-checkbox:checked {
  background: var(--color-brown-dark);
  border-color: var(--color-brown-dark);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fbf2de' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
  background-size: 14px 14px;
  background-position: center;
  background-repeat: no-repeat;
}

.photo-thumb {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
}

.photo-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0.75rem 1rem;
  background: linear-gradient(to top, rgba(61, 43, 31, 0.85), transparent);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.photo-card:hover .photo-overlay {
  opacity: 1;
}

.photo-date {
  color: var(--color-cream);
  font-size: 0.8rem;
  font-family: var(--font-body);
}

/* "Printed" badge on the templated-composite card */
.photo-badge {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 2;
  padding: 0.2rem 0.6rem;
  background: var(--color-brown-dark);
  color: var(--color-cream);
  font-family: var(--font-display);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  border-radius: 999px;
  box-shadow: var(--shadow-soft);
  pointer-events: none;
}

.photo-badge--pending {
  background: #c9a227;
  color: var(--color-brown-dark);
}

.photo-badge--failed {
  background: #8a3a2a;
  color: var(--color-cream);
}

.photo-badge--original {
  background: var(--color-cream);
  color: var(--color-brown-dark);
  border: 1px solid var(--color-brown-light);
}

/* Modal */
.photo-modal {
  position: fixed;
  inset: 0;
  background: rgba(61, 43, 31, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 2rem;
}

.modal-content {
  position: relative;
  background: var(--color-cream);
  border: 3px solid var(--color-brown-dark);
  border-radius: 16px;
  padding: 1.5rem;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  box-shadow: var(--shadow-hard);
}

.close-btn {
  position: absolute;
  top: 0.75rem;
  right: 1rem;
  width: 36px;
  height: 36px;
  border: none;
  background: var(--color-cream-dark);
  color: var(--color-brown-dark);
  font-size: 1.5rem;
  line-height: 1;
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: var(--color-brown-light);
  color: var(--color-cream);
}

.modal-image {
  display: block;
  max-width: 100%;
  max-height: 70vh;
  width: auto;
  height: auto;
  object-fit: contain;
  object-position: center;
  border-radius: 10px;
  border: 2px solid var(--color-brown-light);
  box-shadow: var(--shadow-soft);
}

.modal-info {
  margin-top: 1rem;
  text-align: center;
  color: var(--color-brown-light);
  font-family: var(--font-body);
}

.modal-date {
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  font-family: var(--font-display);
}

.modal-original-note {
  margin: 0.35rem 0 0;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--color-brown);
}

.modal-path {
  font-size: 0.8rem;
  opacity: 0.8;
  word-break: break-all;
}

.modal-actions {
  display: flex;
  gap: 1rem;
  margin-top: 1.5rem;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 10px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
  font-family: var(--font-display);
}

.btn-primary {
  background: linear-gradient(180deg, #e8c872 0%, #c9a227 50%, #a68520 100%);
  color: var(--color-brown-dark);
  border: 3px solid var(--color-brown);
  box-shadow:
    0 4px 0 var(--color-brown),
    var(--shadow-soft);
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow:
    0 5px 0 var(--color-brown),
    var(--shadow-medium);
}

.btn-primary:active {
  transform: translateY(2px);
  box-shadow:
    0 2px 0 var(--color-brown),
    var(--shadow-soft);
}

.btn-reprint {
  background: linear-gradient(180deg, #e8c872 0%, #c9a227 50%, #a68520 100%);
  color: var(--color-brown-dark);
  border: 3px solid var(--color-brown);
  box-shadow:
    0 4px 0 var(--color-brown),
    var(--shadow-soft);
}

.btn-reprint:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    0 5px 0 var(--color-brown),
    var(--shadow-medium);
}

.btn-reprint:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow:
    0 2px 0 var(--color-brown),
    var(--shadow-soft);
}

.btn-reprint:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background: linear-gradient(
    180deg,
    var(--color-cream) 0%,
    var(--color-cream-dark) 100%
  );
  color: var(--color-brown-dark);
  border: 2px solid var(--color-brown-light);
}

.btn-secondary:hover {
  border-color: var(--color-brown);
  color: var(--color-brown-dark);
}

.btn-danger {
  background: var(--color-cream);
  color: var(--color-brown-dark);
  border: 2px solid var(--color-brown-light);
}

.btn-danger:hover {
  background: var(--color-cream-dark);
  border-color: var(--color-brown);
  color: var(--color-brown-dark);
}

/* Confirmation modal */
.confirm-modal {
  align-items: center;
  justify-content: center;
}

.confirm-content {
  max-width: 420px;
}

.confirm-title {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0 0 1rem 0;
}

/* Digital-copies QR modal */
.gallery-qr {
  display: block;
  width: 260px;
  height: 260px;
  margin: 0 auto 0.75rem;
  border-radius: 8px;
}

.gallery-qr-hint {
  margin: 0 0 0.5rem;
  color: var(--color-brown);
  font-size: 0.95rem;
  text-align: center;
  max-width: 34ch;
}

.gallery-qr-url {
  margin: 0 0 1rem;
  font-size: 0.78rem;
  color: var(--color-brown-light);
  text-align: center;
  word-break: break-all;
  max-width: 40ch;
}

.confirm-message {
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--color-brown);
  margin: 0 0 1.5rem 0;
  line-height: 1.5;
}

.confirm-reprint-stepper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.confirm-reprint-label {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

.confirm-reprint-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.confirm-reprint-stepper .stepper-btn {
  width: 44px;
  height: 44px;
  border: 2px solid var(--color-brown-dark);
  background: var(--color-cream);
  color: var(--color-brown-dark);
  font-size: 1.5rem;
  line-height: 1;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.confirm-reprint-stepper .stepper-btn:hover {
  background: var(--color-brown-dark);
  color: var(--color-cream);
}

.confirm-reprint-stepper .stepper-value {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  min-width: 2.5rem;
  text-align: center;
  color: var(--color-brown-dark);
}

.confirm-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}
</style>
