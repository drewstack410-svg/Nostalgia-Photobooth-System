<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { usePhotoboothStore } from "@/stores/photobooth";
import { useDashboardStore } from "@/stores/dashboard";
import type {
  Template,
  TemplateCell,
  CameraFrameStyle,
  PrintCutMode,
  CameraFilter,
  FilterOverlay,
  FilterAdjustments,
  BlendMode,
} from "@/stores/photobooth";
import { BLEND_MODES } from "@/stores/photobooth";
import { applyBoothConfig, saveBoothConfig } from "@/lib/boothConfig";
import { getPaperSizePx } from "@/utils/printLayout";
import type { PaperSize } from "@/utils/printLayout";
import TemplatePreview from "@/components/TemplatePreview.vue";
import TemplateLayoutEditor from "@/components/TemplateLayoutEditor.vue";
import OnScreenKeyboard from "@/components/OnScreenKeyboard.vue";
import AdminFormModal from "@/components/AdminFormModal.vue";
import FilterLivePreview from "@/components/FilterLivePreview.vue";

const store = usePhotoboothStore();
const dashboardStore = useDashboardStore();
const { cameraFrameStyle, cameraFrameColor, cameraFrameSvgUrl } =
  storeToRefs(store);

// General section modals
const showLogoModal = ref(false);
const showPaymentQrModal = ref(false);
const showTitleBgModal = ref(false);
const showFontsModal = ref(false);
const showFiltersModal = ref(false);
const showTemplatesModal = ref(false);
const showCameraFrameModal = ref(false);
const showPrinterModal = ref(false);
const showSecurityModal = ref(false);
const showTimingModal = ref(false);

// ── Booth identity (per machine, runtime) ──────────────────────────────
// Not a build-time value: one build ships to the whole fleet, so a baked-in
// kiosk id would make every booth report as the same one.
const boothIdInput = ref("");
const pocketBaseInput = ref("");
const boothSaved = ref(false);
const boothWarning = computed(() =>
  boothIdInput.value.trim()
    ? ""
    : 'No booth ID set — this machine reports as "default" and its sales cannot be told apart from any other booth.',
);

onMounted(async () => {
  const cfg = await applyBoothConfig();
  boothIdInput.value = cfg.kioskId;
  pocketBaseInput.value = cfg.pocketBaseUrl;
});

async function saveBooth() {
  boothSaved.value = await saveBoothConfig({
    kioskId: boothIdInput.value,
    pocketBaseUrl: pocketBaseInput.value,
  });
  if (boothSaved.value) setTimeout(() => (boothSaved.value = false), 2000);
}

// Admin PIN
const pinDraft = ref("");
const pinConfirmDraft = ref("");
const pinFormError = ref("");

function openSecurityModal() {
  pinDraft.value = "";
  pinConfirmDraft.value = "";
  pinFormError.value = "";
  showSecurityModal.value = true;
}

function saveAdminPin() {
  const digits = pinDraft.value.replace(/\D/g, "");
  if (digits.length < 4) {
    pinFormError.value = "PIN must be at least 4 digits.";
    return;
  }
  if (digits !== pinConfirmDraft.value.replace(/\D/g, "")) {
    pinFormError.value = "PINs don't match.";
    return;
  }
  store.setAdminPin(digits);
  pinFormError.value = "";
  showSecurityModal.value = false;
}

function resetAdminPin() {
  // There is always a PIN gate — this resets it back to the 1234 default.
  store.clearAdminPin();
  showSecurityModal.value = false;
}

// Timing (countdowns)
function updateShootingFirstCountdown(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10);
  if (!isNaN(val)) store.setShootingFirstCountdown(val);
}
function updateShootingSubsequentCountdown(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10);
  if (!isNaN(val)) store.setShootingSubsequentCountdown(val);
}
function updatePrintingCountdown(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10);
  if (!isNaN(val)) store.setPrintingCountdown(val);
}
function updateQrCountdown(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10);
  if (!isNaN(val)) store.setQrCountdown(val);
}
function toggleQrAutoAdvance() {
  store.setQrAutoAdvanceEnabled(!store.qrAutoAdvanceEnabled);
}

function toggleCameraDetection(e: Event) {
  store.setCameraDetectionEnabled((e.target as HTMLInputElement).checked);
}

function togglePaymentEnabled(e: Event) {
  store.setPaymentEnabled((e.target as HTMLInputElement).checked);
}

// ── Payment middleware status ──────────────────────────────────────
// The middleware is a SEPARATE Windows program, so its own window can't
// be drawn inside this page. What staff actually need is proof the link
// is alive — that's what this panel shows.
const bridge = ref<PaymentBridgeStatus | null>(null);
const launchMsg = ref("");
let unsubscribeBridge: (() => void) | null = null;

const bridgeState = computed(() => {
  const b = bridge.value;
  if (!b) return { label: "Checking…", tone: "idle" };
  if (b.error) return { label: "Blocked", tone: "bad" };
  if (!b.listening) return { label: "Not running", tone: "bad" };
  if (b.signalCount > 0) return { label: "Connected", tone: "good" };
  return { label: "Ready — waiting for first payment", tone: "warn" };
});

function formatSignalTime(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

async function launchMiddleware() {
  launchMsg.value = "";
  const res = await window.electronAPI?.launchMiddleware?.();
  if (!res) return;
  launchMsg.value = res.success
    ? `Started: ${res.path}`
    : res.error || "Could not start the middleware.";
  if (res.success) setTimeout(() => void startMiddlewareView(), 2500);
}

// ── Live view of the middleware's own window ───────────────────────
// Streams the real window into the page. It is a VIEW: Windows does not
// let one program host another's window, so clicks are not forwarded —
// "Open controls" brings the real window forward to interact with.
const middlewareVideo = ref<HTMLVideoElement | null>(null);
const middlewareStream = ref<MediaStream | null>(null);
const middlewareViewError = ref("");
const middlewareWindowName = ref("");

async function startMiddlewareView() {
  middlewareViewError.value = "";
  try {
    const list = await window.electronAPI?.listMiddlewareWindows?.();
    const match = list?.matches?.[0];
    if (!match) {
      middlewareViewError.value =
        "Middleware window not found. Start it with “Open middleware app”, then try again.";
      return;
    }
    middlewareWindowName.value = match.name;
    stopMiddlewareView();
    // Main routes this at the middleware window (see
    // setDisplayMediaRequestHandler) so no picker appears.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    middlewareStream.value = stream;
    await nextTick();
    if (middlewareVideo.value) {
      middlewareVideo.value.srcObject = stream;
      await middlewareVideo.value.play().catch(() => {});
    }
  } catch (e) {
    middlewareViewError.value =
      e instanceof Error ? e.message : "Could not open the live view.";
  }
}

function stopMiddlewareView() {
  middlewareStream.value?.getTracks().forEach((t) => t.stop());
  middlewareStream.value = null;
  if (middlewareVideo.value) middlewareVideo.value.srcObject = null;
}

async function focusMiddleware() {
  const res = await window.electronAPI?.focusMiddlewareWindow?.();
  if (res && !res.success) middlewareViewError.value = res.error || "Could not focus the window.";
}

onMounted(async () => {
  bridge.value = (await window.electronAPI?.getPaymentBridgeStatus?.()) ?? null;
  unsubscribeBridge =
    window.electronAPI?.onPaymentBridgeStatus?.((s) => {
      bridge.value = s;
    }) ?? null;
});

onUnmounted(() => {
  unsubscribeBridge?.();
  unsubscribeBridge = null;
  // Never leave a screen-capture stream running behind the admin panel.
  stopMiddlewareView();
});

// Printer settings
interface PrinterInfo { name: string; displayName: string; isDefault: boolean; status: number; }
const availablePrinters = ref<PrinterInfo[]>([]);
const printerLoading = ref(false);
const printerError = ref("");

async function loadPrinters() {
  if (!window.electronAPI?.getPrinters) return;
  printerLoading.value = true;
  printerError.value = "";
  try {
    const result = await window.electronAPI.getPrinters();
    if (result.success) {
      availablePrinters.value = result.printers;
    } else {
      printerError.value = result.error || "Could not load printers";
    }
  } catch (e: unknown) {
    printerError.value = e instanceof Error ? e.message : "Error loading printers";
  } finally {
    printerLoading.value = false;
  }
}

function openPrinterModal() {
  showPrinterModal.value = true;
  loadPrinters();
}

function selectPrinter(name: string) {
  store.setSelectedPrinter(name);
}

function updateCopies(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value, 10);
  if (!isNaN(val)) store.setPrintCopies(val);
}

function selectPrintCutMode(mode: PrintCutMode) {
  store.setPrintCutMode(mode);
}

// One-click shortcut to the DNP printer's Properties dialog. The "2inch
// cut" flag is a vendor driver feature and can't be toggled directly from
// JS/PowerShell without the DNP SDK, so we surface the dialog here instead.
const openingPrinterProps = ref(false);
const openPrinterError = ref("");
async function openPrinterProperties() {
  if (!window.electronAPI?.openPrinterProperties) {
    openPrinterError.value = "Printer properties not supported in this build.";
    return;
  }
  openingPrinterProps.value = true;
  openPrinterError.value = "";
  try {
    const res = await window.electronAPI.openPrinterProperties(
      store.selectedPrinterName || "",
    );
    if (!res.success) {
      openPrinterError.value =
        res.error || "Could not open printer properties dialog.";
    }
  } catch (e) {
    openPrinterError.value =
      e instanceof Error ? e.message : "Error opening printer properties.";
  } finally {
    openingPrinterProps.value = false;
  }
}

// Customize: logo and title screen background
const logoInputRef = ref<HTMLInputElement | null>(null);
const titleBgImageInputRef = ref<HTMLInputElement | null>(null);
const titleBgVideoInputRef = ref<HTMLInputElement | null>(null);
const titleBgMediaChoice = ref<"image" | "video">("image");

function triggerLogoInput() {
  logoInputRef.value?.click();
}
function triggerTitleBgImageInput() {
  titleBgImageInputRef.value?.click();
}
function triggerTitleBgVideoInput() {
  titleBgVideoInputRef.value?.click();
}

function onLogoChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    store.setCustomLogo(reader.result as string);
  };
  reader.readAsDataURL(file);
  input.value = "";
}
function clearLogo() {
  store.clearCustomLogo();
}

const paymentQrInputRef = ref<HTMLInputElement | null>(null);
function triggerPaymentQrInput() {
  paymentQrInputRef.value?.click();
}
function onPaymentQrChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    store.setPaymentQr(reader.result as string);
  };
  reader.readAsDataURL(file);
  input.value = "";
}
function clearPaymentQr() {
  store.clearPaymentQr();
}

function updateLogoScale(e: Event) {
  store.setTitleLogoScale(parseFloat((e.target as HTMLInputElement).value));
}
function updateQrScale(e: Event) {
  store.setPaymentQrScale(parseFloat((e.target as HTMLInputElement).value));
}
function updateStartBtnScale(e: Event) {
  store.setStartButtonScale(parseFloat((e.target as HTMLInputElement).value));
}

// Shown when an upload is rejected or fails, so a bad file isn't a
// silent no-op (the old handlers just `return`ed).
const titleBgError = ref("");
const titleBgBusy = ref(false);

async function handleTitleBgFile(kind: "image" | "video", event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // let the same file be re-picked after an error
  titleBgError.value = "";
  if (!file) return;

  // Some systems report .mov as an empty type; fall back to extension.
  const looksRight =
    file.type.startsWith(`${kind}/`) ||
    (kind === "video" && /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(file.name)) ||
    (kind === "image" && /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name));
  if (!looksRight) {
    titleBgError.value = `That file doesn't look like ${kind === "video" ? "a video" : "an image"} (${file.name}).`;
    return;
  }

  titleBgBusy.value = true;
  try {
    const ok = await store.setTitleBackgroundFile(kind, file);
    if (!ok) titleBgError.value = "Couldn't save the background. Check the app log for details.";
  } catch (e) {
    console.error("[Settings] Title background upload failed:", e);
    titleBgError.value = e instanceof Error ? e.message : "Upload failed.";
  } finally {
    titleBgBusy.value = false;
  }
}

const onTitleBgImageChange = (e: Event) => handleTitleBgFile("image", e);
const onTitleBgVideoChange = (e: Event) => handleTitleBgFile("video", e);

// ── Payment screen background (same mechanism, 'payment' slot) ──────
const showPaymentBgModal = ref(false);
const paymentBgVideoInputRef = ref<HTMLInputElement | null>(null);
const paymentBgError = ref("");
const paymentBgBusy = ref(false);

function triggerPaymentBgInput() {
  paymentBgVideoInputRef.value?.click();
}

async function onPaymentBgChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  paymentBgError.value = "";
  if (!file) return;
  const isVideo =
    file.type.startsWith("video/") || /\.(mp4|webm|ogv|mov|m4v)$/i.test(file.name);
  const isImage =
    file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
  if (!isVideo && !isImage) {
    paymentBgError.value = `That file isn't a video or image (${file.name}).`;
    return;
  }
  paymentBgBusy.value = true;
  try {
    const ok = await store.setPaymentBackgroundFile(isVideo ? "video" : "image", file);
    if (!ok) paymentBgError.value = "Couldn't save the background. Check the app log.";
  } catch (e) {
    console.error("[Settings] Payment background upload failed:", e);
    paymentBgError.value = e instanceof Error ? e.message : "Upload failed.";
  } finally {
    paymentBgBusy.value = false;
  }
}

function clearPaymentBackground() {
  store.clearPaymentBackground();
}
function clearTitleBackground() {
  store.clearTitleBackground();
}

watch(showTitleBgModal, (open) => {
  if (open) {
    titleBgMediaChoice.value = store.titleBackgroundType === "video" ? "video" : "image";
  }
});

// Custom fonts
const displayFontInputRef = ref<HTMLInputElement | null>(null);
const bodyFontInputRef = ref<HTMLInputElement | null>(null);
const FONT_ACCEPT = ".woff2,.woff,.ttf,.otf";

function triggerDisplayFontInput() {
  displayFontInputRef.value?.click();
}
function triggerBodyFontInput() {
  bodyFontInputRef.value?.click();
}
function onDisplayFontChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const isFont =
    file.type.startsWith("font/") || /\.(woff2?|ttf|otf)$/i.test(file.name);
  if (!isFont) return;
  const reader = new FileReader();
  reader.onload = () => {
    store.setCustomDisplayFont(reader.result as string);
  };
  reader.readAsDataURL(file);
  input.value = "";
}
function onBodyFontChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const isFont =
    file.type.startsWith("font/") || /\.(woff2?|ttf|otf)$/i.test(file.name);
  if (!isFont) return;
  const reader = new FileReader();
  reader.onload = () => {
    store.setCustomBodyFont(reader.result as string);
  };
  reader.readAsDataURL(file);
  input.value = "";
}

// Filters (camera): add via .cube upload; toggle On/Off per filter
function removeFilter(id: string) {
  store.removeFilter(id);
}

/**
 * Colour overlay — a Photoshop fill layer in effect: pick a colour, a blend
 * mode and an opacity, and it composites over the photo. Switching it on
 * seeds a sensible default so the operator sees something immediately
 * rather than a no-op at 0%.
 */
