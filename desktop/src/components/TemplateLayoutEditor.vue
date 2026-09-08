<script setup lang="ts">
/**
 * Direct-manipulation layout editor for a template's photo slots —
 * the LumaBooth "Photo Layout" behaviour the client asked for.
 *
 * The operator sees the frame artwork at its true paper aspect with a
 * numbered rectangle per capture on top. Drag the body to move, drag a
 * corner to resize, drag the stalk handle below the box to rotate.
 *
 * Slots are stored as FRACTIONS of the print area (see TemplateCell in
 * the store), never pixels, so the same template composites correctly
 * whatever size the sheet is rendered at.
 *
 * Why DOM elements and not a <canvas>: hit-testing, focus rings and
 * touch targets come free, and a rotated slot is just a CSS transform.
 * The print composite reproduces the same maths on canvas.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import {
  openVideoStream,
  stopWebcamTracks,
  webcamErrorMessage,
} from "@/utils/openCamera";
import { getFrameWindows } from "@/utils/frameWindows";
import type { WindowRect } from "@/utils/frameWindows";
import {
  getPaperSizePx,
  getTemplateCellRects,
  PAPER_SIZES,
  type PaperSize,
} from "@/utils/printLayout";
import type { TemplateCell } from "@/stores/photobooth";
import { prepareFrameDataUrl } from "@/utils/pngAlpha";
import {
  cellShotNumber,
  downloadPhotoLayoutFile,
  draftTemplateFromLayoutPng,
  embedImageAsDataUrl,
  layoutFileSlug,
  parsePhotoLayoutDocumentJson,
  serializePhotoLayout,
  stampCellShots,
} from "@/utils/photoLayoutFile";

const props = withDefaults(
  defineProps<{
    modelValue: TemplateCell[];
    photoCount: number;
    frameImageUrl?: string;
    paperSize?: PaperSize;
    /** Grid used to seed slots when the frame has no detectable windows. */
    frameRows?: number;
    frameCols?: number;
    /** Print-cell inset/spacing in sheet pixels — same as the template form. */
    cellMargin?: number;
    cellGap?: number;
    cellZoom?: number;
    cellOffsetX?: number;
    cellOffsetY?: number;
    fitMode?: "cover" | "contain";
    /** Used only for the exported filename. */
    layoutName?: string;
    /** Hide Image / paper controls when those live on the parent form. */
    embedded?: boolean;
  }>(),
  {
    photoCount: 4,
    frameRows: 0,
    frameCols: 0,
    cellMargin: 24,
    cellGap: 24,
    cellZoom: 1,
    cellOffsetX: 0,
    cellOffsetY: 0,
    fitMode: "contain",
    layoutName: "",
    embedded: false,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", cells: TemplateCell[]): void;
  (e: "update:frameImageUrl", url: string): void;
  (e: "update:paperSize", size: PaperSize): void;
  (e: "update:photoCount", count: number): void;
  (e: "update:layoutName", name: string): void;
}>();

const stage = ref<HTMLElement | null>(null);
const cells = ref<TemplateCell[]>([]);
const selected = ref<number>(-1);
const lockAspect = ref(false);
const seedNote = ref("");

// Undo/redo hold JSON snapshots. A snapshot is pushed when a gesture
// ENDS, not while dragging — otherwise one drag would fill the stack.
const undoStack = ref<string[]>([]);
const redoStack = ref<string[]>([]);
const canUndo = computed(() => undoStack.value.length > 0);
const canRedo = computed(() => redoStack.value.length > 0);

const paperAspect = computed(() => {
  const spec = getPaperSizePx(props.paperSize);
  return spec.width / spec.height;
});

const displayFrameUrl = ref("");
watch(
  () => props.frameImageUrl,
  async (url) => {
    displayFrameUrl.value = url || "";
    if (!url) return;
    try {
      displayFrameUrl.value = await prepareFrameDataUrl(url);
    } catch {
      /* keep the original src */
    }
  },
  { immediate: true },
);

watch(
  () => props.frameImageUrl,
  async (url, prev) => {
    if (!url || url === prev) return;
    if (cells.value.length > 1) return;
    await seed();
  },
);

function snapshot() {
  undoStack.value.push(JSON.stringify(cells.value));
  // A new edit invalidates the redo branch.
  redoStack.value = [];
  if (undoStack.value.length > 50) undoStack.value.shift();
}

function undo() {
  const prev = undoStack.value.pop();
  if (!prev) return;
  redoStack.value.push(JSON.stringify(cells.value));
  cells.value = JSON.parse(prev);
  commit();
}

function redo() {
  const next = redoStack.value.pop();
  if (!next) return;
  undoStack.value.push(JSON.stringify(cells.value));
  cells.value = JSON.parse(next);
  commit();
}

function commit() {
  emit("update:modelValue", JSON.parse(JSON.stringify(cells.value)));
  const shots = Math.max(
    1,
    ...cells.value.map((c, i) => cellShotNumber(c, i, props.photoCount)),
  );
  if (shots > props.photoCount) emit("update:photoCount", shots);
}

