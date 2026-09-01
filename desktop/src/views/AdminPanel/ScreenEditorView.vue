<script setup lang="ts">
/**
 * Admin → Screen Editor. Pick a kiosk screen, then edit it against a
 * live 16:9 preview. Only Welcome is available for now.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import WelcomeStage from "@/components/WelcomeStage.vue";
import type { WelcomeLayer } from "@/components/WelcomeStage.vue";

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const SCREENS = [
  {
    id: "welcome" as const,
    name: "Welcome screen",
    description: "Home screen guests see first — logo, start button, and background.",
  },
];

const store = usePhotoboothStore();
const selectedScreen = ref<(typeof SCREENS)[number]["id"] | null>(null);
const selectedLayer = ref<WelcomeLayer>("background");

const frameRef = ref<HTMLElement | null>(null);
const previewScale = ref(0.4);
let resizeObserver: ResizeObserver | null = null;

function fitPreview() {
  const el = frameRef.value;
  if (!el) return;
  const pad = 16;
  const w = Math.max(0, el.clientWidth - pad);
  const h = Math.max(0, el.clientHeight - pad);
  if (w < 8 || h < 8) return;
  previewScale.value = Math.min(w / CANVAS_W, h / CANVAS_H);
}

function clearTitleBackground() {
  store.clearTitleBackground();
}

async function onDropFiles(payload: { files: File[]; layer: WelcomeLayer }) {
  const file = payload.files[0];
  if (!file) return;
  const isVideo =
    file.type.startsWith("video/") ||
    /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(file.name);
  const isImage =
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);
  if (isVideo) {
    selectedLayer.value = "background";
    titleBgMediaChoice.value = "video";
    titleBgBusy.value = true;
    titleBgError.value = "";
    try {
      const ok = await store.setTitleBackgroundFile("video", file);
      if (!ok) titleBgError.value = "Couldn't save the background.";
    } catch (e) {
      titleBgError.value = e instanceof Error ? e.message : "Upload failed.";
    } finally {
      titleBgBusy.value = false;
    }
    return;
  }
  if (!isImage) return;
  if (payload.layer === "logo") {
    selectedLayer.value = "logo";
    const reader = new FileReader();
    reader.onload = () => store.setCustomLogo(reader.result as string);
    reader.readAsDataURL(file);
    return;
  }
  selectedLayer.value = "background";
  titleBgMediaChoice.value = "image";
  titleBgBusy.value = true;
  titleBgError.value = "";
  try {
    const ok = await store.setTitleBackgroundFile("image", file);
    if (!ok) titleBgError.value = "Couldn't save the background.";
  } catch (e) {
    titleBgError.value = e instanceof Error ? e.message : "Upload failed.";
  } finally {
    titleBgBusy.value = false;
  }
}

function resetLayout() {
  store.resetWelcomeLayout();
}

function nudgeSelected(e: KeyboardEvent) {
  if (!selectedScreen.value) return;
  const host = (e.target as HTMLElement | null)?.closest?.(".screen-editor") as HTMLElement | null
    ?? document.querySelector(".screen-editor");
  if (!host || host.offsetParent === null) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (selectedLayer.value !== "logo" && selectedLayer.value !== "start") return;
  const layout = store.ensureWelcomeLayout();
  const box = { ...layout[selectedLayer.value] };
  const stepX = (e.shiftKey ? 10 : 1) / CANVAS_W;
  const stepY = (e.shiftKey ? 10 : 1) / CANVAS_H;
  if (e.key === "ArrowLeft") box.x -= stepX;
  else if (e.key === "ArrowRight") box.x += stepX;
  else if (e.key === "ArrowUp") box.y -= stepY;
  else if (e.key === "ArrowDown") box.y += stepY;
  else return;
  e.preventDefault();
  store.setWelcomeItem(selectedLayer.value, box);
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => fitPreview());
  if (frameRef.value) resizeObserver.observe(frameRef.value);
  fitPreview();
  window.addEventListener("keydown", nudgeSelected);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("keydown", nudgeSelected);
});

watch(selectedScreen, async (id) => {
  if (id === "welcome") store.ensureWelcomeLayout();
  await nextTick();
  if (frameRef.value && resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver.observe(frameRef.value);
  }
  fitPreview();
});

const previewWidth = computed(() => `${Math.round(CANVAS_W * previewScale.value)}px`);
const previewHeight = computed(() => `${Math.round(CANVAS_H * previewScale.value)}px`);

const logoInputRef = ref<HTMLInputElement | null>(null);
const titleBgImageInputRef = ref<HTMLInputElement | null>(null);
const titleBgVideoInputRef = ref<HTMLInputElement | null>(null);
const titleBgMediaChoice = ref<"image" | "video" | "color">("image");
const titleBgError = ref("");
const titleBgBusy = ref(false);
const hexDraft = ref(store.welcomeBackgroundColor);

const BG_SWATCHES = [
  "#f4ead5",
  "#e8d5b5",
  "#ffffff",
  "#000000",
  "#3d2b1f",
  "#6b3b11",
  "#c4a35a",
  "#8b1e1e",
];

watch(
  () => store.welcomeBackgroundColor,
  (c) => {
    hexDraft.value = c;
  },
);

function chooseBgMode(mode: "image" | "video" | "color") {
  titleBgMediaChoice.value = mode;
  store.setWelcomeBackgroundFill(mode === "color" ? "color" : "media");
}

function applyHexColor() {
  store.setWelcomeBackgroundColor(hexDraft.value);
  hexDraft.value = store.welcomeBackgroundColor;
}

watch(
  () => [store.welcomeBackgroundFill, store.titleBackgroundType] as const,
  ([fill, type]) => {
    if (fill === "color") {
      titleBgMediaChoice.value = "color";
      return;
    }
    if (type === "video" || type === "image") titleBgMediaChoice.value = type;
  },
  { immediate: true },
);

function triggerLogoInput() {
  logoInputRef.value?.click();
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
function updateLogoScale(e: Event) {
  store.setTitleLogoScale(parseFloat((e.target as HTMLInputElement).value));
}
function updateStartBtnScale(e: Event) {
  store.setStartButtonScale(parseFloat((e.target as HTMLInputElement).value));
}

async function handleTitleBgFile(kind: "image" | "video", event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  titleBgError.value = "";
  if (!file) return;
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
    if (!ok) {
      titleBgError.value = "Couldn't save the background. Check the app log for details.";
    }
  } catch (e) {
    titleBgError.value = e instanceof Error ? e.message : "Upload failed.";
  } finally {
    titleBgBusy.value = false;
  }
}

const inspectorTitle = computed(() => {
  if (selectedLayer.value === "logo") return "Logo";
  if (selectedLayer.value === "start") return "Start button";
  return "Background";
});
</script>

<template>
  <div class="screen-editor">
    <div v-if="!selectedScreen" class="screen-picker">
      <p class="screen-picker__intro">
        Choose a kiosk screen to edit. Changes apply immediately.
      </p>
      <div class="screen-grid">
        <div
          v-for="screen in SCREENS"
          :key="screen.id"
          class="screen-card"
          role="button"
          tabindex="0"
          :aria-label="`Edit ${screen.name}`"
          @click="selectedScreen = screen.id"
          @keydown.enter.prevent="selectedScreen = screen.id"
          @keydown.space.prevent="selectedScreen = screen.id"
        >
          <div class="screen-card__thumb">
            <div
              v-if="screen.id === 'welcome'"
              class="screen-card__stage"
              :style="{ width: `${CANVAS_W}px`, height: `${CANVAS_H}px` }"
            >
              <WelcomeStage instant canvas />
            </div>
          </div>
          <span class="screen-card__name">{{ screen.name }}</span>
          <span class="screen-card__desc">{{ screen.description }}</span>
        </div>
      </div>
    </div>

    <div v-else class="screen-workspace">
      <div class="screen-toolbar">
        <button type="button" class="screen-back" @click="selectedScreen = null">
          ← Screens
        </button>
        <h2 class="screen-toolbar__title">Welcome screen</h2>
        <button type="button" class="screen-reset" @click="resetLayout">
          Reset layout
        </button>
      </div>

      <div class="screen-workspace__body">
        <div ref="frameRef" class="preview-frame">
          <div
            class="preview-sizer"
            :style="{ width: previewWidth, height: previewHeight }"
          >
            <div
              class="preview-stage"
              :style="{
                width: `${CANVAS_W}px`,
                height: `${CANVAS_H}px`,
                transform: `scale(${previewScale})`,
              }"
            >
              <WelcomeStage
                interactive
                instant
                canvas
                :selected="selectedLayer"
                @select="selectedLayer = $event"
                @drop-files="onDropFiles"
              />
            </div>
          </div>
        </div>

        <aside class="inspector">
          <h3 class="inspector__title">{{ inspectorTitle }}</h3>
          <p class="inspector__hint">
            Drag to move, pull a corner to resize, or drop an image/video onto
            the canvas. Arrow keys nudge; hold Shift for larger steps.
          </p>

          <template v-if="selectedLayer === 'background'">
            <div class="choice-row">
              <label class="radio-option">
                <input
                  type="radio"
                  value="image"
                  :checked="titleBgMediaChoice === 'image'"
                  @change="chooseBgMode('image')"
                />
                <span>Image</span>
              </label>
              <label class="radio-option">
                <input
                  type="radio"
                  value="video"
                  :checked="titleBgMediaChoice === 'video'"
                  @change="chooseBgMode('video')"
                />
                <span>Video</span>
              </label>
              <label class="radio-option">
                <input
                  type="radio"
                  value="color"
                  :checked="titleBgMediaChoice === 'color'"
                  @change="chooseBgMode('color')"
                />
                <span>Color</span>
              </label>
            </div>
            <div v-show="titleBgMediaChoice === 'color'" class="color-editor">
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="store.welcomeBackgroundColor"
                  aria-label="Background color"
                  @input="
                    store.setWelcomeBackgroundColor(
                      ($event.target as HTMLInputElement).value,
                    )
                  "
                />
                <input
                  v-model="hexDraft"
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  aria-label="Hex color"
                  @change="applyHexColor"
                  @keydown.enter.prevent="applyHexColor"
                />
              </div>
              <div class="color-editor__swatches">
                <button
                  v-for="swatch in BG_SWATCHES"
                  :key="swatch"
                  type="button"
                  class="color-swatch"
                  :class="{ 'color-swatch--active': store.welcomeBackgroundColor === swatch }"
                  :style="{ background: swatch }"
                  :aria-label="swatch"
                  @click="store.setWelcomeBackgroundColor(swatch)"
                />
              </div>
              <p class="form-hint">
                Solid color fills the Welcome screen. Switch back to Image or
                Video to use media again.
              </p>
            </div>
            <div
              v-show="titleBgMediaChoice === 'image'"
              class="upload-card"
              :class="{
                'upload-card--filled':
                  store.titleBackgroundType === 'image' && store.titleBackgroundUrl,
              }"
              @click="titleBgImageInputRef?.click()"
            >
              <input
                ref="titleBgImageInputRef"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                class="upload-card-input"
                @change="handleTitleBgFile('image', $event)"
              />
              <template
                v-if="store.titleBackgroundType === 'image' && store.titleBackgroundUrl"
              >
                <img :src="store.titleBackgroundUrl" alt="" class="upload-card-preview" />
              </template>
              <template v-else>
                <span class="upload-card-icon">+</span>
                <span class="upload-card-text">Upload image</span>
              </template>
            </div>
            <div
              v-show="titleBgMediaChoice === 'video'"
              class="upload-card"
              :class="{
                'upload-card--filled':
                  store.titleBackgroundType === 'video' && store.titleBackgroundUrl,
              }"
              @click="titleBgVideoInputRef?.click()"
            >
              <input
                ref="titleBgVideoInputRef"
                type="file"
                accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"
                class="upload-card-input"
                @change="handleTitleBgFile('video', $event)"
              />
              <template
                v-if="store.titleBackgroundType === 'video' && store.titleBackgroundUrl"
              >
                <video
                  :src="store.titleBackgroundUrl"
                  class="upload-card-preview"
                  muted
                  playsinline
                />
              </template>
              <template v-else>
                <span class="upload-card-icon">+</span>
                <span class="upload-card-text">Upload video</span>
              </template>
            </div>
            <p v-if="titleBgBusy" class="form-hint">Saving background…</p>
            <p v-if="titleBgError" class="form-error">{{ titleBgError }}</p>
            <template v-if="titleBgMediaChoice !== 'color'">
              <p class="form-hint">
                MP4 (H.264) plays most reliably. Clearing returns to the default
                Welcome background.
              </p>
              <button
                v-if="store.titleBackgroundUrl"
                type="button"
                class="btn-clear"
                @click="clearTitleBackground"
              >
                Clear uploaded background
              </button>
            </template>
          </template>

          <template v-else-if="selectedLayer === 'logo'">
            <div
              class="upload-card"
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
                <img :src="store.customLogoUrl" alt="Custom logo" class="upload-card-preview" />
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
            <label class="form-label">
              Size — {{ Math.round(store.titleLogoScale * 100) }}%
            </label>
            <p class="form-hint">100% is the size in the approved design.</p>
            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.01"
              :value="store.titleLogoScale"
              class="form-range"
              @input="updateLogoScale"
            />
          </template>

          <template v-else>
            <label class="form-label">
              Size — {{ Math.round(store.startButtonScale * 100) }}%
            </label>
            <p class="form-hint">
              100% is the full design size; it ships at 80% for a 24" screen.
            </p>
            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.01"
              :value="store.startButtonScale"
              class="form-range"
              @input="updateStartBtnScale"
            />
          </template>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screen-editor {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.screen-picker {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
}

.screen-picker__intro {
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--color-brown);
  margin: 0 0 1.25rem;
}

.screen-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.screen-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.65rem;
  padding: 0.75rem;
  text-align: left;
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.screen-card:hover,
.screen-card:focus-visible {
  border-color: var(--color-brown-dark);
  background: var(--color-cream-dark);
  outline: none;
}

.screen-card__thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 8px;
  background: #2a1c14;
  border: 1px solid var(--color-brown-light);
  container-type: inline-size;
  pointer-events: none;
}

.screen-card__stage {
  transform-origin: top left;
  transform: scale(calc(100cqw / 1920));
}

.screen-card__name {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-brown-dark);
}

.screen-card__desc {
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--color-brown);
  line-height: 1.4;
}

.screen-workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.screen-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--color-brown-light);
}

.screen-back {
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-brown);
  background: transparent;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
}

.screen-back:hover {
  color: var(--color-brown-dark);
  border-color: var(--color-brown);
}

.screen-toolbar__title {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0;
  flex: 1;
}

.screen-reset {
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-brown);
  background: transparent;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
}

.screen-reset:hover {
  color: var(--color-brown-dark);
  border-color: var(--color-brown);
}

.screen-workspace__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
}

.preview-frame {
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #2a1c14;
  overflow: hidden;
}

.preview-sizer {
  position: relative;
  flex-shrink: 0;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.preview-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  pointer-events: auto;
}

.inspector {
  min-height: 0;
  overflow-y: auto;
  padding: 1.15rem;
  background: var(--color-cream-dark);
  border-left: 2px solid var(--color-brown-light);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.inspector__title {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0;
}

.inspector__hint {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--color-brown);
  margin: 0;
}

.choice-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem 1.25rem;
}

.radio-option {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--color-brown-dark);
}

.color-editor {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.color-editor__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.color-editor__picker {
  width: 48px;
  height: 40px;
  padding: 0;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.color-editor__hex {
  flex: 1;
  min-width: 0;
  padding: 0.45rem 0.6rem;
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--color-brown-dark);
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
}

.color-editor__hex:focus {
  outline: none;
  border-color: var(--color-brown-dark);
}

.color-editor__swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.color-swatch {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 2px solid rgba(61, 43, 31, 0.25);
  border-radius: 6px;
  cursor: pointer;
}

.color-swatch--active {
  border-color: var(--color-brown-dark);
  box-shadow: 0 0 0 2px #c4a35a;
}

.form-label {
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

.form-hint {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--color-brown);
  margin: 0;
}

.form-error {
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: #b23b3b;
  margin: 0;
}

.form-range {
  width: 100%;
  accent-color: var(--color-brown-dark);
}

.upload-card {
  position: relative;
  min-height: 110px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  padding: 0.85rem;
  background: var(--color-cream);
  border: 2px dashed var(--color-brown-light);
  border-radius: 10px;
  color: var(--color-brown-light);
  cursor: pointer;
}

.upload-card:hover {
  border-color: var(--color-brown);
  color: var(--color-brown);
}

.upload-card--filled {
  border-style: solid;
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
  max-height: 120px;
  object-fit: contain;
  display: block;
  border-radius: 6px;
}

.upload-card-icon {
  font-size: 1.75rem;
  font-weight: 300;
  line-height: 1;
}

.upload-card-text {
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
}

.upload-card-hint {
  font-family: var(--font-body);
  font-size: 0.75rem;
  opacity: 0.8;
}

.upload-card-remove {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--color-brown-dark);
  color: var(--color-cream);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}

.btn-clear {
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--color-brown);
  background: transparent;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  padding: 0.45rem 0.7rem;
  cursor: pointer;
  align-self: flex-start;
}

.btn-clear:hover {
  border-color: var(--color-brown);
  color: var(--color-brown-dark);
}
</style>
