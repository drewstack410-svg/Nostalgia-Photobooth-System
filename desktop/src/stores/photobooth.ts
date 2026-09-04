/**
 * Photobooth store – central state for the nostalgia photobooth app.
 *
 * Sections:
 * - Templates: User-added photo-strip templates. Add, remove, toggle active,
 *   delete. Persisted to userData/templates.json (localStorage is a mirror).
 * - Session: Selected template, captured photos, required/remaining count.
 * - Camera options: mirrorMode (preview/capture flip).
 * - Recent strips: Saved strips for title-screen film roll and reprint.
 * - Customize: Logo, title background (image/video), display/body fonts, camera filters.
 *   All persisted to localStorage.
 *
 * Used by: TitleScreen, TemplateSelect, CameraView, PrintingView, AdminPanel,
 * SettingsView, useCustomFonts, App.vue, reprint/gallery flows.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { makePreviewDataUrl } from "@/utils/imagePreview";
import { revokeMediaUrl } from "@/utils/mediaBytes";
import {
  assetItemId,
  assetKey,
  clampBox,
  defaultStartButtonStyle,
  defaultWelcomeLayout,
  isAssetId,
  moveLayerOrder,
  normalizeWelcomeLayout,
  parseStartButtonStyle,
  parseTextStyle,
  parseWelcomeLayout,
  WELCOME_CANVAS_W,
  WELCOME_LOGO_NATIVE_W,
  WELCOME_START_NATIVE_W,
  type WelcomeBox,
  type WelcomeItemId,
  type WelcomeLayout,
  type WelcomeAssetKind,
  type WelcomeStartButtonStyle,
  type WelcomeTextStyle,
} from "@/utils/welcomeLayout";
import {
  defaultKioskButtonStyle,
  defaultKioskLayout,
  isKioskActionButton,
  kioskItemDef,
  KIOSK_SCREEN_IDS,
  lockKioskActionButtonSize,
  lockKioskStartButtonSize,
  normalizeKioskLayout,
  parseKioskButtonStyle,
  parseKioskLayout,
  type KioskBackgroundFill,
  type KioskButtonStyle,
  type KioskLayout,
  type KioskScreenId,
} from "@/utils/kioskLayout";
import {
  DEFAULT_ADJUSTMENTS,
  type FilterAdjustments,
} from "@/utils/filterPreview";

export { DEFAULT_ADJUSTMENTS };
export type { FilterAdjustments };

/** IPC Uint8Array is ArrayBufferLike; Blob wants a plain ArrayBuffer. */
function blobFromIpcBytes(bytes: Uint8Array, type: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type });
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
/**
 * One photo slot's placement on the print sheet, written by the layout
 * editor (Admin → Templates → Edit layout). Stored as FRACTIONS of the
 * print area rather than pixels so a template stays correct if it's
 * later re-rendered at a different paper size or DPI.
 *
 * `rotation` is clockwise degrees about the slot's own centre. The
 * composite rotates the clip path together with the photo, so a tilted
 * slot crops to a tilted rectangle — matching what the editor shows.
 */
export interface TemplateCell {
  /** Left edge, 0..1 of the print area width. */
  x: number;
  /** Top edge, 0..1 of the print area height. */
  y: number;
  /** Width, 0..1 of the print area width. */
  w: number;
  /** Height, 0..1 of the print area height. */
  h: number;
  /** Clockwise degrees about the slot's centre. 0 = axis-aligned. */
  rotation: number;
}

export interface Template {
  id: string;
  name: string;
  photoCount: number;
  layout: "vertical" | "horizontal";
  /**
   * Explicit per-slot placement from the layout editor. When present
   * this OUTRANKS both the frame's auto-detected windows and the
   * margin/gap grid — it's the operator's direct instruction.
   *
   * Absent on every template until someone opens the editor and saves,
   * so existing templates keep composing exactly as they did before.
   * Length should match `photoCount`; the composite tolerates a
   * mismatch by cycling captures (`i % count`) as it always has.
   */
  cells?: TemplateCell[];
  /**
   * Paper size this template was DESIGNED for. The print composite
   * is rendered at this size's native pixel dimensions (see
   * src/utils/printLayout.ts → PAPER_SIZES) so the output matches
   * the paper aspect with no stretch and no letterbox. If absent
   * the renderer falls back to 4×6 landscape for back-compat.
   */
  paperSize?: import("@/utils/printLayout").PaperSize;
  /**
   * Each photo CELL's width:height aspect. Lets a template trade
   * crop for white-margin without changing paperSize: 1.5 = native
   * 3:2 (no crop, big margins), 1.0 = square (modest crop, modest
   * margins), 0.5 = portrait fill (heavy crop, no margins). Only
   * consulted by templates without a `frameImageUrl` — PNG-frame
   * templates take their cell dimensions from the frame itself.
   */
  cellAspect?: number;
  /**
   * Zoom factor applied (centred) to the cover-fit photo inside each
   * cell. 1.0 = normal cover (fills the cell). < 1.0 pulls the photo
   * back so more of the subject is visible — used by Heart Grid
   * (0.85) so the photo sits comfortably inside the heart cutouts
   * rather than being cropped tight to the cell rectangle. Default 1.
   */
  cellZoom?: number;
  /**
   * How each capture is fitted into its photo window.
   *
   *  "cover"   — fills the window, cropping whatever overflows. A 3:2
   *              capture in a portrait window loses ~49% of the frame.
   *  "contain" — the WHOLE photo is visible, aspect preserved, with
   *              letterbox bars in the leftover space. This is what the
   *              client asked for ("walang cropping, pero retain aspect
   *              ratio padin para maiwasan yung stretch").
   *
   * Per-template because the right answer differs by artwork: the 2x2's
   * tall windows crop heavily under cover, while the 4x2's near-3:2
   * windows lose under 10% and look better filled. Defaults to
   * "contain" so nothing is silently cut off.
   */
  fitMode?: "cover" | "contain";
  /**
   * Nudges the photo inside its window, as a percentage of the window
   * (-50..50). Positive X moves right, positive Y moves down.
   *
   * Pairs with `cellZoom`: zoom in past the window and these choose
   * WHICH part stays visible — e.g. raise the framing so heads aren't
   * cut off. With "contain" they reposition the photo within its
   * letterbox instead.
   */
  cellOffsetX?: number;
  cellOffsetY?: number;
  /**
   * Outer margin (px on the print sheet) around the whole photo grid.
   * Default 24. The 4×2 Layout uses 0 (cells reach the sheet edges).
   */
  cellMargin?: number;
  /**
   * Gap (px on the print sheet) between adjacent photo cells.
   * Default 24. The 4×2 Layout uses 0 (cells butt together).
   */
  cellGap?: number;
  frameImageUrl?: string;
  isActive?: boolean;
  thumbnailDefaultUrl?: string;
  thumbnailActiveUrl?: string;
  frameRows?: number;
  frameCols?: number;
}

export interface CapturedPhoto {
  id: string;
  /** Viewfinder-cropped still used for print / strip / Grid. */
  dataUrl: string;
  /** Full uncropped camera frame (filters applied). Gallery + disk/cloud. */
  fullDataUrl?: string;
  /**
   * Full uncropped camera frame with no filter, overlay, or grain.
   * Written to the local session folder only — never uploaded for QR.
   */
  originalDataUrl?: string;
  timestamp: Date;
}

export type MediaUploadStatus = "pending" | "uploading" | "done" | "failed";

export interface SavedPhotoStrip {
  id: string;
  dataUrl: string;
  timestamp: Date;
  path?: string;
  /**
   * Groups all captures from the same booth session under one ID.
   * A reprint flow can filter recent strips by sessionId to pull
   * exactly the photos that belong together (and re-feed them through
   * the template at print time) without mixing in shots from
   * neighbouring sessions.
   */
  sessionId?: string;
  /**
   * Which template was used at capture time. Stored alongside the
   * captures so a future reprint can recreate the templated print
   * sheet without us having to save the rendered composite.
   */
  templateId?: string;
  /** Position within the session (0-based) — useful for ordered reprint. */
  sessionIndex?: number;
  /**
   * True for the one entry per session that holds the finished
   * TEMPLATED print (frame applied) rather than a raw capture. Stored
   * as a downscaled JPEG preview so the admin gallery can show "the
   * actual picture printed" next to the individual captures. Reprint
   * deliberately IGNORES these entries — it rebuilds the print sheet
   * full-res from the original captures.
   */
  isComposite?: boolean;
  // Legacy single-image fields — kept for back-compat with strips
  // saved before the per-capture upload change. New strips populate
  // `cloudinaryPhotos` instead. When present, `cloudinaryUrl` mirrors
  // the FIRST entry of `cloudinaryPhotos` so existing UI that reads
  // the singular field still works.
  cloudinaryUrl?: string;
  cloudinaryPublicId?: string;
  // Per-capture Cloudinary uploads. One entry per individual photo
  // taken in the session — never the templated/composited strip.
  // Order matches `capturedPhotos` order at save time.
  cloudinaryPhotos?: Array<{ url: string; publicId: string }>;
  // Cloudinary URL of a single shareable composite (the captured
  // photos stacked into one image, no template/frame). This is what
  // the QR code encodes — scanning opens a page showing all of the
  // session's photos as one image the user can save to their phone.
  // Same value is mirrored on every strip entry from a session, so
  // QRScanView can read it from the most recent strip.
  shareableUrl?: string;
  /**
   * Guest gallery upload. Missing on strips saved before this field
   * existed — treat as "done" when shareableUrl is set, otherwise
   * unknown/offline.
   */
  uploadStatus?: MediaUploadStatus;
}

export type TitleBackgroundType = "image" | "video" | null;
export type WelcomeBackgroundFill = "media" | "color";
export type FilterEffectType =
  | "sepia"
  | "bw"
  | "original"
  | "fujifilm"
  | "cube";

export type CameraFrameStyle = "wooden" | "blur" | "color" | "svg" | "none";
export type PrintCutMode = "standard" | "dnp-2-inch-cut";

/**
 * Photoshop-style blend modes for the overlay layer.
 *
 * These names are deliberately the CSS/canvas spelling, because that is what
 * both halves of the pipeline take verbatim: `mix-blend-mode` in the live
 * preview and `globalCompositeOperation` on the capture canvas. Both
 * implement the same W3C compositing formulas, so the two agree without any
 * translation layer — the mistake that made the sepia preview disagree with
 * the print.
 */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/** The modes worth exposing in the admin UI, in Photoshop's own order. */
export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "color-dodge", label: "Color Dodge" },
  { value: "color-burn", label: "Color Burn" },
  { value: "hard-light", label: "Hard Light" },
  { value: "soft-light", label: "Soft Light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
  { value: "hue", label: "Hue" },
  { value: "saturation", label: "Saturation" },
  { value: "color", label: "Color" },
  { value: "luminosity", label: "Luminosity" },
];

const BLEND_MODE_VALUES = new Set<string>(BLEND_MODES.map((m) => m.value));

export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === "string" && BLEND_MODE_VALUES.has(value);
}

/**
 * A colour wash composited over the photo, exactly like a Photoshop fill
 * layer set to a blend mode with an opacity.
 *
 * Added because grading via .cube LUTs is fiddly to author — this gives the
 * operator a direct "tint the photo like this" control instead. It layers on
 * TOP of whatever the filter's effectType already did, so an overlay can be
 * combined with sepia/B&W/a LUT, or used on its own with effectType
 * "original".
 */
export interface FilterOverlay {
  /** CSS colour of the wash. */
  color: string;
  blendMode: BlendMode;
  /** 0..1, matching Photoshop's Opacity field. */
  opacity: number;
}

export type OverlayMediaKind = "image" | "video";

/**
 * A PNG / JPEG / MOV (or MP4) layer composited over the filtered photo,
 * the same idea as dropping a file onto a Photoshop layer and setting
 * blend mode + opacity. Lives *above* the colour wash and *below*
 * vignette/grain. The file itself is stored on disk (not in this
 * object) — only the layer settings and a filename for the UI live here.
 */
export interface FilterMediaOverlay {
  blendMode: BlendMode;
  /** 0..1, matching Photoshop's Opacity field. */
  opacity: number;
  mediaType: OverlayMediaKind;
  mediaName: string;
}

export interface CameraFilter {
  id: string;
  name: string;
  effectType: FilterEffectType;
  isActive: boolean;
  /** Optional colour wash composited over the result. */
  overlay?: FilterOverlay;
  /** Optional image/video layer composited over the result. */
  mediaOverlay?: FilterMediaOverlay;
  /** LUT data for .cube filters (when effectType === "cube") */
  cubeData?: string;
  /**
   * For cube filters: which base colour preset to apply first,
   * before the LUT is applied on top.
   * e.g. "sepia" → pixel-level sepia → then LUT refines the result.
   */
  baseFilter?: Exclude<FilterEffectType, "cube">;
  /**
   * Whether film grain is baked into captures using this filter.
   * Admin-configurable per filter. `undefined` (filters saved before
   * this field existed) falls back to the legacy rule: grain on for
   * sepia/bw/fujifilm, and for cube filters whose baseFilter is sepia.
   */
  grainEnabled?: boolean;
  /** Fine-tune sliders: grain, exposure, levels, contrast, shadows, vignette, saturation, glow. */
  adjustments?: FilterAdjustments;
}

