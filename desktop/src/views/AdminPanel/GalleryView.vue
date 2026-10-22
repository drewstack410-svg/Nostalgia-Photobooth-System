<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import type { MediaUploadStatus } from "@/stores/photobooth";
import { useDashboardStore } from "@/stores/dashboard";
import { useGalleryEventsStore } from "@/stores/galleryEvents";
import AdminFormModal from "@/components/AdminFormModal.vue";
import QRCode from "qrcode";
import { makePreviewDataUrl } from "@/utils/imagePreview";
import { printCropSiblingPath } from "@/utils/gallerySession";
import {
  cropBarPercentForTemplate,
  cropDataUrlToHighlightedView,
} from "@/utils/viewfinderCrop";
import {
  jobForSession,
  onUploadQueueChange,
  pendingUploadCount,
  retryPendingUploads,
  retrySessionUpload,
  type CloudReadyReason,
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

/** One card in the browse grid — cover thumb + all shots in the session. */
interface GallerySessionCard {
  key: string;
  label: string;
  timestamp: Date;
  photos: GalleryPhoto[];
  thumb: GalleryPhoto;
  count: number;
}

const router = useRouter();
const store = usePhotoboothStore();
const dashboardStore = useDashboardStore();
const eventsStore = useGalleryEventsStore();
const savedPhotos = ref<GalleryPhoto[]>([]);
/** Disk session files that never made it into localStorage (quota / R2 retry). */
const diskSessionPhotos = ref<GalleryPhoto[]>([]);
const localPreviewByPath = ref<Record<string, string>>({});
const isLoading = ref(false);
const selectedPhoto = ref<GalleryPhoto | null>(null);
/** Browse mode: open session dialog (photos listed inside). */
const selectedSession = ref<GallerySessionCard | null>(null);
const viewMode = ref<"session" | "saved">("session");
/** When set, checkboxes are shown and user can select photos for reprint or delete */
const selectionMode = ref<"reprint" | "delete" | "add-to-event" | "remove-from-event" | null>(null);
const selectedIds = ref<Set<string>>(new Set());
/** Confirmation modal: 'reprint' | 'delete' | null */
const confirmAction = ref<"reprint" | "delete" | null>(null);
/** Number of reprint copies to make (when confirmAction === 'reprint') */
const reprintCount = ref(1);

const showEventForm = ref(false);
const editingEventId = ref<string | null>(null);
const eventFormName = ref("");
const eventFormDate = ref("");
const eventFormDescription = ref("");
const eventFormError = ref("");
const confirmDeleteEvent = ref(false);

const isElectron = computed(() => !!window.electronAPI);
const selectedCount = computed(() => selectedIds.value.size);
const hasSelection = computed(() => selectedCount.value > 0);

function looksLikeOriginalFile(nameOrPath?: string): boolean {
  return /-original\.(jpe?g|png)$/i.test(nameOrPath || "");
}

function normalizePath(filePath?: string): string {
  return (filePath || "").replace(/\\/g, "/").toLowerCase();
}

function fileNameOf(filePath?: string): string {
  return normalizePath(filePath).split("/").pop() || "";
}

function isSessionDiskFile(filePath?: string): boolean {
  return /\/session \d+\//i.test(normalizePath(filePath));
}

function isPrintCropName(name: string): boolean {
  return /photo-\d+-print\.(jpe?g|png)$/i.test(name);
}

function sessionIndexFromName(name: string): number {
  const m = name.match(/photo-(\d+)/i);
  return m ? Number(m[1]) - 1 : 0;
}

function sortSessionPhotos(a: GalleryPhoto, b: GalleryPhoto): number {
  const at = new Date(a.timestamp).getTime();
  const bt = new Date(b.timestamp).getTime();
  if (at !== bt) return bt - at;
  if (a.isComposite !== b.isComposite) return a.isComposite ? 1 : -1;
  const ai = a.sessionIndex ?? 0;
  const bi = b.sessionIndex ?? 0;
  if (ai !== bi) return ai - bi;
  if (a.isOriginal !== b.isOriginal) return a.isOriginal ? 1 : -1;
  return 0;
}

function localDateKey(date: Date | string | undefined): string {
  const d = date instanceof Date ? date : date ? new Date(date) : new Date(NaN);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDateKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(y, m - 1, d),
  );
}

function sessionNumberFromPath(filePath?: string): number | null {
  const m = sessionFolderOf(filePath).match(/\/session (\d+)$/i);
  return m ? Number(m[1]) : null;
}

function photoSessionKey(photo: GalleryPhoto): string {
  const folder = sessionFolderOf(photo.path);
  const folderMatch = folder.match(
    /((?:events\/[^/]+\/)?\d{2}-\d{2}-\d{2}\/session \d+)$/i,
  );
  if (folderMatch) return `folder:${folderMatch[1].toLowerCase()}`;
  if (photo.sessionId) return `id:${photo.sessionId}`;
  return `item:${photo.id}`;
}

function photoSessionLabel(photo: GalleryPhoto, includeDate: boolean): string {
  const n = sessionNumberFromPath(photo.path);
  const sessionPart = n != null ? `Session ${n}` : photo.sessionId ? "Session" : "Other";
  if (!includeDate) return sessionPart;
  const date = formatDateKey(localDateKey(photo.timestamp));
  return `${date} · ${sessionPart}`;
}

const filterDate = ref("");
const filterSession = ref("");

