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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getFrameWindows } from "@/utils/frameWindows";
import type { WindowRect } from "@/utils/frameWindows";
import { getPaperSizePx } from "@/utils/printLayout";
import type { PaperSize } from "@/utils/printLayout";
import type { TemplateCell } from "@/stores/photobooth";
import { prepareFrameDataUrl } from "@/utils/pngAlpha";

const props = withDefaults(
  defineProps<{
    modelValue: TemplateCell[];
    photoCount: number;
    frameImageUrl?: string;
    paperSize?: PaperSize;
    /** Grid used to seed slots when the frame has no detectable windows. */
    frameRows?: number;
    frameCols?: number;
  }>(),
  { photoCount: 4, frameRows: 0, frameCols: 0 },
);

const emit = defineEmits<{
  (e: "update:modelValue", cells: TemplateCell[]): void;
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
}

/** An evenly spaced grid, used when the artwork yields no windows. */
function gridSeed(count: number): TemplateCell[] {
  const cols = Math.max(1, props.frameCols || (count <= 2 ? 1 : 2));
  const rows = Math.max(1, props.frameRows || Math.ceil(count / cols));
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
  }));
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
  return (i % Math.max(1, props.photoCount)) + 1;
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
        cells.value = windows.map((r) => ({
          x: r.x / fw,
          y: r.y / fh,
          w: r.width / fw,
          h: r.height / fh,
          rotation: 0,
        }));
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
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
});

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
  <div class="layout-editor">
    <div class="editor-toolbar">
      <button class="tool-btn" :disabled="!canUndo" @click="undo">↶ Undo</button>
      <button class="tool-btn" :disabled="!canRedo" @click="redo">↷ Redo</button>
      <button class="tool-btn" @click="resetLayout">Reset layout</button>
      <button
        class="tool-btn"
        :disabled="selected < 0"
        title="Add another slot showing the same shot"
        @click="duplicateSlot"
      >
        ⧉ Duplicate slot
      </button>
      <button
        class="tool-btn"
        :disabled="selected < 0 || cells.length <= 1"
        @click="deleteSlot"
      >
        Delete slot
      </button>
      <label class="tool-check">
        <input v-model="lockAspect" type="checkbox" />
        Lock aspect
      </label>
      <span class="tool-hint">
        Drag to move · corners to resize · handle below to rotate · arrow
        keys to nudge · duplicate a slot to reuse a shot
      </span>
    </div>

    <div class="stage-wrap">
      <div
        ref="stage"
        class="stage"
        :style="{ aspectRatio: String(paperAspect) }"
        @pointerdown="selected = -1"
      >
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
          :class="{ 'slot--selected': selected === i }"
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

    <p v-if="seedNote" class="editor-note">{{ seedNote }}</p>
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
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.tool-btn {
  padding: 8px 14px;
  border-radius: 8px;
  border: 2px solid var(--color-cream-dark);
  background: #fdfbf7;
  color: var(--color-brown-dark);
  font-weight: 700;
  cursor: pointer;
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tool-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--color-brown-dark);
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
  border: 2px solid var(--color-cream-dark);
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
}

.slot {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid rgba(233, 30, 99, 0.9);
  background: rgba(233, 30, 99, 0.14);
  cursor: move;
  touch-action: none;
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
</style>