// -----------------------------------------------------------------------------
// Storage keys
// -----------------------------------------------------------------------------
const CUSTOM_TEMPLATES_KEY = "nostalgia-custom-templates";
const RECENT_STRIPS_KEY = "nostalgia-recent-strips";
const STORAGE_KEY_LOGO = "nostalgia-custom-logo";
const STORAGE_KEY_START_BTN = "nostalgia-custom-start-button";
const STORAGE_KEY_START_BTN_STYLE = "nostalgia-start-btn-style";
const STORAGE_KEY_PAYMENT_QR = "nostalgia-payment-qr";
const STORAGE_KEY_PAYMENT_ENABLED = "nostalgia-payment-enabled";
const STORAGE_KEY_LOGO_SCALE = "nostalgia-logo-scale";
const STORAGE_KEY_QR_SCALE = "nostalgia-qr-scale";
const STORAGE_KEY_START_BTN_SCALE = "nostalgia-start-btn-scale";
const STORAGE_KEY_WELCOME_LAYOUT = "nostalgia-welcome-layout";
const STORAGE_KEY_KIOSK_LAYOUT = "nostalgia-kiosk-layout-";
const STORAGE_KEY_WELCOME_BG_COLOR = "nostalgia-welcome-bg-color";
const STORAGE_KEY_WELCOME_BG_FILL = "nostalgia-welcome-bg-fill";
const STORAGE_KEY_BG_TYPE = "nostalgia-title-bg-type";
const STORAGE_KEY_BG_URL = "nostalgia-title-bg-url";
const STORAGE_KEY_FILTERS = "nostalgia-camera-filters";
const STORAGE_KEY_DISPLAY_FONT = "nostalgia-custom-display-font";
const STORAGE_KEY_BODY_FONT = "nostalgia-custom-body-font";
const STORAGE_KEY_CAMERA_FRAME_STYLE = "nostalgia-camera-frame-style";
const STORAGE_KEY_CAMERA_FRAME_COLOR = "nostalgia-camera-frame-color";
const STORAGE_KEY_CAMERA_FRAME_SVG = "nostalgia-camera-frame-svg";
const STORAGE_KEY_PRINTER_NAME = "nostalgia-printer-name";
const STORAGE_KEY_PRINT_COPIES = "nostalgia-print-copies";
const STORAGE_KEY_PRINT_CUT_MODE = "nostalgia-print-cut-mode";
const STORAGE_KEY_ADMIN_PIN = "nostalgia-admin-pin";
const STORAGE_KEY_BUILTIN_TEMPLATE_OVERRIDES = "nostalgia-builtin-template-overrides";
const STORAGE_KEY_SHOOTING_FIRST_COUNTDOWN = "nostalgia-shooting-first-countdown";
const STORAGE_KEY_SHOOTING_SUBSEQUENT_COUNTDOWN = "nostalgia-shooting-subsequent-countdown";
const STORAGE_KEY_PRINTING_COUNTDOWN = "nostalgia-printing-countdown";
const STORAGE_KEY_QR_COUNTDOWN = "nostalgia-qr-countdown";
const STORAGE_KEY_QR_AUTO_ADVANCE = "nostalgia-qr-auto-advance";
const STORAGE_KEY_CAMERA_DETECTION = "nostalgia-camera-detection";

// -----------------------------------------------------------------------------
// Built-in templates (hardcoded from assets in public/strip-frame/)
// -----------------------------------------------------------------------------
const BUILTIN_TEMPLATES: Template[] = [
  {
    id: "builtin-2x2-layout",
    name: "2×2 Layout",
    // 2×2 Layout PNG is portrait (1240×1844) — match the paper.
    // Photos fill each film window edge-to-edge (cover, no inset zoom).
    photoCount: 4,
    layout: "vertical",
    paperSize: "4x6-portrait",
    frameRows: 2,
    frameCols: 2,
    cellZoom: 1,
    fitMode: "cover",
    frameImageUrl: `${import.meta.env.BASE_URL}strip-frame/2x2 Layout.png`,
    isActive: true,
  },
  {
    id: "builtin-heart-grid",
    name: "Heart Grid",
    // 3×2 Layout heart PNG is portrait (1200×1800). Its windows are
    // laid out 3 ROWS × 2 COLS (2 photos across, 3 down) — confirmed
    // against the layout-sandbox spec (cells 584×583 at margin/gap
    // 24). Was previously declared 2×3 (flipped), which put photos in
    // the wrong window positions.
    photoCount: 6,
    layout: "vertical",
    paperSize: "4x6-portrait",
    frameRows: 3,
    frameCols: 2,
    cellZoom: 0.85, // pull photos back to sit inside the heart cutouts
    frameImageUrl: `${import.meta.env.BASE_URL}strip-frame/3x2 Layout heart.png`,
    isActive: true,
  },
  {
    id: "builtin-4x2-layout",
    name: "4×2 Layout",
    // 4×2 Layout PNG is portrait (1240×1844), windows laid out
    // 4 ROWS × 2 COLS (2 across, 4 down) edge-to-edge with NO
    // margin/gap — confirmed against the layout-sandbox spec
    // (cells 620×461, margin 0, gap 0). Was declared 2×4 with the
    // default 24px margin/gap, which is why photos didn't fill.
    photoCount: 8,
    layout: "vertical",
    paperSize: "4x6-portrait",
    frameRows: 4,
    frameCols: 2,
    cellMargin: 0,
    cellGap: 0,
    frameImageUrl: `${import.meta.env.BASE_URL}strip-frame/4x2 Layout.png`,
    isActive: true,
  },
];

export function isBuiltinTemplate(id: string): boolean {
  return typeof id === "string" && id.startsWith("builtin-");
}

// -----------------------------------------------------------------------------
// Default camera filters & helpers
// -----------------------------------------------------------------------------
const DEFAULT_FILTERS: CameraFilter[] = [
  { id: "default-original", name: "Original", effectType: "original", isActive: true },
  // Single canonical Sepia. Previously the defaults shipped both
  // "Sepia 3" and "Sepia 4" (each pointing at a different LUT) which
  // produced two near-identical buttons in the camera UI. Kept the
  // sepia4 LUT as the one — admins can still upload other variants
  // through the customize panel.
  { id: "default-sepia",    name: "Sepia",    effectType: "cube",     isActive: true, cubeData: "/luts/sepia4.cube", baseFilter: "sepia" },
  { id: "default-bw",       name: "B & W",    effectType: "bw",       isActive: true },
  { id: "default-fujifilm", name: "Fujifilm", effectType: "fujifilm",  isActive: true },
];