/** An evenly spaced grid matching the form's rows × cols, margin, and gap. */
function gridSeed(count: number): TemplateCell[] {
  const cols = Math.max(1, props.frameCols || (count <= 2 ? 1 : 2));
  const rows = Math.max(
    1,
    props.frameRows || Math.ceil(count / cols),
    Math.ceil(count / cols),
  );
  const spec = getPaperSizePx(props.paperSize);
  const rects = getTemplateCellRects({
    paperSize: props.paperSize,
    photoCount: count,
    frameRows: rows,
    frameCols: cols,
    cellMargin: props.cellMargin,
    cellGap: props.cellGap,
  });
  const fromRects = stampCellShots(
    rects.map((r) => ({
      x: r.x / spec.width,
      y: r.y / spec.height,
      w: r.width / spec.width,
      h: r.height / spec.height,
      rotation: 0,
    })),
    Math.max(1, props.photoCount),
  );
  if (fromRects.length >= count) return fromRects.slice(0, count);
  const margin = 0.04;
  const gap = 0.02;
  const w = (1 - margin * 2 - gap * (cols - 1)) / cols;
  const h = (1 - margin * 2 - gap * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, i) => ({
    x: margin + (i % cols) * (w + gap),
    y: margin + Math.floor(i / cols) * (h + gap),
    w,
    h,
    rotation: 0,
    shot: (i % Math.max(1, props.photoCount)) + 1,
  }));
}

function applyGridFromForm() {
  const n = Math.max(
    1,
    Math.max(1, props.frameRows || 1) * Math.max(1, props.frameCols || 1),
  );
  cells.value = gridSeed(n);
  if (selected.value >= cells.value.length) selected.value = -1;
  commit();
}

/**
 * Natural size of an image, resolved from the `load` event.
 *
 * This used to call `img.decode()`. That promise waits for a *render*-ready
 * decode, and a page that isn't compositing (a hidden window, a background
 * tab, an offscreen test runner) can leave it pending forever — which hung
 * `seed()` before it ever assigned a slot, leaving the editor blank with no
 * error. We only ever needed naturalWidth/Height, which `load` already
 * guarantees, so wait for that instead and never block on rasterisation.
 */
function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = () =>
      resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onload = done;
    img.onerror = () => resolve({ w: 1, h: 1 });
    img.src = src;
    // A cached image can already be complete before the handler is attached.
    if (img.complete && img.naturalWidth) done();
  });
}

/**
 * Which capture lands in slot `i`. The compositor indexes the captures
 * positionally (`slot % photoCount`), so this is the single source of
 * truth for "slot 5 shows shot 1 again".
 */
function shotFor(i: number) {
  return cellShotNumber(cells.value[i], i, props.photoCount);
}

/**
 * The detector returns windows in reading order — left→right, then down.
 * That is correct while every window gets its own capture, but wrong the
 * moment a shot repeats: because slot→shot is positional, reading order
 * down a three-wide strip yields shots 1, 4, 3, 2 rather than 1, 2, 3, 4.
 *
 * So when the artwork carries MORE windows than the template has shots,
 * re-order them column-major: each column then reads shot 1..N downward
 * and the columns repeat, which is the strip people expect. When the
 * counts match — every template that exists today — the order is returned
 * untouched, so nothing already in the field moves.
 */
function orderForShots(windows: WindowRect[], shots: number): WindowRect[] {
  if (shots <= 0 || windows.length <= shots) return windows;
  const cols: WindowRect[][] = [];
  for (const w of [...windows].sort((a, b) => a.x - b.x)) {
    const col = cols.find(
      (grp) => Math.abs(grp[0].x - w.x) < Math.min(grp[0].width, w.width) * 0.5,
    );
    if (col) col.push(w);
    else cols.push([w]);
  }
  cols.forEach((col) => col.sort((a, b) => a.y - b.y));
  return cols.flat();
}

/**
 * Seed the editor so the operator starts from the placement the app is
 * ALREADY using, not a blank grid — otherwise opening the editor and
 * saving would silently move every photo.
 */
async function seed() {
  const count = Math.max(1, props.photoCount);
  if (props.frameImageUrl) {
    try {
      // Deliberately WITHOUT an expected count. Frame artwork may hold more
      // windows than the template has shots (three columns of four hearts,
      // four captures); demanding an exact match made the detector return
      // null and dropped the operator onto a flat grid instead.
      const detected = await getFrameWindows(props.frameImageUrl);
      const windows = detected && orderForShots(detected, count);
      if (windows && windows.length) {
        const { w: fw, h: fh } = await imageSize(props.frameImageUrl);
        cells.value = stampCellShots(
          windows.map((r) => ({
            x: r.x / fw,
            y: r.y / fh,
            w: r.width / fw,
            h: r.height / fh,
            rotation: 0,
          })),
          count,
        );
        seedNote.value = `Started from the ${windows.length} window(s) detected in the frame artwork.`;
        commit();
        return;
      }
    } catch {
      /* fall through to the grid */
    }
  }
  cells.value = gridSeed(count);
  seedNote.value = "No windows detected in the artwork — started from an even grid.";
  commit();
}

