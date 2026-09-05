<script setup lang="ts">
/**
 * Admin → Screen Editor. Pick a kiosk screen, then edit it against a
 * live 16:9 preview.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import WelcomeStage from "@/components/WelcomeStage.vue";
import KioskStage from "@/components/KioskStage.vue";
import {
  clampBox,
  getItemBox,
  isAssetId,
  isMovableLayer,
  layerLabel,
  parseTextStyle,
  reorderVisualLayers,
  type WelcomeAssetKind,
  type WelcomeBox,
  type WelcomeItemId,
  type WelcomeStartButtonStyle,
  type WelcomeTextStyle,
} from "@/utils/welcomeLayout";
import {
  KIOSK_SCREENS,
  defaultKioskButtonStyle,
  isKioskLockedLayer,
  isKioskMovableLayer,
  isKioskScreenId,
  getKioskItemBox,
  kioskButtonRadiusMax,
  kioskItemDef,
  kioskLayerLabel,
  kioskScreenDef,
  type KioskButtonStyle,
  type KioskScreenId,
} from "@/utils/kioskLayout";

const TEXT_FONTS = [
  { label: "Display", value: "var(--font-display)" },
  { label: "Body", value: "var(--font-body)" },
  { label: "Playfair Display", value: '"Playfair Display", Georgia, serif' },
  { label: "Cormorant Garamond", value: '"Cormorant Garamond", Georgia, serif' },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: '"Times New Roman", Times, serif' },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Trebuchet MS", value: '"Trebuchet MS", sans-serif' },
  { label: "Impact", value: "Impact, Haettenschweiler, sans-serif" },
  { label: "Courier New", value: '"Courier New", Courier, monospace' },
];

const TEXT_WEIGHTS = [
  { label: "Regular", value: 400 },
  { label: "Medium", value: 500 },
  { label: "Semibold", value: 600 },
  { label: "Bold", value: 700 },
  { label: "Extra Bold", value: 800 },
  { label: "Black", value: 900 },
];

const CANVAS_W = 1920;
const CANVAS_H = 1080;

type EditorScreenId = "welcome" | KioskScreenId;

const SCREENS: {
  id: EditorScreenId;
  name: string;
  description: string;
}[] = [
  {
    id: "welcome",
    name: "Welcome screen",
    description: "Home screen guests see first — logo, start button, and background.",
  },
  ...KIOSK_SCREENS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
  })),
];

const store = usePhotoboothStore();
const selectedScreen = ref<EditorScreenId | null>(null);
const selectedLayer = ref<string>("background");
const isWelcome = computed(() => selectedScreen.value === "welcome");
const kioskId = computed<KioskScreenId | null>(() =>
  isKioskScreenId(selectedScreen.value) ? selectedScreen.value : null,
);

function activeAssets() {
  if (kioskId.value) return store.kioskLayoutOf(kioskId.value)?.assets ?? [];
  return store.welcomeLayout?.assets ?? [];
}

function addAssetToScreen(
  src: string,
  name: string,
  box: WelcomeBox | undefined,
  kind: WelcomeAssetKind,
  text?: WelcomeTextStyle,
) {
  if (kioskId.value) {
    return store.addKioskAsset(kioskId.value, src, name, box, kind, text);
  }
  return store.addWelcomeAsset(src, name, box, kind, text);
}

function replaceAssetSrc(
  id: string,
  src: string,
  kind?: "image" | "video",
) {
  if (kioskId.value) {
    store.replaceKioskAssetSrc(kioskId.value, id, src, kind);
    return;
  }
  store.replaceWelcomeAssetSrc(id, src, kind);
}

function removeAsset(id: string) {
  if (kioskId.value) {
    store.removeKioskAsset(kioskId.value, id);
    return;
  }
  store.removeWelcomeAsset(id);
}

function updateAssetText(id: string, patch: Partial<WelcomeTextStyle>) {
  if (kioskId.value) {
    store.updateKioskAssetText(kioskId.value, id, patch);
    return;
  }
  store.updateWelcomeAssetText(id, patch);
}

function layoutDirty() {
  if (kioskId.value) return store.kioskLayoutDirty(kioskId.value);
  return store.welcomeLayoutDirty;
}

function selectedKioskItem() {
  const id = kioskId.value;
  if (!id) return undefined;
  return kioskItemDef(id, selectedLayer.value);
}

const selectedKioskButton = computed(() => {
  const id = kioskId.value;
  const item = selectedKioskItem();
  if (!id || item?.kind !== "button") return null;
  const saved = store.kioskLayoutOf(id)?.buttons[selectedLayer.value];
  if (saved) return saved;
  return defaultKioskButtonStyle(
    item.buttonLabel || item.label,
    item.buttonVariant || "wood",
  );
});

const kioskButtonCornerMax = computed(() =>
  kioskButtonRadiusMax(selectedKioskItem()?.buttonVariant || "wood"),
);

const editorRef = ref<HTMLElement | null>(null);
const thumbRef = ref<HTMLElement | null>(null);
const frameRef = ref<HTMLElement | null>(null);
const previewScale = ref(0.4);
const thumbScale = ref(0.2);
let resizeObserver: ResizeObserver | null = null;
let visibilityObserver: IntersectionObserver | null = null;

function asEl(v: unknown): HTMLElement | null {
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] as HTMLElement | undefined) ?? null;
  return v instanceof HTMLElement ? v : null;
}

function scaleToBox(el: HTMLElement | null, pad = 0): number | null {
  if (!el) return null;
  const w = Math.max(0, el.clientWidth - pad);
  const h = Math.max(0, el.clientHeight - pad);
  if (w < 8 || h < 8) return null;
  return Math.min(w / CANVAS_W, h / CANVAS_H);
}

function applyScale(target: { value: number }, next: number | null) {
  if (next == null || Math.abs(next - target.value) < 0.0005) return;
  target.value = next;
}

function fitPreview() {
  applyScale(previewScale, scaleToBox(asEl(frameRef.value), 16));
  applyScale(thumbScale, scaleToBox(asEl(thumbRef.value)));
}

function clearTitleBackground() {
  if (kioskId.value) {
    store.clearKioskBackground(kioskId.value);
    store.setKioskBackgroundFill(kioskId.value, "theme");
    kioskBgTab.value = "theme";
  } else {
  store.clearTitleBackground();
  }
}

async function onDropFiles(payload: { files: File[]; layer: string }) {
  const file = payload.files[0];
  if (!file) return;
  const isVideo =
    file.type.startsWith("video/") ||
    /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(file.name);
  const isImage =
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);
  if (isVideo) {
    if (isAssetId(payload.layer)) {
      const current = activeAssets().find(
        (a) => `asset:${a.id}` === payload.layer,
      );
      if (current?.kind === "text") {
        await addAssetFile(file);
        return;
      }
      selectedLayer.value = payload.layer;
      checkpoint();
      const src = await readFileDataUrl(file);
      replaceAssetSrc(payload.layer, src, "video");
      return;
    }
    selectedLayer.value = "background";
    titleBgMediaChoice.value = "video";
    titleBgBusy.value = true;
    titleBgError.value = "";
    try {
      const ok = kioskId.value
        ? await store.setKioskBackgroundFile(kioskId.value, "video", file)
        : await store.setTitleBackgroundFile("video", file);
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
    checkpoint();
    const reader = new FileReader();
    reader.onload = () => store.setCustomLogo(reader.result as string);
    reader.readAsDataURL(file);
    return;
  }
  if (payload.layer === "start") {
    selectedLayer.value = "start";
    checkpoint();
    const reader = new FileReader();
    reader.onload = () =>
      store.setCustomStartButton(reader.result as string);
    reader.readAsDataURL(file);
    return;
  }
  if (isAssetId(payload.layer)) {
    const current = activeAssets().find(
      (a) => `asset:${a.id}` === payload.layer,
    );
    if (current?.kind === "text") {
      await addAssetFile(file);
      return;
    }
    selectedLayer.value = payload.layer;
    checkpoint();
    const reader = new FileReader();
    reader.onload = () =>
      replaceAssetSrc(payload.layer, reader.result as string, "image");
    reader.readAsDataURL(file);
    return;
  }
  await addAssetFile(file);
}

function resetLayout() {
  checkpoint();
  if (kioskId.value) store.resetKioskLayout(kioskId.value);
  else store.resetWelcomeLayout();
  selectedLayer.value = "background";
}

const assetInputRef = ref<HTMLInputElement | null>(null);
const videoAssetInputRef = ref<HTMLInputElement | null>(null);

function boxFromNatural(natW: number, natH: number): WelcomeBox {
  const w = 0.3;
  const h = Math.min(0.7, (w * CANVAS_W * natH) / (natW * CANVAS_H));
  return clampBox({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readNaturalSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => resolve({ w: 1, h: 1 });
    img.src = src;
  });
}

function readVideoSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      resolve({ w: video.videoWidth || 16, h: video.videoHeight || 9 });
    video.onerror = () => resolve({ w: 16, h: 9 });
    video.src = src;
  });
}

function fileKind(file: File): WelcomeAssetKind | null {
  if (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name)
  ) {
    return "image";
  }
  if (
    file.type.startsWith("video/") ||
    /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(file.name)
  ) {
    return "video";
  }
  return null;
}

async function addAssetFile(file: File) {
  const kind = fileKind(file);
  if (!kind) return;
  checkpoint();
  const src = await readFileDataUrl(file);
  const { w, h } =
    kind === "video" ? await readVideoSize(src) : await readNaturalSize(src);
  const name = file.name.replace(/\.[^.]+$/, "") || (kind === "video" ? "Video" : "Image");
  selectedLayer.value = addAssetToScreen(
    src,
    name,
    boxFromNatural(w, h),
    kind,
  );
}

function onAssetInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void addAssetFile(file);
}

function addText() {
  checkpoint();
  selectedLayer.value = addAssetToScreen(
    "",
    "Text",
    clampBox({ x: 0.22, y: 0.38, w: 0.56, h: 0.16 }),
    "text",
  );
  void nextTick(() => textContentRef.value?.focus());
}

function patchSelectedText(patch: Partial<WelcomeTextStyle>) {
  const kioskText = selectedKioskItem();
  if (kioskId.value && kioskText?.kind === "text") {
    store.updateKioskText(kioskId.value, selectedLayer.value, patch);
    return;
  }
  if (!selectedAsset.value || selectedAsset.value.kind !== "text") return;
  updateAssetText(selectedLayer.value, patch);
}

function deleteSelectedAsset() {
  if (!isAssetId(selectedLayer.value)) return;
  checkpoint();
  removeAsset(selectedLayer.value);
  selectedLayer.value = "background";
}

function sendSelected(dir: "back" | "front" | "backward" | "forward") {
  const id = selectedItem();
  if (!id) return;
  checkpoint();
  if (kioskId.value) store.sendKioskLayer(kioskId.value, id, dir);
  else store.sendWelcomeLayer(id, dir);
}

const dragLayerId = ref<string | null>(null);
const dragOverLayerId = ref<string | null>(null);

function onLayerDragStart(id: string, e: DragEvent) {
  if (id === "background") {
    e.preventDefault();
    return;
  }
  dragLayerId.value = id;
  selectedLayer.value = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
}

function onLayerDragOver(id: string, e: DragEvent) {
  if (!dragLayerId.value || id === "background" || id === dragLayerId.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dragOverLayerId.value = id;
}

function onLayerDrop(id: string, e: DragEvent) {
  e.preventDefault();
  const from = dragLayerId.value;
  dragLayerId.value = null;
  dragOverLayerId.value = null;
  if (!from || id === "background" || from === id) return;
  if (kioskId.value) {
    const layout = store.ensureKioskLayout(kioskId.value);
    const next = reorderVisualLayers(layout.order, from, id);
    if (next.join() === layout.order.join()) return;
    checkpoint();
    store.setKioskLayerOrder(kioskId.value, next);
    return;
  }
  const layout = store.ensureWelcomeLayout();
  const next = reorderVisualLayers(layout.order, from, id);
  if (next.join() === layout.order.join()) return;
  checkpoint();
  store.setWelcomeLayerOrder(next);
}

function onLayerDragEnd() {
  dragLayerId.value = null;
  dragOverLayerId.value = null;
}

const showGuides = ref(true);
const showShortcuts = ref(false);
const shortcutsRef = ref<HTMLElement | null>(null);
const shortcutMod = /mac|iphone|ipad/i.test(navigator.platform) ? "⌘" : "Ctrl";
const saveFlash = ref(false);
let saveFlashTimer: ReturnType<typeof setTimeout> | null = null;

function saveScreen() {
  if (kioskId.value) store.saveKioskLayout(kioskId.value);
  else store.saveWelcomeLayout();
  saveFlash.value = true;
  if (saveFlashTimer) clearTimeout(saveFlashTimer);
  saveFlashTimer = setTimeout(() => {
    saveFlash.value = false;
  }, 1600);
}

function leaveWorkspace() {
  if (kioskId.value) {
    if (store.kioskLayoutDirty(kioskId.value)) {
      store.revertKioskLayout(kioskId.value);
    }
  } else if (store.welcomeLayoutDirty) {
    store.revertWelcomeLayout();
  }
  clearHistory();
  selectedScreen.value = null;
  selectedLayer.value = "background";
}

type EditorSnap = {
  welcomeLayout?: ReturnType<typeof store.ensureWelcomeLayout> | null;
  kioskLayout?: ReturnType<typeof store.ensureKioskLayout> | null;
  logo: string | null;
  startBtn: string | null;
  startBtnStyle?: WelcomeStartButtonStyle;
};

type WelcomeClip = {
  id: WelcomeItemId;
  box: WelcomeBox;
  logoUrl: string | null;
  startBtnUrl?: string | null;
  assetSrc?: string;
  assetName?: string;
  assetKind?: WelcomeAssetKind;
  text?: WelcomeTextStyle;
};

const undoStack = ref<string[]>([]);
const redoStack = ref<string[]>([]);
const canUndo = computed(() => undoStack.value.length > 0);
const canRedo = computed(() => redoStack.value.length > 0);
const clipboard = ref<WelcomeClip | null>(null);

const DUP_X = 24 / CANVAS_W;
const DUP_Y = 24 / CANVAS_H;

function closeShortcutsOnOutside(e: MouseEvent) {
  const host = shortcutsRef.value;
  if (!host || host.contains(e.target as Node)) return;
  showShortcuts.value = false;
}

watch(showShortcuts, (open) => {
  if (open) {
    void nextTick(() =>
      document.addEventListener("mousedown", closeShortcutsOnOutside),
    );
  } else {
    document.removeEventListener("mousedown", closeShortcutsOnOutside);
  }
});

function editorIsActive(): boolean {
  if (!selectedScreen.value) return false;
  const host =
    editorRef.value ??
    document.querySelector(".screen-editor");
  return !!host && (host as HTMLElement).offsetParent !== null;
}

function currentSnap(): string {
  return JSON.stringify({
    welcomeLayout: isWelcome.value ? store.welcomeLayout : undefined,
    kioskLayout: kioskId.value ? store.kioskLayoutOf(kioskId.value) : undefined,
    logo: store.customLogoUrl,
    startBtn: store.customStartButtonUrl,
    startBtnStyle: store.startButtonStyle,
  } satisfies EditorSnap);
}

function checkpoint() {
  if (!selectedScreen.value) return;
  if (kioskId.value) store.ensureKioskLayout(kioskId.value);
  else store.ensureWelcomeLayout();
  const snap = currentSnap();
  if (snap === undoStack.value[undoStack.value.length - 1]) return;
  undoStack.value.push(snap);
  if (undoStack.value.length > 50) undoStack.value.shift();
  redoStack.value = [];
}

function applySnap(raw: string) {
  let data: EditorSnap;
  try {
    data = JSON.parse(raw) as EditorSnap;
  } catch {
    return;
  }
  if (data.welcomeLayout) store.applyWelcomeLayout(data.welcomeLayout);
  if (kioskId.value && data.kioskLayout) {
    store.setKioskLayout(kioskId.value, data.kioskLayout);
  }
  if (data.logo) store.setCustomLogo(data.logo);
  else store.clearCustomLogo();
  if (data.startBtn) store.setCustomStartButton(data.startBtn);
  else store.clearCustomStartButton();
  if (data.startBtnStyle) store.applyStartButtonStyle(data.startBtnStyle);
}

function undo() {
  const prev = undoStack.value.pop();
  if (!prev) return;
  redoStack.value.push(currentSnap());
  applySnap(prev);
}

function redo() {
  const next = redoStack.value.pop();
  if (!next) return;
  undoStack.value.push(currentSnap());
  applySnap(next);
}

function clearHistory() {
  undoStack.value = [];
  redoStack.value = [];
  clipboard.value = null;
}

function offsetBox(box: WelcomeBox): WelcomeBox {
  return clampBox({ ...box, x: box.x + DUP_X, y: box.y + DUP_Y });
}

function selectedItem(): string | null {
  if (kioskId.value) {
    return isKioskMovableLayer(kioskId.value, selectedLayer.value)
      ? selectedLayer.value
      : null;
  }
  return isMovableLayer(selectedLayer.value) ? selectedLayer.value : null;
}

function isLockedLayer(id: string) {
  if (kioskId.value) return isKioskLockedLayer(kioskId.value, id);
  return id === "logo" || id === "start" || id === "background";
}

function copySelected() {
  const id = selectedItem();
  if (!id || isLockedLayer(id)) return;
  if (kioskId.value) {
    const layout = store.ensureKioskLayout(kioskId.value);
    const box = getKioskItemBox(layout, id);
    if (!box) return;
    const asset = isAssetId(id)
      ? layout.assets.find((a) => `asset:${a.id}` === id)
      : undefined;
    clipboard.value = {
      id,
      box: { ...box },
      logoUrl: null,
      assetSrc: asset?.src,
      assetName: asset?.name,
      assetKind: asset?.kind,
      text: asset?.kind === "text" ? asset.text : undefined,
    };
    return;
  }
  const layout = store.ensureWelcomeLayout();
  const box = getItemBox(layout, id);
  if (!box) return;
  const asset = isAssetId(id)
    ? layout.assets.find((a) => `asset:${a.id}` === id)
    : undefined;
  clipboard.value = {
    id,
    box: { ...box },
    logoUrl: id === "logo" ? store.customLogoUrl : null,
    startBtnUrl: id === "start" ? store.customStartButtonUrl : null,
    assetSrc: asset?.src,
    assetName: asset?.name,
    assetKind: asset?.kind,
    text: asset?.kind === "text" ? asset.text : undefined,
  };
}

function pasteClipboard() {
  const clip = clipboard.value;
  if (!clip || isLockedLayer(clip.id)) return;
  checkpoint();
  if (clip.assetKind === "text" || clip.text) {
    selectedLayer.value = addAssetToScreen(
      "",
      clip.assetName || "Text",
      offsetBox(clip.box),
      "text",
      clip.text,
    );
    return;
  }
  if (clip.assetSrc) {
    selectedLayer.value = addAssetToScreen(
      clip.assetSrc,
      clip.assetName || (clip.assetKind === "video" ? "Video" : "Image"),
      offsetBox(clip.box),
      clip.assetKind || "image",
    );
    return;
  }
  if (kioskId.value) return;
  const layout = store.ensureWelcomeLayout();
  const current = getItemBox(layout, clip.id);
  if (!current) return;
  store.setWelcomeItem(clip.id, offsetBox(current));
  if (clip.id === "logo" && clip.logoUrl) store.setCustomLogo(clip.logoUrl);
  if (clip.id === "start" && clip.startBtnUrl)
    store.setCustomStartButton(clip.startBtnUrl);
  selectedLayer.value = clip.id;
}

function duplicateSelected() {
  const id = selectedItem();
  if (!id || isLockedLayer(id)) return;
  copySelected();
  pasteClipboard();
}

async function pasteFromKeyboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      applyPastedImage(
        new File([blob], "pasted.png", { type: blob.type || "image/png" }),
      );
      return;
    }
  } catch {
    /* system clipboard has no image, or permission was denied */
  }
  pasteClipboard();
}

