/**
 * Detects the photo WINDOWS in a frame/overlay image by reading its
 * alpha channel — the transparent holes are where captures show through.
 *
 * WHY THIS EXISTS
 * ---------------
 * Templates used to describe their layout with a single `cellMargin`,
 * `cellGap` and `cellZoom`, and the print composite derived an evenly
 * spaced grid from those. That model cannot express real frame artwork:
 * the built-in "2x2 Layout.png" has a 54px side margin but a 106px top
 * margin, an 83px horizontal gap but a 222px vertical gap. The derived
 * grid therefore landed photos a few px off inside every window (and
 * `cellZoom: 0.8` only made it *approximately* right by coincidence),
 * which is the "hindi sakto yung captured image sa mismong layout"
 * report.
 *
 * Reading the windows straight off the artwork is exact, and it works
 * for ANY frame the operator imports later without them having to
 * hand-tune margin/gap numbers.
 *
 * Falls back to null whenever it isn't confident, so callers keep the
 * old grid maths rather than printing something unexpected.
 */

import { prepareFrameCanvas } from "@/utils/pngAlpha";

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const cache = new Map<string, WindowRect[] | null>();

/** Alpha at/below this counts as "a hole in the frame". */
const ALPHA_TRANSPARENT = 40;
/** Ignore specks: a window must be at least this fraction of the sheet. */
const MIN_AREA_FRACTION = 0.004;

/**
 * Connected-component scan over the transparent pixels, returning one
 * bounding box per window, ordered row-major (top-to-bottom, then
 * left-to-right) so window i lines up with capture i.
 */
function findWindows(
  alpha: Uint8ClampedArray,
  w: number,
  h: number,
): WindowRect[] {
  const seen = new Uint8Array(w * h);
  const rects: WindowRect[] = [];
  const minArea = w * h * MIN_AREA_FRACTION;
  // Iterative flood fill — a recursive one blows the stack on a
  // 1240x1844 sheet.
  const stack = new Int32Array(w * h);

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || alpha[start] > ALPHA_TRANSPARENT) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w, maxX = 0, minY = h, maxY = 0, area = 0;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0 && !seen[p - 1] && alpha[p - 1] <= ALPHA_TRANSPARENT) {
        seen[p - 1] = 1; stack[sp++] = p - 1;
      }
      if (x < w - 1 && !seen[p + 1] && alpha[p + 1] <= ALPHA_TRANSPARENT) {
        seen[p + 1] = 1; stack[sp++] = p + 1;
      }
      if (y > 0 && !seen[p - w] && alpha[p - w] <= ALPHA_TRANSPARENT) {
        seen[p - w] = 1; stack[sp++] = p - w;
      }
      if (y < h - 1 && !seen[p + w] && alpha[p + w] <= ALPHA_TRANSPARENT) {
        seen[p + w] = 1; stack[sp++] = p + w;
      }
    }

    if (area >= minArea) {
      rects.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      });
    }
  }

  // Row-major: group by vertical overlap, then sort each row by x.
  rects.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: WindowRect[][] = [];
  for (const r of rects) {
    const row = rows.find(
      (grp) => Math.abs(grp[0].y - r.y) < Math.min(grp[0].height, r.height) * 0.5,
    );
    if (row) row.push(r);
    else rows.push([r]);
  }
  rows.forEach((row) => row.sort((a, b) => a.x - b.x));
  return rows.flat();
}

/**
 * Window rects for a frame image, in the frame's own pixel space.
 *
 * @param expectedCount when given, the result is REJECTED (null) unless
 *   exactly this many windows are found — so a frame whose art confuses
 *   the scan falls back to the grid maths instead of misplacing photos.
 */
export async function getFrameWindows(
  src: string,
  expectedCount?: number,
): Promise<WindowRect[] | null> {
  const key = `${src}|${expectedCount ?? "any"}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  let result: WindowRect[] | null = null;
  try {
    // Knock out authored-white so white gutters count as holes, not
    // opaque sheet — same bitmap the print composite draws.
    const canvas = await prepareFrameCanvas(src);
    const w = canvas.width;
    const h = canvas.height;
    if (w && h) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        const data = ctx.getImageData(0, 0, w, h).data;
        const alpha = new Uint8ClampedArray(w * h);
        for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = data[p];

        const found = findWindows(alpha, w, h);
        // Knocking out white gutters often yields one extra blob — the
        // connected background that touches the sheet edge. Drop those
        // so the remaining interiors match the declared photo count.
        const inner = found.filter(
          (r) =>
            r.x > 1 &&
            r.y > 1 &&
            r.x + r.width < w - 1 &&
            r.y + r.height < h - 1,
        );
        const pick =
          expectedCount && inner.length === expectedCount
            ? inner
            : found;
        if (pick.length > 0 && (!expectedCount || pick.length === expectedCount)) {
          result = pick;
        } else {
          console.warn(
            `[frameWindows] ${src}: found ${found.length} window(s)` +
              (inner.length !== found.length
                ? ` (${inner.length} interior)`
                : "") +
              (expectedCount ? `, expected ${expectedCount}` : "") +
              " — falling back to grid layout",
          );
        }
      }
    }
  } catch (err) {
    console.warn("[frameWindows] detection failed, using grid layout:", err);
  }

  cache.set(key, result);
  return result;
}

/** Maps frame-space rects onto a print area of a different size. */
export function scaleWindows(
  windows: WindowRect[],
  frameW: number,
  frameH: number,
  area: { x: number; y: number; width: number; height: number },
): WindowRect[] {
  const sx = area.width / frameW;
  const sy = area.height / frameH;
  return windows.map((r) => ({
    x: area.x + r.x * sx,
    y: area.y + r.y * sy,
    width: r.width * sx,
    height: r.height * sy,
  }));
}