function resetLayout() {
  snapshot();
  seed();
}

async function exportLayout() {
  if (!cells.value.length) {
    seedNote.value = "Nothing to export yet — add or reset slots first.";
    return;
  }
  let frameImage: string | undefined;
  try {
    frameImage = await embedImageAsDataUrl(props.frameImageUrl);
  } catch {
    frameImage = undefined;
  }
  const payload = serializePhotoLayout({
    name: props.layoutName,
    photoCount: props.photoCount,
    paperSize: props.paperSize,
    cells: cells.value,
    frameImage,
    frameRows: props.frameRows,
    frameCols: props.frameCols,
  });
  downloadPhotoLayoutFile(
    payload,
    `${layoutFileSlug(props.layoutName || "photo-layout")}.photo-layout.json`,
  );
  seedNote.value = frameImage
    ? `Exported ${cells.value.length} slot(s) and the layout PNG.`
    : `Exported ${cells.value.length} slot(s). Add a layout PNG before exporting to include it.`;
}

const store = usePhotoboothStore();
const testShotOn = ref(false);
const testShotUrl = ref("");
const placeholderShotUrl = ref("");
const testShotInputRef = ref<HTMLInputElement | null>(null);
const testCameraStream = ref<MediaStream | null>(null);
const testCameraOn = ref(false);
const testCameraBusy = ref(false);
const previewFullscreen = ref(false);

function bindCameraVideo(el: unknown) {
  const video = el as HTMLVideoElement | null;
  if (!video || !testCameraStream.value) return;
  if (video.srcObject !== testCameraStream.value) {
    video.srcObject = testCameraStream.value;
    video.muted = true;
    void video.play().catch(() => {});
  }
}

async function stopTestCamera() {
  stopWebcamTracks(testCameraStream.value);
  testCameraStream.value = null;
  testCameraOn.value = false;
  if (store.cameraDetectionEnabled) {
    void window.electronAPI?.canonStopLiveView?.();
  }
}

async function startCanonTest(): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.canonCheckAvailable || !store.cameraDetectionEnabled) return false;
  try {
    const available = await api.canonCheckAvailable();
    if (!available.available) return false;
    const listed = await api.canonListCameras();
    if (!listed.success || !listed.cameras?.length) return false;
    const connected = await api.canonConnect(0);
    if (!connected.success) return false;
    const live = await api.canonStartLiveView();
    if (!live.success) return false;
    api.onLiveViewFrame((dataUrl: string) => {
      testShotUrl.value = dataUrl;
    });
    testCameraOn.value = true;
    testShotOn.value = true;
    seedNote.value =
      "Live camera in the slots. Open fullscreen to check the print.";
    return true;
  } catch {
    return false;
  }
}

async function startTestCamera() {
  if (testCameraBusy.value) return;
  testCameraBusy.value = true;
  try {
    if (await startCanonTest()) return;
    const media = await openVideoStream(testCameraStream.value);
    testCameraStream.value = media;
    testCameraOn.value = true;
    testShotOn.value = true;
    await nextTick();
    seedNote.value =
      "Live camera in the slots. Open fullscreen to check the print.";
  } catch (err) {
    seedNote.value = webcamErrorMessage(err);
  } finally {
    testCameraBusy.value = false;
  }
}

async function toggleTestCamera() {
  if (testCameraOn.value) {
    await stopTestCamera();
    if (!testShotUrl.value) testShotUrl.value = makePlaceholderShot();
    seedNote.value = "Camera off — slots still show the test photo.";
    return;
  }
  await startTestCamera();
}

function toggleFullscreenPreview() {
  previewFullscreen.value = !previewFullscreen.value;
}

function makePlaceholderShot(): string {
  const c = document.createElement("canvas");
  c.width = 900;
  c.height = 600;
  const cx = c.getContext("2d")!;
  const grad = cx.createLinearGradient(0, 0, 900, 600);
  grad.addColorStop(0, "#d8c8b0");
  grad.addColorStop(1, "#8a7358");
  cx.fillStyle = grad;
  cx.fillRect(0, 0, 900, 600);
  cx.fillStyle = "rgba(61, 43, 31, 0.35)";
  cx.beginPath();
  cx.arc(450, 240, 90, 0, Math.PI * 2);
  cx.fill();
  cx.fillRect(330, 360, 240, 160);
  cx.fillStyle = "#f7f2e6";
  cx.font = "700 42px Georgia, serif";
  cx.textAlign = "center";
  cx.fillText("Test shot", 450, 80);
  return c.toDataURL("image/jpeg", 0.85);
}

watch(
  () =>
    [props.cellZoom, props.cellOffsetX, props.cellOffsetY, props.fitMode] as const,
  () => {
    if (!placeholderShotUrl.value) placeholderShotUrl.value = makePlaceholderShot();
    if (!testShotUrl.value) testShotUrl.value = placeholderShotUrl.value;
    if (!testCameraOn.value) testShotOn.value = true;
  },
);