const allPhotos = computed(() => {
  if (viewMode.value === "session") {
    const used = new Set<string>();
    const fromStrips: GalleryPhoto[] = store.recentStrips.map((p) => {
      const key = normalizePath(p.path);
      if (key) used.add(key);
      return {
        id: p.id,
        src: p.dataUrl || (key ? localPreviewByPath.value[key] : "") || "",
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
        shareUrl:
          p.shareableUrl || p.cloudinaryUrl || p.cloudinaryPhotos?.[0]?.url || "",
        uploadStatus: p.isOriginal ? undefined : p.uploadStatus,
      };
    });
    const extras = diskSessionPhotos.value.filter((p) => {
      const key = normalizePath(p.path);
      return key && !used.has(key);
    });
    return fromStrips.concat(extras).sort(sortSessionPhotos);
  }
  return savedPhotos.value.map((p) => ({
    ...p,
    isOriginal: p.isOriginal || looksLikeOriginalFile(p.name) || looksLikeOriginalFile(p.path),
  }));
});

const dateOptions = computed(() => {
  const keys = new Set<string>();
  for (const photo of allPhotos.value) {
    const key = localDateKey(photo.timestamp);
    if (key) keys.add(key);
  }
  return [...keys].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
});

const photosForDate = computed(() => {
  if (!filterDate.value) return allPhotos.value;
  return allPhotos.value.filter((p) => localDateKey(p.timestamp) === filterDate.value);
});

const sessionOptions = computed(() => {
  const includeDate = !filterDate.value;
  const seen = new Map<string, { key: string; label: string; sort: number }>();
  for (const photo of photosForDate.value) {
    const key = photoSessionKey(photo);
    if (seen.has(key)) continue;
    const n = sessionNumberFromPath(photo.path);
    seen.set(key, {
      key,
      label: photoSessionLabel(photo, includeDate),
      sort: n ?? Number.MAX_SAFE_INTEGER,
    });
  }
  return [...seen.values()].sort((a, b) => {
    if (a.sort !== b.sort) return a.sort - b.sort;
    return a.label.localeCompare(b.label);
  });
});

const catalogPhotos = computed(() => {
  let photos = photosForDate.value;
  if (filterSession.value) {
    photos = photos.filter((p) => photoSessionKey(p) === filterSession.value);
  }
  return photos;
});

/** Event photos only — never the full catalog. */
const displayPhotos = computed(() => {
  const event = eventsStore.selectedEvent;
  if (!event) return [];
  const ids = new Set(event.photoIds);
  return catalogPhotos.value.filter((p) => ids.has(p.id));
});

/** Full gallery — only while picking existing shots to add. */
const addablePhotos = computed(() => {
  const event = eventsStore.selectedEvent;
  if (!event) return [];
  const already = new Set(event.photoIds);
  return catalogPhotos.value.filter((p) => !already.has(p.id));
});

const gridPhotos = computed(() =>
  selectionMode.value === "add-to-event" ? addablePhotos.value : displayPhotos.value,
);

function orderPhotosInSession(photos: GalleryPhoto[]): GalleryPhoto[] {
  return [...photos].sort((a, b) => {
    if (a.isComposite !== b.isComposite) return a.isComposite ? -1 : 1;
    if (a.isOriginal !== b.isOriginal) return a.isOriginal ? 1 : -1;
    const ai = a.sessionIndex ?? 0;
    const bi = b.sessionIndex ?? 0;
    if (ai !== bi) return ai - bi;
    return (
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  });
}

function pickSessionThumb(photos: GalleryPhoto[]): GalleryPhoto {
  return (
    photos.find((p) => p.isComposite && p.src) ||
    photos.find((p) => !p.isOriginal && p.src) ||
    photos.find((p) => p.src) ||
    photos[0]!
  );
}

/** Browse grid: one card per session (not every individual file). */
const gridSessions = computed((): GallerySessionCard[] => {
  const map = new Map<string, GalleryPhoto[]>();
  for (const photo of gridPhotos.value) {
    const key = photoSessionKey(photo);
    const list = map.get(key);
    if (list) list.push(photo);
    else map.set(key, [photo]);
  }
  const cards: GallerySessionCard[] = [];
  for (const [key, photos] of map) {
    const ordered = orderPhotosInSession(photos);
    const thumb = pickSessionThumb(ordered);
    cards.push({
      key,
      label: photoSessionLabel(ordered[0]!, !filterDate.value),
      timestamp: new Date(thumb.timestamp),
      photos: ordered,
      thumb,
      count: ordered.length,
    });
  }
  return cards.sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  );
});

const isAddingExisting = computed(() => selectionMode.value === "add-to-event");

function focusDefaultEvent() {
  if (eventsStore.selectedEventId) {
    if (eventsStore.events.some((e) => e.id === eventsStore.selectedEventId)) {
      return;
    }
  }
  const preferred =
    eventsStore.activeEventId &&
    eventsStore.events.some((e) => e.id === eventsStore.activeEventId)
      ? eventsStore.activeEventId
      : eventsStore.sortedEvents[0]?.id ?? null;
  eventsStore.selectEvent(preferred);
}

const allSelected = computed(
  () =>
    gridPhotos.value.length > 0 &&
    selectedIds.value.size === gridPhotos.value.length,
);

const filtersActive = computed(() => !!filterDate.value || !!filterSession.value);

function clearGalleryFilters() {
  filterDate.value = "";
  filterSession.value = "";
}

function openCreateEvent() {
  editingEventId.value = null;
  eventFormName.value = "";
  eventFormDate.value = localDateKey(new Date());
  eventFormDescription.value = "";
  eventFormError.value = "";
  showEventForm.value = true;
}

function openEditEvent() {
  const event = eventsStore.selectedEvent;
  if (!event) return;
  editingEventId.value = event.id;
  eventFormName.value = event.name;
  eventFormDate.value = event.date || "";
  eventFormDescription.value = event.description || "";
  eventFormError.value = "";
  showEventForm.value = true;
}

function closeEventForm() {
  showEventForm.value = false;
  eventFormError.value = "";
}

