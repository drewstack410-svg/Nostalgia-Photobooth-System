<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
// Cloudinary unsigned uploads are parked. Guest copies now go to Cloudflare R2.
// import { uploadToCloudinary } from "@/services/cloudinary";
import { uploadToR2 } from "@/services/r2";
import { getPaperSizePx, getTemplateCellRects, occupancyFill } from "@/utils/printLayout";
import type { Rect } from "@/utils/printLayout";
import { getFrameWindows, scaleWindows } from "@/utils/frameWindows";
import type { WindowRect } from "@/utils/frameWindows";
import { makePreviewDataUrl } from "@/utils/imagePreview";
import { buildSessionGif } from "@/utils/sessionGif";
import { composeStripVideo } from "@/utils/composeStripVideo";

const router = useRouter();
const store = usePhotoboothStore();

const countdownSeconds = ref(store.printingCountdownSeconds);
const isSaving = ref(false);
const savedPath = ref("");

type PrintStatus = "idle" | "printing" | "success" | "error";
const printStatus = ref<PrintStatus>("idle");
const printError = ref("");

// PREVIEW MODE: when true, the composite is rendered and shown to the
// user for confirmation BEFORE printing — nothing goes to the printer
// until they click the Print button. Useful during layout tuning so we
// don't burn a sheet of paper on every iteration.
// Set to false now that the layout is locked in — print fires straight
// away. Flip back to true if you ever need to iterate on layout again.
const previewBeforePrint = ref(false);
const previewDataUrl = ref("");
const showPreview = ref(false);
// Keeps the countdown paused while the preview modal is up (so the
// page doesn't auto-advance while the user is inspecting it).
let countdownPaused = false;
// Path to the print-ready composite (the 1800×1200 sheet that includes
// the duplicated cut-mode panels). savedPath.value points at the
// DISPLAY composite (clean single strip) — what the home page shows
// and what the user thinks of as "their photo" — so we keep the print
// path separate and use it for the actual print job.
const printPath = ref("");
// Orientation of the print-ready composite. Some templates (Heart
// Strip, the 2×2/3×2/4×2 PNG frames) are designed portrait; their
// composite is 1200×1800 and the printer must be told to print
// portrait so the driver doesn't fit-contain it onto landscape paper
// (which would leave huge white gutters). Default landscape; the
// composite step updates this when a portrait template is in use.
const printOrientation = ref<"landscape" | "portrait">("landscape");

// `copiesOverride` lets the reprint flow control the exact copy count
// for its job. Without it, the kiosk-wide printCopies setting applies —
// and a reprint that ALSO looped would print reprintCopies × printCopies
// sheets (the bug this parameter fixes).
async function printSavedPhoto(filePath: string, copiesOverride?: number) {
  if (!window.electronAPI?.printPhoto) return;

  printStatus.value = "printing";
  printError.value = "";

  // Paper orientation matches the composite that was generated. Most
  // built-in frames are portrait artwork (1240×1844 / 1200×1800), so
  // their composites are 1200×1800 portrait and we print portrait so
  // the driver doesn't add letterbox gutters to fit landscape paper.
  // The composite step set printOrientation when it ran.
  const paperLayout = printOrientation.value;

  // Cut mode is template-driven: 2×6 strip templates produce a
  // 4×6 portrait sheet with the strip composited side-by-side and
  // ask the driver to physically cut at the midpoint (yielding two
  // 2×6 strips). All other templates print as a single uncut 4×6.
  //
  // Operator setup required for the cut to actually fire:
  //   1. Load standard 4×6 ribbon (NOT 2S center-perforated media).
  //   2. Windows → Devices and Printers → DS-RX1 → Printing
  //      Preferences → Advanced → Printer Features → "2 inch cut:
  //      Enable". This is a driver-level toggle that persists.
  //   3. PowerShell selects `PR (4x6)` paper for cut jobs — only
  //      that paper variant honours the cut feature.
  const driverCutMode =
    store.selectedTemplate?.paperSize === "2x6-portrait"
      ? "dnp-2-inch-cut"
      : "standard";

  try {
    const result = await window.electronAPI.printPhoto({
      filePath,
      printerName: store.selectedPrinterName || "",
      copies: copiesOverride ?? store.printCopies ?? 1,
      paperLayout,
      cutMode: driverCutMode,
      // The media family the driver must select. Without this the print
      // script always forced a 4x6 form, so 6x8 templates printed at 4x6.
      paperSize: store.selectedTemplate?.paperSize ?? "",
    });

    if (result.success) {
      printStatus.value = "success";
      console.log("[Print] ✓ Printed successfully");
      if (result.stdout) {
        console.log("[Print] PowerShell stdout:\n" + result.stdout);
      }
    } else {
      printStatus.value = "error";
      printError.value = result.error || "Unknown print error";
      console.error("[Print] ✗ Print failed:", result.error);
    }
  } catch (err: unknown) {
    printStatus.value = "error";
    printError.value = err instanceof Error ? err.message : "Print error";
    console.error("[Print] Exception:", err);
  }
}

// The async PNG-aspect orientation probe was removed — templates
// now declare their `paperSize` explicitly (Heart Strip → 2×6,
// 2×2/Heart Grid/4×2 → 4×6 portrait, Horizontal Strip → 4×6
// landscape). The composite canvas sizes itself from
// `getPaperSizePx(template.paperSize)` instead of measuring artwork.

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; ext: string } | null {
  const match = /^data:([^,]+),(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const meta = match[1];
  const payload = match[2];
  const isBase64 = /;base64$/i.test(meta);
  const contentType = (
    meta.replace(/;base64$/i, "").split(";")[0] || ""
  ).toLowerCase();
  const ext = contentType.includes("mp4")
    ? "mp4"
    : contentType.includes("webm")
      ? "webm"
      : "mp4";
  const raw = isBase64 ? atob(payload) : payload;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { bytes, ext };
}

// Build the URL of the public gallery page that the QR code points
// at. The gallery is a static site hosted on Vercel (see
// `website/README.md`); it reads the Cloudflare R2 public base +
// object keys from the query string and renders a phone-friendly
// carousel + highlight video.
//
// Falls back to "" when R2 or the gallery base URL aren't
// configured — QRScanView handles that case by showing a friendly
// "cloud upload didn't complete" message instead of a dead QR.
function loadNaturalSize(
  src: string,
): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve(
        img.naturalWidth && img.naturalHeight
          ? { w: img.naturalWidth, h: img.naturalHeight }
          : null,
      );
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

type GallerySlot = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
};

// Same precedence as the print composite / live preview: hand-placed
// cells, then transparent windows in the frame art, then the margin/gap
// grid. Fractions are of the GALLERY print PNG (one strip for 2×6).
async function galleryLayoutParam(): Promise<{ slots: string; par: string } | null> {
  const t = store.sessionTemplate ?? store.selectedTemplate;
  if (!t) return null;
  const sheet = getPaperSizePx(t.paperSize);
  const par = `${Math.round(sheet.width)}x${Math.round(sheet.height)}`;
  let rects: GallerySlot[] = [];

  if (t.cells?.length) {
    rects = t.cells.map((c) => ({
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      rotation: c.rotation || 0,
    }));
  } else if (t.frameImageUrl) {
    const expected =
      Math.max(1, t.frameRows ?? 0) * Math.max(1, t.frameCols ?? 0);
    const [windows, frameSize] = await Promise.all([
      getFrameWindows(
        t.frameImageUrl,
        expected > 1 ? expected : undefined,
      ),
      loadNaturalSize(t.frameImageUrl),
    ]);
    if (windows?.length && frameSize) {
      const isStrip = t.paperSize === "2x6-portrait";
      const printSheet = isStrip ? getPaperSizePx("4x6-portrait") : sheet;
      const frameAspect = frameSize.w / frameSize.h;
      const sheetAspect = printSheet.width / printSheet.height;
      const designAspect = sheet.width / sheet.height;
      const frameIsFullSheet =
        isStrip &&
        Math.abs(frameAspect - sheetAspect) <
          Math.abs(frameAspect - designAspect);
      const areaW = frameIsFullSheet ? frameSize.w / 2 : frameSize.w;
      const areaH = frameSize.h;
      const src = frameIsFullSheet
        ? windows.filter((r) => r.x + r.width / 2 < areaW)
        : windows;
      rects = src.map((r) => ({
        x: r.x / areaW,
        y: r.y / areaH,
        w: r.width / areaW,
        h: r.height / areaH,
      }));
    }
  }

  if (!rects.length) {
    rects = getTemplateCellRects(t).map((r) => ({
      x: r.x / sheet.width,
      y: r.y / sheet.height,
      w: r.width / sheet.width,
      h: r.height / sheet.height,
    }));
  }

  if (!rects.length) return null;
  const slots = rects
    .map((c) => {
      const parts = [c.x, c.y, c.w, c.h].map((v) => Number(v).toFixed(4));
      if (c.rotation) parts.push(Number(c.rotation).toFixed(2));
      return parts.join("_");
    })
    .join(",");
  return { slots, par };
}