function toggleTestShot() {
  if (testShotOn.value) {
    void stopTestCamera();
    testShotOn.value = false;
    seedNote.value = "";
    return;
  }
  if (!testShotUrl.value) testShotUrl.value = makePlaceholderShot();
  testShotOn.value = true;
  seedNote.value =
    "Test shot on — photos sit in the slots under the layout PNG. Use Camera for a live feed, or fullscreen to check the print.";
}

function triggerTestShotPhoto() {
  testShotInputRef.value?.click();
}

function onTestShotFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !file.type.startsWith("image/")) return;
  void stopTestCamera();
  const reader = new FileReader();
  reader.onload = () => {
    testShotUrl.value = String(reader.result || "");
    testShotOn.value = true;
    seedNote.value = `Test shot using ${file.name}.`;
  };
  reader.readAsDataURL(file);
}

/**
 * Duplicating a slot is how one capture gets printed more than once — the
 * LumaBooth behaviour the client asked for.
 *
 * The copy is APPENDED rather than inserted next to its source, because
 * slot→shot is positional: appending is precisely what makes the new slot
 * inherit the shot you copied. Duplicate slots 1,2,3,4 in order and the
 * new slots come out 1,2,3,4 again. Inserting in place would renumber
 * every slot after it.
 */
function duplicateSlot() {
  if (selected.value < 0) return;
  const src = cells.value[selected.value];
  if (!src) return;
  snapshot();
  cells.value = [
    ...cells.value,
    {
      // Nudged off the original so the copy is visible instead of hiding
      // exactly underneath it, but clamped to stay on the sheet.
      x: Math.max(0, Math.min(1 - src.w, src.x + 0.02)),
      y: Math.max(0, Math.min(1 - src.h, src.y + 0.02)),
      w: src.w,
      h: src.h,
      rotation: src.rotation,
      shot: src.shot ?? shotFor(selected.value),
    },
  ];
  selected.value = cells.value.length - 1;
  commit();
}

function deleteSlot() {
  if (selected.value < 0 || cells.value.length <= 1) return;
  snapshot();
  cells.value = cells.value.filter((_, i) => i !== selected.value);
  selected.value = -1;
  commit();
}

function addPhotoSlot() {
  snapshot();
  const nextShot =
    Math.max(
      props.photoCount,
      ...cells.value.map((c, i) => cellShotNumber(c, i, props.photoCount)),
    ) + 1;
  cells.value = [
    ...cells.value,
    {
      x: 0.1 + (cells.value.length % 4) * 0.03,
      y: 0.1 + (cells.value.length % 4) * 0.03,
      w: 0.38,
      h: 0.42,
      rotation: 0,
      shot: nextShot,
    },
  ];
  selected.value = cells.value.length - 1;
  commit();
}

const overlayInputRef = ref<HTMLInputElement | null>(null);
const importInputRef = ref<HTMLInputElement | null>(null);

function triggerOverlay() {
  overlayInputRef.value?.click();
}

function triggerImport() {
  importInputRef.value?.click();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function applyOverlayDataUrl(dataUrl: string) {
  emit("update:frameImageUrl", dataUrl);
  try {
    const draft = await draftTemplateFromLayoutPng(
      dataUrl,
      props.layoutName || "New layout",
    );
    emit("update:paperSize", draft.paperSize);
    snapshot();
    if (draft.cells?.length) {
      cells.value = draft.cells;
      emit("update:photoCount", draft.photoCount);
      commit();
      seedNote.value = `Overlay added — ${cells.value.length} photo box(es) from the PNG.`;
      return;
    }
  } catch {
    /* overlay still applied */
  }
  seedNote.value =
    "Overlay added. Use Photo to place a box in each window, then Export when done.";
}

async function onOverlayFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    seedNote.value = "Choose a PNG or JPEG overlay.";
    return;
  }
  try {
    await applyOverlayDataUrl(await readFileAsDataUrl(file));
  } catch {
    seedNote.value = "Could not read that image.";
  }
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const isImage =
    file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name);
  if (isImage) {
    try {
      await applyOverlayDataUrl(await readFileAsDataUrl(file));
    } catch {
      seedNote.value = "Could not import that image.";
    }
    return;
  }
  try {
    const imported = parsePhotoLayoutDocumentJson(await file.text());
    if (imported.name) emit("update:layoutName", imported.name);
    if (imported.paperSize) emit("update:paperSize", imported.paperSize);
    if (imported.frameImage) emit("update:frameImageUrl", imported.frameImage);
    snapshot();
    if (imported.cells.length) {
      cells.value = imported.cells;
    }
    if (imported.photoCount) emit("update:photoCount", imported.photoCount);
    commit();
    seedNote.value = imported.frameImage
      ? `Imported layout with PNG overlay (${cells.value.length} photo box(es)).`
      : `Imported ${cells.value.length} photo box(es).`;
  } catch (err) {
    seedNote.value =
      err instanceof Error ? err.message : "Could not import that layout.";
  }
}

function onPaperSizeChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value as PaperSize;
  emit("update:paperSize", value);
}

const paperOptions = Object.entries(PAPER_SIZES).map(([value, spec]) => ({
  value: value as PaperSize,
  label: spec.label,
}));