function applyPastedImage(file: File) {
  if (selectedLayer.value === "logo") {
    checkpoint();
    const reader = new FileReader();
    reader.onload = () => store.setCustomLogo(reader.result as string);
    reader.readAsDataURL(file);
    return;
  }
  if (selectedLayer.value === "start") {
    checkpoint();
    const reader = new FileReader();
    reader.onload = () =>
      store.setCustomStartButton(reader.result as string);
    reader.readAsDataURL(file);
    return;
  }
  if (isAssetId(selectedLayer.value)) {
    void onDropFiles({ files: [file], layer: selectedLayer.value });
    return;
  }
  void addAssetFile(file);
}

function onEditorKey(e: KeyboardEvent) {
  if (e.key === "Escape" && showShortcuts.value) {
    e.preventDefault();
    showShortcuts.value = false;
    return;
  }
  if (!editorIsActive()) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (e.target as HTMLElement | null)?.isContentEditable
  ) {
    return;
  }
  const meta = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (meta && key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if (meta && (key === "y" || (key === "z" && e.shiftKey))) {
    e.preventDefault();
    redo();
    return;
  }
  if (meta && key === "c") {
    e.preventDefault();
    copySelected();
    return;
  }
  if (meta && key === "v") {
    e.preventDefault();
    void pasteFromKeyboard();
    return;
  }
  if (meta && key === "d") {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (e.key === "[" ) {
    e.preventDefault();
    sendSelected(meta ? "back" : "backward");
    return;
  }
  if (e.key === "]") {
    e.preventDefault();
    sendSelected(meta ? "front" : "forward");
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (!isAssetId(selectedLayer.value)) return;
    e.preventDefault();
    deleteSelectedAsset();
    return;
  }

  const id = selectedItem();
  if (!id) return;
  let current: WelcomeBox | null = null;
  if (kioskId.value) {
    const layout = store.ensureKioskLayout(kioskId.value);
    current = getKioskItemBox(layout, id);
  } else {
  const layout = store.ensureWelcomeLayout();
    current = getItemBox(layout, id);
  }
  if (!current) return;
  const box = { ...current };
  const stepX = (e.shiftKey ? 10 : 1) / CANVAS_W;
  const stepY = (e.shiftKey ? 10 : 1) / CANVAS_H;
  if (e.key === "ArrowLeft") box.x -= stepX;
  else if (e.key === "ArrowRight") box.x += stepX;
  else if (e.key === "ArrowUp") box.y -= stepY;
  else if (e.key === "ArrowDown") box.y += stepY;
  else return;
  e.preventDefault();
  checkpoint();
  if (kioskId.value) store.setKioskItem(kioskId.value, id, box);
  else store.setWelcomeItem(id, box);
}

function onEditorPaste(e: ClipboardEvent) {
  if (!editorIsActive()) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (e.target as HTMLElement | null)?.isContentEditable
  ) {
    return;
  }
  const file = [...(e.clipboardData?.files || [])].find((f) =>
    f.type.startsWith("image/"),
  );
  if (!file) return;
  e.preventDefault();
  applyPastedImage(file);
}