function toggleFilterOverlay(f: CameraFilter, event: Event) {
  const on = (event.target as HTMLInputElement).checked;
  store.setFilterOverlay(f.id, on ? { ...store.DEFAULT_OVERLAY } : null);
}

function updateOverlay(f: CameraFilter, patch: Partial<FilterOverlay>) {
  if (!f.overlay) return;
  store.setFilterOverlay(f.id, { ...f.overlay, ...patch });
}
function toggleFilterActive(id: string) {
  store.toggleFilterActive(id);
}
function toggleFilterGrain(id: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  store.setFilterGrain(id, checked);
}

const editingFilterId = ref("");
const editingFilter = computed(
  () =>
    store.filters.find((f) => f.id === editingFilterId.value) ??
    store.filters[0] ??
    null,
);
const editingAdj = computed(() =>
  editingFilter.value
    ? store.resolvedAdjustments(editingFilter.value)
    : store.DEFAULT_ADJUSTMENTS,
);

watch(showFiltersModal, (open) => {
  if (open && store.filters[0] && !editingFilterId.value) {
    editingFilterId.value = store.filters[0].id;
  }
});

function selectFilterRow(id: string) {
  editingFilterId.value = id;
}

function updateAdjustment(key: keyof FilterAdjustments, value: number) {
  const f = editingFilter.value;
  if (!f) return;
  store.setFilterAdjustments(f.id, { [key]: value });
}

// Camera frame: style (wooden | color | svg), color picker, custom image upload
const cameraFrameSvgInputRef = ref<HTMLInputElement | null>(null);
const CAMERA_FRAME_OPTIONS: { value: CameraFrameStyle; label: string }[] = [
  { value: "wooden", label: "Wooden" },
  { value: "blur", label: "Blur (live feed as border)" },
  { value: "color", label: "Color" },
  { value: "svg", label: "Custom" },
  { value: "none", label: "No border" },
];
function triggerCameraFrameSvgInput() {
  cameraFrameSvgInputRef.value?.click();
}
function onCameraFrameSvgChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (
    !file ||
    (!file.type.startsWith("image/") && file.type !== "image/svg+xml")
  )
    return;
  const reader = new FileReader();
  reader.onload = () => {
    store.setCameraFrameSvgUrl(reader.result as string);
  };
  reader.readAsDataURL(file);
}
function clearCameraFrameSvg() {
  store.setCameraFrameSvgUrl(null);
  if (cameraFrameSvgInputRef.value) cameraFrameSvgInputRef.value.value = "";
}

const filterCubeInputRef = ref<HTMLInputElement | null>(null);
const newFilterName = ref("");
const newFilterActive = ref(true);
const newFilterGrain = ref(false);
const filterFormStatus = ref<"" | "idle" | "success" | "error">("idle");
const filterFormMessage = ref("");

function triggerCubeUpload() {
  filterFormStatus.value = "idle";
  filterFormMessage.value = "";
  filterCubeInputRef.value?.click();
}

function onCubeFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!/\.cube$/i.test(file.name)) {
    filterFormStatus.value = "error";
    filterFormMessage.value = "Please upload a .cube file.";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const cubeData = reader.result as string;
    const name =
      newFilterName.value.trim() ||
      file.name.replace(/\.cube$/i, "") ||
      "Custom LUT";
    try {
      const added = store.addFilter(name, cubeData, newFilterActive.value);
      if (added) store.setFilterGrain(added.id, newFilterGrain.value);
      filterFormStatus.value = "success";
      filterFormMessage.value = `Added filter "${name}".`;
      newFilterName.value = "";
      newFilterActive.value = true;
      newFilterGrain.value = false;
    } catch {
      filterFormStatus.value = "error";
      filterFormMessage.value = "Failed to add filter.";
    }
  };
  reader.onerror = () => {
    filterFormStatus.value = "error";
    filterFormMessage.value = "Could not read file.";
  };
  reader.readAsText(file);
}

// Template card dropdown menu (vertical 3-dots)
const openMenuTemplateId = ref<string | null>(null);
let clickOutsideCleanup: (() => void) | null = null;
function toggleTemplateMenu(templateId: string) {
  openMenuTemplateId.value =
    openMenuTemplateId.value === templateId ? null : templateId;
}
function closeTemplateMenu() {
  clickOutsideCleanup?.();
  clickOutsideCleanup = null;
  openMenuTemplateId.value = null;
}
watch(openMenuTemplateId, (id) => {
  if (!id) return;
  const close = () => {
    closeTemplateMenu();
  };
  clickOutsideCleanup = () => {
    document.removeEventListener("click", close);
    clickOutsideCleanup = null;
  };
  nextTick(() => document.addEventListener("click", close));
});

// ── Template uploads ────────────────────────────────────────────────
// Custom templates are user-defined: any rows × cols grid, on any of
// the printer's paper shapes, with an OPTIONAL frame image (a
// frameless grid renders fine on its own — see drawPhotosIntoArea in
// PrintingView.vue). Previously the rows/cols fields were hidden
// unless a frame image was uploaded, which meant a "just give me a
// custom grid" template couldn't actually be made — fixed below by
// always showing the grid fields and always deriving photoCount from
// them (rows × cols), instead of a separately-typed, easily-mismatched
// photo count.
const TEMPLATE_UPLOAD_ENABLED = true;

// Add template modal
const showAddTemplateModal = ref(false);

// ── Layout editor (LumaBooth-style direct placement of photo slots) ──
// Edits are held locally and only written to the store on Save, so
// Cancel genuinely discards — important because this changes what
// prints.
const layoutEditorTemplate = ref<Template | null>(null);
const layoutEditorCells = ref<TemplateCell[]>([]);

function openLayoutEditor(t: Template) {
  layoutEditorTemplate.value = t;
  layoutEditorCells.value = t.cells ? JSON.parse(JSON.stringify(t.cells)) : [];
}

function closeLayoutEditor() {
  layoutEditorTemplate.value = null;
  layoutEditorCells.value = [];
}

function saveLayoutEditor() {
  const t = layoutEditorTemplate.value;
  if (!t) return;
  store.setTemplateCells(t.id, layoutEditorCells.value);
  closeLayoutEditor();
}

/** Drops hand-placed slots, reverting to auto-detected windows. */
function clearLayoutEditor() {
  const t = layoutEditorTemplate.value;
  if (!t) return;
  store.setTemplateCells(t.id, null);
  closeLayoutEditor();
}
const newTemplateName = ref("");
const newTemplateFrameImageUrl = ref("");
const frameImageInputRef = ref<HTMLInputElement | null>(null);

// Keyboard state for template name input
const showTemplateNameKeyboard = ref(false);
const keyboardInputDetected = ref(false);
let templateNameBlurTimeout: ReturnType<typeof setTimeout> | null = null;
const newTemplateThumbnailDefaultUrl = ref("");
const newTemplateThumbnailActiveUrl = ref("");
const thumbnailDefaultInputRef = ref<HTMLInputElement | null>(null);
const thumbnailActiveInputRef = ref<HTMLInputElement | null>(null);
// Grid — the actual "how dynamic can it be" knobs. Always required now
// (no more empty = "let the frame image decide"): every template,
// framed or not, needs a defined rows×cols grid to render.
const newTemplateFrameRows = ref<number>(2);
const newTemplateFrameCols = ref<number>(2);
// How many photos the guest actually SHOOTS. May be fewer than the grid
// has cells, in which case the shots repeat across the sheet — e.g. a
// 4x3 grid with 4 shots prints "4 shots, 3 copies". 0/empty means "one
// shot per cell" (shots = rows x cols).
const newTemplateShots = ref<number | null>(null);
// How captures sit in each window. "contain" shows the whole photo
// (letterboxed); "cover" fills the window but crops. Defaults to
// contain so no one's face is silently cut off.
const newTemplateFitMode = ref<"cover" | "contain">("contain");
// Nudge the photo inside its window, as a % of the window. Lets the
// operator pick which part of a zoomed-in photo stays visible.
const newTemplateOffsetX = ref<number>(0);
const newTemplateOffsetY = ref<number>(0);
/** Offsets are a % of the window; beyond ±50 the photo leaves it. */
const clampOffset = (n: number) =>
  Math.max(-50, Math.min(50, Number.isFinite(n) ? n : 0));

/** Shots + copies implied by the current grid and shot count. */
const shotPlan = computed(() => {
  const rows = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameRows.value || 1));
  const cols = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameCols.value || 1));
  const cells = rows * cols;
  const raw = Number(newTemplateShots.value);
  const shots = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), cells) : cells;
  const copies = cells / shots;
  return { cells, shots, copies, even: Number.isInteger(copies) };
});
const newTemplatePaperSize = ref<PaperSize>("4x6-portrait");
const newTemplateCellMargin = ref<number>(24);
const newTemplateCellGap = ref<number>(24);
const newTemplateCellZoom = ref<number>(1);
const newTemplatePrice = ref<number>(0);

// ── Live preview canvas (the "sandbox, brought into the form") ──────
// Renders the ACTUAL sheet size + grid + (optional) frame image, with
// a sample photo cover-fit into every cell using the exact same math
// PrintingView.vue uses at print time (see drawCoverFitCell below,
// copied from its drawPhotosIntoArea/frame-path logic) — so what the
// admin sees here is what will really print, not an approximation.
// A generated placeholder stands in until/unless the admin uploads a
// real sample photo to preview against.
const templatePreviewCanvasRef = ref<HTMLCanvasElement | null>(null);
const newTemplatePreviewPhotoUrl = ref("");
const previewPhotoInputRef = ref<HTMLInputElement | null>(null);
let placeholderCanvasEl: HTMLCanvasElement | null = null;

function getPlaceholderSampleImage(): HTMLCanvasElement {
  if (placeholderCanvasEl) return placeholderCanvasEl;
  const c = document.createElement("canvas");
  c.width = 900;
  c.height = 600; // 3:2 — matches the camera's actual capture aspect
  const cx = c.getContext("2d")!;
  const grad = cx.createLinearGradient(0, 0, 900, 600);
  grad.addColorStop(0, "#d8c8b0");
  grad.addColorStop(1, "#b0a184");
  cx.fillStyle = grad;
  cx.fillRect(0, 0, 900, 600);
  cx.fillStyle = "rgba(75,44,31,0.35)";
  cx.beginPath();
  cx.ellipse(450, 250, 110, 140, 0, 0, Math.PI * 2);
  cx.fill();
  cx.fillRect(330, 370, 240, 230);
  cx.fillStyle = "rgba(75,44,31,0.55)";
  cx.font = "bold 42px sans-serif";
  cx.textAlign = "center";
  cx.fillText("SAMPLE PHOTO", 450, 560);
  placeholderCanvasEl = c;
  return c;
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Mirrors PrintingView.vue's cover-fit-into-cell math exactly (see
// drawPhotosIntoArea) — same centring, same zoom application, same
// clip — so this preview is a true WYSIWYG of what prints.
function drawCoverFitCell(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number },
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
  zoom: number,
) {
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const imgAspect = iw / ih;
  const cAspect = cellW / cellH;
  // Mirrors PrintingView exactly, including fit mode and offset —
  // otherwise the admin's WYSIWYG would promise a different result from
  // the print.
  const fit = newTemplateFitMode.value;
  let baseW: number, baseH: number;
  const fillsWidthFirst = fit === "contain" ? imgAspect > cAspect : imgAspect <= cAspect;
  if (fillsWidthFirst) {
    baseW = cellW;
    baseH = cellW / imgAspect;
  } else {
    baseH = cellH;
    baseW = cellH * imgAspect;
  }
  const dw = baseW * zoom;
  const dh = baseH * zoom;
  const dx =
    cellX + (cellW - dw) / 2 + (cellW * clampOffset(newTemplateOffsetX.value)) / 100;
  const dy =
    cellY + (cellH - dh) / 2 + (cellH * clampOffset(newTemplateOffsetY.value)) / 100;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cellX, cellY, cellW, cellH);
  ctx.clip();
  ctx.drawImage(img, 0, 0, iw, ih, dx, dy, dw, dh);
  ctx.restore();
}

let previewRedrawToken = 0;
async function redrawTemplatePreview() {
  const myToken = ++previewRedrawToken;
  const canvas = templatePreviewCanvasRef.value;
  if (!canvas) return;

  const [frameImg, sampleImg] = await Promise.all([
    newTemplateFrameImageUrl.value
      ? loadImageEl(newTemplateFrameImageUrl.value).catch(() => null)
      : Promise.resolve(null),
    newTemplatePreviewPhotoUrl.value
      ? loadImageEl(newTemplatePreviewPhotoUrl.value).catch(() => getPlaceholderSampleImage())
      : Promise.resolve(getPlaceholderSampleImage()),
  ]);
  // A newer redraw started while these images were loading — drop this
  // stale one so fast typing/uploads can't paint out of order.
  if (myToken !== previewRedrawToken) return;
  if (!templatePreviewCanvasRef.value) return;

  const sheet = getPaperSizePx(newTemplatePaperSize.value);
  canvas.width = sheet.width;
  canvas.height = sheet.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const rows = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameRows.value || 1));
  const cols = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameCols.value || 1));
  const margin = Math.max(0, newTemplateCellMargin.value || 0);
  const gap = Math.max(0, newTemplateCellGap.value || 0);
  const zoom = Math.max(0.1, newTemplateCellZoom.value || 1);
  const innerW = sheet.width - margin * 2 - gap * (cols - 1);
  const innerH = sheet.height - margin * 2 - gap * (rows - 1);
  if (innerW <= 0 || innerH <= 0) return; // matches cellPreview.broken — nothing sane to draw

  const cellW = innerW / cols;
  const cellH = innerH / rows;
  for (let i = 0; i < rows * cols; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellX = margin + col * (cellW + gap);
    const cellY = margin + row * (cellH + gap);
    drawCoverFitCell(ctx, sampleImg, cellX, cellY, cellW, cellH, zoom);
  }

  // Frame drawn on top, filling the whole sheet — matches the
  // frame-PNG print path. (This single-sheet preview doesn't model the
  // 2×6 cut's full-sheet-vs-per-strip duplication — see PrintingView's
  // frameIsFullSheet — since that's a print-time concern, not a design
  // one: either way, this shows the ONE strip's design faithfully.)
  if (frameImg) {
    ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
  }
}

function scheduleTemplatePreviewRedraw() {
  nextTick(() => {
    void redrawTemplatePreview();
  });
}

watch(
  [
    newTemplateFrameRows,
    newTemplateFrameCols,
    newTemplateCellMargin,
    newTemplateCellGap,
    newTemplatePaperSize,
    newTemplateCellZoom,
    newTemplateFitMode,
    newTemplateOffsetX,
    newTemplateOffsetY,
    newTemplateFrameImageUrl,
    newTemplatePreviewPhotoUrl,
  ],
  () => {
    if (showAddTemplateModal.value) scheduleTemplatePreviewRedraw();
  },
);

function onPreviewPhotoChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    newTemplatePreviewPhotoUrl.value = reader.result as string;
  };
  reader.readAsDataURL(file);
}