// ── Pointer gestures ────────────────────────────────────────────────
type Mode = "move" | "resize" | "rotate";
type Corner = { sx: -1 | 1; sy: -1 | 1 };

interface Drag {
  mode: Mode;
  index: number;
  corner?: Corner;
  /** Pointer position at gesture start, in stage fractions. */
  startPx: { x: number; y: number };
  startCell: TemplateCell;
}
let drag: Drag | null = null;

function stageRect() {
  return stage.value?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1);
}

/** Client px → fraction of the stage. */
function toFrac(clientX: number, clientY: number) {
  const r = stageRect();
  return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height };
}

function rotatePt(x: number, y: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

function beginDrag(e: PointerEvent, mode: Mode, index: number, corner?: Corner) {
  e.preventDefault();
  e.stopPropagation();
  selected.value = index;
  drag = {
    mode,
    index,
    corner,
    startPx: toFrac(e.clientX, e.clientY),
    startCell: { ...cells.value[index] },
  };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragEnd);
}

function onDragMove(e: PointerEvent) {
  if (!drag) return;
  const p = toFrac(e.clientX, e.clientY);
  const s = drag.startCell;
  const cell = cells.value[drag.index];
  if (!cell) return;

  if (drag.mode === "move") {
    cell.x = s.x + (p.x - drag.startPx.x);
    cell.y = s.y + (p.y - drag.startPx.y);
    return;
  }

  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;

  if (drag.mode === "rotate") {
    // Angle from the slot's centre to the pointer. The stalk hangs
    // BELOW the box, so 0° must correspond to straight down.
    const r = stageRect();
    const dx = (p.x - cx) * r.width;
    const dy = (p.y - cy) * r.height;
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI - 90;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    cell.rotation = Math.round(deg * 10) / 10;
    return;
  }

  // Resize: keep the OPPOSITE corner pinned in stage space, and do the
  // arithmetic in the slot's own rotated frame so a tilted box grows
  // along its own axes rather than the screen's.
  const c = drag.corner!;
  const r = stageRect();
  const aspect = r.width / r.height;
  // Work in a square space so rotation maths isn't skewed by the
  // stage's aspect, then convert back.
  const toSq = (px: number, py: number) => ({ x: px * aspect, y: py });
  const fromSq = (px: number, py: number) => ({ x: px / aspect, y: py });

  const cSq = toSq(cx, cy);
  const halfSq = toSq(s.w / 2, s.h / 2);
  // Fixed (opposite) corner, in square space.
  const offFixed = rotatePt(-c.sx * halfSq.x, -c.sy * halfSq.y, s.rotation);
  const fixed = { x: cSq.x + offFixed.x, y: cSq.y + offFixed.y };

  const pSq = toSq(p.x, p.y);
  const diag = rotatePt(pSq.x - fixed.x, pSq.y - fixed.y, -s.rotation);

  let localW = Math.abs(diag.x);
  let localH = Math.abs(diag.y);
  const MIN = 0.02;
  if (lockAspect.value || e.shiftKey) {
    const startAspect = (s.w * aspect) / s.h || 1;
    // Grow along whichever axis moved more, then derive the other.
    if (localW / startAspect > localH) localH = localW / startAspect;
    else localW = localH * startAspect;
  }
  localW = Math.max(MIN * aspect, localW);
  localH = Math.max(MIN, localH);

  const signedW = Math.sign(diag.x || 1) * localW;
  const signedH = Math.sign(diag.y || 1) * localH;
  const newCentreOff = rotatePt(signedW / 2, signedH / 2, s.rotation);
  const newCentreSq = {
    x: fixed.x + newCentreOff.x,
    y: fixed.y + newCentreOff.y,
  };
  const newCentre = fromSq(newCentreSq.x, newCentreSq.y);
  const newSize = fromSq(localW, localH);

  cell.w = newSize.x;
  cell.h = newSize.y;
  cell.x = newCentre.x - cell.w / 2;
  cell.y = newCentre.y - cell.h / 2;
}

function onDragEnd() {
  if (drag) {
    // Snapshot the state BEFORE this gesture so undo steps back one
    // whole drag rather than one pointermove.
    const before = cells.value.map((c, i) =>
      i === drag!.index ? drag!.startCell : c,
    );
    undoStack.value.push(JSON.stringify(before));
    redoStack.value = [];
    if (undoStack.value.length > 50) undoStack.value.shift();
    commit();
  }
  drag = null;
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
}

// Arrow keys nudge the selected slot — finer than a drag on a
// touchscreen, and the only way to hit an exact value.
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && previewFullscreen.value) {
    e.preventDefault();
    previewFullscreen.value = false;
    return;
  }
  if (selected.value < 0) return;
  const cell = cells.value[selected.value];
  if (!cell) return;
  const step = e.shiftKey ? 0.01 : 0.002;
  const map: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const d = map[e.key];
  if (!d) return;
  e.preventDefault();
  snapshot();
  cell.x += d[0];
  cell.y += d[1];
  commit();
}