async function buildGalleryUrl(
  publicIds: string[],
  sessionTag: string,
  printId?: string,
  videoIds?: string[],
): Promise<string> {
  if (publicIds.length === 0 && !printId && !(videoIds && videoIds.length)) return "";
  const r2Base = (import.meta.env.VITE_R2_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!r2Base) {
    console.warn("[Gallery] No VITE_R2_PUBLIC_URL set");
    return "";
  }

  const base = (
    import.meta.env.VITE_GALLERY_BASE_URL ||
    `${window.location.origin}/gallery/`
  ).replace(/\/+$/, "/");

  const url = new URL(base);
  url.searchParams.set("base", r2Base);
  url.searchParams.set("ids", publicIds.join(","));
  if (sessionTag) url.searchParams.set("tag", sessionTag);
  if (printId) url.searchParams.set("print", printId);
  if (videoIds && videoIds.length > 0) {
    url.searchParams.set("vids", videoIds.join(","));
  }
  url.searchParams.set("title", "Nostalgia Photobooth");
  return url.toString();
}

// makePreviewDataUrl (downscale-for-localStorage) moved to
// @/utils/imagePreview — the store's disk-seeding path needs it too.

// Crop the left half of a data-URL image. A 2×6 cut template's print
// sheet holds the SAME strip twice (left + right of the cut line); the
// QR gallery's "Photo Strip" slide and the admin "Printed" preview
// should show a single strip — what the customer actually holds — not
// the duplicated sheet. Falls back to the original on any failure.
function cropLeftHalf(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.floor(img.naturalWidth / 2);
      const h = img.naturalHeight;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cx = c.getContext("2d");
      if (!cx) return resolve(dataUrl);
      cx.drawImage(img, 0, 0, w, h, 0, 0, w, h);
      resolve(c.toDataURL("image/png", 0.95));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// DNP DS-RX1(S) HS native 4" x 6" media at 300 DPI.
// Both modes compose in 1800×1200 landscape. Standard prints fill the
// sheet as one frame. DNP 2-inch cut mode splits the sheet into two
// 900×1200 portrait panels side-by-side — the driver's physical cut at
// x = 900 separates them into two identical 2-photo strips, each
// containing BOTH captured photos stacked within a frame.

// Create composite image from captured photos (output matches paper size by layout)
// `purpose` controls whether the composite is built for the printer
// (full 1800×1200 layout including the duplicated cut-mode panels) or
// for display/storage (a clean single-strip layout matching the chosen
// template, never duplicated). Splitting these means the saved file
// and the recent-strips entry show the user just the 2 captured shots
// they actually took, not the 4-image print sheet.
async function createCompositeImage(
  purpose: "print" | "display" = "print",
): Promise<string> {
  const template = store.sessionTemplate;
  if (!template) return "";

  // ── Canvas dimensions come from the template's declared paperSize.
  //    Two-step lookup so we can handle 2×6 strip templates cleanly:
  //
  //    1. DESIGN size — what the template was authored at (e.g. 600×1800
  //       for a 2×6 strip). Used as the cell layout reference.
  //    2. PRINT SHEET size — what the printer driver actually receives.
  //       For 2×6 templates this is a 4×6 PORTRAIT sheet (1228×1844)
  //       with the strip composited TWICE side-by-side; the driver's
  //       2-inch cut feature then slices it into two physical 2×6
  //       strips. This is the universal pattern across LumaBooth /
  //       dslrBooth / Darkroom Booth.
  //
  //    For non-strip templates (Filmstrip, 2×2, Heart Grid, 4×2) the
  //    design size IS the print sheet — no duplication, no cut.
  //
  //    DISPLAY composites never duplicate; they get the design size
  //    only so the home page / Cloudinary upload shows just one strip.
  const designSpec = getPaperSizePx(template.paperSize);
  const requiresCut =
    purpose === "print" && template.paperSize === "2x6-portrait";
  const printSheetSpec = requiresCut
    ? getPaperSizePx("4x6-portrait") // 1240×1844, cut into two 2×6 strips
    : designSpec;

  // No software rotation. The composite is sent to the printer in its
  // native orientation, and the driver is told to use a MATCHING
  // paper size: portrait templates → "PR (4x6)" (the DS-RX1's
  // portrait 4×6 size), landscape templates → "(6x4)". The earlier
  // sideways prints came from forcing "(6x4)" landscape paper under a
  // portrait composite — the driver then rotated to fit. Matching the
  // paper orientation to the composite removes that.
  const needsPrintRotation = false;
  const finalOrientation = printSheetSpec.driverLayout;
  if (purpose === "print") {
    printOrientation.value = finalOrientation;
  }

  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    const CANVAS_W = printSheetSpec.width;
    const CANVAS_H = printSheetSpec.height;
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    console.log(
      `[Composite] paperSize=${template.paperSize ?? "(default 4x6-landscape)"}, design=${designSpec.label} ${designSpec.width}×${designSpec.height}, printSheet=${printSheetSpec.label} ${CANVAS_W}×${CANVAS_H}, requiresCut=${requiresCut}`,
    );

    // ── Layout policy ──
    // EVERY template renders per print area. For cut prints (2×6
    // strip templates) there are TWO print areas — the left and right
    // halves of the 4×6 portrait sheet — and the same strip is drawn
    // into each; the DS-RX1's 2-inch cut slices at the midpoint and
    // the customer gets two identical strips. For everything else
    // there is a single full-sheet print area, so behaviour is
    // unchanged. This applies to BOTH the frame-PNG path and the
    // frameless grid path (the old programmatic-strip renderer that
    // was supposed to handle frameless strips was unreachable dead
    // code — it lived inside the frame-PNG branch).
    const printAreas: Rect[] = requiresCut
      ? [
          { x: 0, y: 0, width: CANVAS_W / 2, height: CANVAS_H },
          { x: CANVAS_W / 2, y: 0, width: CANVAS_W / 2, height: CANVAS_H },
        ]
      : [{ x: 0, y: 0, width: CANVAS_W, height: CANVAS_H }];

    // White background so there are no black bleed areas
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // ── Determine the landscape grid (cols × rows) that best fills the paper
    //    for a given number of photos.
    function bestLandscapeGrid(n: number): { cols: number; rows: number } {
      if (n <= 1) return { cols: 1, rows: 1 };
      if (n === 2) return { cols: 2, rows: 1 }; // two portrait cells side-by-side
      if (n === 3) return { cols: 3, rows: 1 };
      if (n <= 4) return { cols: 2, rows: 2 };
      if (n <= 6) return { cols: 3, rows: 2 };
      return          { cols: 4, rows: 2 };     // up to 8
    }

    // If the template has explicit grid dimensions use them (e.g. frame overlays).
    // Otherwise derive the best landscape grid from photo count.
    const photoCount = store.capturedPhotos.length;
    const hasTplGrid = !!(
      template.frameRows != null && template.frameCols != null &&
      template.frameRows > 0   && template.frameCols > 0
    );
    const grid = hasTplGrid
      ? { cols: template.frameCols!, rows: template.frameRows! }
      : bestLandscapeGrid(photoCount);

    console.log(`[Composite] Canvas ${CANVAS_W}×${CANVAS_H}, grid ${grid.cols}×${grid.rows}, photos=${photoCount}`);
    console.log(`[Composite] capturedPhotos count: ${store.capturedPhotos.length}`);
    store.capturedPhotos.forEach((p, idx) => {
      const urlPreview = p.dataUrl ? p.dataUrl.slice(0, 50) : "EMPTY";
      console.log(`[Composite] Photo ${idx} dataUrl length=${p.dataUrl?.length ?? 0} prefix="${urlPreview}"`);
    });

    // ── Load captured photos
    // IMPORTANT: attach onload/onerror BEFORE setting src — data URLs can fire
    // onload synchronously during src assignment, so the handler must exist first.
    const imagePromises = store.capturedPhotos.map((p, idx) =>
      new Promise<HTMLImageElement | null>((res) => {
        if (!p.dataUrl) {
          console.error(`[Composite] Photo ${idx} has no dataUrl — skipping`);
          res(null);
          return;
        }
        const img = new Image();
        img.onload = () => {
          console.log(`[Composite] Photo ${idx} loaded OK: ${img.width}×${img.height}, naturalW=${img.naturalWidth}`);
          res(img);
        };
        img.onerror = (err) => {
          console.error(`[Composite] Photo ${idx} FAILED to load:`, err);
          res(null);
        };
        img.src = p.dataUrl; // set AFTER handlers are attached
      })
    );

    // ── Draw photos into a FILL-AREA grid (frameless templates) ──
    // Used by templates with no frame PNG (e.g. Horizontal Strip).
    // Divides ONE print area into a cols×rows grid using the
    // template's margin/gap (default 0 → cells reach the area edges)
    // and COVER-FITs each photo (× cellZoom, centred). Same
    // cell-drawing math as the frame-PNG path, just without a frame
    // overlay. Called once per print area, so a 2×6 cut template gets
    // the SAME strip drawn into both halves of the sheet.
    const drawPhotosIntoArea = (
      loadedImages: HTMLImageElement[],
      area: Rect,
    ) => {
      const count = loadedImages.length;
      console.log(`[Composite] drawPhotosIntoArea called with ${count} images, area=(${area.x},${area.y}) ${area.width}×${area.height}`);
      if (count === 0) {
        console.error(`[Composite] ⚠ No loaded images — canvas will be blank!`);
        return;
      }

      const { cols, rows } = grid;
      const margin = template.cellMargin ?? 0;
      const gap = template.cellGap ?? 0;
      const innerW = area.width - margin * 2 - gap * (cols - 1);
      const innerH = area.height - margin * 2 - gap * (rows - 1);
      const cellW = innerW / cols;
      const cellH = innerH / rows;
      const editorCells = template.cells?.length
        ? template.cells.map((c) => ({
            x: area.x + c.x * area.width,
            y: area.y + c.y * area.height,
            width: c.w * area.width,
            height: c.h * area.height,
            rotation: c.rotation || 0,
          }))
        : null;
      const { zoom, fitMode: framelessFit } = occupancyFill(
        template,
        !!editorCells,
      );
      const slotCount = editorCells ? editorCells.length : cols * rows;
      console.log(
        `[Composite] frameless ${editorCells ? `${editorCells.length} editor slot(s)` : `grid ${cols}×${rows}`}, cells ${Math.round(cellW)}×${Math.round(cellH)}, margin ${margin}, gap ${gap}, zoom ${zoom}`,
      );

      for (let i = 0; i < slotCount; i++) {
        const img = loadedImages[i % count];
        let cellX: number;
        let cellY: number;
        let cw: number;
        let ch: number;
        let rotation = 0;
        if (editorCells) {
          ({ x: cellX, y: cellY, width: cw, height: ch } = editorCells[i]);
          rotation = editorCells[i].rotation ?? 0;
        } else {
          const col = i % cols;
          const row = Math.floor(i / cols);
          cellX = Math.round(area.x + margin + col * (cellW + gap));
          cellY = Math.round(area.y + margin + row * (cellH + gap));
          cw = Math.round(cellW);
          ch = Math.round(cellH);
        }

        // Fit × zoom, centred (matches the frame-PNG path).
        const imgAspect = img.naturalWidth / img.naturalHeight;
        const cAspect = cw / ch;
        let baseW: number;
        let baseH: number;
        const fillsWidthFirst =
          framelessFit === "contain" ? imgAspect > cAspect : imgAspect <= cAspect;
        if (fillsWidthFirst) {
          baseW = cw;
          baseH = cw / imgAspect;
        } else {
          baseH = ch;
          baseW = ch * imgAspect;
        }
        const dw = baseW * zoom;
        const dh = baseH * zoom;
        const offX = template.cellOffsetX ?? 0;
        const offY = template.cellOffsetY ?? 0;
        const dx = cellX + (cw - dw) / 2 + (cw * offX) / 100;
        const dy = cellY + (ch - dh) / 2 + (ch * offY) / 100;

        ctx.save();
        if (rotation) {
          const pivotX = cellX + cw / 2;
          const pivotY = cellY + ch / 2;
          ctx.translate(pivotX, pivotY);
          ctx.rotate((rotation * Math.PI) / 180);
          ctx.translate(-pivotX, -pivotY);
        }
        ctx.beginPath();
        ctx.rect(cellX, cellY, cw, ch);
        ctx.clip();
        ctx.drawImage(
          img,
          0,
          0,
          img.naturalWidth,
          img.naturalHeight,
          dx,
          dy,
          dw,
          dh,
        );
        ctx.restore();
      }
    };

    // ── Export the final PNG. For portrait non-cut prints we rotate
    //    the canvas 90° to landscape here (see needsPrintRotation
    //    above) so the DS-RX1 receives a landscape image that maps
    //    1:1 to its native "(6x4)" page — no driver rotation, no
    //    sideways content. Display composites and cut sheets export
    //    unrotated.
    const exportFinalDataUrl = (): string => {
      if (!needsPrintRotation) {
        return canvas.toDataURL("image/png", 0.95);
      }
      const rotated = document.createElement("canvas");
      rotated.width = canvas.height; // portrait H → landscape W
      rotated.height = canvas.width; // portrait W → landscape H
      const rctx = rotated.getContext("2d")!;
      // Rotate 90° clockwise about the new canvas centre. If a test
      // print comes out upside-down, flip the sign to -Math.PI/2.
      rctx.translate(rotated.width / 2, rotated.height / 2);
      rctx.rotate(Math.PI / 2);
      rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      console.log(
        `[Composite] rotated portrait ${canvas.width}×${canvas.height} → landscape ${rotated.width}×${rotated.height} for print`,
      );
      return rotated.toDataURL("image/png", 0.95);
    };

    // ── Finalize: draw frame overlay last (on top), then export
    const finalize = (loadedImages: HTMLImageElement[]) => {
      console.log(`[Composite] finalize() called with ${loadedImages.length} images, frameImageUrl=${template.frameImageUrl || 'none'}`);
      if (template.frameImageUrl) {
        const frameImg = new Image();
        frameImg.onload = async () => {
          // Read the frame's real photo windows off its alpha channel.
          // Rejected (null) unless the count matches the declared grid,
          // so an unexpected result falls back to the margin/gap maths
          // rather than misplacing photos on a paying customer's print.
          let frameWindowRects: WindowRect[] | null = null;
          try {
            const expected =
              Math.max(1, template.frameRows ?? 0) *
              Math.max(1, template.frameCols ?? 0);
            frameWindowRects = await getFrameWindows(
              template.frameImageUrl as string,
              expected > 1 ? expected : undefined,
            );
          } catch (e) {
            console.warn("[Composite] window detection failed:", e);
          }
          const natW = frameImg.naturalWidth;
          const natH = frameImg.naturalHeight;
          console.log(`[Composite] Frame natural size: ${natW}×${natH}`);

          // The frame-PNG path now uses a deterministic margin+gap
          // grid (matching the layout sandbox) instead of probing the
          // PNG for light slots — see the per-printArea block below.
          // We just need the loaded-photo count up front.
          const count = loadedImages.length;
          if (count === 0) {
            console.error(`[Composite] ⚠ No loaded images — canvas will be blank!`);
          }

          // Full-sheet vs per-strip frame art (cut sheets only). A
          // cut sheet's frame PNG can be authored either way:
          //   - single-strip art (one strip's worth of pixels, e.g.
          //     620×1844) — drawn once into EACH half;
          //   - full-sheet art with both halves already duplicated
          //     (e.g. 1240×1844) — drawn ONCE over the whole canvas,
          //     else it would be squashed 2:1 into each half.
          // Decide by which shape the PNG's aspect is closer to.
          const frameAspect = natW / Math.max(1, natH);
          const canvasAspect = CANVAS_W / CANVAS_H;
          const areaAspect = printAreas[0].width / printAreas[0].height;
          const frameIsFullSheet =
            printAreas.length > 1 &&
            Math.abs(frameAspect - canvasAspect) <
              Math.abs(frameAspect - areaAspect);
          if (printAreas.length > 1) {
            console.log(
              `[Composite] cut-sheet frame mode: ${frameIsFullSheet ? "full-sheet (drawn once)" : "per-strip (drawn per half)"}`,
            );
          }

          for (const printArea of printAreas) {
            // ── Frame-PNG template (2×2, Heart Grid, 4×2, strips) ──
            // Matches the operator-approved layout sandbox EXACTLY:
            //   1. Photos COVER-FIT into a simple margin+gap grid
            //      (frameRows × frameCols), so each photo fills its
            //      cell with no letterbox and only an aspect-driven
            //      centre crop.
            //   2. The frame PNG is drawn ON TOP — its transparent
            //      photo windows reveal the photos beneath while its
            //      black film-strip borders + branding overlay the
            //      cell edges.
            // This replaces the old "frame-as-base + contain-fit into
            // detected light slots" path, which produced the
            // not-contained / wrong-size prints. Margin + gap are
            // per-template (default 24): 2×2 / Heart Grid use 24/24;
            // the 4×2 Layout uses 0/0 so its 8 cells reach the sheet
            // edges with no borders.
            const GRID_MARGIN = template.cellMargin ?? 24;
            const GRID_GAP = template.cellGap ?? 24;
            const fCols = Math.max(1, template.frameCols ?? grid.cols);
            const fRows = Math.max(1, template.frameRows ?? grid.rows);
            const innerW =
              printArea.width - GRID_MARGIN * 2 - GRID_GAP * (fCols - 1);
            const innerH =
              printArea.height - GRID_MARGIN * 2 - GRID_GAP * (fRows - 1);
            const fCellW = innerW / fCols;
            const fCellH = innerH / fRows;
            const fSlotCount = fCols * fRows;

            // cellZoom (default 1) scales the cover-fit photo,
            // centred, inside each cell — matches the layout sandbox.
            // Heart Grid uses 0.85 to pull photos back into the heart
            // cutouts; 2×2 / 4×2 leave it at 1 (full cover).
            const cellZoom = template.cellZoom ?? 1;
            console.log(
              `[Composite] frame grid ${fCols}×${fRows}, cells ${Math.round(fCellW)}×${Math.round(fCellH)}, margin ${GRID_MARGIN}, gap ${GRID_GAP}, cellZoom ${cellZoom}`,
            );

            // Where each photo actually goes. PREFERRED: the frame's own
            // transparent windows, read off its alpha channel — exact for
            // any artwork, including layouts the operator imports later.
            //
            // The margin/gap/zoom grid below is only a FALLBACK. It can't
            // describe real frame art: "2x2 Layout.png" has a 54px side
            // margin vs a 106px top margin, and an 83px horizontal gap vs
            // a 222px vertical one, none of which a single margin+gap
            // pair can express. That mismatch (papered over by
            // cellZoom 0.8) is why captures sat a few px off inside every
            // window.
            const offsetX = template.cellOffsetX ?? 0;
            const offsetY = template.cellOffsetY ?? 0;
            // HIGHEST PRECEDENCE: slots the operator positioned by hand
            // in the layout editor. Stored as fractions of the print
            // area (see TemplateCell), so they survive a paper-size or
            // DPI change. Only templates that have actually been edited
            // and saved carry these — everything else falls through to
            // the detection/grid paths below, unchanged.
            const editorCells = template.cells?.length
              ? template.cells.map((c) => ({
                  x: printArea.x + c.x * printArea.width,
                  y: printArea.y + c.y * printArea.height,
                  width: c.w * printArea.width,
                  height: c.h * printArea.height,
                  rotation: c.rotation || 0,
                }))
              : null;
            if (editorCells) {
              console.log(
                `[Composite] using ${editorCells.length} hand-placed slot(s) from the layout editor`,
              );
            }

            const detected = frameWindowRects
              ? scaleWindows(
                  frameWindowRects,
                  frameImg.naturalWidth,
                  frameImg.naturalHeight,
                  printArea,
                )
              : null;
            if (detected && !editorCells) {
              console.log(
                `[Composite] using ${detected.length} window(s) detected from the frame artwork`,
              );
            }

            // 1) Photos cover-fit into each cell/window.
            if (count > 0) {
              const slots =
                editorCells ??
                (detected
                  ? detected.map((w) => ({ ...w, rotation: 0 }))
                  : null);
              const slotTotal = slots ? slots.length : fSlotCount;
              for (let i = 0; i < slotTotal; i++) {
                const img = loadedImages[i % count];
                let cellX: number;
                let cellY: number;
                let cw: number;
                let ch: number;
                let rotation = 0;
                // Layout-editor slots and detected windows ARE the occupancy
                // canvas — fill them cover-fit, never inset/letterbox.
                const { zoom, fitMode } = occupancyFill(template, !!slots);
                if (slots) {
                  ({ x: cellX, y: cellY, width: cw, height: ch } = slots[i]);
                  rotation = slots[i].rotation ?? 0;
                } else {
                  const col = i % fCols;
                  const row = Math.floor(i / fCols);
                  cellX = printArea.x + GRID_MARGIN + col * (fCellW + GRID_GAP);
                  cellY = printArea.y + GRID_MARGIN + row * (fCellH + GRID_GAP);
                  cw = fCellW;
                  ch = fCellH;
                }

                // Cover-fit base dimensions, then apply zoom.
                const imgAspect = img.naturalWidth / img.naturalHeight;
                const cAspect = cw / ch;
                // cover = fill the window and crop the overflow;
                // contain = show the WHOLE photo, letterboxed. Same
                // expression either way — cover takes the larger axis
                // scale, contain the smaller — so aspect is preserved in
                // both and the photo is never stretched.
                let baseW: number;
                let baseH: number;
                const fillsWidthFirst =
                  fitMode === "contain" ? imgAspect > cAspect : imgAspect <= cAspect;
                if (fillsWidthFirst) {
                  baseW = cw;
                  baseH = cw / imgAspect;
                } else {
                  baseH = ch;
                  baseW = ch * imgAspect;
                }
                const dw = baseW * zoom;
                const dh = baseH * zoom;
                // Centred, then nudged by the template's offset (a
                // percentage of the window) so the operator can choose
                // which part of a zoomed-in photo stays visible.
                const dx = cellX + (cw - dw) / 2 + (cw * offsetX) / 100;
                const dy = cellY + (ch - dh) / 2 + (ch * offsetY) / 100;

                ctx.save();
                // Rotate about the slot's centre BEFORE building the
                // clip path, so the mask turns with the photo — a
                // tilted slot crops to a tilted rectangle, which is what
                // the editor draws. Rotating only the image would clip
                // it against an upright box and shear the result.
                if (rotation) {
                  const pivotX = cellX + cw / 2;
                  const pivotY = cellY + ch / 2;
                  ctx.translate(pivotX, pivotY);
                  ctx.rotate((rotation * Math.PI) / 180);
                  ctx.translate(-pivotX, -pivotY);
                }
                ctx.beginPath();
                ctx.rect(cellX, cellY, cw, ch);
                ctx.clip();
                ctx.drawImage(
                  img,
                  0,
                  0,
                  img.naturalWidth,
                  img.naturalHeight,
                  dx,
                  dy,
                  dw,
                  dh,
                );
                ctx.restore();
              }
            }

            // 2) Frame PNG ON TOP of this print area — unless the
            //    art is a full-sheet design (then it draws once,
            //    after the loop, covering both halves).
            if (!frameIsFullSheet) {
              ctx.drawImage(
                frameImg,
                printArea.x,
                printArea.y,
                printArea.width,
                printArea.height,
              );
            }

            console.log(`[Composite] Frame drawn on top of ${fSlotCount} cover-fit cells`);
          }

          if (frameIsFullSheet) {
            ctx.drawImage(frameImg, 0, 0, CANVAS_W, CANVAS_H);
            console.log(
              `[Composite] Full-sheet frame drawn once across both print areas`,
            );
          }

          const dataUrl = exportFinalDataUrl();
          console.log(`[Composite] Final PNG data URL length: ${dataUrl.length}`);
          resolve(dataUrl);
        };
        frameImg.onerror = () => {
          console.error(`[Composite] Frame image failed to load: ${template.frameImageUrl}`);
          for (const printArea of printAreas) {
            drawPhotosIntoArea(loadedImages, printArea);
          }
          resolve(exportFinalDataUrl());
        };
        frameImg.src = template.frameImageUrl;
      } else {
        // Frameless: draw the grid into every print area (both halves
        // for cut sheets → two identical strips; one full sheet
        // otherwise).
        for (const printArea of printAreas) {
          drawPhotosIntoArea(loadedImages, printArea);
        }
        const dataUrl = exportFinalDataUrl();
        console.log(`[Composite] Final PNG (no frame) data URL length: ${dataUrl.length}`);
        resolve(dataUrl);
      }
    };

    Promise.all(imagePromises).then((results) => {
      const loadedImages = results.filter((img): img is HTMLImageElement => img !== null);

      // ── DISPLAY fast-path ──
      // For the display/save composite we want JUST the captured
      // photos laid out in the template's grid — no cream background,
      // no frame border, no padding. The home page slot already
      // provides its own framing; pasting our own template inside it
      // produces the doubled-frame look the user just flagged.
      // Resize the canvas to exactly fit the grid at native photo
      // resolution so no quality is lost.
      if (purpose === "display" && loadedImages.length > 0) {
        const cols = Math.max(1, Math.floor(grid.cols));
        const rows = Math.max(1, Math.floor(grid.rows));
        const photoW = loadedImages[0].naturalWidth;
        const photoH = loadedImages[0].naturalHeight;
        canvas.width = photoW * cols;
        canvas.height = photoH * rows;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // Cycle photos to fill every grid cell (handles cases where
        // the template has more cells than captured photos — rare for
        // display but keeps the layout intact).
        const cellCount = cols * rows;
        for (let i = 0; i < cellCount; i++) {
          const img = loadedImages[i % loadedImages.length];
          const col = i % cols;
          const row = Math.floor(i / cols);
          ctx.drawImage(img, col * photoW, row * photoH, photoW, photoH);
        }
        const dataUrl = canvas.toDataURL("image/png", 0.95);
        console.log(
          `[Composite] DISPLAY composite ${canvas.width}×${canvas.height} (${cols}×${rows} grid, no frame), length=${dataUrl.length}`,
        );
        resolve(dataUrl);
        return;
      }

      finalize(loadedImages);
    });
  });
}

