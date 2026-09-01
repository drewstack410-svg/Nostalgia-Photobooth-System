<script setup lang="ts">
/**
 * Welcome (title) screen stage. Guest mode uses saved layout when
 * present, otherwise the original centred stack. Editor mode is a
 * Canva-style canvas: drag to move, corner handles to resize, drop
 * files onto the stage.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import BoxButton from "@/components/BoxButton.vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import {
  resizeBox,
  type WelcomeBox,
  type WelcomeItemId,
} from "@/utils/welcomeLayout";

export type WelcomeLayer = "background" | "logo" | "start";
type Handle = "nw" | "ne" | "sw" | "se";

const props = withDefaults(
  defineProps<{
    interactive?: boolean;
    selected?: WelcomeLayer | null;
    instant?: boolean;
    canvas?: boolean;
  }>(),
  { interactive: false, selected: null, instant: false, canvas: false },
);

const emit = defineEmits<{
  start: [];
  select: [layer: WelcomeLayer];
  "drop-files": [payload: { files: File[]; layer: WelcomeLayer }];
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
const useAbs = computed(() => props.interactive || !!layout.value);

const isReady = ref(props.instant);
onMounted(() => {
  if (props.instant) {
    if (props.interactive) store.ensureWelcomeLayout();
    return;
  }
  setTimeout(() => {
    isReady.value = true;
  }, 100);
});

function boxStyle(box: WelcomeBox) {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
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
  e.preventDefault();
  e.stopPropagation();
  emit("select", id);
  const laid = store.ensureWelcomeLayout();
  drag = {
    id,
    mode,
    startPtr: toFrac(e.clientX, e.clientY),
    startBox: { ...laid[id] },
  };
  dragging.value = true;
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd);
  window.addEventListener("pointercancel", onDragEnd);
}

function onDragMove(e: PointerEvent) {
  if (!drag) return;
  const p = toFrac(e.clientX, e.clientY);
  const dx = p.x - drag.startPtr.x;
  const dy = p.y - drag.startPtr.y;
  if (drag.mode === "move") {
    store.setWelcomeItem(drag.id, {
      ...drag.startBox,
      x: drag.startBox.x + dx,
      y: drag.startBox.y + dy,
    });
    return;
  }
  store.setWelcomeItem(
    drag.id,
    resizeBox(drag.startBox, drag.mode, dx, dy),
  );
}

function onDragEnd() {
  drag = null;
  dragging.value = false;
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
  if (t?.closest("[data-welcome-item='logo']")) return "logo";
  if (t?.closest("[data-welcome-item='start']")) return "start";
  return "background";
}

function onDrop(e: DragEvent) {
  if (!props.interactive) return;
  e.preventDefault();
  e.stopPropagation();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const layer = hitLayer(e);
  emit("select", layer === "start" ? "background" : layer);
  emit("drop-files", {
    files,
    layer: layer === "start" ? "background" : layer,
  });
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
        :src="store.effectiveTitleBackgroundUrl"
        class="welcome-bg-media"
        autoplay
        muted
        loop
        playsinline
      />
    </div>

    <div class="welcome-content" :class="{ show: isReady }">
      <div
        class="welcome-logo"
        data-welcome-item="logo"
        :class="{
          'welcome-layer--selected': interactive && selected === 'logo',
        }"
        :style="layout ? boxStyle(layout.logo) : { width: logoFlexWidth() }"
        @click="pick('logo', $event)"
        @pointerdown="beginDrag($event, 'logo', 'move')"
      >
        <img :src="logoSrc" alt="Nostalgia Photobooth" />
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
        :style="layout ? boxStyle(layout.start) : undefined"
        @click.stop="onStart"
        @pointerdown="beginDrag($event, 'start', 'move')"
      >
        <BoxButton
          class="welcome-start-btn"
          :margin-top="layout ? '0' : `${Math.round(77 * store.startButtonScale)}px`"
          :style="{
            '--start-btn-scale': layout
              ? (layout.start.w * 1920) / 414.8
              : store.startButtonScale,
          }"
          :svg-src="startBtnLabel"
        />
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
}

.welcome-start-btn :deep(.box-button-svg) {
  width: calc(331.33px * var(--start-btn-scale, 1));
  height: auto;
}

.welcome-start-btn {
  padding: calc(8.4px * var(--start-btn-scale, 1));
  border-radius: calc(5.5px * var(--start-btn-scale, 1));
}

.welcome-logo {
  width: min(90%, 1208px);
  max-width: 100%;
  margin: 0 auto;
}

.welcome-stage--laid-out .welcome-logo,
.welcome-stage--laid-out .welcome-start-wrap {
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

.welcome-logo img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  pointer-events: none;
}

.welcome-stage--interactive .welcome-logo,
.welcome-stage--interactive .welcome-start-wrap {
  cursor: grab;
  outline: 2px solid transparent;
  outline-offset: 0;
  border-radius: 2px;
  user-select: none;
  touch-action: none;
}

.welcome-stage--interactive .welcome-layer--selected {
  outline-color: #c4a35a;
  z-index: 12;
}

.welcome-stage--dragging .welcome-logo,
.welcome-stage--dragging .welcome-start-wrap {
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