function slotStyle(c: TemplateCell) {
  return {
    left: `${c.x * 100}%`,
    top: `${c.y * 100}%`,
    width: `${c.w * 100}%`,
    height: `${c.h * 100}%`,
    transform: `rotate(${c.rotation}deg)`,
  };
}

function clampPreviewOffset(n: number) {
  return Math.max(-50, Math.min(50, Number.isFinite(n) ? n : 0));
}

const previewFillOn = computed(
  () =>
    testShotOn.value ||
    testCameraOn.value ||
    (props.cellZoom ?? 1) !== 1 ||
    (props.cellOffsetX ?? 0) !== 0 ||
    (props.cellOffsetY ?? 0) !== 0,
);

const previewMediaStyle = computed(() => {
  const zoom = Math.max(0.1, props.cellZoom ?? 1);
  const ox = clampPreviewOffset(props.cellOffsetX ?? 0);
  const oy = clampPreviewOffset(props.cellOffsetY ?? 0);
  return {
    objectFit: (props.fitMode === "cover" ? "cover" : "contain") as const,
    transform: `translate(${ox}%, ${oy}%) scale(${zoom})`,
    transformOrigin: "center center",
  };
});

const CORNERS: { key: string; sx: -1 | 1; sy: -1 | 1 }[] = [
  { key: "tl", sx: -1, sy: -1 },
  { key: "tr", sx: 1, sy: -1 },
  { key: "bl", sx: -1, sy: 1 },
  { key: "br", sx: 1, sy: 1 },
];

onMounted(async () => {
  if (props.modelValue?.length) {
    cells.value = JSON.parse(JSON.stringify(props.modelValue));
    seedNote.value = "";
  } else {
    await seed();
  }
  if (!placeholderShotUrl.value) placeholderShotUrl.value = makePlaceholderShot();
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
  void stopTestCamera();
});

watch(
  () =>
    [props.frameRows, props.frameCols, props.cellMargin, props.cellGap] as const,
  () => {
    applyGridFromForm();
  },
);

// Raising the shot count after the editor is open should add the missing
// slots. It must NOT trim: any slot beyond `photoCount` is a deliberate
// duplicate, and truncating here would silently throw the operator's
// layout away the moment they nudged the shot count.
watch(
  () => props.photoCount,
  (n) => {
    const count = Math.max(1, n);
    if (cells.value.length >= count) return;
    const extra = gridSeed(count).slice(cells.value.length);
    cells.value = [...cells.value, ...extra];
    if (selected.value >= cells.value.length) selected.value = -1;
    commit();
  },
);
</script>