function clearPreviewPhoto() {
  newTemplatePreviewPhotoUrl.value = "";
  if (previewPhotoInputRef.value) previewPhotoInputRef.value.value = "";
}

function triggerPreviewPhotoInput() {
  previewPhotoInputRef.value?.click();
}

const PAPER_SIZE_OPTIONS: Array<{ value: PaperSize; label: string }> = [
  { value: "4x6-portrait", label: "4×6 — Portrait (full sheet)" },
  { value: "4x6-landscape", label: "4×6 — Landscape (full sheet)" },
  { value: "2x6-portrait", label: "2×6 — Strip (prints twice, cut in half)" },
  { value: "6x8-portrait", label: "6×8 — Portrait (full sheet)" },
  { value: "6x8-landscape", label: "8×6 — Landscape (full sheet)" },
];

// Rows/cols are only clamped enough to keep the print math from
// collapsing (see cellPreview below for the REAL, quality-based
// ceiling) — 8×8 is already far past anything usable, just a safety
// backstop so a typo can't produce a zero/negative cell size.
const GRID_AXIS_MAX = 8;

// Live "will this actually look OK when printed?" preview. Cell size
// comes straight from the same math PrintingView.vue uses
// (sheet size − margins − gaps, divided across the grid), so this
// reflects the true printed size, not a guess.
const cellPreview = computed(() => {
  const sheet = getPaperSizePx(newTemplatePaperSize.value);
  const rows = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameRows.value || 1));
  const cols = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameCols.value || 1));
  const margin = Math.max(0, newTemplateCellMargin.value || 0);
  const gap = Math.max(0, newTemplateCellGap.value || 0);
  const innerW = sheet.width - margin * 2 - gap * (cols - 1);
  const innerH = sheet.height - margin * 2 - gap * (rows - 1);
  const cellWpx = innerW / cols;
  const cellHpx = innerH / rows;
  // DS-RX1 imageable area is ~307 DPI on every paper size (see
  // src/utils/printLayout.ts) — dividing px by that gives real inches.
  const DPI = 307;
  return {
    rows,
    cols,
    totalCells: rows * cols,
    cellWIn: cellWpx / DPI,
    cellHIn: cellHpx / DPI,
    broken: innerW <= 0 || innerH <= 0,
  };
});

// Soft, non-blocking guidance — not a hard cap. Thresholds come from
// what actually reads as a recognizable keepsake photo at this
// printer's ~307 DPI: a 2×6 strip only has 1844px of height to divide,
// so it gets a stricter photo-count warning than a full 4×6 sheet.
const cellSizeWarning = computed(() => {
  const p = cellPreview.value;
  if (p.broken) {
    return "This grid doesn't fit on the sheet with the current margin/gap — reduce rows, cols, margin, or gap.";
  }
  const smallestSideIn = Math.min(p.cellWIn, p.cellHIn);
  if (smallestSideIn < 0.9) {
    return `Each photo will print at only ~${p.cellWIn.toFixed(1)}"×${p.cellHIn.toFixed(1)}" — likely too small to make out faces clearly.`;
  }
  const stripLimit = newTemplatePaperSize.value === "2x6-portrait" ? 5 : 16;
  if (p.totalCells > stripLimit) {
    return `${p.totalCells} photos on this sheet is a lot — recommended max is around ${stripLimit} for this paper size before quality suffers.`;
  }
  return "";
});

function openAddTemplateModal() {
  newTemplateName.value = "";
  newTemplateFrameImageUrl.value = "";
  newTemplateShots.value = null;
  newTemplateFitMode.value = "contain";
  newTemplateOffsetX.value = 0;
  newTemplateOffsetY.value = 0;
  newTemplateFrameRows.value = 2;
  newTemplateFrameCols.value = 2;
  newTemplatePaperSize.value = "4x6-portrait";
  newTemplateCellMargin.value = 24;
  newTemplateCellGap.value = 24;
  newTemplateCellZoom.value = 1;
  newTemplatePreviewPhotoUrl.value = "";
  newTemplateThumbnailDefaultUrl.value = "";
  newTemplateThumbnailActiveUrl.value = "";
  newTemplatePrice.value = 0;
  showAddTemplateModal.value = true;
  // Reset keyboard state
  showTemplateNameKeyboard.value = false;
  keyboardInputDetected.value = false;
  if (templateNameBlurTimeout) {
    clearTimeout(templateNameBlurTimeout);
    templateNameBlurTimeout = null;
  }
  scheduleTemplatePreviewRedraw();
}

function onFrameImageChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    newTemplateFrameImageUrl.value = reader.result as string;
  };
  reader.readAsDataURL(file);
}

function clearFrameImage() {
  newTemplateFrameImageUrl.value = "";
  if (frameImageInputRef.value) frameImageInputRef.value.value = "";
}

function onThumbnailDefaultChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (
    !file ||
    (!file.type.startsWith("image/") && file.type !== "image/svg+xml")
  )
    return;
  const reader = new FileReader();
  reader.onload = () => {
    newTemplateThumbnailDefaultUrl.value = reader.result as string;
  };
  reader.readAsDataURL(file);
}

function onThumbnailActiveChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (
    !file ||
    (!file.type.startsWith("image/") && file.type !== "image/svg+xml")
  )
    return;
  const reader = new FileReader();
  reader.onload = () => {
    newTemplateThumbnailActiveUrl.value = reader.result as string;
  };
  reader.readAsDataURL(file);
}

function clearThumbnailDefault() {
  newTemplateThumbnailDefaultUrl.value = "";
  if (thumbnailDefaultInputRef.value) thumbnailDefaultInputRef.value.value = "";
}

function clearThumbnailActive() {
  newTemplateThumbnailActiveUrl.value = "";
  if (thumbnailActiveInputRef.value) thumbnailActiveInputRef.value.value = "";
}

function triggerFrameInput() {
  frameImageInputRef.value?.click();
}
function triggerThumbnailDefaultInput() {
  thumbnailDefaultInputRef.value?.click();
}
function triggerThumbnailActiveInput() {
  thumbnailActiveInputRef.value?.click();
}

function closeAddTemplateModal() {
  showAddTemplateModal.value = false;
  // Close keyboard when modal closes
  showTemplateNameKeyboard.value = false;
  keyboardInputDetected.value = false;
  if (templateNameBlurTimeout) {
    clearTimeout(templateNameBlurTimeout);
    templateNameBlurTimeout = null;
  }
}

function handleTemplateNameClick(event: MouseEvent | TouchEvent) {
  keyboardInputDetected.value = false;

  if (templateNameBlurTimeout) {
    clearTimeout(templateNameBlurTimeout);
    templateNameBlurTimeout = null;
  }

  showTemplateNameKeyboard.value = true;

  const input = event.target as HTMLInputElement;
  if (input) {
    input.focus();
  }
}

function handleTemplateNameFocus() {
  if (keyboardInputDetected.value) {
    keyboardInputDetected.value = false;
    return;
  }

  if (templateNameBlurTimeout) {
    clearTimeout(templateNameBlurTimeout);
    templateNameBlurTimeout = null;
  }

  showTemplateNameKeyboard.value = true;
}

function handleTemplateNameBlur() {
  if (templateNameBlurTimeout) {
    clearTimeout(templateNameBlurTimeout);
    templateNameBlurTimeout = null;
  }

  templateNameBlurTimeout = setTimeout(() => {
    if (document.activeElement?.tagName !== "BUTTON") {
      showTemplateNameKeyboard.value = false;
    }
    templateNameBlurTimeout = null;
  }, 200);
}

function handleTemplateNameKeyDown(_event: KeyboardEvent) {
  keyboardInputDetected.value = true;

  if (showTemplateNameKeyboard.value) {
    nextTick(() => {
      showTemplateNameKeyboard.value = false;
    });
  }
}

function updateTemplateName(value: string) {
  newTemplateName.value = value;
}

function handleTemplateNameKeyboardEnter() {
  showTemplateNameKeyboard.value = false;
}

function submitAddTemplate() {
  const name = newTemplateName.value.trim();
  if (!name) return;

  const frameRows = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameRows.value || 1));
  const frameCols = Math.max(1, Math.min(GRID_AXIS_MAX, newTemplateFrameCols.value || 1));
  // Refuse a grid that mathematically doesn't fit (see cellPreview) —
  // this is the one hard stop; everything else is just a warning.
  if (cellPreview.value.broken) return;

  // Shots the guest takes. Defaults to one per cell, but can be fewer —
  // the remaining cells repeat the same shots, which is how "4 shots,
  // 3 copies" on a 4x3 sheet is expressed. The print composite and the
  // shooting preview both index cells with `i % shots`.
  const photoCount = shotPlan.value.shots;
  // layout is only ever consulted for the generic fallback icon when a
  // template has neither a custom thumbnail nor a frame image (see
  // TemplatePreview.vue) — derive it instead of asking for it twice.
  const layout: "vertical" | "horizontal" = frameCols > frameRows ? "horizontal" : "vertical";
  const frameImageUrl = newTemplateFrameImageUrl.value.trim() || undefined;
  const thumbnailDefaultUrl =
    newTemplateThumbnailDefaultUrl.value.trim() || undefined;
  const thumbnailActiveUrl =
    newTemplateThumbnailActiveUrl.value.trim() || undefined;
  const template = store.addTemplate({
    name,
    layout,
    photoCount,
    paperSize: newTemplatePaperSize.value,
    frameImageUrl,
    frameRows,
    frameCols,
    cellMargin: Math.max(0, newTemplateCellMargin.value || 0),
    cellGap: Math.max(0, newTemplateCellGap.value || 0),
    cellZoom: Math.max(0.1, newTemplateCellZoom.value || 1),
    fitMode: newTemplateFitMode.value,
    cellOffsetX: clampOffset(newTemplateOffsetX.value),
    cellOffsetY: clampOffset(newTemplateOffsetY.value),
    thumbnailDefaultUrl,
    thumbnailActiveUrl,
  });
  const price = Number(newTemplatePrice.value);
  if (!Number.isNaN(price) && price >= 0) {
    dashboardStore.setPricePerTemplate(template.id, price);
  }
  closeAddTemplateModal();
}

function toggleActive(template: Template, event: Event) {
  event.stopPropagation();

  const currentStatus = isTemplateActive(template);
  const newStatus = !currentStatus;

  const confirmed = confirm(
    `${newStatus ? "Activate" : "Deactivate"} template "${template.name}"?\n\n` +
      `This template will ${newStatus ? "appear" : "be hidden"} in the template selection screen.`,
  );

  if (confirmed) {
    store.toggleTemplateActive(template.id);
  }
}

function isTemplateActive(template: Template): boolean {
  const foundTemplate = store.templates.find((t) => t.id === template.id);
  return foundTemplate ? foundTemplate.isActive !== false : true;
}

function handleDeleteTemplate(template: Template, event: Event) {
  event.stopPropagation();
  const confirmed = confirm(
    `Delete template "${template.name}"?\n\nThis cannot be undone.`,
  );
  if (confirmed) {
    store.removeTemplate(template.id);
  }
}
</script>