function saveEventForm() {
  const name = eventFormName.value.trim();
  if (!name) {
    eventFormError.value = "Name is required.";
    return;
  }
  try {
    if (editingEventId.value) {
      eventsStore.updateEvent(editingEventId.value, {
        name,
        date: eventFormDate.value,
        description: eventFormDescription.value,
      });
    } else {
      eventsStore.createEvent({
        name,
        date: eventFormDate.value,
        description: eventFormDescription.value,
      });
    }
    closeEventForm();
  } catch (e) {
    eventFormError.value =
      e instanceof Error ? e.message : "Could not save event.";
  }
}

function askDeleteEvent() {
  if (!eventsStore.selectedEvent) return;
  confirmDeleteEvent.value = true;
}

function confirmDeleteEventAction() {
  const id = eventsStore.selectedEventId;
  if (id) eventsStore.deleteEvent(id);
  confirmDeleteEvent.value = false;
  cancelSelectionMode();
  focusDefaultEvent();
}

function startAddToEvent() {
  if (!eventsStore.selectedEvent) return;
  selectedIds.value = new Set();
  selectionMode.value = "add-to-event";
  selectedPhoto.value = null;
  selectedSession.value = null;
  if (viewMode.value === "saved" && !savedPhotos.value.length) {
    void loadSavedPhotos();
  }
}

function startRemoveFromEvent() {
  if (!eventsStore.selectedEvent) return;
  selectedIds.value = new Set();
  selectionMode.value = "remove-from-event";
  selectedPhoto.value = null;
  selectedSession.value = null;
}

function applyAddToEvent() {
  const event = eventsStore.selectedEvent;
  if (!event || !selectedIds.value.size) return;
  eventsStore.addPhotos(event.id, [...selectedIds.value]);
  cancelSelectionMode();
}

function applyRemoveFromEvent() {
  const event = eventsStore.selectedEvent;
  if (!event || !selectedIds.value.size) return;
  eventsStore.removePhotos(event.id, [...selectedIds.value]);
  cancelSelectionMode();
}

function eventCountLabel(eventId: string): number {
  const event = eventsStore.events.find((e) => e.id === eventId);
  if (!event) return 0;
  const ids = new Set(event.photoIds);
  return catalogPhotos.value.filter((p) => ids.has(p.id)).length;
}

function launchSelectedEvent() {
  const event = eventsStore.selectedEvent;
  if (!event) return;
  eventsStore.launchEvent(event.id);
  cancelSelectionMode();
  router.push("/");
}

function stopLaunchedEvent() {
  eventsStore.stopActiveEvent();
}

watch([filterDate, viewMode, dateOptions, sessionOptions], () => {
  if (filterDate.value && !dateOptions.value.includes(filterDate.value)) {
    filterDate.value = "";
  }
  if (
    filterSession.value &&
    !sessionOptions.value.some((s) => s.key === filterSession.value)
  ) {
    filterSession.value = "";
  }
});

watch(gridPhotos, (photos) => {
  if (!selectedIds.value.size) return;
  const ids = new Set(photos.map((p) => p.id));
  const next = new Set([...selectedIds.value].filter((id) => ids.has(id)));
  if (next.size !== selectedIds.value.size) selectedIds.value = next;
});

