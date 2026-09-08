declare const require: (name: string) => any;

const assert = require("node:assert/strict");

import {
  findLightSlotRects,
  fitImageContain,
  fitRectContain,
  getDnpTwoInchCutPanelRects,
  getPrintCanvasSize,
} from "../src/utils/printLayout";

function closeTo(actual: number, expected: number, label: string) {
  assert.ok(
    Math.abs(actual - expected) < 0.001,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

function assertRect(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number },
  label: string,
) {
  closeTo(actual.x, expected.x, `${label}.x`);
  closeTo(actual.y, expected.y, `${label}.y`);
  closeTo(actual.width, expected.width, `${label}.width`);
  closeTo(actual.height, expected.height, `${label}.height`);
}

function makeImageData(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 170;
    data[i + 1] = 160;
    data[i + 2] = 135;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function fillRect(
  image: { width: number; data: Uint8ClampedArray },
  x: number,
  y: number,
  width: number,
  height: number,
) {
  for (let yy = y; yy < y + height; yy++) {
    for (let xx = x; xx < x + width; xx++) {
      const i = (yy * image.width + xx) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = 255;
    }
  }
}

const fittedFrame = fitRectContain(
  { width: 800, height: 1200 },
  { x: 0, y: 0, width: 1800, height: 1200 },
);
assertRect(
  fittedFrame,
  { x: 500, y: 0, width: 800, height: 1200 },
  "portrait 2x1 frame on landscape paper",
);

const portraitPhoto = fitImageContain(
  { width: 1200, height: 1800 },
  { x: 100, y: 100, width: 700, height: 420 },
);
assertRect(
  portraitPhoto,
  { x: 310, y: 100, width: 280, height: 420 },
  "portrait photo inside wide slot",
);

const landscapePhoto = fitImageContain(
  { width: 1800, height: 1200 },
  { x: 100, y: 100, width: 700, height: 420 },
);
assertRect(
  landscapePhoto,
  { x: 135, y: 100, width: 630, height: 420 },
  "landscape photo inside wide slot",
);

const frameMask = makeImageData(100, 160);
fillRect(frameMask, 10, 12, 80, 50);
fillRect(frameMask, 10, 98, 80, 50);

const slots = findLightSlotRects(frameMask, { rows: 2, cols: 1 });
assert.equal(slots.length, 2);
assertRect(slots[0], { x: 10, y: 12, width: 80, height: 50 }, "slot 1");
assertRect(slots[1], { x: 10, y: 98, width: 80, height: 50 }, "slot 2");

// `getPrintCanvasSize` is now a deprecated shim that always returns
// the 4×6-landscape print area. Dimensions are the DS-RX1's TRUE
// imageable area (1844×1240) — confirmed against both the DNP Print
// Area table and the upstream PhotoboothProject pipeline, which
// renders to the exact driver imageable area. NOT the nominal
// 1800×1200 the legacy code used to send, which forced a ~2% scale
// and caused the "white gutter on one edge" complaints in DNP
// forums. New code should consult `template.paperSize` and call
// `getPaperSizePx()` directly instead of this shim.
assert.deepEqual(getPrintCanvasSize("standard"), {
  width: 1844,
  height: 1240,
});
assert.deepEqual(getPrintCanvasSize("dnp-2-inch-cut"), {
  width: 1844,
  height: 1240,
});

// The original cut-panel test stays meaningful — `getDnpTwoInchCutPanelRects`
// just splits whatever canvas you hand it down the middle. We feed it the
// legacy 1800×1200 here so the asserted dims still read cleanly; the cut
// feature itself is currently disabled at the driver level (Path A).
const cutPanels = getDnpTwoInchCutPanelRects({
  width: 1800,
  height: 1200,
});
assert.equal(cutPanels.length, 2);
assertRect(cutPanels[0], { x: 0, y: 0, width: 900, height: 1200 }, "left cut panel");
assertRect(cutPanels[1], { x: 900, y: 0, width: 900, height: 1200 }, "right cut panel");

console.log("print layout tests passed");