let previewAlive = true;

function observePreview() {
  if (!previewAlive || !resizeObserver) return;
  resizeObserver.disconnect();
  const editor = asEl(editorRef.value);
  const thumb = asEl(thumbRef.value);
  const frame = asEl(frameRef.value);
  if (editor) resizeObserver.observe(editor);
  if (thumb) resizeObserver.observe(thumb);
  if (frame) resizeObserver.observe(frame);
  fitPreview();
}

onMounted(() => {
  previewAlive = true;
  resizeObserver = new ResizeObserver(() => {
    if (previewAlive) fitPreview();
  });
  visibilityObserver = new IntersectionObserver((entries) => {
    if (!previewAlive) return;
    if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0)) {
      void nextTick(() => {
        if (previewAlive) fitPreview();
      });
    }
  });
  if (editorRef.value) visibilityObserver.observe(editorRef.value);
  observePreview();
  window.addEventListener("keydown", onEditorKey);
  window.addEventListener("paste", onEditorPaste);
});

onBeforeUnmount(() => {
  previewAlive = false;
  if (saveFlashTimer) clearTimeout(saveFlashTimer);
  if (kioskId.value && store.kioskLayoutDirty(kioskId.value)) {
    store.revertKioskLayout(kioskId.value);
  } else if (store.welcomeLayoutDirty) {
    store.revertWelcomeLayout();
  }
  resizeObserver?.disconnect();
  visibilityObserver?.disconnect();
  document.removeEventListener("mousedown", closeShortcutsOnOutside);
  window.removeEventListener("keydown", onEditorKey);
  window.removeEventListener("paste", onEditorPaste);
});

watch(selectedScreen, async (id) => {
  selectedLayer.value = "background";
  if (id === "welcome") {
    store.ensureWelcomeLayout();
    clearHistory();
  } else if (isKioskScreenId(id)) {
    const layout = store.ensureKioskLayout(id);
    const fill = layout.backgroundFill;
    kioskBgTab.value =
      fill === "media" ? "image" : fill === "color" ? "color" : "theme";
    clearHistory();
  }
  await nextTick();
  if (previewAlive) observePreview();
});

const previewWidth = computed(() => `${Math.round(CANVAS_W * previewScale.value)}px`);
const previewHeight = computed(() => `${Math.round(CANVAS_H * previewScale.value)}px`);

const logoInputRef = ref<HTMLInputElement | null>(null);
const textContentRef = ref<HTMLTextAreaElement | null>(null);
const startBtnInputRef = ref<HTMLInputElement | null>(null);
const kioskBtnInputRef = ref<HTMLInputElement | null>(null);
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

const activeBgColor = computed(() => {
  if (kioskId.value) {
    return store.kioskLayoutOf(kioskId.value)?.backgroundColor || "#f4ead5";
  }
  return store.welcomeBackgroundColor;
});