<template>
  <div class="tab-content settings-content">
    <!-- General: Logo, Title background, Fonts -->
    <section class="section general-container">
      <h2 class="section-title">General</h2>
      <div class="general-grid">
        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showLogoModal = true"
        >
          <h3 class="subsection-title">Logo</h3>
          <p class="section-desc">
            Upload a logo to show on the title screen (replaces the default).
          </p>
        </button>

        <!-- Live proof that the client's middleware is talking to us.
             Its own window is a separate Windows app and cannot be
             embedded here, so this shows the connection instead. -->
        <div class="general-card">
          <h3 class="subsection-title">
            Payment middleware
            <span class="bridge-pill" :class="`bridge-pill--${bridgeState.tone}`">
              {{ bridgeState.label }}
            </span>
          </h3>
          <p class="section-desc">
            The middleware (LumaBooth Middleware) runs as its own program and
            handles the bill acceptor and QR payments. It connects to this app
            automatically whenever both are open — there is nothing to set up.
          </p>

          <dl class="bridge-facts">
            <div>
              <dt>Listening on</dt>
              <dd>{{ bridge?.port ? `127.0.0.1:${bridge.port}` : "—" }}</dd>
            </div>
            <div>
              <dt>Payments received</dt>
              <dd>{{ bridge?.signalCount ?? 0 }}</dd>
            </div>
            <div>
              <dt>Last signal</dt>
              <dd>{{ formatSignalTime(bridge?.lastSignalAt ?? null) }}</dd>
            </div>
            <div>
              <dt>Detail</dt>
              <dd>{{ bridge?.lastSignalDetail || "No payments yet this session" }}</dd>
            </div>
          </dl>

          <p v-if="bridge?.error" class="form-error">{{ bridge.error }}</p>

          <div class="bridge-actions">
            <button type="button" class="btn-clear-bg" @click="launchMiddleware">
              Open middleware app
            </button>
            <button
              v-if="!middlewareStream"
              type="button"
              class="btn-clear-bg"
              @click="startMiddlewareView"
            >
              Show middleware
            </button>
            <template v-else>
              <button type="button" class="btn-clear-bg" @click="focusMiddleware">
                Open controls
              </button>
              <button type="button" class="btn-clear-bg" @click="stopMiddlewareView">
                Hide
              </button>
            </template>
          </div>
          <p v-if="launchMsg" class="current-setting">{{ launchMsg }}</p>
          <p v-if="middlewareViewError" class="form-error">{{ middlewareViewError }}</p>

          <!-- The middleware's real window, live. Windows won't let one
               program host another's window, so this is a view; use
               "Open controls" to bring the real one forward. -->
          <div v-show="middlewareStream" class="mw-view">
            <div class="mw-view-bar">
              <span class="mw-view-name">{{ middlewareWindowName }}</span>
              <span class="mw-view-note">live — use “Open controls” to interact</span>
            </div>
            <video ref="middlewareVideo" class="mw-view-video" muted playsinline></video>
          </div>

          <ul v-if="bridge?.recent?.length" class="bridge-log">
            <li v-for="(s, i) in bridge.recent.slice(0, 5)" :key="i">
              <span class="bridge-log-kind" :class="`bridge-log-kind--${s.kind}`">{{ s.kind }}</span>
              <span class="bridge-log-time">{{ formatSignalTime(s.at) }}</span>
              <span class="bridge-log-detail">{{ s.detail }}</span>
            </li>
          </ul>
        </div>

        <!-- Free-event switch: when off, choosing a template goes
             straight to shooting and the Payment screen never shows. -->
        <div class="general-card">
          <h3 class="subsection-title">Charge for sessions</h3>
          <p class="section-desc">
            Turn off for free events — the booth skips the payment screen and
            goes straight from template selection to shooting.
          </p>
          <label class="filters-table-status">
            <input
              type="checkbox"
              :checked="store.paymentEnabled"
              aria-label="Toggle payment"
              @change="togglePaymentEnabled"
            />
            <span>{{ store.paymentEnabled ? "On (payment required)" : "Off (free sessions)" }}</span>
          </label>
        </div>

        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showPaymentQrModal = true"
        >
          <h3 class="subsection-title">Payment QR code</h3>

          <p class="section-desc">
            Shown inside the frame on the payment screen.
            <span class="current-setting">
              {{ store.paymentQrUrl ? "QR uploaded." : "No QR — shows the amount instead." }}
            </span>
          </p>
        </button>

        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showPaymentBgModal = true"
        >
          <h3 class="subsection-title">Payment screen background</h3>
          <p class="section-desc">
            Upload an MP4 (or image) for the payment screen. Replaces the
            animated photo film strips there.
            <span class="current-setting">
              {{ store.paymentBackgroundUrl ? "Background set." : "Using the film strips." }}
            </span>
          </p>
        </button>

        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showTitleBgModal = true"
        >
          <h3 class="subsection-title">Title screen background</h3>
          <p class="section-desc">
            Upload an image or video for the title screen background.
          </p>
        </button>

        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showFontsModal = true"
        >
          <h3 class="subsection-title">Fonts</h3>
          <p class="section-desc">
            Display font for headings; body font for paragraphs and UI text.
          </p>
        </button>

        <!-- Booth identity. Every dashboard record is filtered by kiosk id,
             so two booths sharing one id have their sales merged and become
             impossible to tell apart. Set this per machine before it ships. -->
        <div class="general-card">
          <h3 class="subsection-title">Booth</h3>
          <p class="section-desc">
            Identifies this machine in the sales dashboard, and points it at
            the shared PocketBase server. Set once per booth — it is stored on
            this machine and survives app updates.
          </p>
          <label class="booth-field">
            <span>Booth ID</span>
            <input
              v-model="boothIdInput"
              type="text"
              placeholder="e.g. booth-07"
              spellcheck="false"
              @change="saveBooth"
            />
          </label>
          <label class="booth-field">
            <span>PocketBase server</span>
            <input
              v-model="pocketBaseInput"
              type="text"
              placeholder="http://192.168.1.10:8090 (blank = this machine)"
              spellcheck="false"
              @change="saveBooth"
            />
          </label>
          <p v-if="boothWarning" class="booth-warning">{{ boothWarning }}</p>
          <p v-else-if="boothSaved" class="booth-saved">Saved.</p>
        </div>

        <button
          type="button"
          class="general-card general-card--clickable"
          @click="openSecurityModal"
        >
          <h3 class="subsection-title">Admin PIN</h3>
          <p class="section-desc">
            The hidden admin gesture always asks for this PIN before opening
            the panel.
            <span class="current-setting">
              PIN is set ({{ store.adminPin.length }} digits). Default is 1234.
            </span>
          </p>
        </button>
      </div>
    </section>

    <!-- Timing: shooting, printing, QR auto-advance countdowns -->
    <section class="section general-container">
      <h2 class="section-title">Timing</h2>
      <div class="general-grid">
        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showTimingModal = true"
        >
          <h3 class="subsection-title">Countdowns</h3>
          <p class="section-desc">
            How long the shooting, printing, and QR screens count down before
            advancing automatically.
          </p>
        </button>
      </div>
    </section>

    <!-- Camera: Filters, Camera frame -->
    <section class="section general-container">
      <h2 class="section-title">Camera</h2>
      <div class="general-grid">
        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showFiltersModal = true"
        >
          <h3 class="subsection-title">Filters</h3>
          <p class="section-desc">
            Manage camera filters. Add, remove, and activate or deactivate
            filters shown on the camera screen.
          </p>
        </button>

        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showCameraFrameModal = true"
        >
          <h3 class="subsection-title">Camera frame</h3>
          <p class="section-desc">
            Customize the border: wooden, blur, color, custom image, or no
            border.
          </p>
        </button>

        <div class="general-card">
          <h3 class="subsection-title">Camera detection</h3>
          <p class="section-desc">
            Detect and connect the Canon camera. Turn OFF to run the app in
            test mode (sample photo) without a camera connected.
          </p>
          <label class="filters-table-status" style="margin-top: 0.75rem;">
            <input
              type="checkbox"
              :checked="store.cameraDetectionEnabled"
              aria-label="Toggle camera detection"
              @change="toggleCameraDetection"
            />
            <span>{{ store.cameraDetectionEnabled ? "On (real camera)" : "Off (test mode)" }}</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Printer -->
    <section class="section general-container">
      <h2 class="section-title">Printer</h2>
      <div class="general-grid">
        <button
          type="button"
          class="general-card general-card--clickable"
          @click="openPrinterModal"
        >
          <h3 class="subsection-title">Printer settings</h3>
          <p class="section-desc">
            Select which printer to use and how many copies to print per session.
            <span v-if="store.selectedPrinterName" class="current-setting">
              Current: <strong>{{ store.selectedPrinterName }}</strong>
              &nbsp;·&nbsp; {{ store.printCopies }} {{ store.printCopies === 1 ? 'copy' : 'copies' }}
              &nbsp;·&nbsp; {{ store.printCutMode === 'dnp-2-inch-cut' ? '2-inch cut' : 'standard 4x6' }}
            </span>
            <span v-else class="current-setting">
              Using system default printer.
              {{ store.printCutMode === 'dnp-2-inch-cut' ? '2-inch cut mode enabled.' : '' }}
            </span>
          </p>
        </button>
      </div>
    </section>

    <!-- Image: Templates -->
    <section class="section general-container">
      <h2 class="section-title">Image</h2>
      <div class="general-grid">
        <button
          type="button"
          class="general-card general-card--clickable"
          @click="showTemplatesModal = true"
        >
          <h3 class="subsection-title">Templates</h3>
          <p class="section-desc">
            Manage photo strip templates. Add new templates and set which are
            active for the template picker.
          </p>
        </button>
      </div>
    </section>

    <!-- Modals (General + Image) -->
    <AdminFormModal
      v-model:open="showPaymentBgModal"
      title="Payment screen background"
      description="Upload an MP4 (or image) to use as the payment screen background. It replaces the animated photo film strips on that screen."
    >
      <div
        class="upload-card upload-card--bg"
        :class="{ 'upload-card--filled': store.paymentBackgroundUrl }"
        @click="triggerPaymentBgInput()"
      >
        <input
          ref="paymentBgVideoInputRef"
          type="file"
          accept="video/mp4,video/webm,video/ogg,video/quicktime,image/*,.mp4,.webm,.ogv,.mov,.m4v"
          class="upload-card-input"
          @change="onPaymentBgChange"
        />
        <template v-if="store.paymentBackgroundUrl">
          <video
            v-if="store.paymentBackgroundType === 'video'"
            :src="store.paymentBackgroundUrl"
            class="upload-card-preview"
            muted
            autoplay
            loop
            playsinline
          />
          <img v-else :src="store.paymentBackgroundUrl" alt="" class="upload-card-preview" />
          <button
            type="button"
            class="upload-card-remove"
            aria-label="Remove"
            @click.stop="clearPaymentBackground"
          >
            ×
          </button>
        </template>
        <template v-else>
          <span class="upload-card-icon">🎬</span>
          <span class="upload-card-text">Upload background</span>
          <span class="upload-card-hint">MP4 (H.264) recommended</span>
        </template>
      </div>
      <p v-if="paymentBgBusy" class="current-setting">Saving background…</p>
      <p v-if="paymentBgError" class="form-error">{{ paymentBgError }}</p>
      <button
        v-if="store.paymentBackgroundUrl"
        type="button"
        class="btn-clear-bg"
        @click="clearPaymentBackground"
      >
        Clear payment background
      </button>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showPaymentQrModal"
      title="Payment QR code"
      description="Upload the payment QR (e.g. GCash / Maya). It is shown inside the frame on the payment screen. With no QR uploaded, the screen shows the amount and hint instead."
    >
      <div
        class="upload-card upload-card--logo"
        :class="{ 'upload-card--filled': store.paymentQrUrl }"
        @click="triggerPaymentQrInput()"
      >
        <input
          ref="paymentQrInputRef"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          class="upload-card-input"
          @change="onPaymentQrChange"
        />
        <template v-if="store.paymentQrUrl">
          <img
            :src="store.paymentQrUrl"
            alt="Payment QR code"
            class="upload-card-preview"
          />
          <button
            type="button"
            class="upload-card-remove"
            aria-label="Remove payment QR"
            @click.stop="clearPaymentQr"
          >
            ×
          </button>
        </template>
        <template v-else>
          <span class="upload-card-icon">+</span>
          <span class="upload-card-text">Upload payment QR</span>
          <span class="upload-card-hint">Crop tight to the QR — PNG, JPEG or WebP</span>
        </template>
      </div>

      <div class="form-row" style="margin-top: 1.25rem">
        <label class="form-label">
          Size — {{ Math.round(store.paymentQrScale * 100) }}%
        </label>
        <p class="form-hint form-hint-block">
          Scales the QR inside the frame on the payment screen. Reduce it if
          your QR export has little white margin of its own.
        </p>
        <input
          type="range"
          min="0.5"
          max="1.5"
          step="0.01"
          :value="store.paymentQrScale"
          class="form-range"
          :style="{ '--range-pct': `${((store.paymentQrScale - 0.5) / 1) * 100}%` }"
          @input="updateQrScale"
        />
      </div>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showLogoModal"
      title="Logo"
      description="Upload a logo to show on the title screen (replaces the default)."
    >
      <div
        class="upload-card upload-card--logo"
        :class="{ 'upload-card--filled': store.customLogoUrl }"
        @click="triggerLogoInput()"
      >
        <input
          ref="logoInputRef"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          class="upload-card-input"
          @change="onLogoChange"
        />
        <template v-if="store.customLogoUrl">
          <img
            :src="store.customLogoUrl"
            alt="Custom logo"
            class="upload-card-preview"
          />
          <button
            type="button"
            class="upload-card-remove"
            aria-label="Remove logo"
            @click.stop="clearLogo"
          >
            ×
          </button>
        </template>
        <template v-else>
          <span class="upload-card-icon">+</span>
          <span class="upload-card-text">Upload logo</span>
          <span class="upload-card-hint">PNG, JPEG, WebP or SVG</span>
        </template>
      </div>

      <div class="form-row" style="margin-top: 1.25rem">
        <label class="form-label">
          Logo size — {{ Math.round(store.titleLogoScale * 100) }}%
        </label>
        <p class="form-hint form-hint-block">
          Scales the logo on the title screen. 100% is the size in the
          approved design.
        </p>
        <input
          type="range"
          min="0.5"
          max="1.5"
          step="0.01"
          :value="store.titleLogoScale"
          class="form-range"
          :style="{ '--range-pct': `${((store.titleLogoScale - 0.5) / 1) * 100}%` }"
          @input="updateLogoScale"
        />
      </div>

      <div class="form-row" style="margin-top: 1.25rem">
        <label class="form-label">
          "Click Here To Start" button — {{ Math.round(store.startButtonScale * 100) }}%
        </label>
        <p class="form-hint form-hint-block">
          100% is the full size from the approved design; it ships at 80%
          because that reads better on a 24" screen.
        </p>
        <input
          type="range"
          min="0.5"
          max="1.5"
          step="0.01"
          :value="store.startButtonScale"
          class="form-range"
          :style="{ '--range-pct': `${((store.startButtonScale - 0.5) / 1) * 100}%` }"
          @input="updateStartBtnScale"
        />
      </div>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showTitleBgModal"
      title="Title screen background"
      description="Upload an image or video for the title screen background. Setting a background replaces the animated photo film strips."
    >
      <div class="title-bg-choice-row">
        <label class="radio-option">
          <input
            v-model="titleBgMediaChoice"
            type="radio"
            value="image"
            class="radio-input"
          />
          <span class="radio-label">Image</span>
        </label>
        <label class="radio-option">
          <input
            v-model="titleBgMediaChoice"
            type="radio"
            value="video"
            class="radio-input"
          />
          <span class="radio-label">Video</span>
        </label>
      </div>
      <div class="customize-bg-uploads customize-bg-uploads--single">
        <div
          v-show="titleBgMediaChoice === 'image'"
          class="upload-card upload-card--bg"
          :class="{
            'upload-card--filled':
              store.titleBackgroundType === 'image' && store.titleBackgroundUrl,
          }"
          @click="triggerTitleBgImageInput()"
        >
          <input
            ref="titleBgImageInputRef"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            class="upload-card-input"
            @change="onTitleBgImageChange"
          />
          <template
            v-if="
              store.titleBackgroundType === 'image' && store.titleBackgroundUrl
            "
          >
            <img
              :src="store.titleBackgroundUrl"
              alt="Background"
              class="upload-card-preview"
            />
            <button
              type="button"
              class="upload-card-remove"
              aria-label="Remove"
              @click.stop="clearTitleBackground"
            >
              ×
            </button>
          </template>
          <template v-else>
            <span class="upload-card-icon">🖼️</span>
            <span class="upload-card-text">Upload image</span>
          </template>
        </div>
        <div
          v-show="titleBgMediaChoice === 'video'"
          class="upload-card upload-card--bg"
          :class="{
            'upload-card--filled':
              store.titleBackgroundType === 'video' && store.titleBackgroundUrl,
          }"
          @click="triggerTitleBgVideoInput()"
        >
          <input
            ref="titleBgVideoInputRef"
            type="file"
            accept="video/mp4,video/webm,video/ogg,video/quicktime,.mp4,.webm,.ogv,.mov,.m4v"
            class="upload-card-input"
            @change="onTitleBgVideoChange"
          />
          <template v-if="store.titleBackgroundType === 'video' && store.titleBackgroundUrl">
            <video
              :src="store.titleBackgroundUrl"
              class="upload-card-preview"
              muted
              autoplay
              loop
              playsinline
            />
            <button type="button" class="upload-card-remove" aria-label="Remove" @click.stop="clearTitleBackground">×</button>
          </template>
          <template v-else>
            <span class="upload-card-icon">🎬</span>
            <span class="upload-card-text">Upload video</span>
          </template>
        </div>
      </div>
      <p v-if="titleBgBusy" class="current-setting">Saving background…</p>
      <p v-if="titleBgError" class="form-error">{{ titleBgError }}</p>
      <p class="form-hint form-hint-block">
        MP4 (H.264) plays most reliably. Setting a background replaces the
        animated photo film strips on the title screen.
      </p>
      <button
        v-if="store.titleBackgroundUrl"
        type="button"
        class="btn-clear-bg"
        @click="clearTitleBackground"
      >
        Clear title background
      </button>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showFontsModal"
      title="Fonts"
      description="Display font is used for headings and titles; body font for paragraphs and UI text. WOFF2, WOFF, TTF or OTF."
    >
      <div class="fonts-uploads">
        <div class="font-upload-block">
          <label class="form-label">Display font</label>
          <div
            class="upload-card upload-card--font"
            :class="{
              'upload-card--filled': store.customDisplayFontUrl,
            }"
            @click="triggerDisplayFontInput()"
          >
            <input
              ref="displayFontInputRef"
              type="file"
              :accept="FONT_ACCEPT"
              class="upload-card-input"
              @change="onDisplayFontChange"
            />
            <template v-if="store.customDisplayFontUrl">
              <span class="upload-card-text">Display font set</span>
              <button
                type="button"
                class="upload-card-remove"
                aria-label="Remove display font"
                @click.stop="store.clearCustomDisplayFont()"
              >
                ×
              </button>
            </template>
            <template v-else>
              <span class="upload-card-icon">Aa</span>
              <span class="upload-card-text">Upload</span>
              <span class="upload-card-hint">WOFF2, WOFF, TTF, OTF</span>
            </template>
          </div>
        </div>
        <div class="font-upload-block">
          <label class="form-label">Body font</label>
          <div
            class="upload-card upload-card--font"
            :class="{
              'upload-card--filled': store.customBodyFontUrl,
            }"
            @click="triggerBodyFontInput()"
          >
            <input
              ref="bodyFontInputRef"
              type="file"
              :accept="FONT_ACCEPT"
              class="upload-card-input"
              @change="onBodyFontChange"
            />
            <template v-if="store.customBodyFontUrl">
              <span class="upload-card-text">Body font set</span>
              <button
                type="button"
                class="upload-card-remove"
                aria-label="Remove body font"
                @click.stop="store.clearCustomBodyFont()"
              >
                ×
              </button>
            </template>
            <template v-else>
              <span class="upload-card-icon">Aa</span>
              <span class="upload-card-text">Upload</span>
              <span class="upload-card-hint">WOFF2, WOFF, TTF, OTF</span>
            </template>
          </div>
        </div>
      </div>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showSecurityModal"
      title="Admin PIN"
      description="The hidden 3-tap admin gesture on the title screen always asks for this PIN before opening the admin panel. Defaults to 1234."
    >
      <div class="pin-settings-form">
        <div class="current-setting" style="margin-bottom: 1rem;">
          A PIN is currently set ({{ store.adminPin.length }} digits).
        </div>
        <div class="form-row">
          <label class="form-label">New PIN (4–8 digits)</label>
          <input
            v-model="pinDraft"
            type="password"
            inputmode="numeric"
            maxlength="8"
            class="form-input"
            placeholder="Enter new PIN"
          />
        </div>
        <div class="form-row">
          <label class="form-label">Confirm PIN</label>
          <input
            v-model="pinConfirmDraft"
            type="password"
            inputmode="numeric"
            maxlength="8"
            class="form-input"
            placeholder="Re-enter new PIN"
          />
        </div>
        <p v-if="pinFormError" class="form-error">{{ pinFormError }}</p>
        <div class="pin-settings-actions">
          <button type="button" class="btn-primary" @click="saveAdminPin">
            Save PIN
          </button>
          <button
            type="button"
            class="btn-clear-bg"
            @click="resetAdminPin"
          >
            Reset to default (1234)
          </button>
        </div>
      </div>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showTimingModal"
      title="Countdowns"
      description="Controls how long each screen waits before advancing automatically."
    >
      <div class="timing-settings-form">
        <h3 class="subsection-title">Shooting</h3>
        <div class="form-row">
          <label class="form-label">First photo countdown (seconds)</label>
          <input
            type="number"
            min="1"
            max="60"
            :value="store.shootingFirstCountdownSeconds"
            class="form-input form-input--short"
            @change="updateShootingFirstCountdown"
          />
        </div>
        <div class="form-row">
          <label class="form-label">Following photos countdown (seconds)</label>
          <input
            type="number"
            min="1"
            max="60"
            :value="store.shootingSubsequentCountdownSeconds"
            class="form-input form-input--short"
            @change="updateShootingSubsequentCountdown"
          />
        </div>

        <h3 class="subsection-title" style="margin-top: 1.5rem;">Printing</h3>
        <div class="form-row">
          <label class="form-label">Auto-advance to QR screen (seconds)</label>
          <input
            type="number"
            min="1"
            max="120"
            :value="store.printingCountdownSeconds"
            class="form-input form-input--short"
            @change="updatePrintingCountdown"
          />
        </div>

        <h3 class="subsection-title" style="margin-top: 1.5rem;">QR Code</h3>
        <div class="form-row">
          <label class="filters-table-status">
            <input
              type="checkbox"
              :checked="store.qrAutoAdvanceEnabled"
              aria-label="Auto-return to title screen"
              @change="toggleQrAutoAdvance"
            />
            <span>Auto-return to title screen</span>
          </label>
        </div>
        <div v-if="store.qrAutoAdvanceEnabled" class="form-row">
          <label class="form-label">Countdown (seconds)</label>
          <input
            type="number"
            min="1"
            max="120"
            :value="store.qrCountdownSeconds"
            class="form-input form-input--short"
            @change="updateQrCountdown"
          />
        </div>
      </div>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showFiltersModal"
      title="Filters"
      description="Add LUT filters, then select one to fine-tune grain, levels, contrast and shadows on a live camera preview."
      size="wide"
    >
      <div class="filters-studio">
      <div class="filters-studio-main">
      <div class="filters-add-form">
        <fieldset class="filters-add-fieldset">
          <legend class="filters-add-legend">Add filter</legend>
          <div class="filters-add-row filters-add-row--name-status">
            <div class="filters-add-field">
              <label class="filters-add-label" for="filter-name-input">
                Name
              </label>
              <input
                id="filter-name-input"
                v-model="newFilterName"
                type="text"
                class="filters-name-input"
                placeholder="e.g. Vintage Warm"
                aria-label="Filter name (optional, defaults to filename)"
              />
            </div>
            <div class="filters-add-field">
              <label class="filters-add-label" for="filter-status-input">
                Status
              </label>
              <label class="filters-table-status filters-add-status">
                <input
                  id="filter-status-input"
                  v-model="newFilterActive"
                  type="checkbox"
                  aria-label="Set filter active on camera"
                />
                <span>{{ newFilterActive ? "Active" : "Disabled" }}</span>
              </label>
            </div>
            <div class="filters-add-field">
              <label class="filters-add-label" for="filter-grain-input">
                Grain
              </label>
              <label class="filters-table-status filters-add-status">
                <input
                  id="filter-grain-input"
                  v-model="newFilterGrain"
                  type="checkbox"
                  aria-label="Bake film grain into captures with this filter"
                />
                <span>{{ newFilterGrain ? "On" : "Off" }}</span>
              </label>
            </div>
          </div>
          <div class="filters-add-row filters-add-row--upload">
            <label class="filters-add-label">Upload .cube file</label>
            <div
              class="upload-card upload-card--cube"
              role="button"
              tabindex="0"
              aria-label="Choose .cube LUT file"
              @click="triggerCubeUpload"
              @keydown.enter.prevent="triggerCubeUpload"
              @keydown.space.prevent="triggerCubeUpload"
            >
              <input
                ref="filterCubeInputRef"
                id="filter-cube-file"
                type="file"
                accept=".cube"
                class="upload-card-input"
                aria-label="Choose .cube LUT file"
                @change="onCubeFileChange"
              />
              <span class="upload-card-icon" aria-hidden="true">◇</span>
              <span class="upload-card-text">Upload .cube file</span>
              <span class="upload-card-hint">.cube LUT</span>
            </div>
          </div>
          <div class="filters-add-actions">
            <p
              v-if="filterFormMessage"
              class="filters-form-status"
              :class="{
                'filters-form-status--success': filterFormStatus === 'success',
                'filters-form-status--error': filterFormStatus === 'error',
              }"
              role="status"
              aria-live="polite"
            >
              {{ filterFormMessage }}
            </p>
            <button
              type="button"
              class="btn btn-primary filters-add-btn"
              @click="triggerCubeUpload"
            >
              Add filter
            </button>
          </div>
        </fieldset>
      </div>
      <div class="filters-table-wrap">
        <table class="filters-table" role="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Grain</th>
              <th scope="col">Overlay</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="f in store.filters"
              :key="f.id"
              :class="{
                'filters-table-row--inactive': !f.isActive,
                'filters-table-row--selected': editingFilter?.id === f.id,
              }"
              @click="selectFilterRow(f.id)"
            >
              <td class="filters-table-name">{{ f.name }}</td>
              <td>
                <label class="filters-table-status">
                  <input
                    type="checkbox"
                    :checked="f.isActive"
                    aria-label="Toggle filter on camera"
                    @change="toggleFilterActive(f.id)"
                  />
                  <span>{{ f.isActive ? "Active" : "Disabled" }}</span>
                </label>
              </td>
              <td>
                <label class="filters-table-status">
                  <input
                    type="checkbox"
                    :checked="store.filterWantsGrain(f)"
                    aria-label="Toggle film grain for this filter"
                    @change="toggleFilterGrain(f.id, $event)"
                  />
                  <span>{{ store.filterWantsGrain(f) ? "On" : "Off" }}</span>
                </label>
              </td>
              <!-- Colour wash, the equivalent of a Photoshop fill layer set
                   to a blend mode. Applies on top of whatever this filter's
                   effect already did, so it works on its own or combined
                   with sepia / B&W / a LUT. -->
              <td>
                <div class="filter-overlay-cell">
                  <label class="filters-table-status">
                    <input
                      type="checkbox"
                      :checked="!!f.overlay"
                      aria-label="Toggle colour overlay for this filter"
                      @change="toggleFilterOverlay(f, $event)"
                    />
                    <span>{{ f.overlay ? "On" : "Off" }}</span>
                  </label>

                  <template v-if="f.overlay">
                    <input
                      type="color"
                      class="filter-overlay-color"
                      :value="f.overlay.color"
                      aria-label="Overlay colour"
                      @input="updateOverlay(f, { color: ($event.target as HTMLInputElement).value })"
                    />
                    <select
                      class="filter-overlay-mode"
                      :value="f.overlay.blendMode"
                      aria-label="Overlay blend mode"
                      @change="updateOverlay(f, { blendMode: ($event.target as HTMLSelectElement).value as BlendMode })"
                    >
                      <option v-for="m in BLEND_MODES" :key="m.value" :value="m.value">
                        {{ m.label }}
                      </option>
                    </select>
                    <label class="filter-overlay-opacity">
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        :value="Math.round(f.overlay.opacity * 100)"
                        :style="{ '--range-pct': `${Math.round(f.overlay.opacity * 100)}%` }"
                        aria-label="Overlay opacity"
                        @input="updateOverlay(f, { opacity: Number(($event.target as HTMLInputElement).value) / 100 })"
                      />
                      <span class="filter-overlay-opacity-value">
                        {{ Math.round(f.overlay.opacity * 100) }}%
                      </span>
                    </label>
                  </template>
                </div>
              </td>
              <td>
                <button
                  v-if="!store.isDefaultFilter(f.id)"
                  type="button"
                  class="filters-table-delete"
                  aria-label="Delete filter"
                  title="Delete"
                  @click="removeFilter(f.id)"
                >
                  ×
                </button>
                <span v-else class="filters-table-action-placeholder">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      </div>
      <aside class="filters-studio-side">
        <FilterLivePreview
          v-if="showFiltersModal"
          :filter="editingFilter"
        />
        <div v-if="editingFilter" class="filter-adjust">
          <h3 class="filter-adjust-title">Advanced adjustments</h3>
          <p class="filter-adjust-hint">
            Fine-tune {{ editingFilter.name }}. Changes apply live and are saved on this filter.
          </p>
          <label class="filter-adjust-row">
            <span>Grain</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              :value="editingAdj.grain"
              :style="{ '--range-pct': `${editingAdj.grain}%` }"
              @input="updateAdjustment('grain', Number(($event.target as HTMLInputElement).value))"
            />
            <span class="filter-adjust-value">{{ editingAdj.grain }}</span>
          </label>
          <label class="filter-adjust-row">
            <span>Levels</span>
            <input
              type="range"
              min="-100"
              max="100"
              step="1"
              :value="editingAdj.levels"
              :style="{ '--range-pct': `${(editingAdj.levels + 100) / 2}%` }"
              @input="updateAdjustment('levels', Number(($event.target as HTMLInputElement).value))"
            />
            <span class="filter-adjust-value">{{ editingAdj.levels }}</span>
          </label>
          <label class="filter-adjust-row">
            <span>Contrast</span>
            <input
              type="range"
              min="-100"
              max="100"
              step="1"
              :value="editingAdj.contrast"
              :style="{ '--range-pct': `${(editingAdj.contrast + 100) / 2}%` }"
              @input="updateAdjustment('contrast', Number(($event.target as HTMLInputElement).value))"
            />
            <span class="filter-adjust-value">{{ editingAdj.contrast }}</span>
          </label>
          <label class="filter-adjust-row">
            <span>Shadows</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              :value="editingAdj.shadows"
              :style="{ '--range-pct': `${editingAdj.shadows}%` }"
              @input="updateAdjustment('shadows', Number(($event.target as HTMLInputElement).value))"
            />
            <span class="filter-adjust-value">{{ editingAdj.shadows }}</span>
          </label>
        </div>
      </aside>
      </div>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showCameraFrameModal"
      title="Camera frame"
      description="Choose the border style: Wooden, Blur (live feed as border), Color, Custom, or No border."
    >
      <div class="camera-frame-options">
        <!-- Camera preview first, centered -->
        <div class="camera-frame-preview-wrap">
          <span class="camera-frame-preview-label">Preview</span>
          <div
            class="camera-frame-preview"
            :class="{
              'camera-frame--wooden': cameraFrameStyle === 'wooden',
              'camera-frame--blur': cameraFrameStyle === 'blur',
              'camera-frame--color': cameraFrameStyle === 'color',
              'camera-frame--svg': cameraFrameStyle === 'svg',
              'camera-frame--none': cameraFrameStyle === 'none',
            }"
            :style="
              cameraFrameStyle === 'color'
                ? { '--camera-frame-color': cameraFrameColor }
                : cameraFrameStyle === 'svg' && cameraFrameSvgUrl
                  ? { '--camera-frame-bg-image': `url(${cameraFrameSvgUrl})` }
                  : {}
            "
          >
            <div class="camera-frame-preview-inner"></div>
          </div>
        </div>

        <div class="camera-frame-dropdown-row">
          <label class="form-label" for="camera-frame-style">Frame style</label>
          <select
            id="camera-frame-style"
            class="form-select camera-frame-select"
            :value="cameraFrameStyle"
            @change="
              store.setCameraFrameStyle(
                ($event.target as HTMLSelectElement).value as CameraFrameStyle,
              )
            "
          >
            <option
              v-for="opt in CAMERA_FRAME_OPTIONS"
              :key="opt.value"
              :value="opt.value"
            >
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div v-if="cameraFrameStyle === 'color'" class="camera-frame-color-row">
          <label class="form-label" for="camera-frame-color"
            >Border color</label
          >
          <div class="camera-frame-color-input-wrap">
            <input
              id="camera-frame-color"
              type="color"
              :value="cameraFrameColor"
              class="camera-frame-color-picker"
              @input="
                store.setCameraFrameColor(
                  ($event.target as HTMLInputElement).value,
                )
              "
            />
            <input
              type="text"
              :value="cameraFrameColor"
              class="camera-frame-color-text"
              placeholder="#8B7355"
              @input="
                store.setCameraFrameColor(
                  ($event.target as HTMLInputElement).value,
                )
              "
            />
          </div>
        </div>

        <div v-if="cameraFrameStyle === 'svg'" class="camera-frame-svg-row">
          <label class="form-label">Custom border image</label>
          <p class="form-hint form-hint-block">
            Upload an image or SVG to use as the camera frame border
            (tiled/repeated).
          </p>
          <div
            class="upload-card upload-card--frame-svg"
            :class="{ 'upload-card--filled': cameraFrameSvgUrl }"
            @click="triggerCameraFrameSvgInput()"
          >
            <input
              ref="cameraFrameSvgInputRef"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              class="upload-card-input"
              @change="onCameraFrameSvgChange"
            />
            <template v-if="cameraFrameSvgUrl">
              <img
                :src="cameraFrameSvgUrl"
                alt="Frame"
                class="upload-card-preview"
              />
              <button
                type="button"
                class="upload-card-remove"
                aria-label="Remove"
                @click.stop="clearCameraFrameSvg"
              >
                ×
              </button>
            </template>
            <template v-else>
              <span class="upload-card-icon">+</span>
              <span class="upload-card-text">Upload image</span>
              <span class="upload-card-hint">PNG, JPEG, WebP, SVG</span>
            </template>
          </div>
        </div>
      </div>
    </AdminFormModal>

    <!-- Printer modal -->
    <AdminFormModal
      v-model:open="showPrinterModal"
      title="Printer settings"
      description="Select the printer and number of copies. The composite photo will be sent automatically after each session."
    >
      <div class="printer-settings">
        <!-- Copies -->
        <div class="form-row">
          <label class="form-label">Copies per session</label>
          <input
            type="number"
            min="1"
            max="10"
            :value="store.printCopies"
            class="form-input form-input--short"
            @change="updateCopies"
          />
        </div>

        <div class="form-row">
          <label class="form-label">Cut mode</label>
          <div class="printer-list">
            <label
              class="printer-option"
              :class="{ 'printer-option--active': store.printCutMode === 'standard' }"
            >
              <input
                type="radio"
                name="print-cut-mode"
                value="standard"
                :checked="store.printCutMode === 'standard'"
                @change="selectPrintCutMode('standard')"
              />
              <span class="printer-name">Standard 4x6 print</span>
            </label>
            <label
              class="printer-option"
              :class="{ 'printer-option--active': store.printCutMode === 'dnp-2-inch-cut' }"
            >
              <input
                type="radio"
                name="print-cut-mode"
                value="dnp-2-inch-cut"
                :checked="store.printCutMode === 'dnp-2-inch-cut'"
                @change="selectPrintCutMode('dnp-2-inch-cut')"
              />
              <span class="printer-name">
                DNP 2-inch cut
                <span class="printer-default-badge">2x6 x2</span>
              </span>
            </label>
          </div>
          <p class="form-hint form-hint-block">
            The app sends one 4x6 sheet with two duplicate 6x2 strips stacked
            top and bottom. The DNP printer physically cuts the sheet in half,
            producing two 2x6 photo strips per print.
          </p>
          <div
            v-if="store.printCutMode === 'dnp-2-inch-cut'"
            class="cut-mode-driver-setup"
          >
            <button
              type="button"
              class="open-printer-props-btn"
              :disabled="openingPrinterProps"
              @click="openPrinterProperties"
            >
              {{ openingPrinterProps ? "Opening…" : "Open printer settings" }}
            </button>
            <p class="form-hint form-hint-block">
              The DNP "2inch cut" toggle is a vendor driver feature — it
              has to be enabled inside the Windows printer dialog. Click the
              button above to open it, then go to
              <strong>Advanced</strong> tab →
              <strong>Printing Defaults…</strong> →
              <strong>Advanced…</strong> →
              <strong>Printer Features</strong> →
              set <strong>2inch cut: Enable</strong> → OK. Paper Size stays
              <strong>(6x4)</strong>. This only has to be done once.
            </p>
            <p v-if="openPrinterError" class="printer-error">
              {{ openPrinterError }}
            </p>
          </div>
        </div>

        <!-- Printer list -->
        <div class="form-row">
          <label class="form-label">Printer</label>
          <div v-if="printerLoading" class="printer-loading">Loading printers…</div>
          <div v-else-if="printerError" class="printer-error">{{ printerError }}</div>
          <div v-else class="printer-list">
            <!-- Default option -->
            <label class="printer-option" :class="{ 'printer-option--active': !store.selectedPrinterName }">
              <input
                type="radio"
                name="printer"
                value=""
                :checked="!store.selectedPrinterName"
                @change="selectPrinter('')"
              />
              <span class="printer-name">System default printer</span>
            </label>

            <label
              v-for="p in availablePrinters"
              :key="p.name"
              class="printer-option"
              :class="{ 'printer-option--active': store.selectedPrinterName === p.name }"
            >
              <input
                type="radio"
                name="printer"
                :value="p.name"
                :checked="store.selectedPrinterName === p.name"
                @change="selectPrinter(p.name)"
              />
              <span class="printer-name">
                {{ p.displayName || p.name }}
                <span v-if="p.isDefault" class="printer-default-badge">default</span>
              </span>
            </label>

            <p v-if="availablePrinters.length === 0" class="printer-empty">
              No printers found. Make sure a printer is installed on this machine.
            </p>

            <button type="button" class="btn-refresh" @click="loadPrinters">↻ Refresh</button>
          </div>
        </div>
      </div>
    </AdminFormModal>

    <AdminFormModal
      v-model:open="showTemplatesModal"
      title="Templates"
      description="Photo strip templates. These are fixed for now — the set below is what shows in the template picker."
      size="large"
    >
      <div class="templates-grid">
        <div
          v-for="t in store.templates"
          :key="t.id"
          class="template-card template-card--custom"
          :class="{ 'template-card--inactive': t.isActive === false }"
        >
          <div class="template-menu-wrap template-menu-wrap--top-right">
            <button
              type="button"
              class="template-control-btn template-menu-btn"
              aria-label="Template options"
              aria-haspopup="true"
              :aria-expanded="openMenuTemplateId === t.id"
              @click.stop="toggleTemplateMenu(t.id)"
            >
              <span class="template-menu-dots" aria-hidden="true">⋮</span>
            </button>
            <div
              v-if="openMenuTemplateId === t.id"
              class="template-menu-dropdown"
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                class="template-menu-item"
                @click.stop="
                  toggleActive(t, $event);
                  closeTemplateMenu();
                "
              >
                {{ t.isActive !== false ? "Set inactive" : "Set active" }}
              </button>
              <button
                type="button"
                role="menuitem"
                class="template-menu-item"
                @click.stop="
                  openLayoutEditor(t);
                  closeTemplateMenu();
                "
              >
                Edit layout…
              </button>
              <button
                v-if="!store.isBuiltinTemplate(t.id)"
                type="button"
                role="menuitem"
                class="template-menu-item template-menu-item--danger"
                @click.stop="
                  handleDeleteTemplate(t, $event);
                  closeTemplateMenu();
                "
              >
                Delete
              </button>
            </div>
          </div>
          <TemplatePreview :template="t" size="mini" prefer-active-thumbnail />
          <p class="template-label">{{ t.name }}</p>

          <div
            class="template-status-badge"
            :class="{
              'status-active': t.isActive !== false,
              'status-inactive': t.isActive === false,
            }"
          >
            <span class="status-dot"></span>
            <span class="status-text">{{
              t.isActive !== false ? "Active" : "Inactive"
            }}</span>
          </div>
        </div>

        <!-- Opens the add-template modal (rows×cols grid, any paper
             size, optional frame image). -->
        <div
          v-if="TEMPLATE_UPLOAD_ENABLED"
          class="template-card add-template-card"
          @click="openAddTemplateModal"
        >
          <div class="add-template-placeholder">
            <span class="add-icon">+</span>
            <span class="add-text">Add new template</span>
          </div>
        </div>
      </div>

      <!-- Add-template modal — lets an admin define a custom rows×cols
           grid on any paper size, with an optional frame image. -->
      <div
        v-if="TEMPLATE_UPLOAD_ENABLED && showAddTemplateModal"
        class="modal-overlay"
        @click.self="closeAddTemplateModal"
      >
        <div class="modal add-template-modal">
          <h3 class="modal-title add-template-modal__header">Add new template</h3>
          <form
            id="add-template-form"
            class="add-template-form"
            @submit.prevent="submitAddTemplate"
          >
            <!-- Landscape two-column layout: left = name/paper/price/grid
                 fields (compact, text-driven); right = frame image +
                 live preview (visual, needs more vertical room). Putting
                 these side by side instead of all-stacked is what keeps
                 the modal short enough to fit on screen without the top
                 or bottom clipping off. -->
            <div class="add-template-columns">
              <div class="add-template-col add-template-col--left">
                <div class="form-row">
                  <div class="form-row-field form-row-field--full">
                    <label class="form-label">Name</label>
                    <input
                      id="template-name-input"
                      v-model="newTemplateName"
                      type="text"
                      class="form-input"
                      :class="{ 'keyboard-active': showTemplateNameKeyboard }"
                      placeholder="e.g. My Strip 5"
                      required
                      @click="handleTemplateNameClick"
                      @touchstart="handleTemplateNameClick"
                      @focus="handleTemplateNameFocus"
                      @blur="handleTemplateNameBlur"
                      @keydown="handleTemplateNameKeyDown"
                    />

                    <div v-if="showTemplateNameKeyboard" class="keyboard-wrapper">
                      <OnScreenKeyboard
                        :model-value="newTemplateName"
                        input-type="text"
                        @update:model-value="updateTemplateName"
                        @enter="handleTemplateNameKeyboardEnter"
                      />
                    </div>
                  </div>
                </div>
                <div class="form-row form-row--layout-and-number">
                  <div class="form-row-field">
                    <label class="form-label">Paper size</label>
                    <select v-model="newTemplatePaperSize" class="form-select">
                      <option
                        v-for="opt in PAPER_SIZE_OPTIONS"
                        :key="opt.value"
                        :value="opt.value"
                      >
                        {{ opt.label }}
                      </option>
                    </select>
                  </div>
                  <div class="form-row-field">
                    <label class="form-label">Price (₱)</label>
                    <input
                      v-model.number="newTemplatePrice"
                      type="number"
                      class="form-input"
                      min="0"
                      step="0.01"
                      placeholder="0"
                    />
                  </div>
                </div>

                <label class="form-label">Grid — rows × columns</label>
                <p class="form-hint form-hint-block">
                  This is what makes the template dynamic: any grid shape
                  works, with or without a frame image. Leave "Shots" empty to
                  take one photo per cell, or set it lower to repeat the same
                  shots as copies on the sheet.
                </p>
                <p class="form-hint form-hint-block">
                  <strong>
                    {{ shotPlan.cells }} cells → {{ shotPlan.shots }} shot{{ shotPlan.shots === 1 ? "" : "s" }}
                    <template v-if="shotPlan.copies > 1"> × {{ shotPlan.copies }} copies</template>
                  </strong>
                  <span v-if="!shotPlan.even" class="form-error">
                    — {{ shotPlan.shots }} doesn't divide evenly into
                    {{ shotPlan.cells }} cells, so the last copy will be partial.
                  </span>
                </p>
                <div class="frame-layout-fields">
                  <div class="frame-layout-field">
                    <label class="form-sublabel">Rows</label>
                    <input
                      v-model.number="newTemplateFrameRows"
                      type="number"
                      class="form-input"
                      min="1"
                      :max="GRID_AXIS_MAX"
                    />
                  </div>
                  <div class="frame-layout-field">
                    <label class="form-sublabel">Cols</label>
                    <input
                      v-model.number="newTemplateFrameCols"
                      type="number"
                      class="form-input"
                      min="1"
                      :max="GRID_AXIS_MAX"
                    />
                  </div>
                  <div class="frame-layout-field">
                    <label class="form-sublabel">Photo fit</label>
                    <select v-model="newTemplateFitMode" class="form-input">
                      <option value="contain">Whole photo (no crop)</option>
                      <option value="cover">Fill window (crops)</option>
                    </select>
                  </div>
                  <div class="frame-layout-field">
                    <label class="form-sublabel">Shots</label>
                    <input
                      v-model.number="newTemplateShots"
                      type="number"
                      class="form-input"
                      min="1"
                      :max="shotPlan.cells"
                      :placeholder="String(shotPlan.cells)"
                    />
                  </div>
                  <div class="frame-layout-field">
                    <label class="form-sublabel">Margin (px)</label>
                    <input
                      v-model.number="newTemplateCellMargin"
                      type="number"
                      class="form-input"
                      min="0"
                    />
                  </div>
                  <div class="frame-layout-field">
                    <label class="form-sublabel">Gap (px)</label>
                    <input
                      v-model.number="newTemplateCellGap"
                      type="number"
                      class="form-input"
                      min="0"
                    />
                  </div>
                  <div class="frame-layout-field frame-layout-field--wide">
                    <label class="form-sublabel">Zoom ({{ newTemplateCellZoom.toFixed(2) }}×)</label>
                    <input
                      v-model.number="newTemplateCellZoom"
                      type="range"
                      class="form-range"
                      min="0.5"
                      max="2"
                      step="0.01"
                      :style="{ '--range-pct': `${((newTemplateCellZoom - 0.5) / 1.5) * 100}%` }"
                    />
                  </div>
                  <div class="frame-layout-field frame-layout-field--wide">
                    <label class="form-sublabel">
                      Move photo — across {{ newTemplateOffsetX }}% / down
                      {{ newTemplateOffsetY }}%
                    </label>
                    <input
                      v-model.number="newTemplateOffsetX"
                      type="range"
                      class="form-range"
                      min="-50"
                      max="50"
                      step="1"
                      :style="{ '--range-pct': `${newTemplateOffsetX + 50}%` }"
                    />
                    <input
                      v-model.number="newTemplateOffsetY"
                      type="range"
                      class="form-range"
                      min="-50"
                      max="50"
                      step="1"
                      :style="{ '--range-pct': `${newTemplateOffsetY + 50}%` }"
                    />
                  </div>
                </div>
                <p class="form-hint form-hint-block">
                  Zoom past 1.00× to fill the window (the overflow is cropped),
                  then use the sliders to choose which part stays visible — e.g.
                  move the photo down so heads aren't cut off. The preview below
                  updates as you go and is exactly what prints.
                </p>
                <!-- Live, math-accurate preview of what actually prints —
                     same cell-size formula PrintingView.vue uses, so this
                     isn't a guess. Turns into a visible warning (not a
                     block) once cells get too small to be a good keepsake,
                     or a hard note if the grid genuinely doesn't fit. -->
                <p
                  class="form-hint form-hint-block cell-preview"
                  :class="{ 'cell-preview--warn': cellSizeWarning }"
                >
                  Each photo cell prints at ~{{ cellPreview.cellWIn.toFixed(1) }}"
                  × {{ cellPreview.cellHIn.toFixed(1) }}" ({{ cellPreview.totalCells }}
                  photo{{ cellPreview.totalCells === 1 ? "" : "s" }} total).
                  <template v-if="cellSizeWarning">
                    <br />⚠️ {{ cellSizeWarning }}
                  </template>
                </p>
              </div>

              <div class="add-template-col add-template-col--right">
                <label class="form-label">Frame image (optional)</label>
                <div
                  class="upload-card"
                  :class="{
                    'upload-card--filled': newTemplateFrameImageUrl,
                  }"
                  @click="triggerFrameInput()"
                >
                  <input
                    ref="frameImageInputRef"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    class="upload-card-input"
                    @change="onFrameImageChange"
                  />
                  <template v-if="newTemplateFrameImageUrl">
                    <img
                      :src="newTemplateFrameImageUrl"
                      alt="Frame"
                      class="upload-card-preview"
                    />
                    <button
                      type="button"
                      class="upload-card-remove"
                      aria-label="Remove"
                      @click.stop="clearFrameImage"
                    >
                      ×
                    </button>
                  </template>
                  <template v-else>
                    <span class="upload-card-icon">+</span>
                    <span class="upload-card-text">Add frame image</span>
                    <span class="upload-card-hint">
                      Leave empty for a plain photo grid. If provided, it
                      must be pre-made to match the grid — its transparent
                      windows won't move to fit whatever rows/cols you pick.
                    </span>
                  </template>
                </div>
                <div class="preview-photo-actions">
                  <button
                    type="button"
                    class="preview-photo-btn"
                    @click="triggerPreviewPhotoInput()"
                  >
                    {{ newTemplatePreviewPhotoUrl ? "Change" : "Upload a" }} sample
                    photo to preview with
                  </button>
                  <button
                    v-if="newTemplatePreviewPhotoUrl"
                    type="button"
                    class="preview-photo-btn preview-photo-btn--clear"
                    @click="clearPreviewPhoto()"
                  >
                    Use placeholder instead
                  </button>
                </div>
                <input
                  ref="previewPhotoInputRef"
                  type="file"
                  accept="image/*"
                  class="upload-card-input"
                  @change="onPreviewPhotoChange"
                />

                <label class="form-label">Live preview</label>
                <p class="form-hint form-hint-block">
                  Exactly what will print — same sheet size, grid, and
                  cover-fit math as a real capture.
                </p>
                <canvas
                  ref="templatePreviewCanvasRef"
                  class="template-live-preview"
                ></canvas>
              </div>
            </div>

            <label class="form-label">Thumbnail (selection preview)</label>
            <p class="form-hint form-hint-block">
              Shown in template picker. Default = unselected, Active = selected.
            </p>
            <div class="upload-cards-row">
              <div
                class="upload-card upload-card--thumb"
                :class="{
                  'upload-card--filled': newTemplateThumbnailDefaultUrl,
                }"
                @click="triggerThumbnailDefaultInput()"
              >
                <input
                  ref="thumbnailDefaultInputRef"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  class="upload-card-input"
                  @change="onThumbnailDefaultChange"
                />
                <template v-if="newTemplateThumbnailDefaultUrl">
                  <img
                    :src="newTemplateThumbnailDefaultUrl"
                    alt="Default"
                    class="upload-card-preview"
                  />
                  <button
                    type="button"
                    class="upload-card-remove"
                    aria-label="Remove"
                    @click.stop="clearThumbnailDefault"
                  >
                    ×
                  </button>
                </template>
                <template v-else>
                  <span class="upload-card-icon">+</span>
                  <span class="upload-card-text">Default</span>
                </template>
              </div>
              <div
                class="upload-card upload-card--thumb"
                :class="{
                  'upload-card--filled': newTemplateThumbnailActiveUrl,
                }"
                @click="triggerThumbnailActiveInput()"
              >
                <input
                  ref="thumbnailActiveInputRef"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  class="upload-card-input"
                  @change="onThumbnailActiveChange"
                />
                <template v-if="newTemplateThumbnailActiveUrl">
                  <img
                    :src="newTemplateThumbnailActiveUrl"
                    alt="Active"
                    class="upload-card-preview"
                  />
                  <button
                    type="button"
                    class="upload-card-remove"
                    aria-label="Remove"
                    @click.stop="clearThumbnailActive"
                  >
                    ×
                  </button>
                </template>
                <template v-else>
                  <span class="upload-card-icon">+</span>
                  <span class="upload-card-text">Active</span>
                </template>
              </div>
            </div>
          </form>
          <!-- Outside the scrollable <form> so it stays pinned as a
               footer regardless of scroll position — see
               .add-template-modal's flex-column layout below. The
               submit button targets the form by id since it's no
               longer a DOM descendant of it. -->
          <div class="modal-actions add-template-modal__footer">
            <button
              type="button"
              class="btn btn-secondary"
              @click="closeAddTemplateModal"
            >
              Cancel
            </button>
            <button type="submit" form="add-template-form" class="btn btn-primary">
              Add template
            </button>
          </div>
        </div>
      </div>
    </AdminFormModal>

    <!-- Photo-slot layout editor. Positions where each capture lands on
         the sheet by direct manipulation, replacing the zoom/offset
         sliders for templates whose artwork needs exact placement. -->
    <AdminFormModal
      :open="!!layoutEditorTemplate"
      :title="`Photo layout — ${layoutEditorTemplate?.name ?? ''}`"
      size="large"
      @close="closeLayoutEditor"
    >
      <div v-if="layoutEditorTemplate" class="layout-editor-modal">
        <TemplateLayoutEditor
          v-model="layoutEditorCells"
          :photo-count="layoutEditorTemplate.photoCount"
          :frame-image-url="layoutEditorTemplate.frameImageUrl"
          :paper-size="layoutEditorTemplate.paperSize"
          :frame-rows="layoutEditorTemplate.frameRows"
          :frame-cols="layoutEditorTemplate.frameCols"
        />

        <div class="modal-actions">
          <button
            v-if="layoutEditorTemplate.cells?.length"
            type="button"
            class="btn btn-secondary"
            @click="clearLayoutEditor"
          >
            Use automatic placement
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            @click="closeLayoutEditor"
          >
            Cancel
          </button>
          <button type="button" class="btn btn-primary" @click="saveLayoutEditor">
            Save layout
          </button>
        </div>
      </div>
    </AdminFormModal>
  </div>