// Save the composite image
/**
 * Claims this sitting's "<MM-DD-YY>/Session N" folder, drops the printed
 * sheet into it, and kicks off the session GIF.
 *
 * The GIF is deliberately fire-and-forget: encoding a handful of frames
 * takes a second or two and the print is already on its way out, so
 * nobody should be made to wait on it. Returns the folder (or null when
 * the folder could not be created, in which case callers fall back to the
 * old flat filenames rather than losing the customer's photos).
 */
async function beginSessionFolder(
  stripDataUrl: string,
  captureDataUrls: string[],
): Promise<string | null> {
  const api = window.electronAPI;
  if (!api?.beginSession) return null;

  let folder: string | null = null;
  try {
    const r = await api.beginSession();
    if (r?.success && r.folder) folder = r.folder;
    else console.warn("[Session] could not create folder:", r?.error);
  } catch (e) {
    console.warn("[Session] beginSession failed:", e);
  }
  if (!folder) return null;

  if (stripDataUrl) {
    try {
      const r = await api.savePhoto(stripDataUrl, `${folder}/strip.png`);
      if (r?.success) console.log("[Session] strip saved:", r.path);
      else console.warn("[Session] strip save failed:", r?.error);
    } catch (e) {
      console.warn("[Session] strip save error:", e);
    }
  }

  if (captureDataUrls.length && api.saveSessionBytes) {
    const gifFolder = folder;
    void buildSessionGif(captureDataUrls, { maxWidth: 480, delayMs: 600 })
      .then((bytes) =>
        api.saveSessionBytes!({
          bytes,
          filename: `${gifFolder}/session.gif`,
        }),
      )
      .then((r) => {
        if (r?.success) console.log("[Session] gif saved:", r.path);
        else console.warn("[Session] gif save failed:", r?.error);
      })
      .catch((e) => console.warn("[Session] gif build failed:", e));
  }

  return folder;
}