watch(activeBgColor, (c) => {
    hexDraft.value = c;
});

function chooseBgMode(mode: "image" | "video" | "color" | "theme") {
  titleBgMediaChoice.value = mode === "theme" ? "color" : mode;
  if (kioskId.value) {
    store.setKioskBackgroundFill(
      kioskId.value,
      mode === "color" ? "color" : mode === "theme" ? "theme" : "media",
    );
    kioskBgTab.value = mode;
    return;
  }
  store.setWelcomeBackgroundFill(mode === "color" ? "color" : "media");
}

const kioskBgTab = ref<"theme" | "image" | "video" | "color">("theme");

const kioskBgIsCustom = computed(() =>
  kioskId.value ? store.kioskHasCustomBackground(kioskId.value) : false,
);
const inspectorBgUrl = computed(() => {
  if (kioskId.value) return store.kioskBackgroundUrl(kioskId.value);
  return store.effectiveTitleBackgroundUrl;
});
const inspectorBgType = computed(() => {
  if (kioskId.value) return store.kioskBackgroundType(kioskId.value);
  return store.effectiveTitleBackgroundType;
});
const inspectorHasImage = computed(
  () =>
    inspectorBgType.value === "image" &&
    !!inspectorBgUrl.value &&
    (kioskId.value ? kioskBgIsCustom.value : true),
);
const inspectorHasVideo = computed(
  () =>
    inspectorBgType.value === "video" &&
    !!inspectorBgUrl.value &&
    (kioskId.value ? kioskBgIsCustom.value : true),
);
const inspectorCanClear = computed(() => {
  if (kioskId.value) return kioskBgIsCustom.value;
  return titleBgMediaChoice.value !== "color" && !!store.titleBackgroundUrl;
});

function applyHexColor() {
  if (kioskId.value) {
    store.setKioskBackgroundColor(kioskId.value, hexDraft.value);
    hexDraft.value = store.ensureKioskLayout(kioskId.value).backgroundColor;
    return;
  }
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
    if (type === "video" || type === "image") {
      titleBgMediaChoice.value = type;
      return;
    }
    titleBgMediaChoice.value = "video";
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
  checkpoint();
  const reader = new FileReader();
  reader.onload = () => {
    store.setCustomLogo(reader.result as string);
  };
  reader.readAsDataURL(file);
  input.value = "";
}
function clearLogo() {
  checkpoint();
  store.clearCustomLogo();
}
function triggerStartBtnInput() {
  startBtnInputRef.value?.click();
}
function onStartBtnChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  checkpoint();
  const reader = new FileReader();
  reader.onload = () => {
    store.setCustomStartButton(reader.result as string);
  };
  reader.readAsDataURL(file);
  input.value = "";
}
function clearStartButton() {
  checkpoint();
  store.clearCustomStartButton();
}
function updateLogoScale(e: Event) {
  store.setTitleLogoScale(parseFloat((e.target as HTMLInputElement).value));
}
function updateStartBtnScale(e: Event) {
  store.setStartButtonScale(parseFloat((e.target as HTMLInputElement).value));
}
function patchStartButton(patch: Partial<WelcomeStartButtonStyle>) {
  const touchesText =
    patch.fontFamily !== undefined ||
    patch.fontSize !== undefined ||
    patch.fontWeight !== undefined ||
    patch.italic !== undefined ||
    patch.labelColor !== undefined;
  if (
    touchesText &&
    patch.label === undefined &&
    !store.startButtonStyle.label.trim()
  ) {
    store.setStartButtonStyle({ label: "Click Here To Start", ...patch });
    return;
  }
  store.setStartButtonStyle(patch);
}
function resetStartButtonLook() {
  checkpoint();
  store.resetStartButtonStyle();
}

function patchKioskButton(patch: Partial<KioskButtonStyle>) {
  if (!kioskId.value) return;
  store.updateKioskButton(kioskId.value, selectedLayer.value, patch);
}

function triggerKioskBtnInput() {
  kioskBtnInputRef.value?.click();
}

function onKioskBtnChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  checkpoint();
  const reader = new FileReader();
  reader.onload = () => {
    patchKioskButton({ imageSrc: reader.result as string });
  };
  reader.readAsDataURL(file);
  input.value = "";
}

function clearKioskButtonImage() {
  checkpoint();
  patchKioskButton({ imageSrc: undefined });
}

function updateKioskBtnScale(e: Event) {
  if (!kioskId.value) return;
  store.setKioskButtonScale(
    kioskId.value,
    selectedLayer.value,
    parseFloat((e.target as HTMLInputElement).value),
  );
}

function resetKioskButtonLook() {
  if (!kioskId.value) return;
  checkpoint();
  store.resetKioskButton(kioskId.value, selectedLayer.value);
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
    const ok = kioskId.value
      ? await store.setKioskBackgroundFile(kioskId.value, kind, file)
      : await store.setTitleBackgroundFile(kind, file);
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
  if (kioskId.value) {
    return kioskLayerLabel(
      kioskId.value,
      selectedLayer.value,
      store.kioskLayoutOf(kioskId.value),
    );
  }
  return layerLabel(selectedLayer.value, store.welcomeLayout);
});

const workspaceTitle = computed(() => {
  if (kioskId.value) return kioskScreenDef(kioskId.value).name;
  return "Welcome screen";
});

const layerRows = computed(() => {
  if (kioskId.value) {
    const layout = store.kioskLayoutOf(kioskId.value);
    const movable = layout
      ? [...layout.order].reverse()
      : [...kioskScreenDef(kioskId.value).items.map((i) => i.id)].reverse();
    return [
      ...movable.map((id) => ({
        id,
        label: kioskLayerLabel(kioskId.value!, id, layout),
        locked: isLockedLayer(id),
      })),
      { id: "background" as const, label: "Background", locked: true },
    ];
  }
  const layout = store.welcomeLayout;
  const movable = layout ? [...layout.order].reverse() : ["start", "logo"];
  return [
    ...movable.map((id) => ({
      id,
      label: layerLabel(id, layout),
      locked: isLockedLayer(id),
    })),
    { id: "background" as const, label: "Background", locked: true },
  ];
});

const selectedAsset = computed(() => {
  if (!isAssetId(selectedLayer.value)) return null;
  const key = selectedLayer.value.slice(6);
  return activeAssets().find((a) => a.id === key) ?? null;
});

const selectedFixedText = computed(() => {
  const item = selectedKioskItem();
  if (!kioskId.value || item?.kind !== "text") return null;
  const layout = store.kioskLayoutOf(kioskId.value);
  return parseTextStyle(layout?.texts[selectedLayer.value] ?? item.text);
});

const selectedText = computed(() => {
  if (selectedFixedText.value) return selectedFixedText.value;
  return selectedAsset.value?.kind === "text"
    ? parseTextStyle(selectedAsset.value.text)
    : null;
});

const screenDirty = computed(() => layoutDirty());
</script>