</template>

<style scoped>
.tab-content {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.section {
  background: transparent;
  border-radius: 12px;
  padding: 1.25rem;
}

.section-title {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  margin: 0 0 0.5rem 0;
}

.section-desc {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown-light);
  margin: 0 0 1rem 0;
}

.general-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.general-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
}

.fonts-uploads {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

@media (max-width: 500px) {
  .fonts-uploads {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 1100px) {
  .general-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 900px) {
  .general-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 500px) {
  .general-grid {
    grid-template-columns: 1fr;
  }
}

/* Live view of the middleware's own window */
.mw-view {
  margin-top: 0.9rem;
  border: 1px solid var(--color-cream-dark);
  border-radius: 8px;
  overflow: hidden;
  background: #1c1c1c;
}
.mw-view-bar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.4rem 0.7rem;
  background: #2a2622;
  color: #efe7db;
  font-size: 0.75rem;
}
.mw-view-name {
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mw-view-note {
  opacity: 0.7;
  white-space: nowrap;
}
.mw-view-video {
  display: block;
  width: 100%;
  max-height: 460px;
  object-fit: contain;
  background: #101010;
}

/* ── Payment middleware status panel ── */
.bridge-pill {
  display: inline-block;
  margin-left: 0.6rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  vertical-align: middle;
}
.bridge-pill--good { background: #e0f0e2; color: #2f6b39; }
.bridge-pill--warn { background: #fdf0d8; color: #8a6318; }
.bridge-pill--bad { background: #f8e2e0; color: #9a3b32; }
.bridge-pill--idle { background: #eceae4; color: #6b6157; }

.bridge-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.6rem 1rem;
  margin: 0.9rem 0 0.6rem;
}
.bridge-facts dt {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-brown-light);
  font-weight: 700;
}
.bridge-facts dd {
  margin: 0.15rem 0 0;
  font-size: 0.9rem;
  color: var(--color-brown-dark);
  word-break: break-word;
}

.bridge-actions {
  display: flex;
  gap: 0.6rem;
  margin-top: 0.6rem;
}

.bridge-log {
  list-style: none;
  margin: 0.9rem 0 0;
  padding: 0.6rem 0 0;
  border-top: 1px solid var(--color-cream-dark);
  font-size: 0.82rem;
}
.bridge-log li {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  padding: 0.2rem 0;
}
.bridge-log-kind {
  min-width: 54px;
  font-weight: 700;
  text-transform: uppercase;
  font-size: 0.68rem;
}
.bridge-log-kind--paid { color: #2f6b39; }
.bridge-log-kind--partial { color: #8a6318; }
.bridge-log-kind--failed { color: #9a3b32; }
.bridge-log-kind--other { color: var(--color-brown-light); }
.bridge-log-time { color: var(--color-brown-light); }
.bridge-log-detail { color: var(--color-brown-dark); }

.general-card {
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 12px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}

.general-card--clickable {
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.general-card--clickable:hover {
  border-color: var(--color-brown);
  background: var(--color-cream-dark);
}

.general-card--clickable .subsection-title {
  margin: 0 0 0.25rem 0;
}

.general-card--clickable .section-desc {
  margin: 0;
  font-size: 0.85rem;
}

.customize-bg-uploads--stacked {
  grid-template-columns: 1fr;
}

.subsection-title {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  margin: 0 0 0.25rem 0;
}

.title-bg-choice-row {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1rem;
}

.radio-option {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--color-brown-dark);
}

.radio-input {
  width: 1.1rem;
  height: 1.1rem;
  accent-color: var(--color-brown);
  cursor: pointer;
}

.radio-label {
  user-select: none;
}

.customize-bg-uploads {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.customize-bg-uploads--single {
  grid-template-columns: 1fr;
}

.upload-card--logo {
  width: 100%;
  height: 100%;
  margin: 0 auto;
}

.upload-card--bg {
  min-height: 100px;
}

.upload-card--bg .upload-card-preview {
  object-fit: cover;
}

.upload-card--bg video.upload-card-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.btn-clear-bg {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown);
  background: transparent;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-clear-bg:hover {
  background: var(--color-cream);
  border-color: var(--color-brown);
}

.btn-primary {
  padding: 0.5rem 1.25rem;
  font-size: 0.95rem;
  font-family: var(--font-display);
  font-weight: 600;
  border-radius: 8px;
  border: 2px solid var(--color-brown);
  background: linear-gradient(180deg, #e8c872 0%, #c9a227 50%, #a68520 100%);
  color: var(--color-brown-dark);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary:hover {
  filter: brightness(1.05);
}

.form-error {
  color: #b23b3b;
  font-family: var(--font-body);
  font-size: 0.85rem;
  margin: 0.25rem 0 0;
}

.pin-settings-form,
.timing-settings-form {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.pin-settings-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
}

.font-upload-block {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.upload-card--font {
  min-height: 100px;
}

.upload-card--font .upload-card-icon {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

/* Add filter form */
.filters-add-form {
  margin-bottom: 1.25rem;
}

.filters-add-fieldset {
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  background: var(--color-cream);
  margin: 0;
}

.filters-add-legend {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--color-brown-dark);
  padding: 0 0.5rem;
  margin-bottom: 0.75rem;
}

.filters-add-row {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
}

.filters-add-row:last-of-type {
  margin-bottom: 0;
}

.filters-add-row--name-status {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 1.5rem;
}

.filters-add-row--name-status .filters-add-field:first-child {
  flex: 1 1 70%;
  min-width: 200px;
}

.filters-add-row--name-status .filters-add-field:last-child {
  flex: 0 0 auto;
}

.filters-add-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.filters-add-field .filters-name-input {
  max-width: 100%;
}

.filters-add-label {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--color-brown-dark);
}

.filters-add-row--upload {
  flex-direction: column;
  align-items: stretch;
}

.filters-add-row--upload .filters-add-label {
  flex: none;
}

.upload-card--cube {
  width: 100%;
  min-height: 100px;
}

.upload-card--cube .upload-card-icon {
  font-size: 1.5rem;
}

.filters-add-btn {
  padding: 0.5rem 1.25rem;
  font-size: 0.95rem;
  font-family: var(--font-display);
  font-weight: 600;
  border-radius: 8px;
  border: 2px solid var(--color-brown);
  background: linear-gradient(180deg, #e8c872 0%, #c9a227 50%, #a68520 100%);
  color: var(--color-brown-dark);
  cursor: pointer;
  transition: all 0.2s ease;
}

.filters-add-btn:hover {
  filter: brightness(1.05);
}

.filters-name-input {
  width: 100%;
  max-width: 280px;
  padding: 0.5rem 0.75rem;
  font-family: var(--font-body);
  font-size: 0.95rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-brown-dark);
}

.filters-name-input::placeholder {
  color: var(--color-brown-light);
}

.filters-name-input:focus {
  outline: 2px solid var(--color-gold);
  outline-offset: 2px;
}

.filters-add-status {
  margin-top: 0.25rem;
}

.filters-add-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1rem;
}

.filters-add-actions .filters-form-status {
  margin-right: auto;
}

.filters-form-status {
  margin: 0;
  font-size: 0.9rem;
  color: var(--color-brown-dark);
}

.filters-form-status--success {
  color: #276749;
}

.filters-form-status--error {
  color: #c53030;
}

.filters-table-wrap {
  overflow-x: auto;
  margin-top: 0.5rem;
}

.filters-studio {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 1.25rem;
  align-items: start;
}

.filters-studio-side {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.filters-table tbody tr {
  cursor: pointer;
}

.filters-table-row--selected {
  background: rgba(201, 162, 39, 0.18);
}

.filters-table-row--selected:hover {
  background: rgba(201, 162, 39, 0.26);
}

.filter-adjust {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
}

.filter-adjust-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--color-brown-dark);
}

.filter-adjust-hint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-brown);
  line-height: 1.35;
}

.filter-adjust-row {
  display: grid;
  grid-template-columns: 5.2rem 1fr 2.6rem;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

.filter-adjust-row input[type="range"] {
  width: 100%;
}

.filter-adjust-value {
  font-variant-numeric: tabular-nums;
  text-align: right;
  font-weight: 600;
}

@media (max-width: 860px) {
  .filters-studio {
    grid-template-columns: 1fr;
  }
}

.filters-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-body);
  font-size: 0.9rem;
}

.filters-table th,
.filters-table td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--color-brown-light);
}

.filters-table th {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--color-brown-dark);
  background: var(--color-cream);
}

.filters-table tbody tr:hover {
  background: var(--color-cream-dark);
}

.filters-table-row--inactive {
  opacity: 0.75;
}

.filters-table-name {
  font-weight: 600;
  color: var(--color-brown-dark);
}

/* Colour-overlay controls: colour, blend mode and opacity on one row. */
.booth-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  font-size: 0.9rem;
  color: var(--color-brown-dark);
}

.booth-field input:not([type="range"]) {
  padding: 8px 10px;
  border: 1px solid var(--color-cream-dark);
  border-radius: 6px;
  font-family: inherit;
  font-size: 0.9rem;
}

.booth-warning {
  margin: 10px 0 0;
  font-size: 0.85rem;
  color: #b23b3b;
}

.booth-saved {
  margin: 10px 0 0;
  font-size: 0.85rem;
  opacity: 0.75;
}

.filter-overlay-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.filter-overlay-color {
  width: 38px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--color-cream-dark);
  border-radius: 6px;
  background: none;
  cursor: pointer;
}

