<script setup lang="ts">
/**
 * Welcome (title) screen stage. Guest mode uses saved layout when
 * present, otherwise the original centred stack. Editor mode is a
 * Canva-style canvas: drag to move, corner handles to resize, drop
 * files onto the stage.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import BoxButton from "@/components/BoxButton.vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import {
  WELCOME_CANVAS_W,
  WELCOME_START_NATIVE_W,
  allItemBoxes,
  assetItemId,
  assetKey,
  getItemBox,
  isAssetId,
  layerZ,
  normalizeOrder,
  parseTextStyle,
  resizeBox,
  snapBoxToGuides,
  startButtonCssVars,
  type SnapLine,
  type WelcomeAsset,
  type WelcomeBox,
  type WelcomeItemId,
  type WelcomeLayer,
} from "@/utils/welcomeLayout";

export type { WelcomeLayer };
type Handle = "nw" | "ne" | "sw" | "se";

const props = withDefaults(
  defineProps<{
    interactive?: boolean;
    selected?: WelcomeLayer | null;
    instant?: boolean;
    canvas?: boolean;
    showGuides?: boolean;
  }>(),
  {
    interactive: false,
    selected: null,
    instant: false,
    canvas: false,
    showGuides: false,
  },
);

const emit = defineEmits<{
  start: [];
  select: [layer: WelcomeLayer];
  "drop-files": [payload: { files: File[]; layer: WelcomeLayer }];
  "history-checkpoint": [];
}>();

const store = usePhotoboothStore();
const stageRef = ref<HTMLElement | null>(null);

const logoSrc = computed(
  () => store.customLogoUrl || `${import.meta.env.BASE_URL}Logo.svg`,
);
const startBtnLabel = `${import.meta.env.BASE_URL}start-button-text.svg`;
const hasCustomTitleBg = computed(() => !!store.effectiveTitleBackgroundUrl);
const showMediaBg = computed(
  () => store.welcomeBackgroundFill !== "color" && hasCustomTitleBg.value,
);

const layout = computed(() => store.welcomeLayout);
const useAbs = computed(() => !!layout.value);
const bgVideoRef = ref<HTMLVideoElement | null>(null);

const isReady = ref(props.instant);

const startBtnScale = computed(() => {
  const laid = layout.value;
  if (laid) return (laid.start.w * WELCOME_CANVAS_W) / WELCOME_START_NATIVE_W;
  return store.startButtonScale;
});

const startBtnCss = computed(() =>
  startButtonCssVars(store.startButtonStyle, startBtnScale.value),
);
const startBtnUsesArtwork = computed(
  () => !store.startButtonStyle.label.trim(),
);

function playBgVideo() {
  const el = bgVideoRef.value;
  if (!el) return;
  el.play().catch(() => {
    /* autoplay can be blocked until the tab is visible */
  });
}

onMounted(() => {
  playBgVideo();
  if (props.instant) {
    if (props.interactive) store.ensureWelcomeLayout();
    return;
  }
  setTimeout(() => {
    isReady.value = true;
  }, 100);
});

function boxStyle(box: WelcomeBox, id?: WelcomeItemId) {
  const order = layout.value ? normalizeOrder(layout.value) : [];
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
    zIndex: id ? layerZ(order, id) : undefined,
  };
}

function logoFlexWidth() {
  return `min(90%, ${Math.round(1208 * store.titleLogoScale)}px)`;
}

function pick(layer: WelcomeLayer, event?: Event) {
  if (!props.interactive) return;
  event?.stopPropagation();
  emit("select", layer);
}

function onStart(event?: Event) {
  event?.stopPropagation();
  if (props.interactive) {
    emit("select", "start");
    return;
  }
  emit("start");
}