<template>
  <div
    class="layout-editor"
    :class="{
      'layout-editor--embedded': embedded,
      'layout-editor--fs': previewFullscreen,
    }"
    :style="{ '--paper-aspect': String(paperAspect) }"
  >
    <div class="editor-toolbar">
      <button
        type="button"
        class="tool-btn"
        title="Add a photo placeholder"
        @click="addPhotoSlot"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="2" />
          <path d="M8 15l3-3.5 2.2 2.6L16 11l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Photo</span>
      </button>
      <button
        v-if="!embedded"
        type="button"
        class="tool-btn"
        title="Add the layout PNG overlay"
        @click="triggerOverlay"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2" />
          <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
          <path d="M3 16l5.5-5 4 3.5L16 12l5 4" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Image</span>
      </button>
      <input
        ref="overlayInputRef"
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        class="tool-file"
        aria-label="Choose layout PNG overlay"
        @change="onOverlayFile"
      />
      <label v-if="!embedded" class="tool-paper">
        <span class="tool-btn__label">Paper</span>
        <select
          class="tool-select"
          :value="paperSize || '4x6-portrait'"
          aria-label="Paper size"
          @change="onPaperSizeChange"
        >
          <option
            v-for="opt in paperOptions"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="tool-btn"
        title="Import a LumaBooth-style layout package or PNG overlay"
        @click="triggerImport"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4v10M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span class="tool-btn__label">Import</span>
      </button>
      <input
        ref="importInputRef"
        type="file"
        accept=".json,application/json,.photo-layout.json,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        class="tool-file"
        aria-label="Import layout package or PNG"
        @change="onImportFile"
      />
      <button
        type="button"
        class="tool-btn"
        :disabled="!cells.length && !frameImageUrl"
        title="Export this layout and PNG as a shareable file"
        @click="exportLayout"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 14V4M8 8l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span class="tool-btn__label">Export</span>
      </button>
      <button
        type="button"
        class="tool-btn"
        :disabled="!canUndo"
        title="Undo"
        @click="undo"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 8H5V4M5.3 16.7A8 8 0 1 0 7 7.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Undo</span>
      </button>
      <button
        type="button"
        class="tool-btn"
        :disabled="!canRedo"
        title="Redo"
        @click="redo"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M15 8h4V4M18.7 16.7A8 8 0 1 1 17 7.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Redo</span>
      </button>
      <button
        v-if="!embedded"
        type="button"
        class="tool-btn"
        title="Reset layout"
        @click="resetLayout"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 12a8 8 0 1 1-2.2-5.5M20 5v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Reset</span>
      </button>
      <button
        type="button"
        class="tool-btn"
        :class="{ 'tool-btn--on': testShotOn }"
        :disabled="!cells.length"
        title="Fill the slots with a sample photo to preview the print"
        @click="toggleTestShot"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          <circle cx="12" cy="13.5" r="3.2" stroke="currentColor" stroke-width="2" />
        </svg>
        <span class="tool-btn__label">Test</span>
      </button>
      <button
        type="button"
        class="tool-btn"
        :class="{ 'tool-btn--on': testCameraOn }"
        :disabled="!cells.length || testCameraBusy"
        title="Open the camera and fit the live feed into the slots"
        @click="toggleTestCamera"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="13" r="3.5" stroke="currentColor" stroke-width="2" />
          <path d="M4 8h3l1.4-2h7.2L17 8h3v11H4V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Camera</span>
      </button>
      <button
        v-if="testShotOn"
        type="button"
        class="tool-btn"
        title="Use a still photo instead of the placeholder or camera"
        @click="triggerTestShotPhoto"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 7h3l1-2h4l1 2h3v12H7V7z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          <path d="M9 16l2.5-3 2 2.2L16 13l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Photo</span>
      </button>
      <button
        type="button"
        class="tool-btn"
        :class="{ 'tool-btn--on': previewFullscreen }"
        :disabled="!cells.length"
        title="View the layout full screen (Esc to exit)"
        @click="toggleFullscreenPreview"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8 4H5v3M16 4h3v3M8 20H5v-3M16 20h3v-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">{{ previewFullscreen ? "Exit" : "Full" }}</span>
      </button>
      <input
        ref="testShotInputRef"
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        class="tool-file"
        aria-label="Choose a test shot photo"
        @change="onTestShotFile"
      />
      <button
        type="button"
        class="tool-btn"
        :disabled="selected < 0"
        title="Add another slot showing the same shot"
        @click="duplicateSlot"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="2" />
        </svg>
        <span class="tool-btn__label">Copy</span>
      </button>
      <button
        type="button"
        class="tool-btn"
        :disabled="selected < 0 || cells.length <= 1"
        title="Delete selected slot"
        @click="deleteSlot"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tool-btn__label">Delete</span>
      </button>
      <button
        type="button"
        class="tool-btn"
        :class="{ 'tool-btn--on': lockAspect }"
        title="Lock aspect ratio while resizing"
        @click="lockAspect = !lockAspect"
      >
        <svg class="tool-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span class="tool-btn__label">Lock</span>
      </button>
    </div>

    <div class="stage-wrap">
      <div
        ref="stage"
        class="stage"
        :style="{ aspectRatio: String(paperAspect) }"
        @pointerdown="selected = -1"
      >
        <template v-if="testCameraStream">
          <div
            v-for="(cell, i) in cells"
            :key="`cam-${i}`"
            class="test-photo"
            :style="slotStyle(cell)"
          >
            <video
              class="test-camera"
              autoplay
              muted
              playsinline
              :style="previewMediaStyle"
              :ref="bindCameraVideo"
            />
          </div>
        </template>
        <template v-else-if="previewFillOn">
          <div
            v-for="(cell, i) in cells"
            :key="`shot-${i}`"
            class="test-photo"
            :style="slotStyle(cell)"
          >
            <img
              :src="testShotUrl || placeholderShotUrl"
              alt=""
              draggable="false"
              :style="previewMediaStyle"
            />
          </div>
        </template>
        <img
          v-if="displayFrameUrl"
          :src="displayFrameUrl"
          class="stage-frame"
          alt=""
          draggable="false"
        />

        <div
          v-for="(cell, i) in cells"
          :key="i"
          class="slot"
          :class="{
            'slot--selected': selected === i,
            'slot--preview': previewFillOn,
          }"
          :style="slotStyle(cell)"
          @pointerdown="beginDrag($event, 'move', i)"
        >
          <!-- The SHOT this slot receives, not the slot's ordinal — with
               duplicates in play those differ, and the shot number is what
               the operator is actually placing. -->
          <span class="slot-number">{{ shotFor(i) }}</span>

          <template v-if="selected === i">
            <span
              v-for="c in CORNERS"
              :key="c.key"
              class="handle"
              :class="`handle--${c.key}`"
              @pointerdown="
                beginDrag($event, 'resize', i, { sx: c.sx, sy: c.sy })
              "
            ></span>
            <span class="rotate-stalk"></span>
            <span
              class="handle handle--rotate"
              @pointerdown="beginDrag($event, 'rotate', i)"
              >↺</span
            >
          </template>
        </div>
      </div>
    </div>

    <p v-if="seedNote && !embedded" class="editor-note">{{ seedNote }}</p>
    <p v-if="selected >= 0" class="editor-readout">
      Slot {{ selected + 1 }} (shot {{ shotFor(selected) }}) —
      x {{ (cells[selected].x * 100).toFixed(1) }}%,
      y {{ (cells[selected].y * 100).toFixed(1) }}%,
      w {{ (cells[selected].w * 100).toFixed(1) }}%,
      h {{ (cells[selected].h * 100).toFixed(1) }}%,
      {{ cells[selected].rotation.toFixed(1) }}°
    </p>
  </div>