.filter-overlay-mode {
  padding: 4px 6px;
  border: 1px solid var(--color-cream-dark);
  border-radius: 6px;
  background: #fff;
  font-size: 0.85rem;
}

.filter-overlay-opacity {
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter-overlay-opacity input[type="range"] {
  width: 90px;
}

.filter-overlay-opacity-value {
  font-variant-numeric: tabular-nums;
  font-size: 0.8rem;
  min-width: 3ch;
}

.filters-table-status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  user-select: none;
}

.filters-table-status input[type="checkbox"] {
  width: 1.1rem;
  height: 1.1rem;
  accent-color: var(--color-brown);
  cursor: pointer;
}

.filters-table-delete {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-brown-light);
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  transition: all 0.2s ease;
}

.filters-table-delete:hover {
  background: rgba(229, 62, 62, 0.15);
  color: #c53030;
}

.filters-table-action-placeholder {
  color: var(--color-brown-light);
  font-size: 0.9rem;
}

.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 1rem;
}

.template-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 10px;
  transition: all 0.2s ease;
}

.template-card:hover {
  border-color: var(--color-brown-dark);
  box-shadow: var(--shadow-soft);
}

.template-card--custom {
  position: relative;
}

.template-card--inactive {
  opacity: 0.6;
  border-color: var(--color-brown-light);
}