type Drag = {
  id: WelcomeItemId;
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

function beginDrag(
  e: PointerEvent,
  id: WelcomeItemId,
  mode: "move" | Handle,
) {
  if (!props.interactive) return;
  if (editingTextId.value === id && mode === "move") return;
  e.preventDefault();
  e.stopPropagation();
  emit("select", id);
  emit("history-checkpoint");
  const laid = store.ensureWelcomeLayout();
  const startBox = getItemBox(laid, id);
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

function applyDragBox(raw: WelcomeBox, skipSnap: boolean) {
  const laid = store.welcomeLayout;
  const others = laid
    ? allItemBoxes(laid)
        .filter((item) => item.id !== drag?.id)
        .map((item) => item.box)
    : [];
  if (props.showGuides && !skipSnap) {
    const snapped = snapBoxToGuides(raw, others);
    activeGuides.value = snapped.lines;
    store.setWelcomeItem(drag!.id, snapped.box);
    return;
  }
  activeGuides.value = [];
  store.setWelcomeItem(drag!.id, raw);
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
    resizeBox(drag.startBox, drag.mode, dx, dy, !isTextItem(drag.id)),
    e.altKey,
  );
}

function isTextItem(id: WelcomeItemId): boolean {
  if (!isAssetId(id) || !layout.value) return false;
  return layout.value.assets.some(
    (a) => a.id === assetKey(id) && a.kind === "text",
  );
}

function textCss(asset: WelcomeAsset) {
  const t = parseTextStyle(asset.text);
  return {
    fontFamily: t.fontFamily,
    fontSize: `${t.fontSize}px`,
    fontWeight: String(t.fontWeight),
    fontStyle: t.italic ? "italic" : "normal",
    textDecoration: t.underline ? "underline" : "none",
    color: t.color,
    textAlign: t.align,
    letterSpacing: `${t.letterSpacing}px`,
    lineHeight: String(t.lineHeight),
    opacity: t.opacity,
  };
}

function assetBoxStyle(asset: WelcomeAsset) {
  const id = assetItemId(asset.id);
  const t = asset.kind === "text" ? parseTextStyle(asset.text) : null;
  return {
    ...boxStyle(asset, id),
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

async function startTextEdit(asset: WelcomeAsset, e: MouseEvent) {
  if (!props.interactive) return;
  e.preventDefault();
  e.stopPropagation();
  onDragEnd();
  const id = assetItemId(asset.id);
  emit("select", id);
  emit("history-checkpoint");
  editingTextId.value = id;
  await nextTick();
  const el = textEditEl.value;
  if (!el) return;
  el.innerText = parseTextStyle(asset.text).content;
  el.focus();
}

function finishTextEdit(e: FocusEvent, asset: WelcomeAsset) {
  const el = e.target as HTMLElement;
  const content = el.innerText ?? "";
  editingTextId.value = null;
  store.updateWelcomeAssetText(assetItemId(asset.id), { content });
}

watch(
  () => props.interactive,
  (on) => {
    if (!on) editingTextId.value = null;
  },
);

function onDragEnd() {
  drag = null;
  dragging.value = false;
  activeGuides.value = [];
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
}

onBeforeUnmount(onDragEnd);

function onDragOver(e: DragEvent) {
  if (!props.interactive) return;
  if (![...((e.dataTransfer?.types as string[] | undefined) || [])].includes("Files")) {
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function hitLayer(e: DragEvent): WelcomeLayer {
  const t = e.target as HTMLElement | null;
  const item = t?.closest("[data-welcome-item]") as HTMLElement | null;
  const id = item?.dataset.welcomeItem;
  if (id === "logo" || id === "start" || (id && id.startsWith("asset:"))) {
    return id;
  }
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
</script>

<template>
  <div
    ref="stageRef"
    class="welcome-stage"
    :class="{
      'welcome-stage--interactive': interactive,
      'welcome-stage--canvas': canvas,
      'welcome-stage--laid-out': useAbs,
      'welcome-stage--dragging': dragging,
    }"
    @click="pick('background', $event)"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <div
      class="welcome-bg welcome-bg--color"
      :style="{ backgroundColor: store.welcomeBackgroundColor }"
    />
    <div v-if="showMediaBg" class="welcome-bg">
      <img
        v-if="store.effectiveTitleBackgroundType === 'image'"
        :src="store.effectiveTitleBackgroundUrl"
        alt=""
        class="welcome-bg-media"
      />
      <video
        v-else
        ref="bgVideoRef"
        :src="store.effectiveTitleBackgroundUrl"
        class="welcome-bg-media"
        autoplay
        muted
        loop
        playsinline
        @loadeddata="playBgVideo"
      />
    </div>

    <div class="welcome-content" :class="{ show: isReady }">
      <div
        class="welcome-logo"
        data-welcome-item="logo"
        :class="{
          'welcome-layer--selected': interactive && selected === 'logo',
        }"
        :style="layout ? boxStyle(layout.logo, 'logo') : { width: logoFlexWidth() }"
        @click="pick('logo', $event)"
        @pointerdown="beginDrag($event, 'logo', 'move')"
      >
        <img :src="logoSrc" alt="Nostalgia Photobooth" />
        <span v-if="interactive" class="welcome-lock" aria-hidden="true">
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
        <template v-if="interactive && selected === 'logo'">
          <span
            v-for="h in HANDLES"
            :key="h"
            class="handle"
            :class="`handle--${h}`"
            @pointerdown="beginDrag($event, 'logo', h)"
          />
        </template>
      </div>

      <div
        class="welcome-start-wrap"
        data-welcome-item="start"
        :class="{
          'welcome-layer--selected': interactive && selected === 'start',
        }"
        :style="layout ? boxStyle(layout.start, 'start') : undefined"
        @click.stop="onStart"
        @pointerdown="beginDrag($event, 'start', 'move')"
      >
        <img
          v-if="store.customStartButtonUrl"
          :src="store.customStartButtonUrl"
          alt="Click Here To Start"
          class="welcome-start-art"
        />
        <BoxButton
          v-else
          class="welcome-start-btn"
          :class="{ 'welcome-start-btn--text': !startBtnUsesArtwork }"
          :margin-top="layout ? '0' : `${Math.round(77 * store.startButtonScale)}px`"
          :style="startBtnCss"
          :svg-src="startBtnUsesArtwork ? startBtnLabel : undefined"
        >
          {{ store.startButtonStyle.label }}
        </BoxButton>
        <span v-if="interactive" class="welcome-lock" aria-hidden="true">
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
        <template v-if="interactive && selected === 'start'">
          <span
            v-for="h in HANDLES"
            :key="h"
            class="handle"
            :class="`handle--${h}`"
            @pointerdown="beginDrag($event, 'start', h)"
          />
        </template>
      </div>

      <div
        v-for="asset in layout?.assets || []"
        :key="asset.id"
        class="welcome-asset"
        :data-welcome-item="assetItemId(asset.id)"
        :class="{
          'welcome-layer--selected':
            interactive && selected === assetItemId(asset.id),
        }"
        :style="assetBoxStyle(asset)"
        @click="pick(assetItemId(asset.id), $event)"
        @dblclick="asset.kind === 'text' && startTextEdit(asset, $event)"
        @pointerdown="beginDrag($event, assetItemId(asset.id), 'move')"
      >
        <template v-if="asset.kind === 'text'">
          <div
            v-if="editingTextId === assetItemId(asset.id)"
            ref="textEditEl"
            class="welcome-text welcome-text--editing"
            contenteditable="true"
            :style="textCss(asset)"
            @pointerdown.stop
            @blur="finishTextEdit($event, asset)"
          />
          <div v-else class="welcome-text" :style="textCss(asset)">
            {{ parseTextStyle(asset.text).content }}
          </div>
        </template>
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
    </div>

    <div
      v-if="interactive && showGuides"
      class="welcome-guides"
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
.welcome-stage {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.welcome-stage--canvas {
  height: 100%;
  width: 100%;
}

.welcome-stage--interactive {
  cursor: default;
}

.welcome-stage--dragging {
  cursor: grabbing;
}

.welcome-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.welcome-bg-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}

.welcome-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  margin-top: -17px;
  z-index: 10;
  opacity: 0;
  transform: translateY(20px);
  transition:
    opacity 0.8s ease,
    transform 0.8s ease;
}

.welcome-content.show {
  opacity: 1;
  transform: translateY(0);
}

.welcome-stage--laid-out .welcome-content {
  position: absolute;
  inset: 0;
  margin: 0;
  display: block;
  opacity: 1;
  transform: none;
  transition: none;
}

.welcome-start-btn :deep(.box-button) {
  padding: calc(20.65px * var(--start-btn-scale, 1))
    calc(33.35px * var(--start-btn-scale, 1));
  border-radius: var(--btn-inner-radius, 2px) !important;
}

.welcome-start-btn :deep(.box-button-svg) {
  width: calc(331.33px * var(--start-btn-scale, 1));
  height: auto;
}

.welcome-start-btn--text :deep(.box-button-svg) {
  width: auto;
}

.welcome-start-btn {
  padding: calc(8.4px * var(--start-btn-scale, 1));
  border-radius: var(--btn-radius, calc(5.5px * var(--start-btn-scale, 1)));
}

.welcome-start-btn--text {
  max-width: 100%;
}

.welcome-start-btn--text :deep(.box-button) {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.welcome-lock {
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
  box-shadow: 0 2px 8px rgba(48, 18, 7, 0.28);
}

.welcome-lock svg {
  width: 18px;
  height: 18px;
}

.welcome-logo {
  position: relative;
  width: min(90%, 1208px);
  max-width: 100%;
  margin: 0 auto;
}

.welcome-start-wrap {
  position: relative;
}

.welcome-stage--laid-out .welcome-logo,
.welcome-stage--laid-out .welcome-start-wrap,
.welcome-stage--laid-out .welcome-asset {
  position: absolute;
  margin: 0;
  max-width: none;
  box-sizing: border-box;
}

.welcome-stage--laid-out .welcome-start-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}

.welcome-stage--laid-out .welcome-start-btn {
  margin-top: 0 !important;
}

.welcome-stage--interactive .welcome-start-btn {
  pointer-events: none;
}

.welcome-logo img,
.welcome-asset img,
.welcome-asset video,
.welcome-start-art {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  pointer-events: none;
}

.welcome-start-art {
  width: min(90%, 331px);
  height: auto;
}

.welcome-stage--laid-out .welcome-start-art {
  width: 100%;
  height: 100%;
}

.welcome-text {
  width: 100%;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  pointer-events: none;
  outline: none;
}

.welcome-text--editing {
  pointer-events: auto;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}

.welcome-stage--interactive .welcome-logo,
.welcome-stage--interactive .welcome-start-wrap,
.welcome-stage--interactive .welcome-asset {
  cursor: grab;
  outline: 2px solid transparent;
  outline-offset: 0;
  border-radius: 2px;
  user-select: none;
  touch-action: none;
}

.welcome-stage--interactive .welcome-layer--selected {
  outline-color: #c4a35a;
}

.welcome-stage--dragging .welcome-logo,
.welcome-stage--dragging .welcome-start-wrap,
.welcome-stage--dragging .welcome-asset {
  cursor: grabbing;
}

.handle {
  position: absolute;
  width: 16px;
  height: 16px;
  background: #fff;
  border: 2px solid #c4a35a;
  border-radius: 2px;
  z-index: 13;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
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

.welcome-guides {
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
  box-shadow: 0 0 0 1px rgba(225, 78, 200, 0.25);
}

@media (max-width: 1200px) {
  .welcome-stage:not(.welcome-stage--canvas):not(.welcome-stage--laid-out)
    .welcome-logo {
    width: min(80%, 700px);
  }
}

@media (max-width: 768px) {
  .welcome-stage:not(.welcome-stage--canvas):not(.welcome-stage--laid-out)
    .welcome-logo {
    width: min(90%, 400px);
  }
}

@media (max-width: 480px) {
  .welcome-stage:not(.welcome-stage--canvas):not(.welcome-stage--laid-out)
    .welcome-logo {
    width: min(92%, 320px);
  }
}
</style>