export function isDefaultFilter(id: string): boolean {
  return typeof id === "string" && id.startsWith("default-");
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------
export const usePhotoboothStore = defineStore("photobooth", () => {
  // ---- Templates (state & persistence) ----
  const customTemplates = ref<Template[]>([]);
  // BUILTIN_TEMPLATES is a hardcoded module-level array (not per-instance
  // state), so a built-in's active status / layout cells are tracked
  // separately here and merged in via `templates` below.
  type BuiltinOverrideMap = Record<
    string,
    {
      isActive?: boolean;
      cells?: TemplateCell[];
      name?: string;
      photoCount?: number;
    }
  >;
  const builtinTemplateOverrides = ref<BuiltinOverrideMap>({});

  function usesDiskTemplates(): boolean {
    return typeof window !== "undefined" && !!window.electronAPI?.loadTemplates;
  }

  function parseStoredTemplates(raw: string | null): Template[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as Template[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t) => t && typeof t.id === "string" && !isBuiltinTemplate(t.id))
        .map((t) => ({ ...t, isActive: t.isActive !== false }));
    } catch {
      return [];
    }
  }

  function parseStoredOverrides(raw: string | null): BuiltinOverrideMap {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as BuiltinOverrideMap;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Browser-only load. Electron skips this: a previous "drop custom
   * templates that share a built-in's rows×cols" migration deleted real
   * 2×2 / 3×2 / 4×2 layouts and then wrote that empty list over
   * templates.json, so every restart snapped back to the built-ins.
   * Disk is the source of truth; hydrateTemplatesFromDisk recovers
   * anything localStorage still has.
   */
  function loadCustomTemplates() {
    if (usesDiskTemplates()) return;
    customTemplates.value = parseStoredTemplates(
      localStorage.getItem(CUSTOM_TEMPLATES_KEY),
    );
  }

  /**
   * Persist templates.
   *
   * Disk is authoritative. localStorage CANNOT hold these: an imported
   * template carries its frame artwork and both thumbnails as base64 data
   * URLs, so a few templates plus the recent-strips previews overrun the
   * ~5MB origin quota. Past that point every `setItem` throws
   * QuotaExceededError — which is exactly how operators lost every layout
   * they had added as soon as the software restarted.
   *
   * The localStorage write is kept only as a best-effort fallback for
   * running outside Electron (`npm run dev` in a plain browser), and is
   * wrapped because at quota it WILL throw and must not take the caller
   * down with it.
   *
   * Writes are serialised so a later save cannot finish before an earlier
   * one and leave disk on a stale snapshot.
   */
  let persistChain: Promise<void> = Promise.resolve();

  function persistTemplatesToDisk(): Promise<void> {
    persistChain = persistChain.then(writeTemplatesNow, writeTemplatesNow);
    return persistChain;
  }

  async function writeTemplatesNow(): Promise<void> {
    const api = window.electronAPI;
    if (!api?.saveTemplates) return;
    try {
      const payload = {
        customTemplates: JSON.parse(JSON.stringify(customTemplates.value)),
        builtinTemplateOverrides: JSON.parse(
          JSON.stringify(builtinTemplateOverrides.value),
        ),
      };
      const r = await api.saveTemplates(payload);
      if (!r?.success) {
        console.error("[Templates] Disk save failed:", r?.error);
      }
    } catch (e) {
      console.error("[Templates] Disk save threw:", e);
    }
  }

  function mirrorTemplatesToLocalStorage() {
    try {
      localStorage.setItem(
        CUSTOM_TEMPLATES_KEY,
        JSON.stringify(customTemplates.value),
      );
    } catch (e) {
      console.warn("[Templates] localStorage mirror skipped (quota):", e);
    }
    try {
      localStorage.setItem(
        STORAGE_KEY_BUILTIN_TEMPLATE_OVERRIDES,
        JSON.stringify(builtinTemplateOverrides.value),
      );
    } catch (e) {
      console.warn("[Templates] localStorage mirror skipped (quota):", e);
    }
  }

  function saveCustomTemplates(): Promise<void> {
    mirrorTemplatesToLocalStorage();
    return persistTemplatesToDisk();
  }

  function loadBuiltinTemplateOverrides() {
    if (usesDiskTemplates()) return;
    builtinTemplateOverrides.value = parseStoredOverrides(
      localStorage.getItem(STORAGE_KEY_BUILTIN_TEMPLATE_OVERRIDES),
    );
  }

  function saveBuiltinTemplateOverrides(): Promise<void> {
    return saveCustomTemplates();
  }

  /**
   * Load templates from disk, which is where they now live.
   *
   * Called once at startup, before any screen that lists templates. If the
   * file does not exist yet this is a first run after the upgrade, so
   * whatever localStorage still holds is imported and written to disk — an
   * operator's existing layouts are carried over rather than dropped.
   *
   * Also re-merges any custom templates / layout cells that localStorage
   * still has but disk lost (the old duplicate-builtin wipe).
   */
  async function hydrateTemplatesFromDisk() {
    const api = window.electronAPI;
    if (!api?.loadTemplates) return; // browser dev: localStorage load already ran

    const lsTemplates = parseStoredTemplates(
      localStorage.getItem(CUSTOM_TEMPLATES_KEY),
    );
    const lsOverrides = parseStoredOverrides(
      localStorage.getItem(STORAGE_KEY_BUILTIN_TEMPLATE_OVERRIDES),
    );

    try {
      const res = await api.loadTemplates();
      if (res?.success && res.data) {
        const data = res.data as {
          customTemplates?: Template[];
          builtinTemplateOverrides?: BuiltinOverrideMap;
        };
        if (Array.isArray(data.customTemplates)) {
          customTemplates.value = data.customTemplates.map((t) => ({
            ...t,
            isActive: t.isActive !== false,
          }));
        }
        if (data.builtinTemplateOverrides) {
          builtinTemplateOverrides.value = data.builtinTemplateOverrides;
        }

        let recovered = 0;
        const byId = new Map(customTemplates.value.map((t) => [t.id, t]));
        for (const t of lsTemplates) {
          const existing = byId.get(t.id);
          if (!existing) {
            customTemplates.value = [...customTemplates.value, t];
            byId.set(t.id, t);
            recovered += 1;
          } else if (
            (!existing.cells || existing.cells.length === 0) &&
            t.cells &&
            t.cells.length > 0
          ) {
            customTemplates.value = customTemplates.value.map((c) =>
              c.id === t.id ? { ...c, cells: t.cells } : c,
            );
            recovered += 1;
          }
        }
        const mergedOverrides: BuiltinOverrideMap = {
          ...builtinTemplateOverrides.value,
        };
        for (const [id, ov] of Object.entries(lsOverrides)) {
          const cur = mergedOverrides[id];
          const diskHasCells = Array.isArray(cur?.cells) && cur.cells.length > 0;
          const lsHasCells = Array.isArray(ov?.cells) && ov.cells.length > 0;
          if (lsHasCells && !diskHasCells) {
            mergedOverrides[id] = { ...cur, ...ov };
            recovered += 1;
          }
        }
        builtinTemplateOverrides.value = mergedOverrides;

        console.log(
          `[Templates] Loaded ${customTemplates.value.length} custom template(s) from disk`,
        );
        if (recovered > 0) {
          console.log(
            `[Templates] Restored ${recovered} layout(s) that disk had dropped`,
          );
          await saveCustomTemplates();
        }
        return;
      }

      // No file yet — migrate whatever localStorage managed to keep.
      console.log(
        "[Templates] No templates.json yet — migrating from localStorage",
      );
      customTemplates.value = lsTemplates;
      builtinTemplateOverrides.value = lsOverrides;
      await saveCustomTemplates();
    } catch (e) {
      console.error("[Templates] Disk load failed, keeping localStorage:", e);
      if (!customTemplates.value.length && lsTemplates.length) {
        customTemplates.value = lsTemplates;
      }
      if (
        !Object.keys(builtinTemplateOverrides.value).length &&
        Object.keys(lsOverrides).length
      ) {
        builtinTemplateOverrides.value = lsOverrides;
      }
    }
  }

  const templates = computed(() => [
    ...BUILTIN_TEMPLATES.map((t) => {
      const override = builtinTemplateOverrides.value[t.id];
      return override ? { ...t, ...override } : t;
    }),
    ...customTemplates.value,
  ]);
  const activeTemplates = computed(() =>
    templates.value.filter((t) => t.isActive !== false),
  );

  // ---- Session ----
  const selectedTemplate = ref<Template | null>(null);
  const capturedPhotos = ref<CapturedPhoto[]>([]);
  const currentPhotoIndex = ref(0);
  /** Per-shot highlight clips (blob: URLs) recorded around each shutter. */
  const highlightClips = ref<string[]>([]);

  function clearHighlightClips() {
    for (const url of highlightClips.value) {
      revokeMediaUrl(url);
    }
    highlightClips.value = [];
  }

  /**
   * Live copy of the selected template (cells, zoom, fitMode) from the
   * templates list — not the snapshot taken at pick time. The shooting
   * preview and print composite must follow the latest admin layout.
   */
  const sessionTemplate = computed(() => {
    const sel = selectedTemplate.value;
    if (!sel) return null;
    return templates.value.find((t) => t.id === sel.id) ?? sel;
  });

  /**
   * How many photos the guest actually SHOOTS.
   *
   * `photoCount` is authoritative — NOT rows x cols. A sheet can hold
   * more cells than there are shots, in which case the captures repeat
   * across the sheet: a 4x3 grid with photoCount 4 is "4 shots, 3
   * copies", which is what the client asked for. The print composite
   * and the live preview both index cells with `i % shots`.
   *
   * This previously returned rows x cols, so that same template
   * demanded 12 separate captures.
   */
  const requiredPhotos = computed(() => {
    const t = selectedTemplate.value;
    if (!t) return 0;
    if (t.photoCount != null && t.photoCount > 0) return t.photoCount;
    const rows = t.frameRows;
    const cols = t.frameCols;
    if (rows != null && cols != null && rows > 0 && cols > 0) return rows * cols;
    return 1;
  });

  /** Cells on the sheet (may exceed requiredPhotos → repeated copies). */
  const templateCellCount = computed(() => {
    const t = sessionTemplate.value;
    if (!t) return 0;
    if (t.cells?.length) return t.cells.length;
    const rows = t.frameRows;
    const cols = t.frameCols;
    if (rows != null && cols != null && rows > 0 && cols > 0) return rows * cols;
    return Math.max(1, t.photoCount ?? 1);
  });

  /** How many times the shot sequence repeats on the sheet. */
  const templateCopies = computed(() => {
    const shots = requiredPhotos.value;
    if (!shots) return 1;
    return Math.max(1, Math.round(templateCellCount.value / shots));
  });
  const hasAllPhotos = computed(
    () => capturedPhotos.value.length >= requiredPhotos.value,
  );
  const remainingPhotos = computed(
    () => requiredPhotos.value - capturedPhotos.value.length,
  );

  // ---- Camera options ----
  const mirrorMode = ref(true);

  // When false, the camera screen skips all Canon EDSDK detection /
  // connection and uses sample.png for preview and captures instead —
  // lets the whole flow (template → payment → camera → print → QR) be
  // walked through without the physical camera. Toggle in Settings → Camera.
  // Default true (real Canon camera) for production.
  const cameraDetectionEnabled = ref(true);
  function loadCameraDetection() {
    const saved = localStorage.getItem(STORAGE_KEY_CAMERA_DETECTION);
    if (saved !== null) cameraDetectionEnabled.value = saved === "true";
  }
  function setCameraDetectionEnabled(enabled: boolean) {
    cameraDetectionEnabled.value = enabled;
    localStorage.setItem(STORAGE_KEY_CAMERA_DETECTION, String(enabled));
  }

  // ---- Admin access PIN ----
  // The hidden 3-tap admin gesture on the title screen is ALWAYS gated by
  // a PIN. Fresh installs default to 1234; the operator can change it
  // (4–8 digits) in Settings → Admin PIN, or reset it back to the default.
  const DEFAULT_ADMIN_PIN = "1234";
  const adminPin = ref<string>(DEFAULT_ADMIN_PIN);

  function loadAdminPin() {
    const saved = localStorage.getItem(STORAGE_KEY_ADMIN_PIN);
    // Ignore stale/empty values (e.g. a PIN "removed" under the old
    // behavior) so the gate always falls back to the 1234 default.
    if (saved !== null && saved.length >= 4) adminPin.value = saved;
  }
  function setAdminPin(pin: string) {
    const digitsOnly = pin.replace(/\D/g, "").slice(0, 8);
    if (digitsOnly.length < 4) return; // never allow a shorter-than-4 PIN
    adminPin.value = digitsOnly;
    localStorage.setItem(STORAGE_KEY_ADMIN_PIN, digitsOnly);
  }
  function clearAdminPin() {
    // There is always a PIN gate — "clearing" resets to the 1234 default.
    adminPin.value = DEFAULT_ADMIN_PIN;
    localStorage.removeItem(STORAGE_KEY_ADMIN_PIN);
  }

  // ---- Countdown timing (shooting / printing / QR) ----
  const shootingFirstCountdownSeconds = ref(15);
  // Same posing window as the first shot. The 5s freeze after a capture
  // is extra and must not shorten this. (Used to default to 10, which
  // made shot 2 look like 15−5.)
  const shootingSubsequentCountdownSeconds = ref(15);
  const printingCountdownSeconds = ref(20);
  const qrCountdownSeconds = ref(30);
  const qrAutoAdvanceEnabled = ref(true);

  function loadTimingSettings() {
    const clamp = (n: number, min: number, max: number) =>
      Math.max(min, Math.min(max, n));
    const first = localStorage.getItem(STORAGE_KEY_SHOOTING_FIRST_COUNTDOWN);
    if (first !== null) {
      const n = parseInt(first, 10);
      if (!isNaN(n)) shootingFirstCountdownSeconds.value = clamp(n, 1, 60);
    }
    const subsequent = localStorage.getItem(STORAGE_KEY_SHOOTING_SUBSEQUENT_COUNTDOWN);
    if (subsequent !== null) {
      const n = parseInt(subsequent, 10);
      if (!isNaN(n)) shootingSubsequentCountdownSeconds.value = clamp(n, 1, 60);
    }
    // Old default was 10 while first-shot was 15. The freeze-after-shot
    // is NOT part of the posing countdown — bump the legacy 10 so shot
    // 2+ still get a full 15s timer unless the operator set something else.
    if (
      subsequent === "10" &&
      shootingFirstCountdownSeconds.value === 15
    ) {
      shootingSubsequentCountdownSeconds.value = 15;
      localStorage.setItem(STORAGE_KEY_SHOOTING_SUBSEQUENT_COUNTDOWN, "15");
    }
    const printing = localStorage.getItem(STORAGE_KEY_PRINTING_COUNTDOWN);
    if (printing !== null) {
      const n = parseInt(printing, 10);
      if (!isNaN(n)) printingCountdownSeconds.value = clamp(n, 1, 120);
    }
    const qr = localStorage.getItem(STORAGE_KEY_QR_COUNTDOWN);
    if (qr !== null) {
      const n = parseInt(qr, 10);
      if (!isNaN(n)) qrCountdownSeconds.value = clamp(n, 1, 120);
    }
    const qrEnabled = localStorage.getItem(STORAGE_KEY_QR_AUTO_ADVANCE);
    if (qrEnabled !== null) qrAutoAdvanceEnabled.value = qrEnabled === "true";
  }

  function setShootingFirstCountdown(seconds: number) {
    const clamped = Math.max(1, Math.min(60, Math.round(seconds)));
    shootingFirstCountdownSeconds.value = clamped;
    localStorage.setItem(STORAGE_KEY_SHOOTING_FIRST_COUNTDOWN, String(clamped));
  }
  function setShootingSubsequentCountdown(seconds: number) {
    const clamped = Math.max(1, Math.min(60, Math.round(seconds)));
    shootingSubsequentCountdownSeconds.value = clamped;
    localStorage.setItem(STORAGE_KEY_SHOOTING_SUBSEQUENT_COUNTDOWN, String(clamped));
  }
  function setPrintingCountdown(seconds: number) {
    const clamped = Math.max(1, Math.min(120, Math.round(seconds)));
    printingCountdownSeconds.value = clamped;
    localStorage.setItem(STORAGE_KEY_PRINTING_COUNTDOWN, String(clamped));
  }
  function setQrCountdown(seconds: number) {
    const clamped = Math.max(1, Math.min(120, Math.round(seconds)));
    qrCountdownSeconds.value = clamped;
    localStorage.setItem(STORAGE_KEY_QR_COUNTDOWN, String(clamped));
  }
  function setQrAutoAdvanceEnabled(enabled: boolean) {
    qrAutoAdvanceEnabled.value = enabled;
    localStorage.setItem(STORAGE_KEY_QR_AUTO_ADVANCE, String(enabled));
  }

  // ---- Recent strips ----
  const recentStrips = ref<SavedPhotoStrip[]>([]);

  // ---- Customize (logo, title bg, fonts, camera filters) ----
  const customLogoUrl = ref<string | null>(null);
  const customStartButtonUrl = ref<string | null>(null);
  const startButtonStyle = ref<WelcomeStartButtonStyle>(defaultStartButtonStyle());

  function persistStartButtonStyle() {
    localStorage.setItem(
      STORAGE_KEY_START_BTN_STYLE,
      JSON.stringify(startButtonStyle.value),
    );
  }
  function setStartButtonStyle(patch: Partial<WelcomeStartButtonStyle>) {
    startButtonStyle.value = parseStartButtonStyle({
      ...startButtonStyle.value,
      ...patch,
    });
    persistStartButtonStyle();
  }
  function applyStartButtonStyle(style: WelcomeStartButtonStyle) {
    startButtonStyle.value = parseStartButtonStyle(style);
    persistStartButtonStyle();
  }
  function resetStartButtonStyle() {
    startButtonStyle.value = defaultStartButtonStyle();
    localStorage.removeItem(STORAGE_KEY_START_BTN_STYLE);
  }
  function loadStartButtonStyle() {
    const raw = localStorage.getItem(STORAGE_KEY_START_BTN_STYLE);
    if (!raw) return;
    try {
      startButtonStyle.value = parseStartButtonStyle(JSON.parse(raw));
    } catch {
      startButtonStyle.value = defaultStartButtonStyle();
    }
  }
  // Operator-supplied payment QR (e.g. GCash/Maya), shown inside the
  // frame on the payment screen. Null = show the amount/hint instead.
  const paymentQrUrl = ref<string | null>(null);

  // Whether the booth charges at all. Off = free event: choosing a
  // template goes straight to shooting and the Payment screen is never
  // shown. Defaults ON so a paid booth can't accidentally go free.
  const paymentEnabled = ref(true);
  function loadPaymentEnabled() {
    const saved = localStorage.getItem(STORAGE_KEY_PAYMENT_ENABLED);
    if (saved !== null) paymentEnabled.value = saved === "true";
  }

  // Operator-adjustable size for the title-screen logo and the payment
  // QR. 1 = the design's native size; the sliders run 0.5x–1.5x so an
  // uploaded logo/QR whose artwork has different padding can be matched
  // to the layout without re-exporting it.
  const titleLogoScale = ref(1);
  const paymentQrScale = ref(1);
  // The Start button was sized to the Figma spec (414x87), which the
  // client found too large on the real 24" screen. Default to 0.8 and
  // let them tune it; 1.0 is the design size.
  const startButtonScale = ref(0.8);
  const clampScale = (n: number) => Math.min(1.5, Math.max(0.5, n));
  function loadScales() {
    const l = parseFloat(localStorage.getItem(STORAGE_KEY_LOGO_SCALE) || "");
    if (!isNaN(l)) titleLogoScale.value = clampScale(l);
    const q = parseFloat(localStorage.getItem(STORAGE_KEY_QR_SCALE) || "");
    if (!isNaN(q)) paymentQrScale.value = clampScale(q);
    const s = parseFloat(localStorage.getItem(STORAGE_KEY_START_BTN_SCALE) || "");
    if (!isNaN(s)) startButtonScale.value = clampScale(s);
  }
  function setStartButtonScale(n: number) {
    startButtonScale.value = clampScale(n);
    localStorage.setItem(STORAGE_KEY_START_BTN_SCALE, String(startButtonScale.value));
    if (welcomeLayout.value) {
      scaleWelcomeItem("start", startButtonScale.value, WELCOME_START_NATIVE_W);
    }
  }
  function setTitleLogoScale(n: number) {
    titleLogoScale.value = clampScale(n);
    localStorage.setItem(STORAGE_KEY_LOGO_SCALE, String(titleLogoScale.value));
    if (welcomeLayout.value) {
      scaleWelcomeItem("logo", titleLogoScale.value, WELCOME_LOGO_NATIVE_W);
    }
  }
  function setPaymentQrScale(n: number) {
    paymentQrScale.value = clampScale(n);
    localStorage.setItem(STORAGE_KEY_QR_SCALE, String(paymentQrScale.value));
  }
  function setPaymentEnabled(enabled: boolean) {
    paymentEnabled.value = enabled;
    localStorage.setItem(STORAGE_KEY_PAYMENT_ENABLED, String(enabled));
  }
  const welcomeLayout = ref<WelcomeLayout | null>(null);
  const lastPersistedWelcomeLayout = ref("");

  function layoutSnapshot(layout: WelcomeLayout | null): string {
    return layout ? JSON.stringify(layout) : "";
  }

  function persistWelcomeLayout() {
    if (!welcomeLayout.value) {
      localStorage.removeItem(STORAGE_KEY_WELCOME_LAYOUT);
      lastPersistedWelcomeLayout.value = "";
      return;
    }
    const raw = JSON.stringify(welcomeLayout.value);
    localStorage.setItem(STORAGE_KEY_WELCOME_LAYOUT, raw);
    lastPersistedWelcomeLayout.value = raw;
  }

  const welcomeLayoutDirty = computed(
    () => layoutSnapshot(welcomeLayout.value) !== lastPersistedWelcomeLayout.value,
  );

  function loadWelcomeLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_WELCOME_LAYOUT);
      if (!raw) {
        lastPersistedWelcomeLayout.value = "";
        return;
      }
      welcomeLayout.value = parseWelcomeLayout(JSON.parse(raw));
      lastPersistedWelcomeLayout.value = layoutSnapshot(welcomeLayout.value);
    } catch {
      welcomeLayout.value = null;
      lastPersistedWelcomeLayout.value = "";
    }
  }

  function saveWelcomeLayout() {
    persistWelcomeLayout();
  }

  function revertWelcomeLayout() {
    if (!lastPersistedWelcomeLayout.value) {
      welcomeLayout.value = null;
      return;
    }
    try {
      welcomeLayout.value = parseWelcomeLayout(
        JSON.parse(lastPersistedWelcomeLayout.value),
      );
    } catch {
      welcomeLayout.value = null;
    }
  }

  function scaleWelcomeItem(
    id: "logo" | "start",
    scale: number,
    nativeW: number,
  ) {
    const layout = welcomeLayout.value;
    if (!layout) return;
    const cur = layout[id];
    const aspect = cur.h / cur.w || 1;
    const w = (nativeW * scale) / WELCOME_CANVAS_W;
    const h = w * aspect;
    const cx = cur.x + cur.w / 2;
    const cy = cur.y + cur.h / 2;
    welcomeLayout.value = normalizeWelcomeLayout({
      ...layout,
      [id]: clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }),
    });
  }

  function ensureWelcomeLayout(): WelcomeLayout {
    if (!welcomeLayout.value) {
      welcomeLayout.value = defaultWelcomeLayout(
        titleLogoScale.value,
        startButtonScale.value,
      );
    } else {
      welcomeLayout.value = normalizeWelcomeLayout(welcomeLayout.value);
    }
    return welcomeLayout.value;
  }

  function setWelcomeItem(id: WelcomeItemId, box: WelcomeBox) {
    const layout = ensureWelcomeLayout();
    const next = clampBox(box);
    if (id === "logo" || id === "start") {
      welcomeLayout.value = normalizeWelcomeLayout({ ...layout, [id]: next });
      if (id === "logo") {
        titleLogoScale.value = clampScale(
          (next.w * WELCOME_CANVAS_W) / WELCOME_LOGO_NATIVE_W,
        );
        localStorage.setItem(STORAGE_KEY_LOGO_SCALE, String(titleLogoScale.value));
      } else {
        startButtonScale.value = clampScale(
          (next.w * WELCOME_CANVAS_W) / WELCOME_START_NATIVE_W,
        );
        localStorage.setItem(
          STORAGE_KEY_START_BTN_SCALE,
          String(startButtonScale.value),
        );
      }
      return;
    }
    if (!isAssetId(id)) return;
    const key = assetKey(id);
    welcomeLayout.value = normalizeWelcomeLayout({
      ...layout,
      assets: layout.assets.map((a) =>
        a.id === key ? { ...a, ...next } : a,
      ),
    });
  }

  function addWelcomeAsset(
    src: string,
    name = "Image",
    box?: WelcomeBox,
    kind: WelcomeAssetKind = "image",
    text?: WelcomeTextStyle,
  ): string {
    const layout = ensureWelcomeLayout();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const placed = clampBox(box ?? { x: 0.34, y: 0.3, w: 0.28, h: 0.22 });
    const itemId = assetItemId(id);
    const label =
      name ||
      (kind === "video" ? "Video" : kind === "text" ? "Text" : "Image");
    welcomeLayout.value = normalizeWelcomeLayout({
      ...layout,
      assets: [
        ...layout.assets,
        {
          id,
          src,
          name: label,
          kind,
          ...(kind === "text" ? { text: parseTextStyle(text) } : {}),
          ...placed,
        },
      ],
      order: [...layout.order, itemId],
    });
    return itemId;
  }

  function removeWelcomeAsset(id: WelcomeItemId) {
    if (!isAssetId(id)) return;
    const layout = ensureWelcomeLayout();
    const key = assetKey(id);
    welcomeLayout.value = normalizeWelcomeLayout({
      ...layout,
      assets: layout.assets.filter((a) => a.id !== key),
    });
  }

  function replaceWelcomeAssetSrc(
    id: WelcomeItemId,
    src: string,
    kind?: "image" | "video",
  ) {
    if (!isAssetId(id)) return;
    const layout = ensureWelcomeLayout();
    const key = assetKey(id);
    welcomeLayout.value = normalizeWelcomeLayout({
      ...layout,
      assets: layout.assets.map((a) =>
        a.id === key
          ? { ...a, src, kind: kind ?? a.kind ?? "image", text: undefined }
          : a,
      ),
    });
  }

  function updateWelcomeAssetText(
    id: WelcomeItemId,
    patch: Partial<WelcomeTextStyle>,
  ) {
    if (!isAssetId(id)) return;
    const layout = ensureWelcomeLayout();
    const key = assetKey(id);
    welcomeLayout.value = normalizeWelcomeLayout({
      ...layout,
      assets: layout.assets.map((a) => {
        if (a.id !== key || a.kind !== "text") return a;
        const text = parseTextStyle({ ...a.text, ...patch });
        const line = text.content.split("\n")[0].trim();
        return { ...a, text, name: line.slice(0, 32) || "Text" };
      }),
    });
  }

  function sendWelcomeLayer(
    id: WelcomeItemId,
    dir: "back" | "front" | "backward" | "forward",
  ) {
    const layout = ensureWelcomeLayout();
    welcomeLayout.value = normalizeWelcomeLayout({
      ...layout,
      order: moveLayerOrder(layout.order, id, dir),
    });
  }

  function setWelcomeLayerOrder(order: string[]) {
    const layout = ensureWelcomeLayout();
    welcomeLayout.value = normalizeWelcomeLayout({ ...layout, order });
  }

  function resetWelcomeLayout() {
    welcomeLayout.value = defaultWelcomeLayout(
      titleLogoScale.value,
      startButtonScale.value,
    );
  }

  function applyWelcomeLayout(layout: WelcomeLayout) {
    const next = normalizeWelcomeLayout(layout);
    welcomeLayout.value = next;
    titleLogoScale.value = clampScale(
      (next.logo.w * WELCOME_CANVAS_W) / WELCOME_LOGO_NATIVE_W,
    );
    startButtonScale.value = clampScale(
      (next.start.w * WELCOME_CANVAS_W) / WELCOME_START_NATIVE_W,
    );
  }

  const emptyKioskLayouts = (): Record<KioskScreenId, KioskLayout | null> => ({
    templates: null,
    payment: null,
    camera: null,
    printing: null,
    qr: null,
  });
  const emptyKioskSnaps = (): Record<KioskScreenId, string> => ({
    templates: "",
    payment: "",
    camera: "",
    printing: "",
    qr: "",
  });

  const kioskLayouts = ref<Record<KioskScreenId, KioskLayout | null>>(
    emptyKioskLayouts(),
  );
  const lastPersistedKiosk = ref<Record<KioskScreenId, string>>(emptyKioskSnaps());

  function kioskLayoutOf(id: KioskScreenId): KioskLayout | null {
    const cur = kioskLayouts.value[id];
    return cur ? normalizeKioskLayout(id, cur) : null;
  }

  function kioskSnapshot(layout: KioskLayout | null): string {
    return layout ? JSON.stringify(layout) : "";
  }

  function kioskLayoutDirty(id: KioskScreenId): boolean {
    return kioskSnapshot(kioskLayouts.value[id]) !== lastPersistedKiosk.value[id];
  }

  function persistKioskLayout(id: KioskScreenId) {
    const layout = kioskLayouts.value[id];
    const key = STORAGE_KEY_KIOSK_LAYOUT + id;
    if (!layout) {
      localStorage.removeItem(key);
      lastPersistedKiosk.value = { ...lastPersistedKiosk.value, [id]: "" };
      return;
    }
    const raw = JSON.stringify(layout);
    localStorage.setItem(key, raw);
    lastPersistedKiosk.value = { ...lastPersistedKiosk.value, [id]: raw };
  }

  function loadKioskLayouts() {
    const next = emptyKioskLayouts();
    const snaps = emptyKioskSnaps();
    for (const id of KIOSK_SCREEN_IDS) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_KIOSK_LAYOUT + id);
        if (!raw) continue;
        const parsed = parseKioskLayout(id, JSON.parse(raw));
        next[id] = parsed;
        snaps[id] = parsed ? JSON.stringify(parsed) : "";
      } catch {
        next[id] = null;
      }
    }
    kioskLayouts.value = next;
    lastPersistedKiosk.value = snaps;
  }

  function saveKioskLayout(id: KioskScreenId) {
    persistKioskLayout(id);
  }

  function revertKioskLayout(id: KioskScreenId) {
    const raw = lastPersistedKiosk.value[id];
    if (!raw) {
      kioskLayouts.value = { ...kioskLayouts.value, [id]: null };
      return;
    }
    try {
      kioskLayouts.value = {
        ...kioskLayouts.value,
        [id]: parseKioskLayout(id, JSON.parse(raw)),
      };
    } catch {
      kioskLayouts.value = { ...kioskLayouts.value, [id]: null };
    }
  }

  function ensureKioskLayout(id: KioskScreenId): KioskLayout {
    const cur = kioskLayouts.value[id];
    const next = cur
      ? normalizeKioskLayout(id, cur)
      : defaultKioskLayout(id);
    kioskLayouts.value = { ...kioskLayouts.value, [id]: next };
    return next;
  }

  function setKioskLayout(id: KioskScreenId, layout: KioskLayout) {
    kioskLayouts.value = {
      ...kioskLayouts.value,
      [id]: normalizeKioskLayout(id, layout),
    };
  }

  function resetKioskLayout(id: KioskScreenId) {
    kioskLayouts.value = {
      ...kioskLayouts.value,
      [id]: defaultKioskLayout(id),
    };
  }

  function setKioskItem(id: KioskScreenId, itemId: string, box: WelcomeBox) {
    const layout = ensureKioskLayout(id);
    const next = clampBox(box);
    if (isAssetId(itemId)) {
      const key = assetKey(itemId);
      setKioskLayout(id, {
        ...layout,
        assets: layout.assets.map((a) =>
          a.id === key ? { ...a, ...next } : a,
        ),
      });
      return;
    }
    const items = { ...layout.items, [itemId]: next };
    const scale = layout.buttons[itemId]?.scale ?? 1;
    if (isKioskActionButton(id, itemId)) {
      items[itemId] = lockKioskActionButtonSize(next, scale);
    }
    if (id === "camera" && itemId === "startBtn") {
      items[itemId] = lockKioskStartButtonSize(items[itemId]!, scale);
    }
    setKioskLayout(id, {
      ...layout,
      items,
    });
  }

  function addKioskAsset(
    screenId: KioskScreenId,
    src: string,
    name = "Image",
    box?: WelcomeBox,
    kind: WelcomeAssetKind = "image",
    text?: WelcomeTextStyle,
  ): string {
    const layout = ensureKioskLayout(screenId);
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const placed = clampBox(box ?? { x: 0.34, y: 0.3, w: 0.28, h: 0.22 });
    const itemId = assetItemId(id);
    const label =
      name ||
      (kind === "video" ? "Video" : kind === "text" ? "Text" : "Image");
    setKioskLayout(screenId, {
      ...layout,
      assets: [
        ...layout.assets,
        {
          id,
          src,
          name: label,
          kind,
          ...(kind === "text" ? { text: parseTextStyle(text) } : {}),
          ...placed,
        },
      ],
      order: [...layout.order, itemId],
    });
    return itemId;
  }

  function removeKioskAsset(screenId: KioskScreenId, id: string) {
    if (!isAssetId(id)) return;
    const layout = ensureKioskLayout(screenId);
    const key = assetKey(id);
    setKioskLayout(screenId, {
      ...layout,
      assets: layout.assets.filter((a) => a.id !== key),
    });
  }

  function replaceKioskAssetSrc(
    screenId: KioskScreenId,
    id: string,
    src: string,
    kind?: "image" | "video",
  ) {
    if (!isAssetId(id)) return;
    const layout = ensureKioskLayout(screenId);
    const key = assetKey(id);
    setKioskLayout(screenId, {
      ...layout,
      assets: layout.assets.map((a) =>
        a.id === key
          ? { ...a, src, kind: kind ?? a.kind ?? "image", text: undefined }
          : a,
      ),
    });
  }

  function updateKioskAssetText(
    screenId: KioskScreenId,
    id: string,
    patch: Partial<WelcomeTextStyle>,
  ) {
    if (!isAssetId(id)) return;
    const layout = ensureKioskLayout(screenId);
    const key = assetKey(id);
    setKioskLayout(screenId, {
      ...layout,
      assets: layout.assets.map((a) => {
        if (a.id !== key || a.kind !== "text") return a;
        const text = parseTextStyle({ ...a.text, ...patch });
        const line = text.content.split("\n")[0].trim();
        return { ...a, text, name: line.slice(0, 32) || "Text" };
      }),
    });
  }

  function updateKioskText(
    screenId: KioskScreenId,
    itemId: string,
    patch: Partial<WelcomeTextStyle>,
  ) {
    const layout = ensureKioskLayout(screenId);
    const current = layout.texts[itemId];
    if (!current) return;
    setKioskLayout(screenId, {
      ...layout,
      texts: {
        ...layout.texts,
        [itemId]: parseTextStyle({ ...current, ...patch }),
      },
    });
  }

  function kioskButtonMeta(screenId: KioskScreenId, itemId: string) {
    const def = kioskItemDef(screenId, itemId);
    return {
      variant: def?.buttonVariant || "wood",
      fallback: def?.buttonLabel || def?.label || "Button",
    };
  }

  function sizedKioskButtonBox(
    screenId: KioskScreenId,
    itemId: string,
    box: WelcomeBox,
    scale: number,
  ): WelcomeBox {
    const s = Math.min(1.5, Math.max(0.5, scale));
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let next: WelcomeBox;
    if (isKioskActionButton(screenId, itemId)) {
      next = lockKioskActionButtonSize(box, s);
    } else if (screenId === "camera" && itemId === "startBtn") {
      next = lockKioskStartButtonSize(box, s);
    } else {
      const native = kioskItemDef(screenId, itemId)?.box ?? box;
      next = { ...box, w: native.w * s, h: native.h * s };
    }
    return clampBox({
      x: cx - next.w / 2,
      y: cy - next.h / 2,
      w: next.w,
      h: next.h,
    });
  }

  function updateKioskButton(
    screenId: KioskScreenId,
    itemId: string,
    patch: Partial<KioskButtonStyle>,
  ) {
    const layout = ensureKioskLayout(screenId);
    const current = layout.buttons[itemId];
    if (!current) return;
    const { variant, fallback } = kioskButtonMeta(screenId, itemId);
    setKioskLayout(screenId, {
      ...layout,
      buttons: {
        ...layout.buttons,
        [itemId]: parseKioskButtonStyle(
          { ...current, ...patch },
          fallback,
          variant,
        ),
      },
    });
  }

  function setKioskButtonScale(
    screenId: KioskScreenId,
    itemId: string,
    scale: number,
  ) {
    const layout = ensureKioskLayout(screenId);
    const current = layout.buttons[itemId];
    const box = layout.items[itemId];
    if (!current || !box) return;
    const s = Math.min(1.5, Math.max(0.5, scale));
    const { variant, fallback } = kioskButtonMeta(screenId, itemId);
    setKioskLayout(screenId, {
      ...layout,
      items: {
        ...layout.items,
        [itemId]: sizedKioskButtonBox(screenId, itemId, box, s),
      },
      buttons: {
        ...layout.buttons,
        [itemId]: parseKioskButtonStyle(
          { ...current, scale: s },
          fallback,
          variant,
        ),
      },
    });
  }

  function resetKioskButton(screenId: KioskScreenId, itemId: string) {
    const layout = ensureKioskLayout(screenId);
    const current = layout.buttons[itemId];
    const box = layout.items[itemId];
    if (!current || !box) return;
    const { variant, fallback } = kioskButtonMeta(screenId, itemId);
    const next = defaultKioskButtonStyle(current.label || fallback, variant);
    setKioskLayout(screenId, {
      ...layout,
      items: {
        ...layout.items,
        [itemId]: sizedKioskButtonBox(screenId, itemId, box, next.scale),
      },
      buttons: {
        ...layout.buttons,
        [itemId]: next,
      },
    });
  }

  function sendKioskLayer(
    screenId: KioskScreenId,
    id: string,
    dir: "back" | "front" | "backward" | "forward",
  ) {
    const layout = ensureKioskLayout(screenId);
    setKioskLayout(screenId, {
      ...layout,
      order: moveLayerOrder(layout.order, id, dir),
    });
  }

  function setKioskLayerOrder(screenId: KioskScreenId, order: string[]) {
    const layout = ensureKioskLayout(screenId);
    setKioskLayout(screenId, { ...layout, order });
  }

  function setKioskBackgroundFill(
    screenId: KioskScreenId,
    fill: KioskBackgroundFill,
  ) {
    const layout = ensureKioskLayout(screenId);
    setKioskLayout(screenId, { ...layout, backgroundFill: fill });
  }

  function setKioskBackgroundColor(screenId: KioskScreenId, raw: string) {
    const t = raw.trim().replace(/^#/, "");
    let color = "";
    if (/^[0-9a-fA-F]{3}$/.test(t)) {
      color = `#${t[0]}${t[0]}${t[1]}${t[1]}${t[2]}${t[2]}`.toLowerCase();
    } else if (/^[0-9a-fA-F]{6}$/.test(t)) {
      color = `#${t.toLowerCase()}`;
    } else return;
    const layout = ensureKioskLayout(screenId);
    setKioskLayout(screenId, { ...layout, backgroundColor: color });
  }

  const DEFAULT_WELCOME_BG_COLOR = "#f4ead5";
  const welcomeBackgroundColor = ref(DEFAULT_WELCOME_BG_COLOR);
  const welcomeBackgroundFill = ref<WelcomeBackgroundFill>("media");

  function normalizeHexColor(raw: string): string | null {
    const t = raw.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(t)) {
      return `#${t[0]}${t[0]}${t[1]}${t[1]}${t[2]}${t[2]}`.toLowerCase();
    }
    if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`;
    return null;
  }

  function loadWelcomeBackgroundFill() {
    const color = normalizeHexColor(
      localStorage.getItem(STORAGE_KEY_WELCOME_BG_COLOR) || "",
    );
    if (color) welcomeBackgroundColor.value = color;
    const fill = localStorage.getItem(STORAGE_KEY_WELCOME_BG_FILL);
    if (fill === "color" || fill === "media") welcomeBackgroundFill.value = fill;
  }

  function setWelcomeBackgroundColor(raw: string) {
    const color = normalizeHexColor(raw);
    if (!color) return;
    welcomeBackgroundColor.value = color;
    localStorage.setItem(STORAGE_KEY_WELCOME_BG_COLOR, color);
  }

  function setWelcomeBackgroundFill(fill: WelcomeBackgroundFill) {
    welcomeBackgroundFill.value = fill;
    localStorage.setItem(STORAGE_KEY_WELCOME_BG_FILL, fill);
  }
  const titleBackgroundType = ref<TitleBackgroundType>(null);
  const titleBackgroundUrl = ref<string | null>(null);

  // The client's own animated backgrounds (frame + corner ornaments +
  // film strips, 1920x1080, supplied per screen). These ship as the
  // DEFAULTS — their fix for the "compressed / mali orientation" strips,
  // since the video replaces the CSS strips with their own artwork.
  // An operator upload overrides them; "Clear" returns to these.
  //
  // The two differ deliberately: the title strips run PARALLEL, the
  // payment strips are MIRRORED into a V. That matches their Figma
  // export, so don't "unify" them.
  const DEFAULT_TITLE_BG_URL = `${import.meta.env.BASE_URL}backgrounds/default-title-background.mp4`;
  const DEFAULT_PAYMENT_BG_URL = `${import.meta.env.BASE_URL}backgrounds/default-payment-background.mp4`;
  const packagedTitleUrl = ref<string | null>(null);
  const packagedPaymentUrl = ref<string | null>(null);

  /** What the title screen should actually render. */
  const effectiveTitleBackgroundUrl = computed(
    () => titleBackgroundUrl.value || packagedTitleUrl.value || DEFAULT_TITLE_BG_URL,
  );
  const effectiveTitleBackgroundType = computed<TitleBackgroundType>(
    () => (titleBackgroundUrl.value ? titleBackgroundType.value : "video"),
  );
  const customDisplayFontUrl = ref<string | null>(null);
  const customBodyFontUrl = ref<string | null>(null);
  const filters = ref<CameraFilter[]>([]);
  const cameraFrameStyle = ref<CameraFrameStyle>("wooden");
  const cameraFrameColor = ref<string>("#8B7355");
  const cameraFrameSvgUrl = ref<string | null>(null);
  const selectedPrinterName = ref<string>("");
  const printCopies = ref<number>(1);
  const printCutMode = ref<PrintCutMode>("standard");

  const activeFilters = computed(() =>
    filters.value
      .filter((f) => f.isActive)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  function loadCustomize() {
    try {
      const logo = localStorage.getItem(STORAGE_KEY_LOGO);
      if (logo) customLogoUrl.value = logo;
      const startBtn = localStorage.getItem(STORAGE_KEY_START_BTN);
      if (startBtn) customStartButtonUrl.value = startBtn;
      loadStartButtonStyle();
      const payQr = localStorage.getItem(STORAGE_KEY_PAYMENT_QR);
      if (payQr) paymentQrUrl.value = payQr;
      const bgType = localStorage.getItem(STORAGE_KEY_BG_TYPE);
      if (bgType === "image" || bgType === "video")
        titleBackgroundType.value = bgType;
      const bgUrl = localStorage.getItem(STORAGE_KEY_BG_URL);
      if (bgUrl) titleBackgroundUrl.value = bgUrl;
      const filtersRaw = localStorage.getItem(STORAGE_KEY_FILTERS);
      if (filtersRaw) {
        try {
          const stored = JSON.parse(filtersRaw) as CameraFilter[];
          const storedByDefaultId = new Map(
            stored.filter((f) => isDefaultFilter(f.id)).map((f) => [f.id, f]),
          );
          // Built-in presets are code constants, so name/effectType/cubeData/
          // baseFilter always come from DEFAULT_FILTERS — that way a shipped
          // preset can be corrected in a release without a stale saved copy
          // overriding it. But the OPERATOR-EDITABLE fields have to survive a
          // restart. Only `isActive` used to, which silently threw away the
          // grain toggle (and would have thrown away every overlay) on the
          // built-in filters the moment the app was reopened.
          const mergedDefaults = DEFAULT_FILTERS.map((d) => {
            const saved = storedByDefaultId.get(d.id);
            if (!saved) return d;
            const merged: CameraFilter = { ...d, isActive: saved.isActive };
            if (saved.grainEnabled !== undefined) {
              merged.grainEnabled = saved.grainEnabled;
            }
            if (saved.overlay) merged.overlay = saved.overlay;
            if (saved.mediaOverlay) merged.mediaOverlay = saved.mediaOverlay;
            if (saved.adjustments) merged.adjustments = clampAdjustments(saved.adjustments);
            return merged;
          });
          const custom = stored.filter((f) => !isDefaultFilter(f.id));
          filters.value = [...mergedDefaults, ...custom];
        } catch {
          filters.value = [...DEFAULT_FILTERS];
          saveFilters();
        }
      } else {
        filters.value = [...DEFAULT_FILTERS];
        saveFilters();
      }
      const displayFont = localStorage.getItem(STORAGE_KEY_DISPLAY_FONT);
      if (displayFont) customDisplayFontUrl.value = displayFont;
      const bodyFont = localStorage.getItem(STORAGE_KEY_BODY_FONT);
      if (bodyFont) customBodyFontUrl.value = bodyFont;
      const frameStyle = localStorage.getItem(STORAGE_KEY_CAMERA_FRAME_STYLE);
      if (
        frameStyle === "wooden" ||
        frameStyle === "blur" ||
        frameStyle === "color" ||
        frameStyle === "svg" ||
        frameStyle === "none"
      )
        cameraFrameStyle.value = frameStyle;
      const frameColor = localStorage.getItem(STORAGE_KEY_CAMERA_FRAME_COLOR);
      if (frameColor) cameraFrameColor.value = frameColor;
      const frameSvg = localStorage.getItem(STORAGE_KEY_CAMERA_FRAME_SVG);
      if (frameSvg) cameraFrameSvgUrl.value = frameSvg;
      const printerName = localStorage.getItem(STORAGE_KEY_PRINTER_NAME);
      if (printerName !== null) selectedPrinterName.value = printerName;
      const copies = localStorage.getItem(STORAGE_KEY_PRINT_COPIES);
      if (copies !== null) {
        const n = parseInt(copies, 10);
        if (!isNaN(n) && n >= 1 && n <= 10) printCopies.value = n;
      }
      const cutMode = localStorage.getItem(STORAGE_KEY_PRINT_CUT_MODE);
      if (cutMode === "standard" || cutMode === "dnp-2-inch-cut") {
        printCutMode.value = cutMode;
      }
    } catch (e) {
      console.error("Failed to load customize settings:", e);
    }
  }

  function setSelectedPrinter(name: string) {
    selectedPrinterName.value = name;
    localStorage.setItem(STORAGE_KEY_PRINTER_NAME, name);
  }

  function setPrintCopies(n: number) {
    const clamped = Math.max(1, Math.min(10, n));
    printCopies.value = clamped;
    localStorage.setItem(STORAGE_KEY_PRINT_COPIES, String(clamped));
  }

  function setPrintCutMode(mode: PrintCutMode) {
    const next: PrintCutMode =
      mode === "dnp-2-inch-cut" ? "dnp-2-inch-cut" : "standard";
    printCutMode.value = next;
    localStorage.setItem(STORAGE_KEY_PRINT_CUT_MODE, next);
  }

  function setCameraFrameStyle(style: CameraFrameStyle) {
    const valid: CameraFrameStyle[] = [
      "wooden",
      "blur",
      "color",
      "svg",
      "none",
    ];
    const next = valid.includes(style) ? style : "wooden";
    cameraFrameStyle.value = next;
    localStorage.setItem(STORAGE_KEY_CAMERA_FRAME_STYLE, next);
  }
  function setCameraFrameColor(color: string) {
    cameraFrameColor.value = color;
    localStorage.setItem(STORAGE_KEY_CAMERA_FRAME_COLOR, color);
  }
  function setCameraFrameSvgUrl(url: string | null) {
    cameraFrameSvgUrl.value = url;
    if (url) localStorage.setItem(STORAGE_KEY_CAMERA_FRAME_SVG, url);
    else localStorage.removeItem(STORAGE_KEY_CAMERA_FRAME_SVG);
  }

  function setCustomLogo(dataUrl: string) {
    customLogoUrl.value = dataUrl;
    localStorage.setItem(STORAGE_KEY_LOGO, dataUrl);
  }
  function clearCustomLogo() {
    customLogoUrl.value = null;
    localStorage.removeItem(STORAGE_KEY_LOGO);
  }
  function setCustomStartButton(dataUrl: string) {
    customStartButtonUrl.value = dataUrl;
    localStorage.setItem(STORAGE_KEY_START_BTN, dataUrl);
  }
  function clearCustomStartButton() {
    customStartButtonUrl.value = null;
    localStorage.removeItem(STORAGE_KEY_START_BTN);
  }
  function setPaymentQr(dataUrl: string) {
    paymentQrUrl.value = dataUrl;
    try {
      localStorage.setItem(STORAGE_KEY_PAYMENT_QR, dataUrl);
    } catch (err) {
      // A phone-screenshot QR can be several MB as a base64 data URL and
      // push the origin over quota, which would otherwise also break
      // recentStrips persistence. Keep it in memory for this session and
      // tell the operator to upload a smaller crop.
      console.error(
        "[Store] Payment QR too large to persist — use a tighter crop / smaller image:",
        err,
      );
    }
  }
  function clearPaymentQr() {
    paymentQrUrl.value = null;
    localStorage.removeItem(STORAGE_KEY_PAYMENT_QR);
  }
  /**
   * Points titleBackgroundUrl at a blob: object URL, revoking whatever
   * it pointed at before so we don't leak.
   *
   * Video MUST go through a blob: URL, not a data: URL — the CSP's
   * media-src allows only 'self' and blob:, so a data: video is blocked
   * outright, and Chromium won't play a large data-URL video anyway
   * (no range requests, no seeking).
   */
  let titleBgObjectUrl: string | null = null;
  function setTitleBackgroundBlob(type: TitleBackgroundType, blob: Blob) {
    if (titleBgObjectUrl) URL.revokeObjectURL(titleBgObjectUrl);
    titleBgObjectUrl = URL.createObjectURL(blob);
    titleBackgroundType.value = type;
    titleBackgroundUrl.value = titleBgObjectUrl;
  }

  // ---- Payment screen background (same mechanism, different slot) ----
  // Lets the client drop in their own animated MP4 for the Payment
  // screen instead of relying on the CSS film strips.
  const paymentBackgroundType = ref<TitleBackgroundType>(null);
  const paymentBackgroundUrl = ref<string | null>(null);
  let paymentBgObjectUrl: string | null = null;

  /** The payment screen's own default (mirrored strips) unless uploaded. */
  const effectivePaymentBackgroundUrl = computed(
    () => paymentBackgroundUrl.value || packagedPaymentUrl.value || DEFAULT_PAYMENT_BG_URL,
  );
  const effectivePaymentBackgroundType = computed<TitleBackgroundType>(
    () => (paymentBackgroundUrl.value ? paymentBackgroundType.value : "video"),
  );

  function setPaymentBackgroundBlob(type: TitleBackgroundType, blob: Blob) {
    if (paymentBgObjectUrl) URL.revokeObjectURL(paymentBgObjectUrl);
    paymentBgObjectUrl = URL.createObjectURL(blob);
    paymentBackgroundType.value = type;
    paymentBackgroundUrl.value = paymentBgObjectUrl;
  }

  async function setPaymentBackgroundFile(type: TitleBackgroundType, file: File) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || (type === "video" ? "video/mp4" : "image/jpeg");
    setPaymentBackgroundBlob(type, new Blob([buf], { type: mime }));
    if (window.electronAPI?.saveTitleBackgroundBytes) {
      const res = await window.electronAPI.saveTitleBackgroundBytes({
        bytes: buf,
        mime,
        slot: "payment",
      });
      if (!res.success) {
        console.error("[Store] Failed to save payment background:", res.error);
      }
      return res.success;
    }
    console.warn("[Store] Payment background can't persist outside Electron — preview only.");
    return true;
  }

  function clearPaymentBackground() {
    if (paymentBgObjectUrl) URL.revokeObjectURL(paymentBgObjectUrl);
    paymentBgObjectUrl = null;
    paymentBackgroundType.value = null;
    paymentBackgroundUrl.value = null;
    void window.electronAPI?.clearTitleBackground?.("payment");
  }

  async function loadPaymentBackgroundFromDisk() {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.getTitleBackground("payment");
      if (result.success && result.bytes && result.mediaType) {
        setPaymentBackgroundBlob(
          result.mediaType,
          blobFromIpcBytes(
            result.bytes,
            result.mime || (result.mediaType === "video" ? "video/mp4" : "image/jpeg"),
          ),
        );
      } else if (!packagedPaymentUrl.value) {
        packagedPaymentUrl.value = await loadPackagedBackground("payment");
      }
    } catch (e) {
      console.error("Failed to load payment background from disk:", e);
    }
  }

  type KioskBgSlot = { type: TitleBackgroundType; url: string | null };
  const kioskBgSlots = ref<Record<"templates" | "camera" | "printing" | "qr", KioskBgSlot>>({
    templates: { type: null, url: null },
    camera: { type: null, url: null },
    printing: { type: null, url: null },
    qr: { type: null, url: null },
  });
  const kioskBgObjectUrls: Partial<Record<KioskScreenId, string | null>> = {};

  function setKioskBackgroundBlob(
    id: Exclude<KioskScreenId, "payment">,
    type: TitleBackgroundType,
    blob: Blob,
  ) {
    const prev = kioskBgObjectUrls[id];
    if (prev) URL.revokeObjectURL(prev);
    const url = URL.createObjectURL(blob);
    kioskBgObjectUrls[id] = url;
    kioskBgSlots.value = {
      ...kioskBgSlots.value,
      [id]: { type, url },
    };
  }

  async function setKioskBackgroundFile(
    id: KioskScreenId,
    type: TitleBackgroundType,
    file: File,
  ) {
    setKioskBackgroundFill(id, "media");
    if (id === "payment") {
      return setPaymentBackgroundFile(type, file);
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || (type === "video" ? "video/mp4" : "image/jpeg");
    setKioskBackgroundBlob(id, type, new Blob([buf], { type: mime }));
    if (window.electronAPI?.saveTitleBackgroundBytes) {
      const res = await window.electronAPI.saveTitleBackgroundBytes({
        bytes: buf,
        mime,
        slot: id,
      });
      if (!res.success) {
        console.error(`[Store] Failed to save ${id} background:`, res.error);
      }
      return res.success;
    }
    return true;
  }

  function clearKioskBackground(id: KioskScreenId) {
    if (id === "payment") {
      clearPaymentBackground();
      return;
    }
    const prev = kioskBgObjectUrls[id];
    if (prev) URL.revokeObjectURL(prev);
    kioskBgObjectUrls[id] = null;
    kioskBgSlots.value = {
      ...kioskBgSlots.value,
      [id]: { type: null, url: null },
    };
    void window.electronAPI?.clearTitleBackground?.(id);
  }

  async function loadKioskBackgroundsFromDisk() {
    if (!window.electronAPI) return;
    for (const id of ["templates", "camera", "printing", "qr"] as const) {
      try {
        const result = await window.electronAPI.getTitleBackground(id);
        if (result.success && result.bytes && result.mediaType) {
          setKioskBackgroundBlob(
            id,
            result.mediaType,
            blobFromIpcBytes(
              result.bytes,
              result.mime ||
                (result.mediaType === "video" ? "video/mp4" : "image/jpeg"),
            ),
          );
        }
      } catch (e) {
        console.error(`Failed to load ${id} background from disk:`, e);
      }
    }
  }

  function kioskBackgroundUrl(id: KioskScreenId): string | null {
    if (id === "payment") return effectivePaymentBackgroundUrl.value;
    return kioskBgSlots.value[id]?.url || effectiveTitleBackgroundUrl.value;
  }

  function kioskBackgroundType(id: KioskScreenId): TitleBackgroundType {
    if (id === "payment") return effectivePaymentBackgroundType.value;
    return kioskBgSlots.value[id]?.url
      ? kioskBgSlots.value[id]!.type
      : effectiveTitleBackgroundType.value;
  }

  /** Theme fill: booth default (Welcome/Payment video), ignoring this screen's upload. */
  function kioskThemeBackgroundUrl(id: KioskScreenId): string | null {
    if (id === "payment") return effectivePaymentBackgroundUrl.value;
    return effectiveTitleBackgroundUrl.value;
  }

  function kioskThemeBackgroundType(id: KioskScreenId): TitleBackgroundType {
    if (id === "payment") return effectivePaymentBackgroundType.value;
    return effectiveTitleBackgroundType.value;
  }

  function kioskHasCustomBackground(id: KioskScreenId): boolean {
    if (id === "payment") return !!paymentBackgroundUrl.value;
    return !!kioskBgSlots.value[id]?.url;
  }

  /**
   * Upload entry point for the admin panel. Takes the File straight from
   * the picker so a multi-MB MP4 never has to be turned into a base64
   * string in the renderer.
   */
  async function setTitleBackgroundFile(type: TitleBackgroundType, file: File) {
    setWelcomeBackgroundFill("media");
    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || (type === "video" ? "video/mp4" : "image/jpeg");
    setTitleBackgroundBlob(type, new Blob([buf], { type: mime }));

    if (window.electronAPI?.saveTitleBackgroundBytes) {
      localStorage.removeItem(STORAGE_KEY_BG_TYPE);
      localStorage.removeItem(STORAGE_KEY_BG_URL);
      const res = await window.electronAPI.saveTitleBackgroundBytes({ bytes: buf, mime });
      if (!res.success) {
        console.error("[Store] Failed to save title background to disk:", res.error);
      }
      return res.success;
    }

    // Plain-browser dev preview (no Electron): only images are small
    // enough for localStorage. A video previews for this session but
    // can't persist — that's a dev-only limitation, not the kiosk path.
    if (type === "image") {
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(file);
      });
      localStorage.setItem(STORAGE_KEY_BG_TYPE, "image");
      try {
        localStorage.setItem(STORAGE_KEY_BG_URL, dataUrl);
      } catch (e) {
        console.error("[Store] Title background too large for localStorage:", e);
      }
    } else {
      console.warn(
        "[Store] Video title background can't persist outside Electron — preview only.",
      );
    }
    return true;
  }

  function setTitleBackground(type: TitleBackgroundType, dataUrl: string) {
    titleBackgroundType.value = type;
    titleBackgroundUrl.value = dataUrl;
    if (window.electronAPI) {
      // Persisted to disk (userData), not localStorage — a video
      // background can be tens of MB as base64, well past localStorage's
      // quota. The type is inferred back from the file extension on
      // load, so no separate type key needs to be written here.
      localStorage.removeItem(STORAGE_KEY_BG_TYPE);
      localStorage.removeItem(STORAGE_KEY_BG_URL);
      window.electronAPI.saveTitleBackground(dataUrl).catch((e) => {
        console.error("Failed to save title background to disk:", e);
      });
    } else {
      // Plain-browser dev preview (no Electron) — localStorage is the
      // only option available; images are usually small enough.
      localStorage.setItem(STORAGE_KEY_BG_TYPE, type ?? "");
      try {
        localStorage.setItem(STORAGE_KEY_BG_URL, dataUrl);
      } catch (e) {
        console.error("Failed to persist title background (likely too large for localStorage):", e);
      }
    }
  }
  function clearTitleBackground() {
    titleBackgroundType.value = null;
    titleBackgroundUrl.value = null;
    localStorage.removeItem(STORAGE_KEY_BG_TYPE);
    localStorage.removeItem(STORAGE_KEY_BG_URL);
    if (window.electronAPI) {
      window.electronAPI.clearTitleBackground().catch((e) => {
        console.error("Failed to clear title background on disk:", e);
      });
    }
  }
  /**
   * Loads the title background from disk (Electron only) — called
   * separately from loadCustomize() because it's async. Falls back to
   * whatever loadCustomize() already read from localStorage when
   * running without Electron (plain-browser dev preview).
   */
  async function loadPackagedBackground(
    slot: "title" | "payment",
  ): Promise<string | null> {
    const api = window.electronAPI;
    if (!api?.getPackagedBackground) return null;
    try {
      const result = await api.getPackagedBackground(slot);
      if (!result.success || !result.bytes || !result.bytes.byteLength) return null;
      const blob = blobFromIpcBytes(result.bytes, result.mime || "video/mp4");
      return URL.createObjectURL(blob);
    } catch (e) {
      console.warn(`[Store] Packaged ${slot} background missing:`, e);
      return null;
    }
  }

  async function loadTitleBackgroundFromDisk() {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.getTitleBackground();
      if (result.success && result.bytes && result.mediaType) {
        const blob = blobFromIpcBytes(
          result.bytes,
          result.mime || (result.mediaType === "video" ? "video/mp4" : "image/jpeg"),
        );
        setTitleBackgroundBlob(result.mediaType, blob);
      } else if (!packagedTitleUrl.value) {
        packagedTitleUrl.value = await loadPackagedBackground("title");
      }
    } catch (e) {
      console.error("Failed to load title background from disk:", e);
    }
  }
  function setCustomDisplayFont(dataUrl: string) {
    customDisplayFontUrl.value = dataUrl;
    localStorage.setItem(STORAGE_KEY_DISPLAY_FONT, dataUrl);
  }
  function clearCustomDisplayFont() {
    customDisplayFontUrl.value = null;
    localStorage.removeItem(STORAGE_KEY_DISPLAY_FONT);
  }
  function setCustomBodyFont(dataUrl: string) {
    customBodyFontUrl.value = dataUrl;
    localStorage.setItem(STORAGE_KEY_BODY_FONT, dataUrl);
  }
  function clearCustomBodyFont() {
    customBodyFontUrl.value = null;
    localStorage.removeItem(STORAGE_KEY_BODY_FONT);
  }

  // ---- Filters ----
  function saveFilters() {
    try {
      localStorage.setItem(STORAGE_KEY_FILTERS, JSON.stringify(filters.value));
    } catch (e) {
      console.error("Failed to save filters:", e);
    }
  }

  function addFilter(
    name: string,
    cubeData: string,
    isActive = true,
  ): CameraFilter | null {
    const trimmedName = name.trim() || "Custom LUT";
    const id = `cube-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const filter: CameraFilter = {
      id,
      name: trimmedName,
      effectType: "cube",
      isActive,
      cubeData,
    };
    filters.value.push(filter);
    saveFilters();
    return filter;
  }
  function removeFilter(id: string) {
    if (isDefaultFilter(id)) return;
    filters.value = filters.value.filter((f) => f.id !== id);
    saveFilters();
    void clearFilterMediaOverlay(id);
  }
  function toggleFilterActive(id: string) {
    const f = filters.value.find((x) => x.id === id);
    if (f) {
      f.isActive = !f.isActive;
      saveFilters();
    }
  }
  function updateFilterName(id: string, name: string) {
    const f = filters.value.find((x) => x.id === id);
    if (f) {
      const fallback = f.effectType === "cube" ? "Custom LUT" : f.effectType;
      f.name = name.trim() || fallback;
      saveFilters();
    }
  }
  function setFilterGrain(id: string, enabled: boolean) {
    const f = filters.value.find((x) => x.id === id);
    if (f) {
      f.grainEnabled = enabled;
      const current = resolvedAdjustments(f);
      f.adjustments = clampAdjustments({
        ...current,
        grain: enabled ? (current.grain > 0 ? current.grain : 100) : 0,
      });
      saveFilters();
    }
  }

  /** Default wash for a filter the operator has just switched overlay on for. */
  const DEFAULT_OVERLAY: FilterOverlay = {
    color: "#c9a227",
    blendMode: "overlay",
    opacity: 0.35,
  };

  /**
   * Sets (or clears, with null) the colour wash for a filter. The same object
   * drives the live preview and the capture, so there is one definition of
   * the look rather than two that can drift apart.
   */
  function setFilterOverlay(id: string, overlay: FilterOverlay | null) {
    const f = filters.value.find((x) => x.id === id);
    if (!f) return;
    if (overlay) {
      f.overlay = {
        color: overlay.color,
        blendMode: overlay.blendMode,
        opacity: Math.max(0, Math.min(1, overlay.opacity)),
      };
    } else {
      delete f.overlay;
    }
    saveFilters();
  }

  /** Default layer settings when the operator first drops a PNG/MOV onto a filter. */
  const DEFAULT_MEDIA_OVERLAY: Pick<FilterMediaOverlay, "blendMode" | "opacity"> = {
    blendMode: "normal",
    opacity: 1,
  };

  type OverlayMediaRuntime = { url: string; type: OverlayMediaKind };
  const overlayMediaRuntime = ref<Record<string, OverlayMediaRuntime>>({});
  const overlayMediaObjectUrls = new Map<string, string>();

  function overlayMediaFor(filterId: string): OverlayMediaRuntime | null {
    return overlayMediaRuntime.value[filterId] ?? null;
  }

  function setOverlayMediaRuntime(
    filterId: string,
    type: OverlayMediaKind,
    blob: Blob,
  ) {
    const prev = overlayMediaObjectUrls.get(filterId);
    if (prev) URL.revokeObjectURL(prev);
    const url = URL.createObjectURL(blob);
    overlayMediaObjectUrls.set(filterId, url);
    overlayMediaRuntime.value = {
      ...overlayMediaRuntime.value,
      [filterId]: { url, type },
    };
  }

  function dropOverlayMediaRuntime(filterId: string) {
    const prev = overlayMediaObjectUrls.get(filterId);
    if (prev) URL.revokeObjectURL(prev);
    overlayMediaObjectUrls.delete(filterId);
    if (!(filterId in overlayMediaRuntime.value)) return;
    const next = { ...overlayMediaRuntime.value };
    delete next[filterId];
    overlayMediaRuntime.value = next;
  }

  function clampOverlayOpacity(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  function sanitizeMediaOverlay(
    raw: Partial<FilterMediaOverlay> &
      Pick<FilterMediaOverlay, "mediaType" | "mediaName">,
  ): FilterMediaOverlay {
    return {
      blendMode: isBlendMode(raw.blendMode)
        ? raw.blendMode
        : DEFAULT_MEDIA_OVERLAY.blendMode,
      opacity: clampOverlayOpacity(
        typeof raw.opacity === "number"
          ? raw.opacity
          : DEFAULT_MEDIA_OVERLAY.opacity,
      ),
      mediaType: raw.mediaType === "video" ? "video" : "image",
      mediaName: raw.mediaName.trim() || "overlay",
    };
  }

  function setFilterMediaOverlay(id: string, overlay: FilterMediaOverlay | null) {
    const f = filters.value.find((x) => x.id === id);
    if (!f) return;
    if (overlay) {
      f.mediaOverlay = sanitizeMediaOverlay(overlay);
    } else {
      delete f.mediaOverlay;
      dropOverlayMediaRuntime(id);
    }
    saveFilters();
  }

  function guessOverlayMediaKind(file: File): OverlayMediaKind | null {
    const name = file.name || "";
    if (
      file.type.startsWith("video/") ||
      /\.(mp4|webm|ogg|ogv|mov|m4v)$/i.test(name)
    ) {
      return "video";
    }
    if (
      file.type.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif)$/i.test(name)
    ) {
      return "image";
    }
    return null;
  }

  function overlayMimeFor(file: File, kind: OverlayMediaKind): string {
    if (file.type) {
      if (file.type === "video/quicktime") return "video/mp4";
      return file.type;
    }
    if (kind === "video") {
      if (/\.webm$/i.test(file.name)) return "video/webm";
      return "video/mp4";
    }
    if (/\.png$/i.test(file.name)) return "image/png";
    if (/\.webp$/i.test(file.name)) return "image/webp";
    if (/\.gif$/i.test(file.name)) return "image/gif";
    return "image/jpeg";
  }

  function overlayPlaybackMime(file: File, kind: OverlayMediaKind): string {
    if (kind === "video") {
      if (/\.webm$/i.test(file.name) || file.type === "video/webm") {
        return "video/webm";
      }
      // Chromium on Windows will not decode a blob tagged video/quicktime,
      // even when the MOV is H.264. Tag MP4/MOV/M4V as video/mp4.
      return "video/mp4";
    }
    return overlayMimeFor(file, kind);
  }

  /**
   * Upload a PNG/JPEG/MOV (etc.) as the Photoshop-style media layer for a
   * filter. The file is persisted under userData in Electron; the renderer
   * only keeps a blob: URL (CSP media-src cannot play a data: video).
   */
  async function setFilterMediaOverlayFile(
    id: string,
    file: File,
  ): Promise<boolean> {
    const f = filters.value.find((x) => x.id === id);
    if (!f) return false;
    const kind = guessOverlayMediaKind(file);
    if (!kind) return false;
    const mime = overlayPlaybackMime(file, kind);
    const buf = new Uint8Array(await file.arrayBuffer());
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    setOverlayMediaRuntime(id, kind, new Blob([copy], { type: mime }));
    f.mediaOverlay = sanitizeMediaOverlay({
      blendMode: f.mediaOverlay?.blendMode ?? DEFAULT_MEDIA_OVERLAY.blendMode,
      opacity: f.mediaOverlay?.opacity ?? DEFAULT_MEDIA_OVERLAY.opacity,
      mediaType: kind,
      mediaName: file.name,
    });
    saveFilters();

    if (window.electronAPI?.saveFilterOverlayMedia) {
      const res = await window.electronAPI.saveFilterOverlayMedia({
        filterId: id,
        bytes: copy,
        mime,
        filename: file.name,
      });
      if (!res.success) {
        console.error("[Store] Failed to save filter overlay media:", res.error);
        return false;
      }
    } else {
      console.warn(
        "[Store] Filter overlay media can't persist outside Electron — preview only.",
      );
    }
    return true;
  }

  async function clearFilterMediaOverlay(id: string) {
    const f = filters.value.find((x) => x.id === id);
    if (f) delete f.mediaOverlay;
    dropOverlayMediaRuntime(id);
    saveFilters();
    if (window.electronAPI?.clearFilterOverlayMedia) {
      try {
        await window.electronAPI.clearFilterOverlayMedia(id);
      } catch (e) {
        console.error("[Store] Failed to clear filter overlay media:", e);
      }
    }
  }

  async function loadFilterOverlayMediaFromDisk() {
    if (!window.electronAPI?.getFilterOverlayMedia) return;
    for (const f of filters.value) {
      if (!f.mediaOverlay) continue;
      try {
        const result = await window.electronAPI.getFilterOverlayMedia(f.id);
        if (result.success && result.bytes && result.mediaType) {
          const mime =
            result.mime ||
            (result.mediaType === "video" ? "video/mp4" : "image/png");
          setOverlayMediaRuntime(
            f.id,
            result.mediaType,
            blobFromIpcBytes(result.bytes, mime),
          );
        }
      } catch (e) {
        console.error("[Store] Failed to load filter overlay media:", f.id, e);
      }
    }
  }

  /**
   * Whether film grain should be applied for a given filter — reads the
   * explicit per-filter toggle when set, otherwise falls back to the
   * legacy rule (grain on for sepia/bw/fujifilm, and cube filters based
   * on sepia) so filters created before this setting existed keep their
   * current look.
   */
  function filterWantsGrain(filter: CameraFilter): boolean {
    if (filter.grainEnabled !== undefined) return filter.grainEnabled;
    return (
      filter.effectType === "sepia" ||
      filter.effectType === "bw" ||
      filter.effectType === "fujifilm" ||
      (filter.effectType === "cube" && filter.baseFilter === "sepia")
    );
  }

  function clampAdjustments(raw: Partial<FilterAdjustments>): FilterAdjustments {
    const n = (v: unknown, min: number, max: number, fallback: number) => {
      const x = typeof v === "number" && Number.isFinite(v) ? v : fallback;
      return Math.max(min, Math.min(max, Math.round(x)));
    };
    const n2 = (v: unknown, min: number, max: number, fallback: number) => {
      const x = typeof v === "number" && Number.isFinite(v) ? v : fallback;
      return Math.max(min, Math.min(max, Math.round(x * 100) / 100));
    };
    return {
      grain: n(raw.grain, 0, 100, 0),
      exposure: n2(raw.exposure, -4, 4, 0),
      levels: n(raw.levels, -100, 100, 0),
      contrast: n(raw.contrast, -100, 100, 0),
      shadows: n(raw.shadows, -100, 100, 0),
      vignette: n(raw.vignette, -100, 100, 0),
      saturation: n(raw.saturation, -100, 100, 0),
      glow: n(raw.glow, 0, 100, 0),
    };
  }

  /** Resolved sliders for a filter, including grain fallback from the toggle. */
  function resolvedAdjustments(filter: CameraFilter): FilterAdjustments {
    const a = filter.adjustments;
    return clampAdjustments({
      grain: a?.grain ?? (filterWantsGrain(filter) ? 100 : 0),
      exposure: a?.exposure ?? 0,
      levels: a?.levels ?? 0,
      contrast: a?.contrast ?? 0,
      shadows: a?.shadows ?? 0,
      vignette: a?.vignette ?? 0,
      saturation: a?.saturation ?? 0,
      glow: a?.glow ?? 0,
    });
  }

  function filterGrainAmount(filter: CameraFilter): number {
    return resolvedAdjustments(filter).grain;
  }

  function setFilterAdjustments(id: string, patch: Partial<FilterAdjustments>) {
    const f = filters.value.find((x) => x.id === id);
    if (!f) return;
    const next = clampAdjustments({ ...resolvedAdjustments(f), ...patch });
    f.adjustments = next;
    f.grainEnabled = next.grain > 0;
    saveFilters();
  }

  // ---- Template actions ----
  /** Next ascending template number (template_1, template_2, ...). */
  function nextTemplateId(): string {
    const existing = customTemplates.value;
    let max = 0;
    for (const t of existing) {
      const m = /^template_(\d+)$/.exec(t.id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `template_${max + 1}`;
  }

  function addTemplate(data: Omit<Template, "id">): Template {
    const template: Template = {
      ...data,
      id: nextTemplateId(),
      isActive: data.isActive !== false, // Default to active
    };
    customTemplates.value.push(template);
    saveCustomTemplates();
    return template;
  }

  /**
   * Update a template's name and/or how many photos the guest shoots.
   * Price lives on the dashboard store (setPricePerTemplate), not here.
   */
  function updateTemplateDetails(
    id: string,
    patch: { name?: string; photoCount?: number },
  ) {
    const name =
      patch.name !== undefined ? patch.name.trim() : undefined;
    let photoCount = patch.photoCount;
    if (photoCount !== undefined) {
      photoCount = Math.max(1, Math.floor(Number(photoCount) || 1));
    }
    if (!name && photoCount === undefined) return;

    if (isBuiltinTemplate(id)) {
      const current = templates.value.find((t) => t.id === id);
      if (!current) return;
      builtinTemplateOverrides.value = {
        ...builtinTemplateOverrides.value,
        [id]: {
          ...(builtinTemplateOverrides.value[id] ?? {}),
          ...(name ? { name } : {}),
          ...(photoCount !== undefined ? { photoCount } : {}),
        },
      };
      saveBuiltinTemplateOverrides();
    } else {
      const idx = customTemplates.value.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const t = { ...customTemplates.value[idx] };
      if (name) t.name = name;
      if (photoCount !== undefined) t.photoCount = photoCount;
      customTemplates.value[idx] = t;
      saveCustomTemplates();
    }

    if (selectedTemplate.value?.id === id) {
      const fresh = templates.value.find((t) => t.id === id);
      if (fresh) selectedTemplate.value = fresh;
    }
  }

  /**
   * Persist hand-placed photo slots from the layout editor. Works for
   * built-ins (written to the override map) and custom templates alike.
   * Passing null clears them, which reverts that template to the
   * auto-detected windows / grid it used before.
   */
  async function setTemplateCells(id: string, cells: TemplateCell[] | null) {
    if (isBuiltinTemplate(id)) {
      const next = { ...builtinTemplateOverrides.value };
      const existing = next[id] ?? {};
      if (cells) {
        next[id] = { ...existing, cells };
      } else {
        const { cells: _drop, ...rest } = existing;
        next[id] = rest;
      }
      builtinTemplateOverrides.value = next;
      await saveBuiltinTemplateOverrides();
    } else {
      const idx = customTemplates.value.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const t = { ...customTemplates.value[idx] };
      if (cells) t.cells = cells;
      else delete t.cells;
      customTemplates.value[idx] = t;
      await saveCustomTemplates();
    }
    // The live session may already hold a stale copy of this template.
    if (selectedTemplate.value?.id === id) {
      const fresh = templates.value.find((t) => t.id === id);
      if (fresh) selectedTemplate.value = fresh;
    }
  }

  function removeTemplate(id: string) {
    if (isBuiltinTemplate(id)) return; // built-ins cannot be deleted
    customTemplates.value = customTemplates.value.filter((t) => t.id !== id);
    saveCustomTemplates();
    if (selectedTemplate.value?.id === id) {
      selectedTemplate.value = null;
    }
  }

  function toggleTemplateActive(id: string) {
    if (isBuiltinTemplate(id)) {
      const current = templates.value.find((t) => t.id === id);
      const newActiveState = !(current?.isActive !== false);
      builtinTemplateOverrides.value = {
        ...builtinTemplateOverrides.value,
        [id]: {
          ...(builtinTemplateOverrides.value[id] ?? {}),
          isActive: newActiveState,
        },
      };
      saveBuiltinTemplateOverrides();
      return;
    }
    const templateIndex = customTemplates.value.findIndex((t) => t.id === id);
    if (templateIndex === -1) return;
    const template = customTemplates.value[templateIndex];
    const newActiveState = !(template.isActive !== false);
    customTemplates.value[templateIndex] = {
      ...template,
      isActive: newActiveState,
    };
    saveCustomTemplates();
  }

  function getTemplateActiveStatus(id: string): boolean {
    const template = templates.value.find((t) => t.id === id);
    return template ? template.isActive !== false : true;
  }

  // ---- Session actions ----
  function selectTemplate(template: Template) {
    selectedTemplate.value =
      templates.value.find((t) => t.id === template.id) ?? template;
    capturedPhotos.value = [];
    clearHighlightClips();
    currentPhotoIndex.value = 0;
  }

  function addPhoto(
    dataUrl: string,
    fullDataUrl?: string,
    originalDataUrl?: string,
  ) {
    const photo: CapturedPhoto = {
      id: `photo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      dataUrl,
      fullDataUrl: fullDataUrl || dataUrl,
      originalDataUrl,
      timestamp: new Date(),
    };
    capturedPhotos.value.push(photo);
    currentPhotoIndex.value = capturedPhotos.value.length;
  }

  function addHighlightClip(dataUrl: string) {
    if (dataUrl) highlightClips.value.push(dataUrl);
  }

  /**
   * Identifies the sitting currently being saved, so the QR screen can show
   * THIS guest's photos and nothing else.
   *
   * The QR screen used to encode `recentStrips[0]` — simply the newest strip
   * on the booth. That is only the current guest's once their upload has
   * finished. Tap Done while it is still uploading (or hit any path where
   * the save bails early) and the newest strip is still the PREVIOUS
   * customer's, so the new guest scanned a code and got a stranger's photos.
   * Scoping by session id makes that impossible: no match means no QR.
   */
  const currentQrSessionId = ref<string | null>(null);

  function beginQrSession(sessionId: string) {
    currentQrSessionId.value = sessionId;
  }

  function resetSession() {
    capturedPhotos.value = [];
    clearHighlightClips();
    currentPhotoIndex.value = 0;
    selectedTemplate.value = null;
    // Critical: clearing this is what stops the next guest inheriting this
    // guest's QR if anything goes wrong during their save.
    currentQrSessionId.value = null;
  }

  // ---- Reprint ----
  // The admin Gallery "Reprint" flow replays a past session through
  // the normal PrintingView composite+print path WITHOUT the live
  // side-effects (no re-save to Pictures, no Cloudinary upload, no
  // new recent-strip, no QR). It does that by loading the session's
  // captures + the template that was used into the session refs and
  // flipping `reprintMode`. PrintingView checks `reprintMode` in
  // onMounted and takes the side-effect-free path.
  const reprintMode = ref(false);
  const reprintCopies = ref(1);
  // Where PrintingView returns after a reprint completes. Admin Gallery
  // reprints go back to "/admin" (default); a customer "print more
  // copies" reprint returns to "/qr" so the guest lands back on their
  // QR/Done screen.
  const reprintReturnRoute = ref("/admin");

  function loadSessionForReprint(
    captures: Array<{ id?: string; dataUrl: string }>,
    templateId: string | undefined,
    copies: number,
  ): boolean {
    const tpl = templateId
      ? (templates.value.find((t) => t.id === templateId) ?? null)
      : null;
    // Without a template we can't rebuild the framed sheet — bail so
    // the caller can warn the operator instead of printing blank.
    if (!tpl) {
      console.warn(
        `[Reprint] template "${templateId}" not found — cannot reprint`,
      );
      return false;
    }
    if (captures.length === 0) {
      console.warn("[Reprint] no captures supplied — cannot reprint");
      return false;
    }
    selectedTemplate.value = tpl;
    capturedPhotos.value = captures.map((c, i) => ({
      id: c.id ?? `reprint_${Date.now()}_${i}`,
      dataUrl: c.dataUrl,
      fullDataUrl: c.dataUrl,
      timestamp: new Date(),
    }));
    currentPhotoIndex.value = capturedPhotos.value.length;
    reprintCopies.value = Math.max(
      1,
      Math.min(99, Math.floor(copies) || 1),
    );
    reprintMode.value = true;
    return true;
  }

  function clearReprintMode() {
    reprintMode.value = false;
    reprintCopies.value = 1;
    reprintReturnRoute.value = "/admin";
  }

  /**
   * Customer "print more copies" of the CURRENT session (captures +
   * template still loaded, i.e. before resetSession). Arms the same
   * reprint path the admin Gallery uses, but sends PrintingView back to
   * the QR screen afterward instead of the admin panel.
   */
  function reprintCurrentSession(copies: number): boolean {
    if (!selectedTemplate.value || capturedPhotos.value.length === 0) {
      return false;
    }
    reprintCopies.value = Math.max(1, Math.min(99, Math.floor(copies) || 1));
    reprintReturnRoute.value = "/qr";
    reprintMode.value = true;
    return true;
  }

  function setMirror(mirror: boolean) {
    mirrorMode.value = mirror;
  }

  // ---- Recent strips actions ----
  // localStorage writes are guarded: a QuotaExceededError must never
  // break the post-print flow (the in-memory list keeps working; only
  // persistence across restarts is lost for that write).
  function persistRecentStrips() {
    try {
      localStorage.setItem(
        RECENT_STRIPS_KEY,
        JSON.stringify(recentStrips.value),
      );
    } catch (e) {
      console.warn(
        "Failed to persist recent strips (likely storage quota):",
        e,
      );
    }
  }

  // Each SESSION writes photoCount + 1 entries (every capture plus the
  // composite), so 20 entries was only ~2 sessions on the 4x2 layout —
  // and once a session rotated out, its digital-copies link was gone for
  // good, which defeats the gallery's "re-show the QR" purpose.
  const MAX_RECENT_ENTRIES = 200;

  function addRecentStrip(strip: SavedPhotoStrip) {
    recentStrips.value.unshift(strip);
    if (recentStrips.value.length > MAX_RECENT_ENTRIES) {
      recentStrips.value = recentStrips.value.slice(0, MAX_RECENT_ENTRIES);
    }
    persistRecentStrips();
  }

  function patchRecentStripSession(
    sessionId: string,
    patch: Partial<
      Pick<
        SavedPhotoStrip,
        | "shareableUrl"
        | "uploadStatus"
        | "cloudinaryUrl"
        | "cloudinaryPublicId"
        | "cloudinaryPhotos"
      >
    >,
  ) {
    if (!sessionId) return;
    let changed = false;
    recentStrips.value = recentStrips.value.map((s) => {
      if (s.sessionId !== sessionId) return s;
      changed = true;
      return { ...s, ...patch };
    });
    if (changed) persistRecentStrips();
  }

  function removeRecentStrip(id: string) {
    recentStrips.value = recentStrips.value.filter((s) => s.id !== id);
    persistRecentStrips();
  }

  function loadRecentStrips() {
    const saved = localStorage.getItem(RECENT_STRIPS_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as SavedPhotoStrip[];
        // JSON round-trip turns Date fields into ISO strings —
        // rehydrate them so Intl.DateTimeFormat (admin gallery) and
        // any date math get real Date objects.
        recentStrips.value = parsed.map((s) => ({
          ...s,
          timestamp: new Date(s.timestamp),
        }));
      } catch (e) {
        console.error("Failed to load recent strips:", e);
      }
    }
  }

  // Fallback seeding ONLY: populate the film roll from disk when
  // localStorage had nothing (fresh install / cleared storage). It
  // must NOT overwrite entries restored by loadRecentStrips — those
  // carry the session metadata (sessionId/templateId/sessionIndex/
  // isComposite/shareableUrl) that admin Reprint and the QR screen
  // depend on; disk files are bare captures with none of it.
  async function loadSavedPhotos() {
    if (recentStrips.value.length > 0) return;
    // Respect an explicitly emptied gallery: if the storage key EXISTS
    // (even as "[]" — the operator deleted every strip), don't
    // resurrect photos from disk. Seed only when nothing was ever
    // persisted (fresh install / cleared storage / pre-persistence
    // build).
    if (localStorage.getItem(RECENT_STRIPS_KEY) !== null) return;
    if (window.electronAPI) {
      try {
        const photos = await window.electronAPI.listSavedPhotos();
        const strips: SavedPhotoStrip[] = [];

        for (const photo of photos.slice(0, 20)) {
          const dataUrl = await window.electronAPI.readPhoto(photo.path);
          if (dataUrl) {
            strips.push({
              id: photo.path,
              // Downscale like every other recentStrips entry — 20
              // full-res PNGs would exceed the localStorage quota on
              // the very next persist, silently breaking persistence
              // until the seeds rotate out. Full-res stays at `path`.
              dataUrl: await makePreviewDataUrl(dataUrl),
              timestamp: new Date(photo.created),
              path: photo.path,
            });
          }
        }

        recentStrips.value = strips;
      } catch (e) {
        console.error("Failed to load saved photos:", e);
      }
    }
  }

  loadCustomTemplates();
  loadCustomize();
  loadBuiltinTemplateOverrides();
  loadAdminPin();
  loadTimingSettings();
  loadCameraDetection();
  loadPaymentEnabled();
  loadScales();
  loadWelcomeLayout();
  loadWelcomeBackgroundFill();
  loadKioskLayouts();

  return {
    // -----------------------------
    // Templates State & Getters
    // -----------------------------
    templates,
    activeTemplates,
    customTemplates,
    selectedTemplate,
    sessionTemplate,

    // -----------------------------
    // Camera Options & Session
    // -----------------------------
    capturedPhotos,
    highlightClips,
    mirrorMode,
    cameraDetectionEnabled,
    setCameraDetectionEnabled,
    recentStrips,
    currentPhotoIndex,
    requiredPhotos,
    templateCellCount,
    templateCopies,
    hasAllPhotos,
    remainingPhotos,

    // -----------------------------
    // Customize (Logo, Title BG, Fonts, Filters)
    // -----------------------------
    customLogoUrl,
    customStartButtonUrl,
    startButtonStyle,
    paymentQrUrl,
    titleBackgroundType,
    titleBackgroundUrl,
    effectiveTitleBackgroundUrl,
    effectiveTitleBackgroundType,
    effectivePaymentBackgroundUrl,
    effectivePaymentBackgroundType,
    customDisplayFontUrl,
    customBodyFontUrl,
    filters,
    activeFilters,
    cameraFrameStyle,
    cameraFrameColor,
    cameraFrameSvgUrl,
    setCameraFrameStyle,
    setCameraFrameColor,
    setCameraFrameSvgUrl,

    // -----------------------------
    // Template Actions
    // -----------------------------
    addTemplate,
    updateTemplateDetails,
    removeTemplate,
    setTemplateCells,
    toggleTemplateActive,
    getTemplateActiveStatus,
    selectTemplate,
    isBuiltinTemplate,

    // -----------------------------
    // Session Actions
    // -----------------------------
    addPhoto,
    addHighlightClip,
    resetSession,
    setMirror,

    // -----------------------------
    // Reprint (admin Gallery)
    // -----------------------------
    reprintMode,
    reprintCopies,
    reprintReturnRoute,
    loadSessionForReprint,
    reprintCurrentSession,
    clearReprintMode,

    // -----------------------------
    // Recent Strips Actions
    // -----------------------------
    addRecentStrip,
    patchRecentStripSession,
    removeRecentStrip,
    loadRecentStrips,
    loadSavedPhotos,
    hydrateTemplatesFromDisk,
    currentQrSessionId,
    beginQrSession,

    // -----------------------------
    // Customize Actions
    // -----------------------------
    setCustomLogo,
    clearCustomLogo,
    setCustomStartButton,
    clearCustomStartButton,
    setStartButtonStyle,
    applyStartButtonStyle,
    resetStartButtonStyle,
    setPaymentQr,
    clearPaymentQr,
    paymentEnabled,
    setPaymentEnabled,
    titleLogoScale,
    paymentQrScale,
    startButtonScale,
    setTitleLogoScale,
    setPaymentQrScale,
    setStartButtonScale,
    welcomeLayout,
    welcomeLayoutDirty,
    ensureWelcomeLayout,
    setWelcomeItem,
    resetWelcomeLayout,
    applyWelcomeLayout,
    addWelcomeAsset,
    removeWelcomeAsset,
    replaceWelcomeAssetSrc,
    updateWelcomeAssetText,
    sendWelcomeLayer,
    setWelcomeLayerOrder,
    saveWelcomeLayout,
    revertWelcomeLayout,
    kioskLayouts,
    kioskLayoutOf,
    kioskLayoutDirty,
    ensureKioskLayout,
    setKioskLayout,
    resetKioskLayout,
    setKioskItem,
    addKioskAsset,
    removeKioskAsset,
    replaceKioskAssetSrc,
    updateKioskAssetText,
    updateKioskText,
    updateKioskButton,
    setKioskButtonScale,
    resetKioskButton,
    sendKioskLayer,
    setKioskLayerOrder,
    saveKioskLayout,
    revertKioskLayout,
    setKioskBackgroundFill,
    setKioskBackgroundColor,
    setKioskBackgroundFile,
    clearKioskBackground,
    loadKioskBackgroundsFromDisk,
    kioskBackgroundUrl,
    kioskBackgroundType,
    kioskThemeBackgroundUrl,
    kioskThemeBackgroundType,
    kioskHasCustomBackground,
    welcomeBackgroundColor,
    welcomeBackgroundFill,
    setWelcomeBackgroundColor,
    setWelcomeBackgroundFill,
    setTitleBackground,
    setTitleBackgroundFile,
    clearTitleBackground,
    loadTitleBackgroundFromDisk,
    paymentBackgroundType,
    paymentBackgroundUrl,
    setPaymentBackgroundFile,
    clearPaymentBackground,
    loadPaymentBackgroundFromDisk,
    setCustomDisplayFont,
    clearCustomDisplayFont,
    setCustomBodyFont,
    clearCustomBodyFont,
    addFilter,
    isDefaultFilter,
    removeFilter,
    toggleFilterActive,
    updateFilterName,
    setFilterGrain,
    setFilterOverlay,
    setFilterMediaOverlay,
    setFilterMediaOverlayFile,
    clearFilterMediaOverlay,
    loadFilterOverlayMediaFromDisk,
    overlayMediaFor,
    overlayMediaRuntime,
    DEFAULT_MEDIA_OVERLAY,
    setFilterAdjustments,
    resolvedAdjustments,
    filterGrainAmount,
    DEFAULT_OVERLAY,
    DEFAULT_ADJUSTMENTS,
    filterWantsGrain,
    loadCustomize,

    // -----------------------------
    // Admin access PIN
    // -----------------------------
    adminPin,
    setAdminPin,
    clearAdminPin,

    // -----------------------------
    // Countdown timing
    // -----------------------------
    shootingFirstCountdownSeconds,
    shootingSubsequentCountdownSeconds,
    printingCountdownSeconds,
    qrCountdownSeconds,
    qrAutoAdvanceEnabled,
    setShootingFirstCountdown,
    setShootingSubsequentCountdown,
    setPrintingCountdown,
    setQrCountdown,
    setQrAutoAdvanceEnabled,

    // -----------------------------
    // Printer Settings
    // -----------------------------
    selectedPrinterName,
    printCopies,
    printCutMode,
    setSelectedPrinter,
    setPrintCopies,
    setPrintCutMode,
  };
});