.template-card--inactive .template-label {
  color: var(--color-brown-light);
}

.template-status-badge {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.25rem 0.5rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: var(--font-body);
}

.status-active {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
}

.status-inactive {
  background: rgba(156, 163, 175, 0.15);
  color: #6b7280;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-text {
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.template-menu-wrap {
  position: relative;
}

.template-menu-wrap--top-right {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
}

.template-control-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--color-brown-dark);
  font-size: 1rem;
  line-height: 1;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.template-control-btn:hover {
  border-color: var(--color-brown-dark);
  transform: scale(1.1);
}

.template-menu-btn {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 0.8;
}

.template-menu-dots {
  letter-spacing: -0.2em;
  user-select: none;
}

.template-menu-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 140px;
  padding: 0.25rem;
  background: var(--color-cream-dark);
  border: 2px solid var(--color-brown-dark);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.template-menu-item {
  display: block;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-brown-dark);
  font-size: 0.875rem;
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.template-menu-item:hover {
  background: rgba(0, 0, 0, 0.06);
}

.template-menu-item--danger {
  color: #dc2626;
}

.template-menu-item--danger:hover {
  background: rgba(239, 68, 68, 0.12);
}

.template-label {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown-dark);
  margin: 0.75rem 0 0 0;
  text-align: center;
}