<template>
  <div ref="editorRef" class="screen-editor">
    <div v-if="!selectedScreen" class="screen-picker">
      <p class="screen-picker__intro">Choose a screen to edit.</p>
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
          <div :ref="screen.id === 'welcome' ? 'thumbRef' : undefined" class="screen-card__thumb">
            <div
              class="preview-stage"
              :style="{
                width: `${CANVAS_W}px`,
                height: `${CANVAS_H}px`,
                transform: `scale(${thumbScale})`,
              }"
            >
              <WelcomeStage v-if="screen.id === 'welcome'" :key="`thumb-${screen.id}`" instant canvas />
              <KioskStage
                v-else-if="isKioskScreenId(screen.id)"
                :key="`thumb-${screen.id}`"
                :screen-id="screen.id"
                canvas
              />
            </div>
          </div>
          <span class="screen-card__name">{{ screen.name }}</span>
          <span class="screen-card__desc">{{ screen.description }}</span>
        </div>
      </div>
    </div>

    <div v-else class="screen-workspace">
      <div class="screen-toolbar">
        <button type="button" class="screen-back" @click="leaveWorkspace">
          ← Screens
        </button>
        <h2 class="screen-toolbar__title">{{ workspaceTitle }}</h2>
        <div class="screen-history">
          <button
            type="button"
            class="screen-icon-btn"
            :disabled="!canUndo"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            @click="undo"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M9 8H5V4M5.3 16.7A8 8 0 1 0 7 7.3"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="screen-icon-btn"
            :disabled="!canRedo"
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
            @click="redo"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M15 8h4V4M18.7 16.7A8 8 0 1 1 17 7.3"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <div ref="shortcutsRef" class="screen-shortcuts">
            <button
              type="button"
              class="screen-icon-btn"
              :class="{ 'screen-icon-btn--on': showShortcuts }"
              title="Editor tips"
              aria-label="Editor tips"
              :aria-expanded="showShortcuts"
              @click="showShortcuts = !showShortcuts"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
                <path
                  d="M12 11v6M12 8h.01"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
            <div
              v-if="showShortcuts"
              class="screen-shortcuts__panel"
              role="dialog"
              aria-label="Editor tips"
            >
              <h3 class="screen-shortcuts__title">Editor tips</h3>
              <p class="screen-shortcuts__note">
                <span class="screen-shortcuts__lock" aria-hidden="true">
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
                A lock means the layer cannot be deleted or duplicated. You can still move, resize, and change its order.
              </p>
              <h4 class="screen-shortcuts__subtitle">Keyboard shortcuts</h4>
              <dl class="screen-shortcuts__list">
                <div>
                  <dt>Undo</dt>
                  <dd><kbd>{{ shortcutMod }}</kbd><kbd>Z</kbd></dd>
                </div>
                <div>
                  <dt>Redo</dt>
                  <dd><kbd>{{ shortcutMod }}</kbd><kbd>Y</kbd></dd>
                </div>
                <div>
                  <dt>Copy</dt>
                  <dd><kbd>{{ shortcutMod }}</kbd><kbd>C</kbd></dd>
                </div>
                <div>
                  <dt>Paste</dt>
                  <dd><kbd>{{ shortcutMod }}</kbd><kbd>V</kbd></dd>
                </div>
                <div>
                  <dt>Duplicate</dt>
                  <dd><kbd>{{ shortcutMod }}</kbd><kbd>D</kbd></dd>
                </div>
                <div>
                  <dt>Nudge</dt>
                  <dd><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd></dd>
                </div>
                <div>
                  <dt>Nudge farther</dt>
                  <dd><kbd>Shift</kbd><span>+</span><kbd>Arrow</kbd></dd>
                </div>
                <div>
                  <dt>Move without snap</dt>
                  <dd><kbd>Alt</kbd><span>+</span><span>drag</span></dd>
                </div>
                <div>
                  <dt>Forward / back</dt>
                  <dd><kbd>]</kbd><kbd>[</kbd></dd>
                </div>
                <div>
                  <dt>Front / back</dt>
                  <dd><kbd>{{ shortcutMod }}</kbd><kbd>]</kbd></dd>
                </div>
                <div>
                  <dt>Edit text</dt>
                  <dd>Double-click</dd>
                </div>
                <div>
                  <dt>Delete</dt>
                  <dd><kbd>Del</kbd></dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
        <div class="screen-add">
          <input
            ref="assetInputRef"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            class="upload-card-input"
            @change="onAssetInput"
          />
          <input
            ref="videoAssetInputRef"
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"
            class="upload-card-input"
            @change="onAssetInput"
          />
          <button
            type="button"
            class="screen-icon-btn"
            title="Add image"
            aria-label="Add image"
            @click="assetInputRef?.click()"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="3"
                y="5"
                width="18"
                height="14"
                rx="2"
                stroke="currentColor"
                stroke-width="2"
              />
              <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
              <path
                d="M21 16.2 15.2 10l-8.7 7"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="screen-icon-btn"
            title="Add video"
            aria-label="Add video"
            @click="videoAssetInputRef?.click()"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="3"
                y="6"
                width="12"
                height="12"
                rx="2"
                stroke="currentColor"
                stroke-width="2"
              />
              <path
                d="M15 10.2 21 7v10l-6-3.2v-3.6Z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            class="screen-icon-btn"
            title="Add text"
            aria-label="Add text"
            @click="addText"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 6V5h14v1M12 5v14M8 19h8"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
        <button
          type="button"
          class="screen-guides"
          :class="{ 'screen-guides--on': showGuides }"
          :aria-pressed="showGuides"
          @click="showGuides = !showGuides"
        >
          Guides
        </button>
        <button type="button" class="screen-reset" @click="resetLayout">
          Reset
        </button>
        <button
          type="button"
          class="screen-save"
          :disabled="!screenDirty && !saveFlash"
          @click="saveScreen"
        >
          {{ saveFlash ? "Saved" : "Save" }}
        </button>
      </div>

      <div class="screen-workspace__body">
        <aside class="layers-panel">
          <div class="layer-box__head">
            <span>Layers</span>
            <div class="layer-box__actions">
              <button
                type="button"
                class="layer-btn"
                :disabled="!selectedItem()"
                title="Send to back"
                @click="sendSelected('back')"
              >
                Back
              </button>
              <button
                type="button"
                class="layer-btn"
                :disabled="!selectedItem()"
                title="Send to front"
                @click="sendSelected('front')"
              >
                Front
              </button>
            </div>
          </div>
          <div class="layer-list">
            <button
              v-for="row in layerRows"
              :key="row.id"
              type="button"
              class="layer-row"
              :class="{
                'layer-row--on': selectedLayer === row.id,
                'layer-row--dragging': dragLayerId === row.id,
                'layer-row--over': dragOverLayerId === row.id,
                'layer-row--locked': row.locked,
                'layer-row--fixed': row.id === 'background',
              }"
              :draggable="row.id !== 'background'"
              :title="row.locked ? 'Cannot delete or duplicate' : undefined"
              @click="selectedLayer = row.id"
              @dragstart="onLayerDragStart(row.id, $event)"
              @dragover="onLayerDragOver(row.id, $event)"
              @drop="onLayerDrop(row.id, $event)"
              @dragend="onLayerDragEnd"
            >
              <span
                v-if="row.id !== 'background'"
                class="layer-row__grip"
                aria-hidden="true"
              >⋮⋮</span>
              <span class="layer-row__name">{{ row.label }}</span>
              <span
                v-if="row.locked"
                class="layer-row__lock"
                aria-label="Locked"
              >
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
            </button>
          </div>
        </aside>

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
                v-if="isWelcome"
                key="welcome-editor"
                interactive
                instant
                canvas
                :show-guides="showGuides"
                :selected="selectedLayer"
                @select="selectedLayer = $event"
                @drop-files="onDropFiles"
                @history-checkpoint="checkpoint"
              />
              <KioskStage
                v-else-if="kioskId"
                :key="`kiosk-editor-${kioskId}`"
                :screen-id="kioskId"
                interactive
                canvas
                :show-guides="showGuides"
                :selected="selectedLayer"
                @select="selectedLayer = $event"
                @drop-files="onDropFiles"
                @history-checkpoint="checkpoint"
              />
            </div>
          </div>
        </div>

        <aside class="inspector">
          <h3 class="inspector__title">{{ inspectorTitle }}</h3>

          <template v-if="selectedLayer === 'background'">
            <div
              class="bg-tabs"
              :class="{ 'bg-tabs--kiosk': !!kioskId }"
              role="tablist"
              aria-label="Background type"
            >
              <button
                v-if="kioskId"
                type="button"
                role="tab"
                class="bg-tabs__tab"
                :class="{ 'bg-tabs__tab--on': kioskBgTab === 'theme' }"
                :aria-selected="kioskBgTab === 'theme'"
                @click="chooseBgMode('theme')"
              >
                Theme
              </button>
              <button
                type="button"
                role="tab"
                class="bg-tabs__tab"
                :class="{
                  'bg-tabs__tab--on': kioskId
                    ? kioskBgTab === 'image'
                    : titleBgMediaChoice === 'image',
                }"
                :aria-selected="kioskId ? kioskBgTab === 'image' : titleBgMediaChoice === 'image'"
                @click="chooseBgMode('image')"
              >
                Image
              </button>
              <button
                type="button"
                role="tab"
                class="bg-tabs__tab"
                :class="{
                  'bg-tabs__tab--on': kioskId
                    ? kioskBgTab === 'video'
                    : titleBgMediaChoice === 'video',
                }"
                :aria-selected="kioskId ? kioskBgTab === 'video' : titleBgMediaChoice === 'video'"
                @click="chooseBgMode('video')"
              >
                Video
              </button>
              <button
                type="button"
                role="tab"
                class="bg-tabs__tab"
                :class="{
                  'bg-tabs__tab--on': kioskId
                    ? kioskBgTab === 'color'
                    : titleBgMediaChoice === 'color',
                }"
                :aria-selected="kioskId ? kioskBgTab === 'color' : titleBgMediaChoice === 'color'"
                @click="chooseBgMode('color')"
              >
                Color
              </button>
            </div>
            <p v-if="kioskId && kioskBgTab === 'theme'" class="inspector__hint">
              Uses the booth's default background. Switch to Image, Video, or
              Color to replace it.
            </p>
            <div
              v-show="kioskId ? kioskBgTab === 'color' : titleBgMediaChoice === 'color'"
              class="color-editor"
            >
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="activeBgColor"
                  aria-label="Background color"
                  @input="
                    kioskId
                      ? store.setKioskBackgroundColor(
                          kioskId,
                          ($event.target as HTMLInputElement).value,
                        )
                      : store.setWelcomeBackgroundColor(
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
                  :class="{ 'color-swatch--active': activeBgColor === swatch }"
                  :style="{ background: swatch }"
                  :aria-label="swatch"
                  @click="
                    kioskId
                      ? store.setKioskBackgroundColor(kioskId, swatch)
                      : store.setWelcomeBackgroundColor(swatch)
                  "
                />
              </div>
            </div>
            <div
              v-show="kioskId ? kioskBgTab === 'image' : titleBgMediaChoice === 'image'"
              class="upload-card"
              :class="{ 'upload-card--filled': inspectorHasImage }"
              @click="titleBgImageInputRef?.click()"
            >
              <input
                ref="titleBgImageInputRef"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                class="upload-card-input"
                @change="handleTitleBgFile('image', $event)"
              />
              <template v-if="inspectorHasImage && inspectorBgUrl">
                <img :src="inspectorBgUrl" alt="" class="upload-card-preview" />
              </template>
              <template v-else>
                <span class="upload-card-icon">+</span>
                <span class="upload-card-text">Upload image</span>
              </template>
            </div>
            <div
              v-show="kioskId ? kioskBgTab === 'video' : titleBgMediaChoice === 'video'"
              class="upload-card"
              :class="{ 'upload-card--filled': inspectorHasVideo }"
              @click="titleBgVideoInputRef?.click()"
            >
              <input
                ref="titleBgVideoInputRef"
                type="file"
                accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v"
                class="upload-card-input"
                @change="handleTitleBgFile('video', $event)"
              />
              <template v-if="inspectorHasVideo && inspectorBgUrl">
                <video
                  :src="inspectorBgUrl"
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
              <button
              v-if="inspectorCanClear"
                type="button"
                class="btn-clear"
                @click="clearTitleBackground"
              >
              Clear
              </button>
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
              </template>
            </div>
            <label class="form-label">
              Size {{ Math.round(store.titleLogoScale * 100) }}%
            </label>
            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.01"
              :value="store.titleLogoScale"
              class="form-range"
              @pointerdown="checkpoint"
              @input="updateLogoScale"
            />
          </template>

          <template v-else-if="selectedLayer === 'start'">
            <div
              class="upload-card"
              :class="{ 'upload-card--filled': store.customStartButtonUrl }"
              @click="triggerStartBtnInput()"
            >
              <input
                ref="startBtnInputRef"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                class="upload-card-input"
                @change="onStartBtnChange"
              />
              <template v-if="store.customStartButtonUrl">
                <img
                  :src="store.customStartButtonUrl"
                  alt="Custom start button"
                  class="upload-card-preview"
                />
                <button
                  type="button"
                  class="upload-card-remove"
                  aria-label="Restore default button"
                  @click.stop="clearStartButton"
                >
                  ×
                </button>
              </template>
          <template v-else>
                <span class="upload-card-icon">+</span>
                <span class="upload-card-text">Upload button</span>
              </template>
            </div>
            <label class="form-label">
              Size {{ Math.round(store.startButtonScale * 100) }}%
            </label>
            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.01"
              :value="store.startButtonScale"
              class="form-range"
              @pointerdown="checkpoint"
              @input="updateStartBtnScale"
            />
            <p v-if="store.customStartButtonUrl" class="inspector__hint">
              Remove the uploaded image to edit the default button's label and
              colors.
            </p>
            <template v-else>
              <label class="form-label">Label</label>
              <input
                class="text-number"
                type="text"
                :value="store.startButtonStyle.label"
                placeholder="Click Here To Start"
                @pointerdown="checkpoint"
                @input="
                  patchStartButton({
                    label: ($event.target as HTMLInputElement).value,
                  })
                "
              />
              <p class="inspector__hint">
                Leave blank to keep the original artwork. Type a label to
                replace it with editable text.
              </p>
              <label class="form-label">Font</label>
              <select
                class="text-select"
                :value="store.startButtonStyle.fontFamily"
                @pointerdown="checkpoint"
                @change="
                  patchStartButton({
                    fontFamily: ($event.target as HTMLSelectElement).value,
                  })
                "
              >
                <option
                  v-for="font in TEXT_FONTS"
                  :key="font.value"
                  :value="font.value"
                >
                  {{ font.label }}
                </option>
              </select>
              <div class="text-row">
                <label class="text-field">
                  <span class="form-label">Type size</span>
                  <input
                    class="text-number"
                    type="number"
                    min="10"
                    max="64"
                    :value="Math.round(store.startButtonStyle.fontSize)"
                    @pointerdown="checkpoint"
                    @change="
                      patchStartButton({
                        fontSize: Number(
                          ($event.target as HTMLInputElement).value,
                        ),
                      })
                    "
                  />
                </label>
                <label class="text-field">
                  <span class="form-label">Weight</span>
                  <select
                    class="text-select"
                    :value="store.startButtonStyle.fontWeight"
                    @pointerdown="checkpoint"
                    @change="
                      patchStartButton({
                        fontWeight: Number(
                          ($event.target as HTMLSelectElement).value,
                        ),
                      })
                    "
                  >
                    <option
                      v-for="weight in TEXT_WEIGHTS"
                      :key="weight.value"
                      :value="weight.value"
                    >
                      {{ weight.label }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="text-toggles">
                <button
                  type="button"
                  class="text-toggle"
                  :class="{
                    'text-toggle--on': store.startButtonStyle.italic,
                  }"
                  title="Italic"
                  aria-label="Italic"
                  @click="
                    checkpoint();
                    patchStartButton({
                      italic: !store.startButtonStyle.italic,
                    });
                  "
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M10 5h9M5 19h9M15.5 5 8.5 19"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
              <label class="form-label">Text color</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="store.startButtonStyle.labelColor"
                  aria-label="Button text color"
                  @pointerdown="checkpoint"
                  @input="
                    patchStartButton({
                      labelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="store.startButtonStyle.labelColor"
                  aria-label="Button text hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchStartButton({
                      labelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">Face</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="store.startButtonStyle.faceColor"
                  aria-label="Button face color"
                  @pointerdown="checkpoint"
                  @input="
                    patchStartButton({
                      faceColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="store.startButtonStyle.faceColor"
                  aria-label="Button face hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchStartButton({
                      faceColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">Frame</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="store.startButtonStyle.bezelColor"
                  aria-label="Button frame color"
                  @pointerdown="checkpoint"
                  @input="
                    patchStartButton({
                      bezelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="store.startButtonStyle.bezelColor"
                  aria-label="Button frame hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchStartButton({
                      bezelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">Shadow</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="store.startButtonStyle.shadowColor"
                  aria-label="Button shadow color"
                  @pointerdown="checkpoint"
                  @input="
                    patchStartButton({
                      shadowColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="store.startButtonStyle.shadowColor"
                  aria-label="Button shadow hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchStartButton({
                      shadowColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">
                Corners {{ store.startButtonStyle.radius.toFixed(1) }}
              </label>
              <input
                type="range"
                min="0"
                max="24"
                step="0.5"
                :value="store.startButtonStyle.radius"
                class="form-range"
                @pointerdown="checkpoint"
                @input="
                  patchStartButton({
                    radius: Number(($event.target as HTMLInputElement).value),
                  })
                "
              />
              <button
                type="button"
                class="btn-clear"
                @click="resetStartButtonLook"
              >
                Reset look
              </button>
            </template>
          </template>

          <template v-else-if="selectedKioskButton">
            <div
              class="upload-card"
              :class="{ 'upload-card--filled': selectedKioskButton.imageSrc }"
              @click="triggerKioskBtnInput()"
            >
              <input
                ref="kioskBtnInputRef"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                class="upload-card-input"
                @change="onKioskBtnChange"
              />
              <template v-if="selectedKioskButton.imageSrc">
                <img
                  :src="selectedKioskButton.imageSrc"
                  alt="Custom button"
                  class="upload-card-preview"
                />
                <button
                  type="button"
                  class="upload-card-remove"
                  aria-label="Restore default button"
                  @click.stop="clearKioskButtonImage"
                >
                  ×
                </button>
              </template>
              <template v-else>
                <span class="upload-card-icon">+</span>
                <span class="upload-card-text">Upload button</span>
              </template>
            </div>
            <label class="form-label">
              Size {{ Math.round(selectedKioskButton.scale * 100) }}%
            </label>
            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.01"
              :value="selectedKioskButton.scale"
              class="form-range"
              @pointerdown="checkpoint"
              @input="updateKioskBtnScale"
            />
            <p v-if="selectedKioskButton.imageSrc" class="inspector__hint">
              Remove the uploaded image to edit the default button's label and
              colors.
            </p>
            <template v-else>
              <label class="form-label">Label</label>
              <input
                class="text-number"
                type="text"
                :value="selectedKioskButton.label"
                @pointerdown="checkpoint"
                @input="
                  patchKioskButton({
                    label: ($event.target as HTMLInputElement).value,
                  })
                "
              />
              <label class="form-label">Font</label>
              <select
                class="text-select"
                :value="selectedKioskButton.fontFamily"
                @pointerdown="checkpoint"
                @change="
                  patchKioskButton({
                    fontFamily: ($event.target as HTMLSelectElement).value,
                  })
                "
              >
                <option
                  v-for="font in TEXT_FONTS"
                  :key="font.value"
                  :value="font.value"
                >
                  {{ font.label }}
                </option>
              </select>
              <div class="text-row">
                <label class="text-field">
                  <span class="form-label">Type size</span>
                  <input
                    class="text-number"
                    type="number"
                    min="10"
                    max="64"
                    :value="Math.round(selectedKioskButton.fontSize)"
                    @pointerdown="checkpoint"
                    @change="
                      patchKioskButton({
                        fontSize: Number(
                          ($event.target as HTMLInputElement).value,
                        ),
                      })
                    "
                  />
                </label>
                <label class="text-field">
                  <span class="form-label">Weight</span>
                  <select
                    class="text-select"
                    :value="selectedKioskButton.fontWeight"
                    @pointerdown="checkpoint"
                    @change="
                      patchKioskButton({
                        fontWeight: Number(
                          ($event.target as HTMLSelectElement).value,
                        ),
                      })
                    "
                  >
                    <option
                      v-for="weight in TEXT_WEIGHTS"
                      :key="weight.value"
                      :value="weight.value"
                    >
                      {{ weight.label }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="text-toggles">
                <button
                  type="button"
                  class="text-toggle"
                  :class="{
                    'text-toggle--on': selectedKioskButton.italic,
                  }"
                  title="Italic"
                  aria-label="Italic"
                  @click="
                    checkpoint();
                    patchKioskButton({
                      italic: !selectedKioskButton.italic,
                    });
                  "
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M10 5h9M5 19h9M15.5 5 8.5 19"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>
              <label class="form-label">Text color</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="selectedKioskButton.labelColor"
                  aria-label="Button text color"
                  @pointerdown="checkpoint"
                  @input="
                    patchKioskButton({
                      labelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="selectedKioskButton.labelColor"
                  aria-label="Button text hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchKioskButton({
                      labelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">Face</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="selectedKioskButton.faceColor"
                  aria-label="Button face color"
                  @pointerdown="checkpoint"
                  @input="
                    patchKioskButton({
                      faceColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="selectedKioskButton.faceColor"
                  aria-label="Button face hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchKioskButton({
                      faceColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">Frame</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="selectedKioskButton.bezelColor"
                  aria-label="Button frame color"
                  @pointerdown="checkpoint"
                  @input="
                    patchKioskButton({
                      bezelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="selectedKioskButton.bezelColor"
                  aria-label="Button frame hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchKioskButton({
                      bezelColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">Shadow</label>
              <div class="color-editor__row">
                <input
                  class="color-editor__picker"
                  type="color"
                  :value="selectedKioskButton.shadowColor"
                  aria-label="Button shadow color"
                  @pointerdown="checkpoint"
                  @input="
                    patchKioskButton({
                      shadowColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
                <input
                  class="color-editor__hex"
                  type="text"
                  spellcheck="false"
                  maxlength="7"
                  :value="selectedKioskButton.shadowColor"
                  aria-label="Button shadow hex color"
                  @pointerdown="checkpoint"
                  @change="
                    patchKioskButton({
                      shadowColor: ($event.target as HTMLInputElement).value,
                    })
                  "
                />
              </div>
              <label class="form-label">
                Corners {{ selectedKioskButton.radius.toFixed(1) }}
              </label>
              <input
                type="range"
                min="0"
                :max="kioskButtonCornerMax"
                step="0.5"
                :value="selectedKioskButton.radius"
                class="form-range"
                @pointerdown="checkpoint"
                @input="
                  patchKioskButton({
                    radius: Number(($event.target as HTMLInputElement).value),
                  })
                "
              />
              <button
                type="button"
                class="btn-clear"
                @click="resetKioskButtonLook"
              >
                Reset look
              </button>
            </template>
            <button
              v-if="selectedKioskButton.imageSrc"
              type="button"
              class="btn-clear"
              @click="resetKioskButtonLook"
            >
              Reset look
            </button>
          </template>

          <template v-else-if="selectedKioskItem()?.kind === 'logo'">
            <p class="inspector__hint">
              Same logo as the Welcome screen. Change it under Welcome → Logo,
              or drag here to reposition.
            </p>
          </template>

          <template v-else-if="selectedKioskItem()?.kind === 'widget'">
            <p class="inspector__hint">
              This is a working part of the screen (carousel, camera, QR frame,
              and so on). You can move and resize it. Extra images and text
              can be added on top from the toolbar.
            </p>
          </template>

          <template v-else-if="selectedText">
            <label class="form-label">Text</label>
            <textarea
              ref="textContentRef"
              class="text-content"
              rows="3"
              :value="selectedText.content"
              @pointerdown="checkpoint"
              @input="
                patchSelectedText({
                  content: ($event.target as HTMLTextAreaElement).value,
                })
              "
            />
            <label class="form-label">Font</label>
            <select
              class="text-select"
              :value="selectedText.fontFamily"
              @pointerdown="checkpoint"
              @change="
                patchSelectedText({
                  fontFamily: ($event.target as HTMLSelectElement).value,
                })
              "
            >
              <option
                v-for="font in TEXT_FONTS"
                :key="font.value"
                :value="font.value"
                :style="{ fontFamily: font.value }"
              >
                {{ font.label }}
              </option>
            </select>
            <div class="text-row">
              <label class="text-field">
                <span class="form-label">Size</span>
                <input
                  class="text-number"
                  type="number"
                  min="8"
                  max="400"
                  :value="Math.round(selectedText.fontSize)"
                  @pointerdown="checkpoint"
                  @change="
                    patchSelectedText({
                      fontSize: Number(($event.target as HTMLInputElement).value),
                    })
                  "
                />
              </label>
              <label class="text-field">
                <span class="form-label">Weight</span>
                <select
                  class="text-select"
                  :value="selectedText.fontWeight"
                  @pointerdown="checkpoint"
                  @change="
                    patchSelectedText({
                      fontWeight: Number(($event.target as HTMLSelectElement).value),
                    })
                  "
                >
                  <option
                    v-for="weight in TEXT_WEIGHTS"
                    :key="weight.value"
                    :value="weight.value"
                  >
                    {{ weight.label }}
                  </option>
                </select>
              </label>
            </div>
            <div class="text-toggles">
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.italic }"
                title="Italic"
                aria-label="Italic"
                @click="
                  checkpoint();
                  patchSelectedText({ italic: !selectedText.italic });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M10 5h9M5 19h9M15.5 5 8.5 19"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.underline }"
                title="Underline"
                aria-label="Underline"
                @click="
                  checkpoint();
                  patchSelectedText({ underline: !selectedText.underline });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M7 5v8.5a5 5 0 0 0 10 0V5M5 20h14"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <span class="text-toggles__split" />
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.align === 'left' }"
                title="Align left"
                aria-label="Align left"
                @click="
                  checkpoint();
                  patchSelectedText({ align: 'left' });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 7h16M4 12h10M4 17h14"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.align === 'center' }"
                title="Align center"
                aria-label="Align center"
                @click="
                  checkpoint();
                  patchSelectedText({ align: 'center' });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 7h16M7 12h10M5 17h14"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.align === 'right' }"
                title="Align right"
                aria-label="Align right"
                @click="
                  checkpoint();
                  patchSelectedText({ align: 'right' });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 7h16M10 12h10M6 17h14"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
            <div class="text-toggles">
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.valign === 'top' }"
                title="Align top"
                aria-label="Align top"
                @click="
                  checkpoint();
                  patchSelectedText({ valign: 'top' });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 5h14M8 10h8M8 15h8"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.valign === 'middle' }"
                title="Align middle"
                aria-label="Align middle"
                @click="
                  checkpoint();
                  patchSelectedText({ valign: 'middle' });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M8 6h8M5 12h14M8 18h8"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="text-toggle"
                :class="{ 'text-toggle--on': selectedText.valign === 'bottom' }"
                title="Align bottom"
                aria-label="Align bottom"
                @click="
                  checkpoint();
                  patchSelectedText({ valign: 'bottom' });
                "
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M8 9h8M8 14h8M5 19h14"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
            <label class="form-label">Color</label>
            <div class="color-editor__row">
              <input
                class="color-editor__picker"
                type="color"
                :value="selectedText.color"
                aria-label="Text color"
                @pointerdown="checkpoint"
                @input="
                  patchSelectedText({
                    color: ($event.target as HTMLInputElement).value,
                  })
                "
              />
              <input
                class="color-editor__hex"
                type="text"
                spellcheck="false"
                maxlength="7"
                :value="selectedText.color"
                aria-label="Text hex color"
                @pointerdown="checkpoint"
                @change="
                  patchSelectedText({
                    color: ($event.target as HTMLInputElement).value,
                  })
                "
              />
            </div>
            <label class="form-label">
              Letter spacing {{ selectedText.letterSpacing }}
            </label>
            <input
              type="range"
              min="-8"
              max="40"
              step="0.5"
              :value="selectedText.letterSpacing"
              class="form-range"
              @pointerdown="checkpoint"
              @input="
                patchSelectedText({
                  letterSpacing: Number(($event.target as HTMLInputElement).value),
                })
              "
            />
            <label class="form-label">
              Line height {{ selectedText.lineHeight.toFixed(2) }}
            </label>
            <input
              type="range"
              min="0.8"
              max="2.4"
              step="0.05"
              :value="selectedText.lineHeight"
              class="form-range"
              @pointerdown="checkpoint"
              @input="
                patchSelectedText({
                  lineHeight: Number(($event.target as HTMLInputElement).value),
                })
              "
            />
            <label class="form-label">
              Opacity {{ Math.round(selectedText.opacity * 100) }}%
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="selectedText.opacity"
              class="form-range"
              @pointerdown="checkpoint"
              @input="
                patchSelectedText({
                  opacity: Number(($event.target as HTMLInputElement).value),
                })
              "
            />
            <button
              v-if="selectedAsset"
              type="button"
              class="btn-clear"
              @click="deleteSelectedAsset"
            >
              Delete
            </button>
          </template>

          <template v-else-if="selectedAsset">
            <div class="upload-card upload-card--filled">
              <video
                v-if="selectedAsset.kind === 'video'"
                :src="selectedAsset.src"
                class="upload-card-preview"
                muted
                loop
                playsinline
                autoplay
              />
              <img
                v-else
                :src="selectedAsset.src"
                :alt="selectedAsset.name"
                class="upload-card-preview"
              />
            </div>
            <button type="button" class="btn-clear" @click="deleteSelectedAsset">
              Delete
            </button>
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
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border-radius: 8px;
  background: #2a1c14;
  border: 1px solid var(--color-brown-light);
  pointer-events: none;
}

.preview-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
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

.screen-history,
.screen-add {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.screen-icon-btn {
  width: 36px;
  height: 36px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-brown);
  background: transparent;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  cursor: pointer;
}

.screen-icon-btn svg {
  width: 18px;
  height: 18px;
}

.screen-icon-btn:hover:not(:disabled) {
  color: var(--color-brown-dark);
  border-color: var(--color-brown);
}

.screen-icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.screen-icon-btn--on {
  color: var(--color-brown-dark);
  border-color: var(--color-brown);
  background: rgba(61, 43, 31, 0.06);
}

.screen-shortcuts {
  position: relative;
}

.screen-shortcuts__panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  width: 300px;
  padding: 0.85rem 1rem 1rem;
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 10px;
  box-shadow: 0 10px 28px rgba(48, 18, 7, 0.2);
}

.screen-shortcuts__title {
  font-family: var(--font-display);
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0 0 0.65rem;
}

.screen-shortcuts__note {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0 0 0.9rem;
  font-family: var(--font-body);
  font-size: 0.8rem;
  line-height: 1.4;
  color: var(--color-brown-dark);
}

.screen-shortcuts__lock {
  flex-shrink: 0;
  width: 1.15rem;
  height: 1.15rem;
  margin-top: 0.05rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-brown);
}

.screen-shortcuts__lock svg {
  width: 14px;
  height: 14px;
}

.screen-shortcuts__subtitle {
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0 0 0.55rem;
}

.screen-shortcuts__list {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin: 0;
}

.screen-shortcuts__list > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.screen-shortcuts__list dt {
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--color-brown-dark);
}

.screen-shortcuts__list dd {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.75rem;
  color: var(--color-brown);
}

.screen-shortcuts__list kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.4rem;
  padding: 0.12rem 0.35rem;
  font-family: inherit;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  background: var(--color-cream-dark);
  border: 1px solid var(--color-brown-light);
  border-bottom-width: 2px;
  border-radius: 4px;
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

.screen-guides {
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

.screen-guides:hover {
  color: var(--color-brown-dark);
  border-color: var(--color-brown);
}

.screen-guides--on {
  color: #9a2d86;
  border-color: #e14ec8;
  background: rgba(225, 78, 200, 0.08);
}

.screen-save {
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--color-cream);
  background: var(--color-brown-dark);
  border: 1px solid var(--color-brown-dark);
  border-radius: 8px;
  padding: 0.4rem 1rem;
  cursor: pointer;
}

.screen-save:hover:not(:disabled) {
  background: var(--color-brown);
}

.screen-save:disabled {
  opacity: 0.45;
  cursor: default;
}

.screen-workspace__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 300px;
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

.inspector {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
  background: var(--color-cream-dark);
  border-left: 2px solid var(--color-brown-light);
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.inspector__title {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0;
}

.layers-panel {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 0.85rem;
  background: var(--color-cream-dark);
  border-right: 2px solid var(--color-brown-light);
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.layer-box__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--color-brown-dark);
}

.layer-box__actions {
  display: flex;
  gap: 0.3rem;
}

.layer-btn {
  padding: 0.2rem 0.45rem;
  font-family: var(--font-display);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-brown);
  background: var(--color-cream);
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  cursor: pointer;
}

.layer-btn:hover:not(:disabled) {
  color: var(--color-brown-dark);
  border-color: var(--color-brown);
}

.layer-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.layer-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.layer-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  text-align: left;
  padding: 0.4rem 0.45rem;
  font-family: var(--font-body);
  font-size: 0.85rem;
  color: var(--color-brown-dark);
  background: var(--color-cream);
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: grab;
}

.layer-row:hover {
  border-color: var(--color-brown-light);
}

.layer-row--on {
  border-color: var(--color-brown-dark);
  background: #fff;
}

.layer-row--dragging {
  opacity: 0.45;
}

.layer-row--over {
  border-color: #e14ec8;
  box-shadow: 0 0 0 1px #e14ec8;
}

.layer-row--fixed {
  cursor: default;
  opacity: 0.75;
}

.layer-row__grip {
  flex-shrink: 0;
  width: 0.85rem;
  font-size: 0.65rem;
  letter-spacing: -0.08em;
  line-height: 1;
  color: var(--color-brown-light);
}

.layer-row__lock {
  flex-shrink: 0;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.9rem;
  height: 0.9rem;
  color: var(--color-brown);
}

.layer-row__lock svg {
  width: 12px;
  height: 12px;
}

.layer-row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspector__hint {
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--color-brown);
  margin: 0;
}

.bg-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 3px;
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 10px;
}

.bg-tabs--kiosk {
  grid-template-columns: repeat(4, 1fr);
}

.bg-tabs__tab {
  padding: 0.4rem 0.35rem;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-family: var(--font-display);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-brown);
  cursor: pointer;
}

.bg-tabs__tab:hover:not(.bg-tabs__tab--on) {
  color: var(--color-brown-dark);
}

.bg-tabs__tab--on {
  background: var(--color-brown-dark);
  color: var(--color-cream);
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

.text-content,
.text-select,
.text-number {
  width: 100%;
  padding: 0.45rem 0.6rem;
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--color-brown-dark);
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
}

.text-content {
  min-height: 4.5rem;
  resize: vertical;
  line-height: 1.35;
  user-select: text;
  -webkit-user-select: text;
}

.text-number,
.text-select,
.color-editor__hex {
  user-select: text;
  -webkit-user-select: text;
}

.text-content:focus,
.text-select:focus,
.text-number:focus {
  outline: none;
  border-color: var(--color-brown-dark);
}

.text-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.text-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}

.text-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.text-toggles__split {
  width: 1px;
  margin: 0 0.15rem;
  background: var(--color-brown-light);
  align-self: stretch;
}

.text-toggle {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-brown);
  background: var(--color-cream);
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  cursor: pointer;
}

.text-toggle svg {
  width: 16px;
  height: 16px;
}

.text-toggle:hover {
  border-color: var(--color-brown);
  color: var(--color-brown-dark);
}

.text-toggle--on {
  color: var(--color-cream);
  background: var(--color-brown-dark);
  border-color: var(--color-brown-dark);
}

.upload-card {
  position: relative;
  min-height: 88px;
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