const sessionPhotoCount = computed(() => {
  const used = new Set(
    store.recentStrips.map((s) => normalizePath(s.path)).filter(Boolean),
  );
  let extra = 0;
  for (const p of diskSessionPhotos.value) {
    const key = normalizePath(p.path);
    if (key && !used.has(key)) extra += 1;
  }
  return store.recentStrips.length + extra;
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

function openSession(session: GallerySessionCard) {
  if (selectionMode.value) return;
  selectedSession.value = session;
  selectedPhoto.value = null;
}

function closeSession() {
  selectedSession.value = null;
  selectedPhoto.value = null;
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

async function hydrateSessionFromDisk() {
  if (!window.electronAPI) return;
  try {
    const listed = await window.electronAPI.listSavedPhotos();
    const known = new Set(
      store.recentStrips.map((s) => normalizePath(s.path)).filter(Boolean),
    );
    const previews: Record<string, string> = { ...localPreviewByPath.value };
    const extras: GalleryPhoto[] = [];

    for (const photo of listed) {
      if (!isSessionDiskFile(photo.path)) continue;
      const key = normalizePath(photo.path);
      const name = fileNameOf(photo.name || photo.path);
      if (!key || isPrintCropName(name)) continue;

      const alreadyListed = known.has(key);
      const strip = alreadyListed
        ? store.recentStrips.find((s) => normalizePath(s.path) === key)
        : undefined;
      if (alreadyListed && strip?.dataUrl) continue;

      const raw = await window.electronAPI.readPhoto(photo.path);
      if (!raw) continue;
      const src = await makePreviewDataUrl(raw);
      previews[key] = src;

      if (alreadyListed) continue;

      const folder = sessionFolderOf(photo.path);
      const sib = store.recentStrips.find(
        (s) => normalizePath(s.path) === key || sessionFolderOf(s.path) === folder,
      );
      extras.push({
        id: photo.path,
        src,
        name: looksLikeOriginalFile(name)
          ? name.replace(/-original/i, " (original)")
          : /^strip\.png$/i.test(name)
            ? "Printed strip"
            : name,
        timestamp: new Date(photo.created),
        path: photo.path,
        isLocal: true,
        isComposite: /^strip\.png$/i.test(name),
        isOriginal: looksLikeOriginalFile(name),
        sessionId: sib?.sessionId,
        templateId: sib?.templateId,
        sessionIndex: sessionIndexFromName(name),
        shareUrl: sib?.shareableUrl || "",
      });
      known.add(key);
    }

    localPreviewByPath.value = previews;
    diskSessionPhotos.value = extras;
  } catch (err) {
    console.error("Failed to hydrate session photos from disk:", err);
  }
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
  selectedSession.value = null;
  selectedPhoto.value = null;
}

function cancelSelectionMode() {
  selectionMode.value = null;
  selectedIds.value = new Set();
  selectedSession.value = null;
  selectedPhoto.value = null;
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
    selectedIds.value = new Set(gridPhotos.value.map((p) => p.id));
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
  const folder = sessionFolderOf(seed.path);
  type ReprintSrc = {
    id: string;
    sessionIndex: number;
    path?: string;
    printPath?: string;
    previewUrl?: string;
  };
  const byIndex = new Map<number, ReprintSrc>();
  const consider = (src: ReprintSrc) => {
    const prev = byIndex.get(src.sessionIndex);
    if (!prev) {
      byIndex.set(src.sessionIndex, src);
      return;
    }
    if (!prev.printPath && src.printPath) prev.printPath = src.printPath;
    if (!prev.path && src.path) prev.path = src.path;
    if (!prev.previewUrl && src.previewUrl) prev.previewUrl = src.previewUrl;
  };
  for (const s of store.recentStrips) {
    if (s.sessionId !== seed.sessionId || s.isComposite || s.isOriginal) continue;
    consider({
      id: s.id,
      sessionIndex: s.sessionIndex ?? 0,
      path: s.path,
      printPath: s.printPath,
      previewUrl: s.dataUrl,
    });
  }
  for (const p of diskSessionPhotos.value) {
    if (p.isComposite || p.isOriginal) continue;
    if (isPrintCropName(fileNameOf(p.path || p.name))) continue;
    const sameSession =
      (p.sessionId && p.sessionId === seed.sessionId) ||
      (folder && sessionFolderOf(p.path) === folder);
    if (!sameSession) continue;
    consider({
      id: p.id,
      sessionIndex: p.sessionIndex ?? 0,
      path: p.path,
      previewUrl: p.src,
    });
  }

  const tpl =
    store.templates.find((t) => t.id === seed.templateId) ??
    store.selectedTemplate;
  const cropBar = cropBarPercentForTemplate(tpl);

  async function readDisk(filePath?: string | null): Promise<string | null> {
    if (!filePath || !window.electronAPI?.readPhoto) return null;
    try {
      return (await window.electronAPI.readPhoto(filePath)) || null;
    } catch {
      return null;
    }
  }

  // Prefer photo-N-print.jpg (the exact still the first print used).
  // If that file is missing, recrop photo-N.jpg the same way CameraView
  // does — never feed the wide live-view frame or a tiny gallery preview
  // straight into the composite.
  const sessionStrips = [...byIndex.values()].sort(
    (a, b) => a.sessionIndex - b.sessionIndex,
  );
  const captures: { id: string; dataUrl: string }[] = [];
  for (const s of sessionStrips) {
    const printFile = s.printPath || printCropSiblingPath(s.path);
    let dataUrl = await readDisk(printFile);
    const usedPrintFile = !!dataUrl;
    if (!dataUrl) dataUrl = await readDisk(s.path);
    if (!dataUrl) dataUrl = s.previewUrl || "";
    if (!dataUrl) continue;
    if (!usedPrintFile) {
      dataUrl = await cropDataUrlToHighlightedView(dataUrl, cropBar);
    }
    captures.push({ id: s.id, dataUrl });
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
  const removedIds: string[] = [];
  for (const photo of photos) {
    if (photo.isLocal) {
      store.removeRecentStrip(photo.id);
      removedIds.push(photo.id);
    } else if (window.electronAPI && photo.path) {
      const result = await window.electronAPI.deletePhoto(photo.path);
      if (result.success) {
        savedPhotos.value = savedPhotos.value.filter((p) => p.id !== photo.id);
        removedIds.push(photo.id);
      }
    }
    if (selectedPhoto.value?.id === photo.id) closePhoto();
  }
  for (const event of eventsStore.events) {
    if (removedIds.some((id) => event.photoIds.includes(id))) {
      eventsStore.removePhotos(event.id, removedIds);
    }
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
const queuePending = ref(pendingUploadCount());
let stopQueueWatch: (() => void) | null = null;

function cloudFailureMessage(
  reason?: CloudReadyReason,
  detail?: string,
): string {
  const base = (() => {
    switch (reason) {
      case "not-configured":
        return "Cloud storage is not configured on this booth (.env / R2 keys).";
      case "timeout":
        return "Cloud storage timed out — check firewall to *.r2.cloudflarestorage.com.";
      case "unreachable":
        return "Cannot reach Cloudflare R2 — check R2 keys on this booth.";
      default:
        return "Cannot reach Cloudflare R2 — check R2 keys on this booth.";
    }
  })();
  const extra = (detail || "").trim();
  return extra ? `${base} (${extra})` : base;
}

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
  retryBusy.value = true;
  try {
    if (sessionId) {
      const result = await retrySessionUpload(sessionId);
      if (result.noConnection) {
        retryNotice.value = cloudFailureMessage(result.reason, result.detail);
      } else if (!result.ok) {
        console.warn("[Gallery] Retry upload failed for", sessionId);
        retryNotice.value = "Upload failed — try again or check R2 credentials.";
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
        retryNotice.value = cloudFailureMessage(result.reason, result.detail);
      } else if (!result.ok) {
        retryNotice.value = "Upload failed — try again or check R2 credentials.";
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

watch(
  () => eventsStore.sortedEvents.map((e) => e.id).join("|"),
  () => {
    focusDefaultEvent();
  },
);

onMounted(() => {
  eventsStore.load();
  focusDefaultEvent();
  stopQueueWatch = onUploadQueueChange(() => {
    queuePending.value = pendingUploadCount();
  });
  window.addEventListener("online", clearRetryNoticeOnOnline);
  if (isElectron.value) {
    void hydrateSessionFromDisk();
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
    <aside class="gallery-events" aria-label="Gallery events">
      <div class="gallery-events__head">
        <h2 class="gallery-events__title">Events</h2>
        <button
          type="button"
          class="gallery-icon-btn gallery-icon-btn--accent"
          title="New event"
          aria-label="New event"
          @click="openCreateEvent"
        >
          <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <button
        v-for="event in eventsStore.sortedEvents"
        :key="event.id"
        type="button"
        class="gallery-event-item"
        :class="{
          'gallery-event-item--active': eventsStore.selectedEventId === event.id,
          'gallery-event-item--launched': eventsStore.activeEventId === event.id,
        }"
        @click="
          eventsStore.selectEvent(event.id);
          closeSession();
          cancelSelectionMode();
        "
      >
        <span class="gallery-event-item__text">
          <span class="gallery-event-item__name">
            {{ event.name }}
            <span
              v-if="eventsStore.activeEventId === event.id"
              class="gallery-event-item__live"
            >Live</span>
          </span>
          <span v-if="event.date" class="gallery-event-item__date">
            {{ formatDateKey(event.date) }}
          </span>
        </span>
        <span class="gallery-event-item__count">{{ eventCountLabel(event.id) }}</span>
      </button>
      <p v-if="!eventsStore.sortedEvents.length" class="gallery-events__empty">
        Create an event to start organizing captures.
      </p>
    </aside>

    <div class="gallery-main">
    <div class="gallery-header">
      <div class="gallery-header-left">
        <div class="gallery-current">
          <h2 class="gallery-current__title">
            <template v-if="isAddingExisting">
              Add to {{ eventsStore.selectedEvent?.name || "event" }}
            </template>
            <template v-else>
              {{ eventsStore.selectedEvent?.name || "Events" }}
            </template>
          </h2>
          <p v-if="isAddingExisting" class="gallery-current__desc">
            Choose existing Session or Saved photos to attach.
          </p>
          <p
            v-else-if="eventsStore.selectedEvent?.description"
            class="gallery-current__desc"
          >
            {{ eventsStore.selectedEvent.description }}
          </p>
        </div>
        <div class="view-toggle" v-if="isElectron && isAddingExisting">
          <button
            class="toggle-btn"
            :class="{ active: viewMode === 'session' }"
            @click="viewMode = 'session'"
          >
            Session ({{ sessionPhotoCount }})
          </button>
          <button
            class="toggle-btn"
            :class="{ active: viewMode === 'saved' }"
            @click="
              viewMode = 'saved';
              if (!savedPhotos.length) loadSavedPhotos();
            "
          >
            Saved ({{ savedPhotos.length }})
          </button>
        </div>
      </div>
      <div
        class="gallery-header-right"
        v-if="
          gridSessions.length > 0 ||
          gridPhotos.length > 0 ||
          canRetryUploads ||
          eventsStore.selectedEvent ||
          selectionMode
        "
      >
        <template v-if="!selectionMode">
          <template v-if="eventsStore.selectedEvent">
            <button
              v-if="eventsStore.activeEventId === eventsStore.selectedEvent.id"
              type="button"
              class="gallery-text-btn"
              title="End launch"
              @click="stopLaunchedEvent"
            >
              <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
              </svg>
              End
            </button>
            <button
              v-else
              type="button"
              class="gallery-text-btn gallery-text-btn--accent"
              title="Launch event"
              @click="launchSelectedEvent"
            >
              <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M8 5.5v13l11-6.5L8 5.5z" fill="currentColor" />
              </svg>
              Launch
            </button>
            <button
              type="button"
              class="gallery-icon-btn gallery-icon-btn--accent"
              title="Add existing photos"
              aria-label="Add existing photos"
              @click="startAddToEvent"
            >
              <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <path d="M12 12v5M9.5 14.5H14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <button
              v-if="displayPhotos.length > 0"
              type="button"
              class="gallery-icon-btn"
              title="Remove from event"
              aria-label="Remove from event"
              @click="startRemoveFromEvent"
            >
              <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <path d="M9.5 14.5H14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <button
              type="button"
              class="gallery-icon-btn"
              title="Edit event"
              aria-label="Edit event"
              @click="openEditEvent"
            >
              <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 20h4l10.5-10.5-4-4L4 16v4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <path d="M12.5 7.5l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <button
              type="button"
              class="gallery-icon-btn gallery-icon-btn--danger"
              title="Delete event"
              aria-label="Delete event"
              @click="askDeleteEvent"
            >
              <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 7h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke="currentColor" stroke-width="2" />
                <path d="M8 7l.8 12h6.4L16 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                <path d="M10 4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                <circle cx="18.5" cy="5.5" r="3.2" fill="#f8e8e8" stroke="currentColor" stroke-width="1.6" />
                <path d="M17.3 5.5h2.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </button>
          </template>
          <button
            type="button"
            class="gallery-icon-btn gallery-icon-btn--accent"
            title="Retry upload"
            aria-label="Retry upload"
            :disabled="retryBusy || !canRetryUploads"
            @click="retryUploads()"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.2-5.5M20 5v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            v-if="displayPhotos.length > 0"
            type="button"
            class="gallery-icon-btn gallery-icon-btn--accent"
            title="Reprint"
            aria-label="Reprint"
            @click="startSelectionMode('reprint')"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 8V4h10v4M7 16H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              <rect x="7" y="14" width="10" height="6" rx="1" stroke="currentColor" stroke-width="2" />
            </svg>
          </button>
          <button
            v-if="displayPhotos.length > 0"
            type="button"
            class="gallery-icon-btn gallery-icon-btn--danger"
            title="Delete photos"
            aria-label="Delete photos"
            @click="startSelectionMode('delete')"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              <circle cx="12" cy="13.5" r="2.6" stroke="currentColor" stroke-width="2" />
              <path d="M7 18l10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            class="gallery-icon-btn"
            title="Cancel"
            aria-label="Cancel"
            @click="cancelSelectionMode"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            type="button"
            class="gallery-icon-btn"
            :title="allSelected ? 'Deselect all' : 'Select all'"
            :aria-label="allSelected ? 'Deselect all' : 'Select all'"
            @click="toggleSelectAll"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="2" />
              <path
                v-if="allSelected"
                d="M8 12l3 3 5-5"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            v-if="selectionMode === 'reprint'"
            type="button"
            class="gallery-icon-btn gallery-icon-btn--accent"
            :disabled="!hasSelection"
            :title="`Reprint ${selectedCount} selected`"
            :aria-label="`Reprint ${selectedCount} selected`"
            @click="openConfirmModal('reprint')"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 8V4h10v4M7 16H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              <rect x="7" y="14" width="10" height="6" rx="1" stroke="currentColor" stroke-width="2" />
            </svg>
            <span v-if="hasSelection" class="gallery-icon-btn__badge">{{ selectedCount }}</span>
          </button>
          <button
            v-else-if="selectionMode === 'delete'"
            type="button"
            class="gallery-icon-btn gallery-icon-btn--danger"
            :disabled="!hasSelection"
            :title="`Delete ${selectedCount} selected`"
            :aria-label="`Delete ${selectedCount} selected`"
            @click="openConfirmModal('delete')"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              <circle cx="12" cy="13.5" r="2.6" stroke="currentColor" stroke-width="2" />
              <path d="M7 18l10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
            <span v-if="hasSelection" class="gallery-icon-btn__badge">{{ selectedCount }}</span>
          </button>
          <button
            v-else-if="selectionMode === 'add-to-event'"
            type="button"
            class="gallery-icon-btn gallery-icon-btn--accent"
            :disabled="!hasSelection"
            :title="`Add ${selectedCount} to event`"
            :aria-label="`Add ${selectedCount} to event`"
            @click="applyAddToEvent"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
            <span v-if="hasSelection" class="gallery-icon-btn__badge">{{ selectedCount }}</span>
          </button>
          <button
            v-else
            type="button"
            class="gallery-icon-btn"
            :disabled="!hasSelection"
            :title="`Remove ${selectedCount} from event`"
            :aria-label="`Remove ${selectedCount} from event`"
            @click="applyRemoveFromEvent"
          >
            <svg class="gallery-icon-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            </svg>
            <span v-if="hasSelection" class="gallery-icon-btn__badge">{{ selectedCount }}</span>
          </button>
        </template>
      </div>
    </div>
    <p
      v-if="selectionMode === 'add-to-event'"
      class="gallery-selection-hint"
      role="status"
    >
      Pick existing gallery photos to add to
      {{ eventsStore.selectedEvent?.name || "this event" }}.
    </p>
    <p
      v-else-if="selectionMode === 'remove-from-event'"
      class="gallery-selection-hint"
      role="status"
    >
      Select photos to unlink from this event. Files stay on disk.
    </p>
    <p
      v-if="retryNotice"
      class="gallery-retry-notice"
      role="status"
    >
      {{ retryNotice }}
    </p>

    <!-- Loading State (only while browsing the full catalog to add) -->
    <div
      v-if="isAddingExisting && viewMode === 'saved' && isLoading"
      class="loading-state"
    >
      <div class="spinner"></div>
      <p>Loading photos...</p>
    </div>

    <div v-else-if="!eventsStore.selectedEvent" class="empty-state">
      <h2>No event selected</h2>
      <p>Create an event to collect captures for a shoot night.</p>
      <button type="button" class="btn btn-reprint" @click="openCreateEvent">
        New event
      </button>
    </div>
    <div
      v-else-if="isAddingExisting && catalogPhotos.length === 0"
      class="empty-state"
    >
      <h2>No Photos Yet</h2>
      <p v-if="viewMode === 'session'">Take some photos first, then add them here.</p>
      <p v-else>Saved photos will appear here to attach.</p>
      <button type="button" class="btn btn-secondary" @click="cancelSelectionMode">
        Back to event
      </button>
    </div>
    <div
      v-else-if="isAddingExisting && addablePhotos.length === 0"
      class="empty-state"
    >
      <h2>No more photos to add</h2>
      <p>Every photo in this tab is already in the event.</p>
      <button type="button" class="btn btn-secondary" @click="cancelSelectionMode">
        Done
      </button>
    </div>
    <div
      v-else-if="
        (!selectionMode && gridSessions.length === 0) ||
        (selectionMode && gridPhotos.length === 0)
      "
      class="empty-state"
    >
      <h2>No photos in this event</h2>
      <p>
        Launch the booth to capture into this event, or add existing pictures
        from Session / Saved.
      </p>
      <button type="button" class="btn btn-reprint" @click="startAddToEvent">
        Add photos
      </button>
    </div>

    <!-- Browse: one thumbnail per session -->
    <div v-else-if="!selectionMode" class="photo-grid">
      <div
        v-for="session in gridSessions"
        :key="session.key"
        class="photo-card session-card"
        @click="openSession(session)"
      >
        <img
          :src="session.thumb.src"
          :alt="session.label"
          class="photo-thumb"
        />
        <span class="photo-badge">{{ session.count }} photo{{ session.count === 1 ? "" : "s" }}</span>
        <div class="photo-overlay photo-overlay--always">
          <span class="photo-date">{{ session.label }}</span>
        </div>
      </div>
    </div>

    <!-- Selection modes: individual photos (add / remove / reprint / delete) -->
    <div v-else class="photo-grid">
      <div
        v-for="photo in gridPhotos"
        :key="photo.id"
        class="photo-card"
        :class="{
          'photo-card--selected': isSelected(photo),
          'photo-card--selection-mode': selectionMode,
        }"
        @click="toggleSelected(photo, $event)"
      >
        <input
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

    <!-- Session dialog: all photos in that session -->
    <div
      v-if="selectedSession"
      class="photo-modal session-modal"
      @click="closeSession"
    >
      <div class="modal-content session-modal-content" @click.stop>
        <button type="button" class="close-btn" @click="closeSession">✕</button>
        <h2 class="session-modal-title">{{ selectedSession.label }}</h2>
        <p class="session-modal-meta">
          {{ selectedSession.count }} photo{{
            selectedSession.count === 1 ? "" : "s"
          }}
          · {{ formatDate(selectedSession.timestamp) }}
        </p>
        <div class="session-photo-grid">
          <button
            v-for="photo in selectedSession.photos"
            :key="photo.id"
            type="button"
            class="session-photo-tile"
            @click="openPhoto(photo)"
          >
            <img :src="photo.src" :alt="photo.name" />
            <span
              v-if="photo.isComposite"
              class="photo-badge"
            >Printed</span>
            <span
              v-else-if="photo.isOriginal"
              class="photo-badge photo-badge--original"
            >Original</span>
            <span class="session-photo-tile__name">{{ photo.name }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Photo Viewer Modal (from session dialog) -->
    <div v-if="selectedPhoto" class="photo-modal photo-modal--nested" @click="closePhoto">
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

    <AdminFormModal
      v-model:open="showEventForm"
      :title="editingEventId ? 'Edit event' : 'New event'"
      description="Captures from Launch go here. You can also attach existing Session or Saved photos."
    >
      <div class="event-form">
        <label class="event-form__label">
          Name
          <input
            v-model="eventFormName"
            type="text"
            class="event-form__input"
            maxlength="80"
            placeholder="e.g. Wedding — May"
            @keydown.enter.prevent="saveEventForm"
          />
        </label>
        <label class="event-form__label">
          Date
          <input v-model="eventFormDate" type="date" class="event-form__input" />
        </label>
        <label class="event-form__label">
          Description
          <textarea
            v-model="eventFormDescription"
            class="event-form__input event-form__textarea"
            rows="3"
            maxlength="240"
            placeholder="Optional notes"
          />
        </label>
        <p v-if="eventFormError" class="event-form__error">{{ eventFormError }}</p>
        <div class="event-form__actions">
          <button type="button" class="btn btn-secondary" @click="closeEventForm">
            Cancel
          </button>
          <button type="button" class="btn btn-reprint" @click="saveEventForm">
            {{ editingEventId ? "Save" : "Create" }}
          </button>
        </div>
      </div>
    </AdminFormModal>

    <div
      v-if="confirmDeleteEvent"
      class="photo-modal confirm-modal"
      @click="confirmDeleteEvent = false"
    >
      <div class="modal-content confirm-content" @click.stop>
        <h2 class="confirm-title">Delete event?</h2>
        <p class="confirm-message">
          Remove “{{ eventsStore.selectedEvent?.name }}”? Photos are not deleted
          from disk — only this event grouping is removed.
        </p>
        <div class="confirm-actions">
          <button
            type="button"
            class="btn btn-secondary"
            @click="confirmDeleteEvent = false"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-danger"
            @click="confirmDeleteEventAction"
          >
            Delete event
          </button>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
/* Beat AdminPanel's `.admin-main > * { flex-direction: column }` so
   events stay on the left and the photo grid stays on the right. */
.gallery-view {
  height: 100%;
  width: 100%;
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: nowrap;
  align-items: stretch;
  background: transparent;
  padding: 0;
  overflow: hidden;
  gap: 0;
}

.gallery-events {
  --evt-bg: #f7efe3;
  --evt-bg-soft: #fffaf2;
  --evt-line: #dcc9ad;
  --evt-text: #3b2a14;
  --evt-muted: #8a6f4f;
  --evt-gold: #e0b45a;
  --evt-gold-deep: #c2822e;
  flex: 0 0 300px;
  width: 300px;
  max-width: 300px;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 1.25rem 1rem;
  border-right: 2px solid var(--evt-line);
  background: linear-gradient(180deg, #fffaf2 0%, var(--evt-bg) 100%);
  overflow-x: hidden;
  overflow-y: auto;
  color: var(--evt-text);
}

.gallery-events__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.gallery-events__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--evt-text);
  letter-spacing: 0.04em;
}

.gallery-text-btn {
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0 0.85rem 0 0.7rem;
  border: 2px solid var(--color-brown-light);
  border-radius: 10px;
  background: var(--color-cream);
  color: var(--color-brown-dark);
  cursor: pointer;
  flex: 0 0 auto;
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.gallery-text-btn:hover:not(:disabled) {
  border-color: var(--color-brown);
  background: #fff8ea;
}

.gallery-text-btn--accent {
  background: #e8c56b;
  border-color: #d4ae4f;
  color: #3b2a14;
}

.gallery-text-btn--accent:hover:not(:disabled) {
  background: #f0d27a;
  border-color: #c2822e;
}

.gallery-icon-btn {
  position: relative;
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--color-brown-light);
  border-radius: 10px;
  background: var(--color-cream);
  color: var(--color-brown-dark);
  cursor: pointer;
  flex: 0 0 auto;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.gallery-icon-btn:hover:not(:disabled) {
  border-color: var(--color-brown);
  background: #fff8ea;
}

.gallery-icon-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.gallery-icon-btn--accent {
  background: #e8c56b;
  border-color: #d4ae4f;
  color: #3b2a14;
}

.gallery-icon-btn--accent:hover:not(:disabled) {
  background: #f0d27a;
  border-color: #c2822e;
}

.gallery-icon-btn--danger {
  color: #8a2b2b;
  border-color: #d4a0a0;
  background: #f8e8e8;
}

.gallery-icon-btn--danger:hover:not(:disabled) {
  background: #f3d4d4;
  border-color: #8a2b2b;
}

.gallery-icon-btn__svg {
  width: 1.25rem;
  height: 1.25rem;
  display: block;
}

.gallery-icon-btn__badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 1.15rem;
  height: 1.15rem;
  padding: 0 0.28rem;
  border-radius: 999px;
  background: #683017;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 700;
  line-height: 1.15rem;
  text-align: center;
}

.gallery-event-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.7rem 0.8rem;
  border: 1px solid #e0d0b8;
  border-radius: 10px;
  background: #e8d7c0;
  color: #5c4033;
  text-align: left;
  cursor: pointer;
  font-family: var(--font-body);
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.gallery-event-item:hover {
  background: #5c4033;
  border-color: #3b2a14;
  color: #f7efe3;
}

.gallery-event-item--active,
.gallery-event-item--active:hover {
  background: #3b2a14;
  border-color: #2a1d12;
  color: #f7efe3;
  box-shadow: inset 3px 0 0 var(--evt-gold-deep);
}

.gallery-event-item--launched:not(.gallery-event-item--active) {
  border-color: var(--evt-gold-deep);
}

.gallery-event-item__live {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  background: var(--evt-gold-deep);
  color: #fff8ea;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  vertical-align: middle;
}

.gallery-event-item__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 0.1rem;
}

.gallery-event-item__name {
  font-weight: 700;
  font-size: 0.92rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
}

.gallery-event-item__date {
  font-size: 0.75rem;
  color: #8a6f4f;
}

.gallery-event-item:hover .gallery-event-item__date,
.gallery-event-item--active .gallery-event-item__date {
  color: #e0d0b8;
}

.gallery-event-item__count {
  flex: 0 0 auto;
  font-size: 0.8rem;
  font-weight: 700;
  color: #3b2a14;
  background: rgba(255, 250, 242, 0.65);
  border-radius: 999px;
  padding: 0.15rem 0.45rem;
}

.gallery-event-item:hover .gallery-event-item__count,
.gallery-event-item--active .gallery-event-item__count {
  color: #3b2a14;
  background: var(--evt-gold);
}

.gallery-events__empty {
  margin: 0.75rem 0.25rem 0;
  font-size: 0.82rem;
  line-height: 1.4;
  color: var(--evt-muted);
}

.gallery-events .gallery-icon-btn {
  background: #fffaf2;
  border-color: var(--evt-line);
  color: var(--evt-text);
}

.gallery-events .gallery-icon-btn:hover:not(:disabled) {
  background: #fff;
  border-color: var(--evt-gold-deep);
}

.gallery-events .gallery-icon-btn--accent {
  background: var(--evt-gold);
  border-color: var(--evt-gold-deep);
  color: #3b2a14;
}

.gallery-main {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
  overflow-x: hidden;
  overflow-y: auto;
}

.gallery-current {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.gallery-current__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--color-brown-dark);
}

.gallery-current__desc {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-brown);
  max-width: 28rem;
}

.gallery-selection-hint {
  margin: 0 0 1rem;
  color: var(--color-brown-dark);
  font-size: 0.95rem;
  font-weight: 600;
}

.event-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.event-form__label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-family: var(--font-body);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

.event-form__input {
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--color-brown-dark);
}

.event-form__textarea {
  resize: vertical;
  min-height: 4.5rem;
}

.event-form__error {
  margin: 0;
  color: #8a2b2b;
  font-size: 0.9rem;
  font-weight: 600;
}

.event-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.65rem;
  margin-top: 0.35rem;
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
  flex-wrap: wrap;
  gap: 0.75rem;
}

.gallery-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.gallery-filter-label {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.gallery-filter-text {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown);
  font-weight: 600;
}

.gallery-select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown-dark);
  min-width: 9rem;
  cursor: pointer;
}

.gallery-select:focus {
  outline: none;
  border-color: var(--color-brown);
  box-shadow: 0 0 0 2px rgba(92, 64, 51, 0.15);
}

.gallery-filter-clear {
  padding: 0.4rem 0.85rem;
  font-size: 0.9rem;
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

.photo-overlay--always {
  opacity: 1;
}

.photo-date {
  color: var(--color-cream);
  font-size: 0.8rem;
  font-family: var(--font-body);
}

.session-modal-content {
  align-items: stretch;
  width: min(960px, 94vw);
  max-height: 90vh;
  overflow: hidden;
}

.session-modal-title {
  margin: 0 2.5rem 0.25rem 0;
  font-family: var(--font-display);
  font-size: 1.35rem;
  color: var(--color-brown-dark);
}

.session-modal-meta {
  margin: 0 0 1rem;
  font-family: var(--font-body);
  font-size: 0.88rem;
  color: var(--color-brown);
}

.session-photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.75rem;
  overflow-y: auto;
  padding: 0.15rem 0.15rem 0.5rem;
  max-height: min(68vh, 720px);
}

.session-photo-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  margin: 0;
  padding: 0;
  border: 2px solid var(--color-brown-light);
  border-radius: 10px;
  overflow: hidden;
  background: var(--color-cream-dark);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease;
}

.session-photo-tile:hover {
  border-color: var(--color-brown-dark);
  transform: translateY(-1px);
}

.session-photo-tile img {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  object-position: center;
}

.session-photo-tile__name {
  display: block;
  padding: 0.4rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.photo-modal--nested {
  z-index: 110;
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