async function saveComposite() {
  isSaving.value = true;

  // Claim this sitting's id BEFORE anything that can fail or await. The
  // guest can tap Done and land on the QR screen while the upload below is
  // still running, and that screen must be able to tell "this guest's photos
  // aren't ready yet" apart from "here are the last guest's photos".
  const sessionTs = Date.now();
  store.beginQrSession(`session_${sessionTs}`);

  try {
    console.log(`[Save] Starting save process... capturedPhotos=${store.capturedPhotos.length}, hasAllPhotos=${store.hasAllPhotos}`);
    // Build the PRINT composite (the full 1800×1200 sheet, including
    // duplicated cut-mode panels). This is the only composite we need —
    // each individual capture goes to disk / Cloudinary / recent strips
    // on its own (no stacked composite for display).
    const printComposite = await createCompositeImage("print");
    console.log(
      "[Save] Print composite created, length:",
      printComposite.length,
    );

    if (window.electronAPI && printComposite) {
      console.log("[Save] Electron API available, attempting to save...");

      // 1) Save the PRINT sheet to a TEMP folder (not the user's
      //    Pictures dir). The print sheet is just a transient artifact
      //    the printer needs — only the individual captures belong in
      //    the canonical save location. A reprint can recreate the
      //    sheet on demand by re-running createCompositeImage with the
      //    saved per-capture photos + the same template.
      const printResult = await window.electronAPI.saveTempPhoto(printComposite);
      if (!printResult.success || !printResult.path) {
        console.error(
          "[Save] Print sheet save failed!",
          printResult.error,
        );
        return;
      }
      printPath.value = printResult.path;
      // savedPath is referenced by the legacy "Print Again" button
      // fallback. Point it at the temp path so the same file gets sent
      // for a re-print within this session — after a restart the temp
      // file is gone, but a future reprint screen can rebuild the
      // sheet from the saved captures.
      savedPath.value = printResult.path;
      console.log("[Save] Print sheet saved to TEMP:", printResult.path);

      if (previewBeforePrint.value) {
        // Preview the PRINT version — that's what actually goes to
        // the printer, including the cut-line indicator.
        previewDataUrl.value = printComposite;
        showPreview.value = true;
        countdownPaused = true;
        console.log("[Save] Preview mode — awaiting user confirmation");
      } else {
        printSavedPhoto(printPath.value);
      }

      // 2) Save each INDIVIDUAL CAPTURE to disk + Cloudinary. After
      //    that we'll synthesise the QR's shareable URL CLIENT-SIDE
      //    by combining the per-capture publicIds with Cloudinary's
      //    overlay transform — no extra upload needed, the stacking
      //    happens at the CDN edge when the user scans.
      // Claim this sitting's date/session folder before anything is written
      // to Pictures, so the strip, the captures and the GIF all land
      // together. Null means the folder couldn't be made — the captures
      // then fall back to the old flat filenames rather than being lost.
      const sessionFolder = await beginSessionFolder(
        printComposite,
        store.capturedPhotos.map((p) => p.dataUrl).filter(Boolean),
      );

      // Also upload the finished TEMPLATED print (frame applied) so the
      // digital gallery can offer it as a download next to the
      // individual captures. For 4×6 templates `printComposite` IS the
      // single templated image; for 2×6 cut templates it's the
      // duplicated side-by-side sheet, so crop to ONE strip first —
      // the customer's keepsake, not the raw print sheet. Uploaded
      // WITHOUT the session tag so it stays out of the animated GIF
      // (which is just the captures). Runs concurrently with the
      // per-capture uploads below.
      const shareComposite =
        printComposite &&
        store.selectedTemplate?.paperSize === "2x6-portrait"
          ? await cropLeftHalf(printComposite)
          : printComposite;
      const compositeUploadPromise: Promise<string | undefined> = (async () => {
        try {
          if (!shareComposite) return undefined;
          const cr = await uploadToR2(
            shareComposite,
            "nostalgia-photobooth",
            `nostalgia_${sessionTs}_print`,
          );
          if (cr.success && cr.publicId) {
            console.log("[Save] Templated print uploaded for gallery:", cr.url);
            return cr.publicId;
          }
          console.warn("[Save] Gallery composite upload failed:", cr.error);
          return undefined;
        } catch (e) {
          console.error("[Save] Gallery composite upload error:", e);
          return undefined;
        }
      })();

      // Bake clips into the printed strip (full frame), save locally,
      // and upload that one video for the gallery. Per-shot crops still
      // land in Videos/ from CameraView; the QR gets the framed strip.
      const highlightUploadPromise: Promise<string[]> = (async () => {
        const clips = store.highlightClips.filter(Boolean);
        if (!clips.length || !shareComposite) return [];
        let stripDataUrl: string | null = null;
        try {
          const layout = await galleryLayoutParam();
          const slots = layout
            ? layout.slots
                .split(",")
                .map((part) => {
                  const n = part.split("_").map(Number);
                  return {
                    x: n[0],
                    y: n[1],
                    w: n[2],
                    h: n[3],
                    rotation: n.length >= 5 ? n[4] : 0,
                  };
                })
                .filter(
                  (s) =>
                    isFinite(s.x) &&
                    isFinite(s.y) &&
                    isFinite(s.w) &&
                    isFinite(s.h) &&
                    s.w > 0 &&
                    s.h > 0,
                )
            : [];
          stripDataUrl = await composeStripVideo({
            frameDataUrl: shareComposite,
            clipDataUrls: clips,
            slots,
          });
        } catch (e) {
          console.warn("[Save] Strip video compose failed:", e);
        }

        const toSave = stripDataUrl
          ? [{ dataUrl: stripDataUrl, name: "highlight-strip" }]
          : clips.map((dataUrl, i) => ({
              dataUrl,
              name: `highlight-${i + 1}`,
            }));

        for (const item of toSave) {
          if (sessionFolder && window.electronAPI?.saveSessionBytes) {
            try {
              const parsed = dataUrlToBytes(item.dataUrl);
              if (parsed) {
                await window.electronAPI.saveSessionBytes({
                  bytes: parsed.bytes,
                  filename: `${sessionFolder}/${item.name}.${parsed.ext}`,
                });
              }
            } catch (e) {
              console.warn(`[Save] ${item.name} session save failed:`, e);
            }
          }
          if (stripDataUrl && window.electronAPI?.saveHighlightVideo) {
            try {
              const parsed = dataUrlToBytes(item.dataUrl);
              if (parsed) {
                const now = new Date();
                const stamp = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getFullYear()).slice(-2)}`;
                const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
                const r = await window.electronAPI.saveHighlightVideo({
                  bytes: parsed.bytes,
                  filename: `${stamp}/highlight-strip-${time}.${parsed.ext}`,
                });
                if (r.success) console.log("[Save] Strip video saved locally:", r.path);
                else console.warn("[Save] Strip video local save failed:", r.error);
              }
            } catch (e) {
              console.warn("[Save] Strip video local save error:", e);
            }
          }
        }

        const ids: string[] = [];
        for (let i = 0; i < toSave.length; i++) {
          const item = toSave[i];
          try {
            const publicId = `nostalgia_${sessionTs}_${item.name}_${Math.random()
              .toString(36)
              .substring(2, 8)}`;
            const cr = await uploadToR2(
              item.dataUrl,
              "nostalgia-photobooth",
              publicId,
            );
            if (cr.success && cr.publicId) {
              ids.push(cr.publicId);
              console.log(`[Save] ${item.name} uploaded:`, cr.url);
            } else {
              console.warn(`[Save] ${item.name} upload failed:`, cr.error);
            }
          } catch (e) {
            console.error(`[Save] ${item.name} upload error:`, e);
          }
        }
        return ids;
      })();

      // Save+upload each capture in parallel, collect results so we
      // can synthesise the shareable QR URL once all uploads land.
      type CaptureResult = {
        idx: number;
        dataUrl: string;
        localPath?: string;
        cloudUrl?: string;
        cloudPublicId?: string;
      };
      const captureResults = await Promise.all(
        store.capturedPhotos.map(async (photo, idx): Promise<CaptureResult> => {
          if (!photo.dataUrl) {
            console.warn(`[Save] Capture ${idx} has no dataUrl — skipping`);
            return { idx, dataUrl: "" };
          }

          // Local file save (per-capture)
          let localPath: string | undefined;
          try {
            const r = await window.electronAPI.savePhoto(
              photo.dataUrl,
              sessionFolder
                ? `${sessionFolder}/photo-${idx + 1}.jpg`
                : undefined,
            );
            if (r.success && r.path) {
              localPath = r.path;
              console.log(`[Save] Capture ${idx} saved to:`, r.path);
            } else {
              console.warn(
                `[Save] Capture ${idx} disk save failed:`,
                r.error,
              );
            }
          } catch (e) {
            console.error(`[Save] Capture ${idx} disk save error:`, e);
          }

          // Cloudflare R2 upload (per-capture, raw camera image — NO
          // template, NO frame, NO composite). Session tag is unused by
          // R2; the gallery GIF is built client-side from `ids`.
          let cloudUrl: string | undefined;
          let cloudPublicId: string | undefined;
          try {
            const publicId = `nostalgia_${sessionTs}_${idx}_${Math.random()
              .toString(36)
              .substring(2, 8)}`;
            const cr = await uploadToR2(
              photo.dataUrl,
              "nostalgia-photobooth",
              publicId,
              `session_${sessionTs}`,
            );
            if (cr.success && cr.url && cr.publicId) {
              cloudUrl = cr.url;
              cloudPublicId = cr.publicId;
              console.log(`[Save] Capture ${idx} uploaded:`, cr.url);
            } else {
              console.warn(
                `[Save] Capture ${idx} upload failed:`,
                cr.error,
              );
            }
          } catch (e) {
            console.error(`[Save] Capture ${idx} upload error:`, e);
          }

          return {
            idx,
            dataUrl: photo.dataUrl,
            localPath,
            cloudUrl,
            cloudPublicId,
          };
        }),
      );

      // Build the QR's target: the public gallery page URL with the
      // per-capture R2 object keys. The gallery page (hosted on
      // Vercel) reads `base` + `ids` + `vids` and renders a carousel
      // plus the session highlight video.
      const successfulIds = captureResults
        .map((r) => r.cloudPublicId)
        .filter((id): id is string => !!id);
      const [compositePublicId, videoIds] = await Promise.all([
        compositeUploadPromise,
        highlightUploadPromise,
      ]);
      const sessionShareableUrl = await buildGalleryUrl(
        successfulIds,
        `session_${sessionTs}`,
        compositePublicId,
        videoIds,
      );
      if (sessionShareableUrl) {
        console.log("[Save] Gallery URL for QR:", sessionShareableUrl);
      } else {
        console.warn(
          "[Save] No gallery URL — R2 uploads didn't produce any usable publicIds",
        );
      }

      // One recent-strip entry per capture. All entries from this
      // session share the same sessionId so a future reprint screen
      // can pull "the photos from session X" without mixing in
      // captures from neighbouring booths sessions. templateId tells
      // the reprint flow which frame to re-apply when rebuilding the
      // print sheet.
      const sessionId = `session_${sessionTs}`;
      const templateId = store.selectedTemplate?.id;
      for (const r of captureResults) {
        if (!r.dataUrl) continue;
        // Persist a DOWNSCALED preview, not the raw 3600×2400 capture:
        // recentStrips lives in localStorage, and 8 full-res captures
        // (~2–5 MB of base64 each) blow straight past the ~5–10 MB
        // quota — the setItem throw used to abort the loop mid-session.
        // Full resolution survives on disk at `path` (and on
        // Cloudinary); the admin reprint flow re-reads the disk file
        // when rebuilding a print sheet.
        const previewUrl = await makePreviewDataUrl(r.dataUrl);
        store.addRecentStrip({
          id: `strip_${sessionTs}_${r.idx}`,
          dataUrl: previewUrl,
          timestamp: new Date(),
          path: r.localPath,
          sessionId,
          templateId,
          sessionIndex: r.idx,
          cloudinaryUrl: r.cloudUrl,
          cloudinaryPublicId: r.cloudPublicId,
          cloudinaryPhotos:
            r.cloudUrl && r.cloudPublicId
              ? [{ url: r.cloudUrl, publicId: r.cloudPublicId }]
              : undefined,
          shareableUrl: sessionShareableUrl,
        });
      }
      console.log(
        `[Save] All ${store.capturedPhotos.length} captures saved & added as individual recent strips`,
      );

      // Add ONE more recent-strip entry per session for the finished
      // TEMPLATED print (the "actual picture printed"), so the admin
      // gallery can show it next to the individual captures. We persist
      // a downscaled JPEG preview (not the full multi-MB PNG) to stay
      // within the localStorage budget; reprint rebuilds full-res from
      // the captures regardless, and `isComposite` keeps this entry out
      // of the capture set + the title-screen film roll. Added LAST so
      // it lands at the front of the session group. Defensive try/catch
      // so a storage hiccup can never break the post-print flow — the
      // print already succeeded by this point.
      try {
        // shareComposite = single strip for 2×6 templates (cropped
        // above), full sheet otherwise — same image the QR gallery got.
        const compositePreview = await makePreviewDataUrl(shareComposite);
        const stripPath = captureResults.find((r) => r.localPath)?.localPath
          ?.replace(/photo-\d+\.[a-z0-9]+$/i, "strip.png");
        store.addRecentStrip({
          id: `strip_${sessionTs}_composite`,
          dataUrl: compositePreview,
          timestamp: new Date(),
          path: stripPath,
          sessionId,
          templateId,
          sessionIndex: -1,
          isComposite: true,
          shareableUrl: sessionShareableUrl,
        });
        console.log("[Save] Added templated-print preview to recent strips");
      } catch (e) {
        console.warn("[Save] Couldn't add composite preview strip:", e);
      }
    } else {
      console.warn("[Save] Electron API not available or no print composite");
      if (!window.electronAPI) {
        console.warn("[Save] window.electronAPI is:", window.electronAPI);
      }
      if (!printComposite) {
        console.warn("[Save] printComposite is empty");
      }
    }
  } catch (err) {
    console.error("[Save] Failed to save:", err);
  }

  isSaving.value = false;
  console.log("[Save] Save process completed");
}

// ── Auto-advance timers ────────────────────────────────────────────
// These MUST be cancellable from outside startCountdown(). Previously
// the interval lived in a function-local `const` and was cleared only
// when the countdown hit zero, so tapping "Done" early (the normal
// path) left it running. `useRouter()` is an app-wide singleton, so the
// orphaned closure kept navigating AFTER the component was gone: ~20s
// later it pushed /qr, whose own 30s timer then ran resetSession() +
// push("/"). That is the "randomly jumps back to the title screen
// mid-session" the client reported — it landed on whoever was using the
// booth ~50s later, and the leaks stacked with every early Done.
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let reprintReturnTimer: ReturnType<typeof setTimeout> | null = null;
let isUnmounted = false;

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// Countdown and auto-advance to the QR screen
function startCountdown() {
  // startCountdown() is reached only after `await saveComposite()`,
  // which uploads to Cloudinary with no timeout — the guest can easily
  // leave during that await, so refuse to arm a timer on a dead view.
  if (isUnmounted) return;
  stopCountdown();
  countdownInterval = setInterval(() => {
    if (isUnmounted) {
      stopCountdown();
      return;
    }
    // Pause while the print preview modal is open
    if (countdownPaused) return;
    countdownSeconds.value--;

    if (countdownSeconds.value <= 0) {
      stopCountdown();
      goToQRView();
    }
  }, 1000);
}

// Preview modal actions
function confirmPrintFromPreview() {
  showPreview.value = false;
  countdownPaused = false;
  // Always print the PRINT-version file (the full 1800×1200 sheet
  // including the duplicated cut-mode panels). printPath falls back to
  // savedPath when cut mode is off, so this stays correct in both modes.
  const target = printPath.value || savedPath.value;
  if (target) {
    printSavedPhoto(target);
  }
}

function cancelPrintFromPreview() {
  // Dismiss the preview without printing. The saved file remains on
  // disk so the user can use the "Print Again" button later if they
  // change their mind.
  showPreview.value = false;
  countdownPaused = false;
  console.log("[Preview] User cancelled — skipping print");
}

function goToQRView() {
  // Cancel the auto-advance FIRST. The Done button routes through here,
  // and without this the interval kept running after unmount.
  stopCountdown();
  if (isUnmounted) return;
  // Navigate to QR view to show download QR code
  router.push("/qr");
}

// ── Reprint path (admin Gallery → "Reprint") ──
// Replays a past session: rebuilds the print composite via the SAME
// createCompositeImage path a fresh print uses (so the output is
// pixel-identical), prints it `reprintCopies` times, then returns to
// the admin panel. Deliberately skips ALL live side-effects — no
// save-to-Pictures, no Cloudinary upload, no recent-strip entry, no
// QR — because this is a re-print of an existing order, not a new
// session.
async function runReprint() {
  printStatus.value = "printing";
  try {
    const printComposite = await createCompositeImage("print");
    if (!window.electronAPI || !printComposite) {
      console.error(
        "[Reprint] no composite (missing electronAPI or template) — aborting",
      );
      printStatus.value = "error";
      printError.value =
        "Couldn't rebuild the print — the template may no longer exist.";
      return;
    }
    // Transient temp file just for the print job (same as a fresh
    // print's print sheet — never lands in the user's Pictures).
    const saved = await window.electronAPI.saveTempPhoto(printComposite);
    if (!saved.success || !saved.path) {
      printStatus.value = "error";
      printError.value = saved.error || "Failed to stage reprint";
      return;
    }
    // Exact reprint count, decoupled from the kiosk-wide printCopies
    // setting (the old per-copy loop multiplied by it: 3 reprints on a
    // 2-copy kiosk printed 6 sheets). The electron print handler clamps
    // a single job to 10 driver copies, so larger counts are sent as
    // chunked jobs — 25 ⇒ 10 + 10 + 5 — instead of silently truncating.
    let remaining = Math.max(1, store.reprintCopies);
    console.log(`[Reprint] printing ${remaining} copy/copies`);
    while (remaining > 0) {
      const batch = Math.min(10, remaining);
      await printSavedPhoto(saved.path, batch);
      if (printStatus.value === "error") break; // don't keep feeding a failing printer
      remaining -= batch;
    }
  } catch (err) {
    console.error("[Reprint] failed:", err);
    printStatus.value = "error";
    printError.value =
      err instanceof Error ? err.message : "Reprint error";
  } finally {
    const returnTo = store.reprintReturnRoute;
    store.clearReprintMode();
    // A customer "print more copies" reprint keeps the session alive so
    // they can reprint again from the QR screen; an admin reprint clears
    // it. Only reset when not returning to the guest-facing QR screen.
    if (returnTo !== "/qr") store.resetSession();
    // Hold briefly on the status so success/error is visible, then
    // return to wherever the reprint was launched from.
    reprintReturnTimer = setTimeout(() => {
      if (!isUnmounted) router.push(returnTo);
    }, 1800);
  }
}

onMounted(async () => {
  // Reprint replay takes priority and bypasses the normal flow.
  if (store.reprintMode) {
    await runReprint();
    return;
  }

  if (!store.hasAllPhotos) {
    router.push("/");
    return;
  }

  await saveComposite();
  startCountdown();
});

// This view previously had NO teardown hook at all, which is what let
// its auto-advance interval outlive the component and hijack a later
// guest's session. Every deferred navigation here must die with the view.
onUnmounted(() => {
  isUnmounted = true;
  stopCountdown();
  if (reprintReturnTimer) {
    clearTimeout(reprintReturnTimer);
    reprintReturnTimer = null;
  }
});
</script>

<template>
  <div class="printing-screen">
    <!-- Done Button — hidden while a print job is in flight so the guest
         can't leave the screen mid-print. -->
    <button
      v-if="printStatus !== 'printing'"
      class="wood-btn done-btn"
      @click="goToQRView"
    >
      Done
    </button>

    <!-- Photo Output Visualization -->
    <div class="output-area">
      <div class="printer-slot">
        <div class="slot-frame">
          <div class="slot-screen">
            <!-- SVG frame in front of the slot (gradient trapezoid shape) -->
            <svg
              class="slot-screen-svg"
              viewBox="0 0 657 439"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <defs>
                <linearGradient
                  id="slotScreenGradient"
                  x1="328.45"
                  y1="438.66"
                  x2="328.45"
                  y2="3.54"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop />
                  <stop offset="0.12" stop-color="#151313" />
                  <stop offset="0.36" stop-color="#3D3738" />
                  <stop offset="0.49" stop-color="#4D4547" />
                  <stop offset="1" stop-color="#1F1B1C" />
                </linearGradient>
              </defs>
              <path
                d="M529.83 138.5C529.83 89.63 530.19 42.92 533.04 0H130.44C132.97 41.41 133.3 86.23 133.3 133.03C133.3 258.01 80.89 368.89 0 438.17H656.92C579.57 368.6 529.84 260.23 529.84 138.49L529.83 138.5Z"
                fill="url(#slotScreenGradient)"
              />
            </svg>
            <!-- Photo strip on top, centered — falls into slot on appear -->
            <div class="slot-screen-content">
              <div
                class="falling-photo-strip mini-strip"
                v-if="store.capturedPhotos.length > 0"
              >
                <img
                  v-for="photo in store.capturedPhotos"
                  :key="photo.id"
                  :src="photo.dataUrl"
                  alt="Photo"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Print Status -->
      <div class="print-status-area">
        <div v-if="printStatus === 'printing'" class="print-status print-status--printing">
          <span class="print-icon">🖨️</span>
          <span>Printing your photo…</span>
        </div>
        <div v-else-if="printStatus === 'success'" class="print-status print-status--success">
          <span class="print-icon">✅</span>
          <span>Photo printed!</span>
          <!-- "Print Again" removed from the success state — once a
               session has printed, the operator does any additional
               copies from the admin Gallery's Reprint flow instead.
               The Retry button below is intentionally kept for the
               error state (failed prints still need a way to retry). -->
        </div>
        <div v-else-if="printStatus === 'error'" class="print-status print-status--error">
          <span class="print-icon">⚠️</span>
          <span>Print failed: {{ printError }}</span>
          <button
            v-if="savedPath"
            class="print-again-btn"
            @click="printSavedPhoto(printPath || savedPath)"
          >
            Retry
          </button>
        </div>
      </div>

      <!-- Delivery Message -->
      <div class="delivery-plaque">
        <span class="plaque-bolt plaque-bolt--tl" aria-hidden="true"></span>
        <span class="plaque-bolt plaque-bolt--tr" aria-hidden="true"></span>
        <span class="plaque-bolt plaque-bolt--bl" aria-hidden="true"></span>
        <span class="plaque-bolt plaque-bolt--br" aria-hidden="true"></span>
        <div class="plaque-content">
          <div class="plaque-arrow">↑</div>
          <div class="plaque-text">
            <em>Please wait</em>
            <span>for your photos</span>
            <span>to print</span>
          </div>
          <div class="plaque-countdown">
            Continuing in <strong>{{ countdownSeconds }}</strong> sec
          </div>
        </div>
      </div>
    </div>

    <!-- Print Preview Modal -->
    <div v-if="showPreview" class="preview-overlay" @click.self="cancelPrintFromPreview">
      <div class="preview-modal">
        <h2 class="preview-title">Print Preview</h2>
        <p class="preview-subtitle">
          This is exactly what will be printed (1800×1200, before the DNP cut splits it into two strips).
        </p>
        <div class="preview-image-wrap">
          <img :src="previewDataUrl" alt="Print preview" class="preview-image" />
        </div>
        <div class="preview-legend">
          <span class="legend-dot legend-dot--cut"></span>
          <span>The dashed line shows where the printer will cut — each half becomes one strip.</span>
        </div>
        <div class="preview-buttons">
          <button class="preview-btn preview-btn--cancel" @click="cancelPrintFromPreview">
            Cancel (don't print)
          </button>
          <button class="preview-btn preview-btn--print" @click="confirmPrintFromPreview">
            Print it
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.printing-screen {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  position: relative;
}

/* Done Button */
/* Done Button — appearance from shared .wood-btn; layout here. Inset
   past the corner ornament (~170px) so it never overlaps it. */
.done-btn {
  position: absolute;
  top: 2.5rem;
  right: 7rem;
  font-size: 1.5rem;
  padding: 0.65rem 2.4rem;
  z-index: 10;
}

/* Output Area */
.output-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2rem;
}

/* Printer Slot */
.printer-slot {
  perspective: 1000px;
}

.slot-frame {
  width: 500px;
  padding: 20px;
  background: linear-gradient(150deg, #fcaf4a 0%, #ffdd8f 52%, #fcaf4a 100%);

  border-radius: 16px;
  box-shadow:
    0 10px 40px rgba(61, 43, 31, 0.4),
    inset 0 2px 10px rgba(255, 255, 255, 0.3);
}

.slot-screen {
  background: linear-gradient(0deg, #4d4547 0%, #000000 100%);
  position: relative;
  border-radius: 8px;
  padding: 0;
  min-height: 250px;
  overflow: hidden;
  box-shadow: inset 0 4px 20px rgba(0, 0, 0, 0.5);
}

/* SVG frame in front: fills the slot, gradient trapezoid */
.slot-screen-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: fill;
}

/* Photo strip layer on top of SVG */
.slot-screen-content {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 250px;
  padding: 24px;
}

/* Falling animation: strip drops into the slot, loops for ~10s then
   stops. It rests at a slight clockwise tilt (v2 design). */
.falling-photo-strip {
  animation: fall-into-slot 0.7s cubic-bezier(0.34, 1.2, 0.64, 1) 14 forwards;
  transform: translateY(-100%) rotate(10deg);
}

@keyframes fall-into-slot {
  0% {
    transform: translateY(-100%) rotate(10deg);
    opacity: 0.6;
  }
  70% {
    transform: translateY(4%) rotate(10deg);
    opacity: 1;
  }
  85% {
    transform: translateY(-2%) rotate(10deg);
  }
  100% {
    transform: translateY(0) rotate(10deg);
    opacity: 1;
  }
}

.mini-strip {
  display: flex;
  gap: 8px;
  padding: 8px;
  background: var(--color-cream);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}

.mini-strip img {
  width: 100px;
  height: 75px;
  object-fit: cover;
  border: 1px solid var(--color-brown-light);
}

/* Print Status */
.print-status-area {
  min-height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.print-status {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 600;
  padding: 0.75rem 1.5rem;
  border-radius: 12px;
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.print-status--printing {
  background: rgba(61, 43, 31, 0.08);
  color: var(--color-brown-dark);
  border: 1.5px solid var(--color-brown-light);
}

.print-status--success {
  background: rgba(60, 120, 60, 0.1);
  color: #2d6a2d;
  border: 1.5px solid #7cb87c;
}

.print-status--error {
  background: rgba(160, 40, 40, 0.1);
  color: #a02828;
  border: 1.5px solid #e07070;
}

.print-icon {
  font-size: 1.4rem;
}

.print-again-btn {
  margin-left: 0.5rem;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  padding: 0.4rem 1rem;
  background: var(--color-brown);
  color: var(--color-cream);
  border: none;
  border-radius: 20px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.print-again-btn:hover {
  background: var(--color-brown-dark);
}

/* Delivery Plaque */
.delivery-plaque {
  position: relative;
  background: linear-gradient(
    180deg,
    #c0c0c0 0%,
    #a0a0a0 20%,
    #808080 80%,
    #606060 100%
  );
  padding: 4px;
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.3),
    inset 0 1px 2px rgba(255, 255, 255, 0.5);
}

/* Four corner bolts (v2): recessed dark screws, one per corner. */
.plaque-bolt {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, #6a6a6a 0%, #3a3a3a 55%, #1c1c1c 100%);
  box-shadow:
    inset 0 1px 1px rgba(0, 0, 0, 0.6),
    0 1px 0 rgba(255, 255, 255, 0.35);
  z-index: 2;
}

.plaque-bolt--tl {
  top: 10px;
  left: 10px;
}
.plaque-bolt--tr {
  top: 10px;
  right: 10px;
}
.plaque-bolt--bl {
  bottom: 10px;
  left: 10px;
}
.plaque-bolt--br {
  bottom: 10px;
  right: 10px;
}

.plaque-content {
  background: linear-gradient(180deg, #e8e8e8 0%, #d0d0d0 50%, #b8b8b8 100%);
  padding: 1.5rem 2rem;
  border-radius: 6px;
  text-align: center;
}

.plaque-arrow {
  font-size: 2rem;
  color: #333;
  margin-bottom: 0.5rem;
}

.plaque-text {
  display: flex;
  flex-direction: column;
  font-family: var(--font-display);
  color: #333;
}

.plaque-text em {
  font-size: 2rem;
  font-weight: 700;
  font-style: italic;
}

.plaque-text span {
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 2px;
}

.plaque-countdown {
  margin-top: 0.75rem;
  font-family: var(--font-display);
  font-size: 1rem;
  color: #333;
}

.plaque-countdown strong {
  font-size: 1.25rem;
  color: var(--color-brown-dark);
}

/* Print Preview Modal */
.preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 2rem;
}

.preview-modal {
  background: #fff;
  border-radius: 12px;
  padding: 2rem;
  max-width: 90vw;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
}

.preview-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.75rem;
  color: #222;
  text-align: center;
}

.preview-subtitle {
  margin: 0;
  font-size: 0.95rem;
  color: #555;
  text-align: center;
}

.preview-image-wrap {
  flex: 1;
  overflow: auto;
  background: repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 20px 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.preview-image {
  max-width: 100%;
  max-height: 60vh;
  object-fit: contain;
  display: block;
}

/* Overlay a dashed vertical line at x=50% to indicate the DNP cut */
.preview-image-wrap::after {
  content: "";
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 50%;
  width: 0;
  border-left: 2px dashed #ff3b30;
  pointer-events: none;
  opacity: 0.7;
}

.preview-legend {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #666;
  justify-content: center;
}

.legend-dot--cut {
  display: inline-block;
  width: 24px;
  height: 0;
  border-top: 2px dashed #ff3b30;
}

.preview-buttons {
  display: flex;
  gap: 1rem;
  justify-content: center;
}

.preview-btn {
  font-family: var(--font-display);
  font-size: 1.1rem;
  font-weight: 600;
  padding: 0.75rem 2rem;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.1s;
}

.preview-btn:active {
  transform: translateY(1px);
}

.preview-btn--cancel {
  background: #e6e6e6;
  color: #333;
}

.preview-btn--cancel:hover {
  background: #d6d6d6;
}

.preview-btn--print {
  background: var(--color-brown-dark, #6b4a2b);
  color: #fff;
}

.preview-btn--print:hover {
  background: #553820;
}
</style>