</template>

<style scoped>
.layout-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editor-toolbar {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tool-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.22rem;
  min-width: 3.4rem;
  padding: 0.4rem 0.45rem 0.32rem;
  border-radius: 8px;
  border: 2px solid var(--color-brown-light);
  background: var(--color-cream-dark);
  color: var(--color-brown-dark);
  font-family: var(--font-display);
  cursor: pointer;
}

.tool-btn__icon {
  width: 1.35rem;
  height: 1.35rem;
  flex-shrink: 0;
}

.tool-btn__label {
  font-size: 0.68rem;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: 0.01em;
}

.tool-btn:hover:not(:disabled) {
  border-color: var(--color-brown-dark);
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tool-btn--on {
  background: var(--color-brown-dark);
  border-color: var(--color-brown-dark);
  color: var(--color-cream);
}

.tool-file {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.tool-paper {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 0.22rem;
  min-width: 3.4rem;
  color: var(--color-brown-dark);
  font-family: var(--font-display);
}

.tool-select {
  padding: 0.38rem 0.6rem;
  border-radius: 8px;
  border: 2px solid var(--color-brown-light);
  background: var(--color-cream-dark);
  color: var(--color-brown-dark);
  font-family: var(--font-body);
  font-size: 0.95rem;
  font-weight: 500;
}

.tool-hint {
  font-size: 0.85rem;
  opacity: 0.7;
}

.stage-wrap {
  display: flex;
  justify-content: center;
}

.stage {
  position: relative;
  /* A DEFINITE height is required: with only max-height/max-width the
     element has no intrinsic size to derive from and aspect-ratio
     collapses it to 0x0. Height drives, width follows the paper aspect,
     and max-width claws back the height on a narrow screen. */
  height: 58vh;
  width: auto;
  max-width: 100%;
  /* The checker makes transparent frame windows obvious. */
  background:
    repeating-conic-gradient(#e9e2d2 0% 25%, #f7f2e6 0% 50%) 50% / 20px 20px;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}

.stage-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* The artwork defines the sheet, so it fills it exactly — matching
     how the composite draws it over the whole print area. */
  object-fit: fill;
  pointer-events: none;
  z-index: 1;
}

.test-photo {
  position: absolute;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.test-photo img,
.test-photo .test-camera {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.slot {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid rgba(233, 30, 99, 0.9);
  background: rgba(233, 30, 99, 0.14);
  cursor: move;
  touch-action: none;
  z-index: 2;
}

.slot--preview {
  background: transparent;
}

.slot--preview .slot-number {
  font-size: clamp(12px, 3vw, 22px);
  align-items: flex-start;
  justify-content: flex-start;
  padding: 4px 6px;
}

.slot--selected {
  background: rgba(3, 169, 244, 0.22);
  border-color: #e91e63;
  z-index: 2;
}

.slot-number {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: clamp(14px, 4vw, 34px);
  font-weight: 800;
  color: #fff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}

.handle {
  position: absolute;
  width: 22px;
  height: 22px;
  margin: -11px 0 0 -11px;
  border-radius: 50%;
  background: #e91e63;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  cursor: nwse-resize;
  touch-action: none;
}

.handle--tl { left: 0; top: 0; }
.handle--tr { left: 100%; top: 0; cursor: nesw-resize; }
.handle--bl { left: 0; top: 100%; cursor: nesw-resize; }
.handle--br { left: 100%; top: 100%; }

.rotate-stalk {
  position: absolute;
  left: 50%;
  top: 100%;
  width: 2px;
  height: 34px;
  margin-left: -1px;
  background: #e91e63;
  pointer-events: none;
}

.handle--rotate {
  left: 50%;
  top: calc(100% + 34px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 13px;
  cursor: grab;
}

.editor-note,
.editor-readout {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-brown-dark);
  opacity: 0.8;
}

.editor-readout {
  font-variant-numeric: tabular-nums;
}

.layout-editor--embedded .editor-toolbar {
  gap: 6px;
}

.layout-editor--embedded .stage {
  height: min(52vh, 640px);
  border-color: var(--color-brown-light);
}

.layout-editor--fs {
  position: fixed;
  inset: 0;
  z-index: 2400;
  background: #1c1612;
  padding: 0.85rem 1rem 1.1rem;
  gap: 10px;
}

.layout-editor--fs .tool-btn {
  background: #f3ebe0;
  color: var(--color-brown-dark);
}

.layout-editor--fs .tool-btn--on {
  background: #e4d4bc;
  border-color: var(--color-brown-dark);
  color: var(--color-brown-dark);
}

.layout-editor--fs .stage,
.layout-editor--embedded.layout-editor--fs .stage {
  height: min(86vh, calc((100vw - 2rem) / var(--paper-aspect, 0.67)));
  max-height: calc(100vh - 7.25rem);
  max-width: 100%;
}

.layout-editor--fs .editor-readout,
.layout-editor--fs .editor-note {
  color: #f7f2e6;
  opacity: 0.85;
}
</style>