.add-template-card {
  min-height: 180px;
  cursor: pointer;
}

.add-template-card .add-template-placeholder {
  flex: 1;
  width: 100%;
  min-height: 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: var(--color-cream);
  border: 2px dashed var(--color-brown-light);
  border-radius: 10px;
  color: var(--color-brown-light);
  transition: all 0.2s ease;
}

.add-template-card:hover .add-template-placeholder {
  border-color: var(--color-brown);
  color: var(--color-brown);
}

.add-icon {
  font-size: 2.5rem;
  font-weight: 300;
  line-height: 1;
}

.add-text {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 600;
  text-align: center;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(61, 43, 31, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 2rem;
}

.modal {
  background: var(--color-cream);
  border: 3px solid var(--color-brown-dark);
  border-radius: 16px;
  padding: 1.5rem;
  max-width: 800px;
  width: 100%;
  box-shadow: var(--shadow-hard);
}

/* The add-template form has a lot of fields (grid controls + a live
 * preview canvas), so it gets its own layout: full screen width, and
 * a flex-column structure where the title (header) and Cancel/Save
 * buttons (footer) are structural siblings OUTSIDE the scrollable
 * <form> — not `position: sticky` on an inline element, which can
 * misbehave depending on the scroll container's overflow/stacking
 * context. Sitting outside the scroll area entirely guarantees they
 * stay visible no matter how tall the form content gets. Padding
 * moves from the shared `.modal` rule (padding: 1.5rem) onto the
 * header/form/footer individually so each can control its own edges. */
.add-template-modal {
  width: 96vw;
  max-width: 96vw;
  max-height: 92vh;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-title {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0 0 1.5rem 0;
}

.add-template-modal__header {
  flex-shrink: 0;
  margin: 0;
  padding: 1.5rem 1.5rem 1rem;
  border-bottom: 2px solid var(--color-brown-light);
  background: var(--color-cream);
}

.add-template-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem 1.5rem;
}

.add-template-modal__footer {
  flex-shrink: 0;
  margin: 0;
  padding: 1rem 1.5rem;
  border-top: 2px solid var(--color-brown-light);
  background: var(--color-cream);
}

.form-row {
  display: flex;
  gap: 1rem;
  align-items: flex-end;
  flex-wrap: wrap;
}

.form-row-field {
  flex: 0 1 auto;
  min-width: 0;
}

.form-row-field--full {
  flex: 1 1 100%;
  min-width: 0;
}

.form-row--layout-and-number .form-row-field {
  flex: 1 1 0;
  min-width: 100px;
}

.form-label {
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

.form-input,
.form-select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--color-brown-dark);
  background: var(--color-cream-dark);
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
}

.form-input:focus,
.form-select:focus {
  outline: none;
  border-color: var(--color-brown-dark);
}

.form-input.keyboard-active {
  border-color: var(--color-brown-dark);
  box-shadow: 0 0 0 3px rgba(61, 43, 31, 0.15);
}

.template-name-input-wrap {
  position: relative;
  width: 100%;
}

.template-name-display {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--color-brown-dark);
  word-break: break-word;
  box-sizing: border-box;
  pointer-events: none;
}

.template-name-input {
  position: absolute;
  inset: 0;
  color: transparent;
  caret-color: var(--color-brown-dark);
  background: transparent !important;
  padding: 0.5rem 0.75rem;
  font-family: var(--font-body);
  font-size: 1rem;
}

.keyboard-wrapper {
  margin-top: 0.75rem;
  width: 100%;
  max-width: 100%;
  padding: 0;
  box-sizing: border-box;
  overflow: hidden;
  display: block;
}

.form-hint {
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--color-brown-light);
  margin: -0.25rem 0 0 0;
}

.form-hint-block {
  margin-bottom: 0.5rem;
}

.form-sublabel {
  font-family: var(--font-body);
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--color-brown);
  margin: 0.5rem 0 0.25rem 0;
}

/* Landscape two-column layout — see the template above: left column
 * is compact/text-driven (name, paper size, grid numbers), right
 * column is visual (frame upload + live preview canvas), so the form
 * grows WIDE rather than TALL and fits on screen without clipping. */
.add-template-columns {
  display: flex;
  gap: 2rem;
  align-items: flex-start;
  flex-wrap: wrap;
}

.add-template-col {
  flex: 1 1 380px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.add-template-col--left {
  /* Text/number fields don't need to stretch just because the modal
   * is now full-width — cap it and let the right column (frame +
   * live preview) absorb the extra space instead. */
  flex: 0 1 480px;
  max-width: 480px;
}

.add-template-col--right {
  flex: 1 1 420px;
}

.frame-layout-field--wide {
  flex: 1 1 100%;
}

.preview-photo-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.form-range {
  width: 100%;
}

.template-live-preview {
  width: 100%;
  /* Bumped up from 320px now that the modal is nearly full-width — the
   * right column has real room to give, and a bigger preview makes
   * alignment easier to judge. */
  max-width: 520px;
  height: auto;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  background: #fff;
  display: block;
}

.preview-photo-btn {
  flex: 1 1 auto;
  margin-top: 0;
  padding: 0.5rem 0.75rem;
  font-family: var(--font-body);
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--color-brown-dark);
  background: var(--color-cream-dark);
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  cursor: pointer;
}

.preview-photo-btn:hover {
  border-color: var(--color-brown-dark);
}

.preview-photo-btn--clear {
  background: transparent;
  color: var(--color-brown-light);
}

.frame-layout-column {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 1 1 0;
  min-width: 0;
}

.frame-layout-fields {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.frame-layout-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1 1 100px;
  min-width: 90px;
}

.cell-preview {
  color: var(--color-brown);
  background: var(--color-cream-dark);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}

.cell-preview--warn {
  color: #8a4a1f;
  background: #fbe8d3;
}

.upload-card {
  position: relative;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 1rem;
  background: var(--color-cream);
  border: 2px dashed var(--color-brown-light);
  border-radius: 10px;
  color: var(--color-brown-light);
  cursor: pointer;
  transition: all 0.2s ease;
}

.upload-card:hover {
  border-color: var(--color-brown);
  color: var(--color-brown);
}

.upload-card--filled {
  border-style: solid;
  border-color: var(--color-brown-light);
  color: var(--color-brown-dark);
  min-height: 100px;
}

.upload-card--filled:hover {
  border-color: var(--color-brown);
}

.upload-card-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.upload-card-preview {
  width: 100%;
  height: 100%;
  min-height: 80px;
  max-height: 140px;
  object-fit: contain;
  display: block;
  border-radius: 6px;
}

.upload-card--thumb .upload-card-preview {
  max-height: 90px;
}

.upload-card-remove {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--color-brown-dark);
  color: var(--color-cream);
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.upload-card-remove:hover {
  background: var(--color-brown);
  transform: scale(1.05);
}

.upload-card-icon {
  font-size: 2rem;
  font-weight: 300;
  line-height: 1;
}

.upload-card-text {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 600;
  text-align: center;
}

.upload-card-hint {
  font-family: var(--font-body);
  font-size: 0.8rem;
  opacity: 0.8;
}

.upload-cards-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.upload-card--thumb {
  min-height: 100px;
}

.upload-card--thumb .upload-card-icon {
  font-size: 1.5rem;
}

.upload-card--thumb .upload-card-text {
  font-size: 0.9rem;
}

.modal-actions {
  display: flex;
  gap: 1rem;
  margin-top: 1rem;
  justify-content: flex-end;
}

.modal-actions .btn {
  padding: 0.5rem 1.25rem;
  font-size: 0.95rem;
  font-family: var(--font-display);
  font-weight: 600;
  border-radius: 8px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.2s ease;
}

.modal-actions .btn-primary {
  background: linear-gradient(180deg, #e8c872 0%, #c9a227 50%, #a68520 100%);
  color: var(--color-brown-dark);
  border-color: var(--color-brown);
}

.modal-actions .btn-primary:hover {
  filter: brightness(1.05);
}

.modal-actions .btn-secondary {
  background: var(--color-cream-dark);
  color: var(--color-brown-dark);
  border-color: var(--color-brown-light);
}

.modal-actions .btn-secondary:hover {
  background: var(--color-brown-light);
  color: var(--color-cream);
}

/* Printer settings */
.printer-settings {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* Cut-mode driver setup block — appears when DNP 2-inch cut is selected */
.cut-mode-driver-setup {
  margin-top: 0.75rem;
  padding: 0.9rem 1rem;
  background: rgba(61, 43, 31, 0.04);
  border: 1.5px dashed var(--color-brown-light);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.open-printer-props-btn {
  align-self: flex-start;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  padding: 0.55rem 1.2rem;
  background: var(--color-brown);
  color: var(--color-cream);
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}

.open-printer-props-btn:hover:not(:disabled) {
  background: var(--color-brown-dark);
}

.open-printer-props-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.printer-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}

.printer-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: 1.5px solid var(--color-brown-light);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.printer-option:hover {
  border-color: var(--color-brown);
  background: rgba(61, 43, 31, 0.04);
}

.printer-option--active {
  border-color: var(--color-brown);
  background: rgba(61, 43, 31, 0.07);
}

.printer-name {
  font-size: 0.95rem;
  color: var(--color-brown-dark);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.printer-default-badge {
  font-size: 0.7rem;
  background: var(--color-brown-light);
  color: var(--color-cream);
  padding: 0.1rem 0.4rem;
  border-radius: 8px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.printer-loading,
.printer-error,
.printer-empty {
  font-size: 0.9rem;
  padding: 0.75rem;
  border-radius: 8px;
  color: var(--color-brown-dark);
}

.printer-error { background: rgba(160,40,40,0.08); color: #a02828; }

.btn-refresh {
  margin-top: 0.5rem;
  align-self: flex-start;
  font-size: 0.85rem;
  padding: 0.4rem 0.9rem;
  background: none;
  border: 1.5px solid var(--color-brown-light);
  border-radius: 20px;
  cursor: pointer;
  color: var(--color-brown);
  transition: all 0.15s;
}

.btn-refresh:hover {
  background: var(--color-brown-light);
  color: var(--color-cream);
}

.form-input--short {
  width: 80px;
}

.current-setting {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.82rem;
  color: var(--color-brown-light);
}

/* Camera frame modal */
.camera-frame-options {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.camera-frame-dropdown-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.camera-frame-select {
  max-width: 220px;
}

/* Camera preview - mirrors CameraView frame styles, centered */
.camera-frame-preview-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.camera-frame-preview-label {
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

.camera-frame-preview {
  width: 100%;
  max-width: 320px;
  aspect-ratio: 4/3;
  padding: 12px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(61, 43, 31, 0.25);
  position: relative;
  overflow: hidden;
  margin: 0 auto;
}

.camera-frame-preview-inner {
  width: 100%;
  height: 100%;
  background: #1a1a1a;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-body);
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.5);
}

.camera-frame-preview-inner::after {
  content: "Camera view";
}

/* Frame style variants (same as CameraView) */
.camera-frame-preview.camera-frame--none {
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.camera-frame-preview.camera-frame--wooden {
  background: url("/wood.svg") repeat;
  background-color: var(--color-wood);
}

/* Blur: live feed as border - preview shows blurred edges + sharp center */
.camera-frame-preview.camera-frame--blur {
  background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 50%, #2a2a2a 100%);
  padding: 0;
}

.camera-frame-preview.camera-frame--blur .camera-frame-preview-inner {
  width: 70%;
  height: 70%;
  margin: 15% auto;
}

.camera-frame-preview.camera-frame--blur .camera-frame-preview-inner::after {
  content: "Live blur border";
  font-size: 0.65rem;
}

.camera-frame-preview.camera-frame--color {
  background-color: var(--camera-frame-color, #8b7355);
}

.camera-frame-preview.camera-frame--svg {
  background-image: var(--camera-frame-bg-image);
  background-repeat: repeat;
  background-color: var(--color-wood);
}

.camera-frame-color-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.camera-frame-color-input-wrap {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.camera-frame-color-picker {
  width: 48px;
  height: 36px;
  padding: 2px;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  cursor: pointer;
  background: var(--color-cream-dark);
}

.camera-frame-color-text {
  flex: 1;
  max-width: 120px;
  padding: 0.5rem 0.75rem;
  font-family: var(--font-body);
  font-size: 0.95rem;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-brown-dark);
}

.camera-frame-svg-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.upload-card--frame-svg {
  min-height: 100px;
}
</style>
