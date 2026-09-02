<script setup lang="ts">
/**
 * Screen-Editor canvas for template / payment / camera / printing / QR.
 * Same drag-resize chrome as WelcomeStage; widgets are live-ish previews.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import TemplatePreview from "@/components/TemplatePreview.vue";
import {
  allKioskItemBoxes,
  defaultKioskLayout,
  getKioskItemBox,
  isKioskFixedId,
  kioskBoxStyle,
  kioskItemDef,
  kioskScreenDef,
  kioskTextCss,
  type KioskScreenId,
} from "@/utils/kioskLayout";
import {
  assetItemId,
  assetKey,
  isAssetId,
  parseTextStyle,
  resizeBox,
  snapBoxToGuides,
  type SnapLine,
  type WelcomeAsset,
  type WelcomeBox,
} from "@/utils/welcomeLayout";

type Handle = "nw" | "ne" | "sw" | "se";

const props = withDefaults(
  defineProps<{
    screenId: KioskScreenId;
    interactive?: boolean;
    selected?: string | null;
    canvas?: boolean;
    showGuides?: boolean;
  }>(),
  {
    interactive: false,
    selected: null,
    canvas: false,
    showGuides: false,
  },
);

const emit = defineEmits<{
  select: [layer: string];
  "drop-files": [payload: { files: File[]; layer: string }];
  "history-checkpoint": [];
}>();

const store = usePhotoboothStore();
const stageRef = ref<HTMLElement | null>(null);
const bgVideoRef = ref<HTMLVideoElement | null>(null);

const layout = computed(
  () => store.kioskLayoutOf(props.screenId) || defaultKioskLayout(props.screenId),
);
const def = computed(() => kioskScreenDef(props.screenId));
const logoSrc = computed(
  () => store.customLogoUrl || `${import.meta.env.BASE_URL}Logo.svg`,
);
const templates = computed(() => store.activeTemplates.slice(0, 3));

const fill = computed(() => layout.value.backgroundFill);
const colorBg = computed(() => layout.value.backgroundColor);
const mediaUrl = computed(() => {
  if (fill.value === "color" || fill.value === "theme") return null;
  return store.kioskBackgroundUrl(props.screenId);
});
const mediaType = computed(() => store.kioskBackgroundType(props.screenId));

onMounted(() => {
  if (props.interactive) store.ensureKioskLayout(props.screenId);
  playBgVideo();
});

function playBgVideo() {
  bgVideoRef.value?.play().catch(() => {});
}

watch(mediaUrl, () => nextTick(playBgVideo));

function boxStyle(id: string) {
  const box = getKioskItemBox(layout.value, id);
  if (!box) return undefined;
  return kioskBoxStyle(box, layout.value.order, id);
}

function pick(layer: string, event?: Event) {
  if (!props.interactive) return;
  event?.stopPropagation();
  emit("select", layer);
}

type Drag = {
  id: string;
  mode: "move" | Handle;
  startPtr: { x: number; y: number };
  startBox: WelcomeBox;
};
let drag: Drag | null = null;
const dragging = ref(false);
const activeGuides = ref<SnapLine[]>([]);

function toFrac(clientX: number, clientY: number) {
  const r = stageRef.value?.getBoundingClientRect();
  if (!r || r.width < 1 || r.height < 1) return { x: 0, y: 0 };
  return {
    x: (clientX - r.left) / r.width,
    y: (clientY - r.top) / r.height,
  };
}

function beginDrag(e: PointerEvent, id: string, mode: "move" | Handle) {
  if (!props.interactive) return;
  if (editingTextId.value === id && mode === "move") return;
  e.preventDefault();
  e.stopPropagation();
  emit("select", id);
  emit("history-checkpoint");
  const laid = store.ensureKioskLayout(props.screenId);
  const startBox = getKioskItemBox(laid, id);
  if (!startBox) return;
  drag = {
    id,
    mode,
    startPtr: toFrac(e.clientX, e.clientY),
    startBox: { ...startBox },
  };
  dragging.value = true;
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragEnd);
}

function isTextLayer(id: string): boolean {
  if (kioskItemDef(props.screenId, id)?.kind === "text") return true;
  if (!isAssetId(id)) return false;
  return layout.value.assets.some(
    (a) => a.id === assetKey(id) && a.kind === "text",
  );
}

function applyDragBox(raw: WelcomeBox, skipSnap: boolean) {
  if (!drag) return;
  const others = allKioskItemBoxes(layout.value, props.screenId)
    .filter((item) => item.id !== drag?.id)
    .map((item) => item.box);
  if (props.showGuides && !skipSnap) {
    const snapped = snapBoxToGuides(raw, others);
    activeGuides.value = snapped.lines;
    store.setKioskItem(props.screenId, drag.id, snapped.box);
    return;
  }
  activeGuides.value = [];
  store.setKioskItem(props.screenId, drag.id, raw);
}

function onDragMove(e: PointerEvent) {
  if (!drag) return;
  const p = toFrac(e.clientX, e.clientY);
  const dx = p.x - drag.startPtr.x;
  const dy = p.y - drag.startPtr.y;
  if (drag.mode === "move") {
    applyDragBox(
      {
        ...drag.startBox,
        x: drag.startBox.x + dx,
        y: drag.startBox.y + dy,
      },
      e.altKey,
    );
    return;
  }
  applyDragBox(
    resizeBox(drag.startBox, drag.mode, dx, dy, !isTextLayer(drag.id)),
    e.altKey,
  );
}

function onDragEnd() {
  drag = null;
  dragging.value = false;
  activeGuides.value = [];
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
}

onBeforeUnmount(onDragEnd);

function textCss(style: ReturnType<typeof parseTextStyle>) {
  return kioskTextCss(style);
}

function assetBoxStyle(asset: WelcomeAsset) {
  const id = assetItemId(asset.id);
  const t = asset.kind === "text" ? parseTextStyle(asset.text) : null;
  return {
    ...boxStyle(id),
    ...(t
      ? {
          display: "flex",
          flexDirection: "column" as const,
          justifyContent:
            t.valign === "top"
              ? "flex-start"
              : t.valign === "bottom"
                ? "flex-end"
                : "center",
        }
      : {}),
  };
}

const editingTextId = ref<string | null>(null);
const textEditEl = ref<HTMLElement | null>(null);

async function startTextEdit(id: string, content: string, e: MouseEvent) {
  if (!props.interactive) return;
  e.preventDefault();
  e.stopPropagation();
  onDragEnd();
  emit("select", id);
  emit("history-checkpoint");
  editingTextId.value = id;
  await nextTick();
  const el = textEditEl.value;
  if (!el) return;
  el.innerText = content;
  el.focus();
}

function finishFixedText(e: FocusEvent, itemId: string) {
  const el = e.target as HTMLElement;
  editingTextId.value = null;
  store.updateKioskText(props.screenId, itemId, {
    content: el.innerText ?? "",
  });
}

function finishAssetText(e: FocusEvent, asset: WelcomeAsset) {
  const el = e.target as HTMLElement;
  editingTextId.value = null;
  store.updateKioskAssetText(props.screenId, assetItemId(asset.id), {
    content: el.innerText ?? "",
  });
}

function onDragOver(e: DragEvent) {
  if (!props.interactive) return;
  if (![...((e.dataTransfer?.types as string[] | undefined) || [])].includes("Files")) {
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function hitLayer(e: DragEvent): string {
  const t = e.target as HTMLElement | null;
  const item = t?.closest("[data-kiosk-item]") as HTMLElement | null;
  const id = item?.dataset.kioskItem;
  if (id && (isKioskFixedId(props.screenId, id) || isAssetId(id))) return id;
  return "background";
}

function onDrop(e: DragEvent) {
  if (!props.interactive) return;
  e.preventDefault();
  e.stopPropagation();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const layer = hitLayer(e);
  emit("select", layer);
  emit("drop-files", { files, layer });
}

const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];

function buttonClass(itemId: string) {
  const variant = kioskItemDef(props.screenId, itemId)?.buttonVariant || "wood";
  if (variant === "ghost") return "ghost-btn";
  if (variant === "start") return "kiosk-start-btn";
  return "wood-btn";
}

function buttonLabel(itemId: string) {
  return (
    layout.value.buttons[itemId]?.label ||
    kioskItemDef(props.screenId, itemId)?.buttonLabel ||
    "Button"
  );
}

function dotsCount() {
  return Math.max(1, store.activeTemplates.length || 3);
}
</script>

<template>
  <div
    ref="stageRef"
    class="kiosk-stage"
    :class="{
      'kiosk-stage--interactive': interactive,
      'kiosk-stage--canvas': canvas,
      'kiosk-stage--dragging': dragging,
      'kiosk-stage--theme': fill === 'theme' && !mediaUrl,
    }"
    @click="pick('background', $event)"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <div
      class="kiosk-bg kiosk-bg--color"
      :style="{
        backgroundColor:
          fill === 'color' ? colorBg : fill === 'theme' ? '#f4ead5' : '#f4ead5',
      }"
    />
    <div v-if="fill === 'media' && mediaUrl" class="kiosk-bg">
      <img
        v-if="mediaType === 'image'"
        :src="mediaUrl"
        alt=""
        class="kiosk-bg-media"
      />
      <video
        v-else
        ref="bgVideoRef"
        :src="mediaUrl"
        class="kiosk-bg-media"
        autoplay
        muted
        loop
        playsinline
        @loadeddata="playBgVideo"
      />
    </div>

    <div
      v-for="item in def.items"
      :key="item.id"
      class="kiosk-item"
      :class="{
        'kiosk-item--selected': interactive && selected === item.id,
        [`kiosk-item--${item.kind}`]: true,
      }"
      :data-kiosk-item="item.id"
      :style="boxStyle(item.id)"
      @click="pick(item.id, $event)"
      @pointerdown="beginDrag($event, item.id, 'move')"
      @dblclick="
        item.kind === 'text'
          ? startTextEdit(
              item.id,
              layout.texts[item.id]?.content || item.text?.content || '',
              $event,
            )
          : undefined
      "
    >
      <template v-if="item.kind === 'text'">
        <div
          v-if="interactive && editingTextId === item.id"
          ref="textEditEl"
          class="kiosk-text kiosk-text--editing"
          contenteditable="true"
          :style="textCss(parseTextStyle(layout.texts[item.id] || item.text))"
          @blur="finishFixedText($event, item.id)"
        />
        <div
          v-else
          class="kiosk-text"
          :style="{
            ...textCss(parseTextStyle(layout.texts[item.id] || item.text)),
            display: 'flex',
            flexDirection: 'column',
            justifyContent:
              parseTextStyle(layout.texts[item.id] || item.text).valign === 'top'
                ? 'flex-start'
                : parseTextStyle(layout.texts[item.id] || item.text).valign ===
                    'bottom'
                  ? 'flex-end'
                  : 'center',
          }"
        >
          {{ layout.texts[item.id]?.content || item.text?.content }}
        </div>
      </template>

      <template v-else-if="item.kind === 'button'">
        <span :class="buttonClass(item.id)" class="kiosk-btn">
          {{ buttonLabel(item.id) }}
        </span>
      </template>

      <template v-else-if="item.kind === 'logo'">
        <img :src="logoSrc" alt="Logo" class="kiosk-logo-img" />
      </template>

      <template v-else-if="item.id === 'carousel'">
        <div class="mock-carousel">
          <div
            v-for="(t, i) in templates.length ? templates : [null, null, null]"
            :key="t?.id || i"
            class="mock-card"
            :class="{ 'mock-card--center': i === 1 || templates.length === 1 }"
          >
            <TemplatePreview
              v-if="t"
              :template="t"
              size="full"
              :active="i === Math.min(1, templates.length - 1)"
            />
            <div v-else class="mock-card-empty" />
          </div>
        </div>
      </template>

      <template v-else-if="item.id === 'dots'">
        <div class="mock-dots">
          <span
            v-for="n in dotsCount()"
            :key="n"
            class="mock-dot"
            :class="{ 'mock-dot--on': n === 1 }"
          />
        </div>
      </template>

      <template v-else-if="item.id === 'qrFrame'">
        <div class="mock-qr-frame">
          <div class="mock-qr-inner">
            <img
              v-if="screenId === 'payment' && store.paymentQrUrl"
              :src="store.paymentQrUrl"
              alt="Payment QR"
            />
            <span v-else class="mock-qr-mark">QR</span>
          </div>
        </div>
      </template>

      <template v-else-if="item.id === 'progress'">
        <div class="mock-progress">
          <div class="mock-progress-bar">
            <div class="mock-progress-fill" />
          </div>
          <span>Waiting for payment…</span>
        </div>
      </template>

      <template v-else-if="item.id === 'strip'">
        <div class="mock-strip">Strip preview</div>
      </template>

      <template v-else-if="item.id === 'viewfinder'">
        <div class="mock-viewfinder">Viewfinder</div>
      </template>

      <template v-else-if="item.id === 'filters'">
        <div class="mock-filters">
          <span
            v-for="f in store.activeFilters.slice(0, 4)"
            :key="f.id"
            class="mock-chip"
          >
            {{ f.name }}
          </span>
          <span v-if="!store.activeFilters.length" class="mock-chip">Filter</span>
        </div>
      </template>

      <template v-else-if="item.id === 'slot'">
        <div class="mock-slot">Printer slot</div>
      </template>

      <template v-else-if="item.id === 'plaque'">
        <div class="mock-plaque">
          Photos<br />Delivered<br />Here
        </div>
      </template>

      <span v-if="interactive" class="kiosk-lock" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <rect
            x="5"
            y="11"
            width="14"
            height="10"
            rx="2"
            stroke="currentColor"
            stroke-width="2"
          />
          <path
            d="M8 11V8a4 4 0 0 1 8 0v3"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <template v-if="interactive && selected === item.id">
        <span
          v-for="h in HANDLES"
          :key="h"
          class="handle"
          :class="`handle--${h}`"
          @pointerdown="beginDrag($event, item.id, h)"
        />
      </template>
    </div>

    <div
      v-for="asset in layout.assets"
      :key="asset.id"
      class="kiosk-item kiosk-item--asset"
      :class="{
        'kiosk-item--selected':
          interactive && selected === assetItemId(asset.id),
      }"
      :data-kiosk-item="assetItemId(asset.id)"
      :style="assetBoxStyle(asset)"
      @click="pick(assetItemId(asset.id), $event)"
      @pointerdown="beginDrag($event, assetItemId(asset.id), 'move')"
      @dblclick="
        asset.kind === 'text'
          ? startTextEdit(
              assetItemId(asset.id),
              parseTextStyle(asset.text).content,
              $event,
            )
          : undefined
      "
    >
      <div
        v-if="asset.kind === 'text' && interactive && editingTextId === assetItemId(asset.id)"
        ref="textEditEl"
        class="kiosk-text kiosk-text--editing"
        contenteditable="true"
        :style="textCss(parseTextStyle(asset.text))"
        @blur="finishAssetText($event, asset)"
      />
      <div
        v-else-if="asset.kind === 'text'"
        class="kiosk-text"
        :style="textCss(parseTextStyle(asset.text))"
      >
        {{ parseTextStyle(asset.text).content }}
      </div>
      <video
        v-else-if="asset.kind === 'video'"
        :src="asset.src"
        muted
        loop
        playsinline
        autoplay
      />
      <img v-else :src="asset.src" :alt="asset.name" />
      <template v-if="interactive && selected === assetItemId(asset.id)">
        <span
          v-for="h in HANDLES"
          :key="h"
          class="handle"
          :class="`handle--${h}`"
          @pointerdown="beginDrag($event, assetItemId(asset.id), h)"
        />
      </template>
    </div>

    <div
      v-if="interactive && showGuides"
      class="kiosk-guides"
      aria-hidden="true"
    >
      <span class="guide guide--v guide--idle" style="left: 50%" />
      <span class="guide guide--h guide--idle" style="top: 50%" />
      <span
        v-for="(g, i) in activeGuides"
        :key="`${g.axis}-${g.at}-${i}`"
        class="guide guide--live"
        :class="g.axis === 'x' ? 'guide--v' : 'guide--h'"
        :style="g.axis === 'x' ? { left: `${g.at * 100}%` } : { top: `${g.at * 100}%` }"
      />
    </div>
  </div>
</template>

<style scoped>
.kiosk-stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #f4ead5;
}

.kiosk-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.kiosk-bg-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}

.kiosk-item {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
}

.kiosk-stage--interactive .kiosk-item {
  cursor: grab;
  outline: 2px solid transparent;
  outline-offset: 0;
  user-select: none;
  touch-action: none;
}

.kiosk-stage--interactive .kiosk-item--selected {
  outline-color: #c4a35a;
}

.kiosk-stage--dragging .kiosk-item {
  cursor: grabbing;
}

.kiosk-text {
  width: 100%;
  height: 100%;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
}

.kiosk-text--editing {
  pointer-events: auto;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
  outline: none;
}

.kiosk-btn {
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  max-height: 100%;
}

.kiosk-logo-img,
.kiosk-item--asset img,
.kiosk-item--asset video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  display: block;
}

.kiosk-start-btn {
  font-family: var(--font-display);
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--color-cream);
  background: var(--color-brown-dark);
  border: 0;
  border-radius: 999px;
  padding: 0.7rem 2rem;
}

.mock-carousel {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.5%;
  pointer-events: none;
}

.mock-card {
  height: 78%;
  flex: 0 1 28%;
  opacity: 0.7;
  transform: scale(0.86);
}

.mock-card--center {
  flex-basis: 34%;
  opacity: 1;
  transform: none;
}

.mock-card-empty {
  width: 100%;
  height: 100%;
  background: rgba(61, 43, 31, 0.08);
  border: 2px dashed var(--color-brown-light);
  border-radius: 8px;
}

.mock-dots {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  width: 100%;
  pointer-events: none;
}

.mock-dot {
  width: 54px;
  height: 16px;
  border-radius: 4px;
  box-shadow: 0 0 0 2px var(--color-brown-light) inset;
}

.mock-dot--on {
  background: var(--color-brown-light);
}

.mock-qr-frame {
  width: 100%;
  height: 100%;
  border-radius: 8%;
  padding: 4%;
  background: repeating-linear-gradient(
    92deg,
    #4e3121 0px,
    #5c3b28 2px,
    #4e3121 4px,
    #402719 6px
  );
  box-sizing: border-box;
  pointer-events: none;
}

.mock-qr-inner {
  width: 100%;
  height: 100%;
  border-radius: 6%;
  background: #f1f2f2;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.mock-qr-inner img {
  width: 88%;
  height: 88%;
  object-fit: contain;
}

.mock-qr-mark {
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--color-brown);
  font-size: 2rem;
}

.mock-progress {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  pointer-events: none;
  font-family: var(--font-body);
  color: var(--color-brown-dark);
  font-size: 0.95rem;
}

.mock-progress-bar {
  height: 10px;
  border-radius: 999px;
  background: rgba(61, 43, 31, 0.15);
  overflow: hidden;
}

.mock-progress-fill {
  width: 28%;
  height: 100%;
  background: var(--color-brown);
}

.mock-strip,
.mock-viewfinder,
.mock-slot {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--color-cream);
  pointer-events: none;
}

.mock-strip {
  background: #3d2b1f;
  border-radius: 10px;
  transform: rotate(-3deg);
}

.mock-viewfinder {
  background: #1a1410;
  border: 10px solid #5a3d28;
  border-radius: 8px;
}

.mock-filters {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.mock-chip {
  padding: 0.35rem 0.7rem;
  border-radius: 999px;
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--color-brown-dark);
}

.mock-slot {
  background: linear-gradient(180deg, #4d4547, #1f1b1c);
  border-radius: 12px;
  clip-path: polygon(20% 0, 80% 0, 100% 100%, 0 100%);
}

.mock-plaque {
  width: 100%;
  height: 100%;
  background: #c4a35a;
  border: 4px solid #6b3b11;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-family: var(--font-display);
  font-weight: 700;
  color: #3d2b1f;
  line-height: 1.15;
  pointer-events: none;
}

.kiosk-lock {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 4;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: #fff;
  background: rgba(61, 43, 31, 0.62);
  border-radius: 50%;
}

.kiosk-lock svg {
  width: 18px;
  height: 18px;
}

.handle {
  position: absolute;
  width: 16px;
  height: 16px;
  background: #fff;
  border: 2px solid #c4a35a;
  border-radius: 2px;
  z-index: 13;
}

.handle--nw {
  top: -8px;
  left: -8px;
  cursor: nwse-resize;
}
.handle--ne {
  top: -8px;
  right: -8px;
  cursor: nesw-resize;
}
.handle--sw {
  bottom: -8px;
  left: -8px;
  cursor: nesw-resize;
}
.handle--se {
  bottom: -8px;
  right: -8px;
  cursor: nwse-resize;
}

.kiosk-guides {
  position: absolute;
  inset: 0;
  z-index: 80;
  pointer-events: none;
}

.guide {
  position: absolute;
}

.guide--v {
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px dashed rgba(225, 78, 200, 0.45);
}

.guide--h {
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dashed rgba(225, 78, 200, 0.45);
}

.guide--live {
  border-color: #e14ec8;
  border-style: solid;
}
</style>
