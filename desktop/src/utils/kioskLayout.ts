/**
 * Layout for the non-Welcome kiosk screens (template choose, payment,
 * shooting, printing, QR). Same 1920×1080 fractional boxes as Welcome.
 */
import {
  assetItemId,
  assetKey,
  clampBox,
  defaultWelcomeText,
  isAssetId,
  parseTextStyle,
  WELCOME_CANVAS_H,
  WELCOME_CANVAS_W,
  type WelcomeAsset,
  type WelcomeAssetKind,
  type WelcomeBox,
  type WelcomeTextStyle,
} from "@/utils/welcomeLayout";

export { WELCOME_CANVAS_W as KIOSK_CANVAS_W, WELCOME_CANVAS_H as KIOSK_CANVAS_H };

/** Matches `.kiosk-action-btn` (13.75rem × 4.6rem at a 16px root). */
const ACTION_BTN_W_PX = 13.75 * 16;
const ACTION_BTN_H_PX = 4.6 * 16;
const ACTION_INSET_X_PX = 7 * 16;
const ACTION_INSET_Y_PX = 3 * 16;

export const KIOSK_ACTION_BTN_W = ACTION_BTN_W_PX / WELCOME_CANVAS_W;
export const KIOSK_ACTION_BTN_H = ACTION_BTN_H_PX / WELCOME_CANVAS_H;

export function kioskActionButtonBox(side: "left" | "right"): WelcomeBox {
  const insetX = ACTION_INSET_X_PX / WELCOME_CANVAS_W;
  const insetY = ACTION_INSET_Y_PX / WELCOME_CANVAS_H;
  return {
    x: side === "left" ? insetX : 1 - insetX - KIOSK_ACTION_BTN_W,
    y: 1 - insetY - KIOSK_ACTION_BTN_H,
    w: KIOSK_ACTION_BTN_W,
    h: KIOSK_ACTION_BTN_H,
  };
}

export function lockKioskActionButtonSize(box: WelcomeBox): WelcomeBox {
  return { ...box, w: KIOSK_ACTION_BTN_W, h: KIOSK_ACTION_BTN_H };
}

/**
 * Live CameraView Start is `clamp(150px, 52cqi, 220px)` in the right
 * column. At 1920×1080 that column is ~400px, so 52cqi = 208px.
 */
const START_BTN_PX = 208;
export const KIOSK_START_BTN_W = START_BTN_PX / WELCOME_CANVAS_W;
export const KIOSK_START_BTN_H = START_BTN_PX / WELCOME_CANVAS_H;

export function kioskStartButtonBox(): WelcomeBox {
  const col = 400 / WELCOME_CANVAS_W;
  const insetX = 48 / WELCOME_CANVAS_W;
  const gap = 32 / WELCOME_CANVAS_W;
  const rightX = insetX + col + gap + col * 2.4 + gap;
  return {
    x: rightX + (col - KIOSK_START_BTN_W) / 2,
    y: 0.345,
    w: KIOSK_START_BTN_W,
    h: KIOSK_START_BTN_H,
  };
}

export function lockKioskStartButtonSize(box: WelcomeBox): WelcomeBox {
  return { ...box, w: KIOSK_START_BTN_W, h: KIOSK_START_BTN_H };
}

/** Live PrintingView: 500px gold slot, 280px square plaque. */
const PRINT_SLOT_W_PX = 500;
const PRINT_SLOT_H_PX = 340;
const PRINT_PLAQUE_PX = 280;

export function kioskPrintSlotBox(): WelcomeBox {
  const w = PRINT_SLOT_W_PX / WELCOME_CANVAS_W;
  const h = PRINT_SLOT_H_PX / WELCOME_CANVAS_H;
  return { x: (1 - w) / 2, y: 0.1, w, h };
}

export function kioskPrintPlaqueBox(): WelcomeBox {
  const w = PRINT_PLAQUE_PX / WELCOME_CANVAS_W;
  const h = PRINT_PLAQUE_PX / WELCOME_CANVAS_H;
  return { x: (1 - w) / 2, y: 0.54, w, h };
}

export function kioskPrintStatusBox(): WelcomeBox {
  return { x: 0.34, y: 0.435, w: 0.32, h: 0.07 };
}

export function isKioskActionButton(
  screenId: KioskScreenId,
  itemId: string,
): boolean {
  if (itemId === "backBtn") return true;
  return screenId === "templates" && itemId === "selectBtn";
}

export type KioskScreenId =
  | "templates"
  | "payment"
  | "camera"
  | "printing"
  | "qr";

export type KioskItemKind = "text" | "button" | "logo" | "widget";
export type KioskButtonVariant = "wood" | "ghost" | "start";
export type KioskBackgroundFill = "theme" | "color" | "media";

export type KioskItemDef = {
  id: string;
  label: string;
  kind: KioskItemKind;
  box: WelcomeBox;
  text?: WelcomeTextStyle;
  buttonLabel?: string;
  buttonVariant?: KioskButtonVariant;
};

export type KioskScreenDef = {
  id: KioskScreenId;
  name: string;
  description: string;
  items: KioskItemDef[];
};

export type KioskButtonStyle = {
  label: string;
};

export type KioskLayout = {
  items: Record<string, WelcomeBox>;
  texts: Record<string, WelcomeTextStyle>;
  buttons: Record<string, KioskButtonStyle>;
  assets: WelcomeAsset[];
  order: string[];
  backgroundFill: KioskBackgroundFill;
  backgroundColor: string;
};

export const KIOSK_SCREEN_IDS: KioskScreenId[] = [
  "templates",
  "payment",
  "camera",
  "printing",
  "qr",
];

export function isKioskScreenId(id: string | null | undefined): id is KioskScreenId {
  return (
    id === "templates" ||
    id === "payment" ||
    id === "camera" ||
    id === "printing" ||
    id === "qr"
  );
}

function heading(
  content: string,
  fontSize: number,
  extra: Partial<WelcomeTextStyle> = {},
): WelcomeTextStyle {
  return {
    ...defaultWelcomeText(),
    content,
    fontSize,
    fontWeight: 700,
    align: "center",
    ...extra,
  };
}

function body(
  content: string,
  fontSize: number,
  extra: Partial<WelcomeTextStyle> = {},
): WelcomeTextStyle {
  return {
    ...defaultWelcomeText(),
    content,
    fontFamily: "var(--font-body)",
    fontSize,
    fontWeight: 400,
    align: "center",
    ...extra,
  };
}

export const KIOSK_SCREENS: KioskScreenDef[] = [
  {
    id: "templates",
    name: "Choose template",
    description: "Carousel where guests pick a photo-strip layout.",
    items: [
      {
        id: "title",
        label: "Title",
        kind: "text",
        box: { x: 0.07, y: 0.05, w: 0.42, h: 0.16 },
        text: heading("Choose Your\nTemplate", 48, {
          align: "left",
          valign: "top",
        }),
      },
      {
        id: "dots",
        label: "Progress dots",
        kind: "widget",
        box: { x: 0.58, y: 0.07, w: 0.32, h: 0.05 },
      },
      {
        id: "carousel",
        label: "Template carousel",
        kind: "widget",
        box: { x: 0.06, y: 0.22, w: 0.88, h: 0.54 },
      },
      {
        id: "backBtn",
        label: "Back button",
        kind: "button",
        box: kioskActionButtonBox("left"),
        buttonLabel: "Back",
        buttonVariant: "ghost",
      },
      {
        id: "selectBtn",
        label: "Select button",
        kind: "button",
        box: kioskActionButtonBox("right"),
        buttonLabel: "Select",
        buttonVariant: "wood",
      },
    ],
  },
  {
    id: "payment",
    name: "Payment",
    description: "Bill / QR payment before the shoot.",
    items: [
      {
        id: "logo",
        label: "Logo",
        kind: "logo",
        box: { x: 0.36, y: 0.06, w: 0.28, h: 0.12 },
      },
      {
        id: "instruction",
        label: "Instructions",
        kind: "text",
        box: { x: 0.1, y: 0.2, w: 0.8, h: 0.16 },
        text: heading(
          "Please Insert a {amount} Bill to Operate\nor Scan the QR Code for Online Payment",
          36,
        ),
      },
      {
        id: "qrFrame",
        label: "QR frame",
        kind: "widget",
        box: { x: 0.375, y: 0.38, w: 0.25, h: 0.44 },
      },
      {
        id: "progress",
        label: "Progress",
        kind: "widget",
        box: { x: 0.28, y: 0.84, w: 0.44, h: 0.07 },
      },
      {
        id: "backBtn",
        label: "Back button",
        kind: "button",
        box: kioskActionButtonBox("left"),
        buttonLabel: "Back",
        buttonVariant: "ghost",
      },
    ],
  },
  {
    id: "camera",
    name: "Shooting",
    description: "Live viewfinder, filters, and the capture button.",
    items: [
      {
        id: "strip",
        label: "Strip preview",
        kind: "widget",
        box: { x: 0.035, y: 0.08, w: 0.2, h: 0.68 },
      },
      {
        id: "viewfinder",
        label: "Viewfinder",
        kind: "widget",
        box: { x: 0.24, y: 0.06, w: 0.5, h: 0.68 },
      },
      {
        id: "filters",
        label: "Filters",
        kind: "widget",
        box: { x: 0.22, y: 0.76, w: 0.56, h: 0.16 },
      },
      {
        id: "startBtn",
        label: "Start button",
        kind: "button",
        box: kioskStartButtonBox(),
        buttonLabel: "Start",
        buttonVariant: "start",
      },
      {
        id: "counter",
        label: "Photo counter",
        kind: "text",
        box: { x: 0.74, y: 0.53, w: 0.22, h: 0.07 },
        text: body("Photo {n} of {total}", 28, { fontFamily: "var(--font-display)" }),
      },
      {
        id: "backBtn",
        label: "Back button",
        kind: "button",
        box: kioskActionButtonBox("left"),
        buttonLabel: "Back",
        buttonVariant: "ghost",
      },
    ],
  },
  {
    id: "printing",
    name: "Printing",
    description: "Printer slot, status, and the photos-delivered plaque.",
    items: [
      {
        id: "doneBtn",
        label: "Done button",
        kind: "button",
        box: { x: 0.78, y: 0.045, w: 0.14, h: 0.08 },
        buttonLabel: "Done",
        buttonVariant: "wood",
      },
      {
        id: "slot",
        label: "Printer slot",
        kind: "widget",
        box: kioskPrintSlotBox(),
      },
      {
        id: "status",
        label: "Print status",
        kind: "text",
        box: kioskPrintStatusBox(),
        text: body("Printing your photo…", 26, {
          fontFamily: "var(--font-display)",
        }),
      },
      {
        id: "plaque",
        label: "Delivery plaque",
        kind: "widget",
        box: kioskPrintPlaqueBox(),
      },
    ],
  },
  {
    id: "qr",
    name: "Photo QR",
    description: "QR code so guests can download their digital copies.",
    items: [
      {
        id: "doneBtn",
        label: "Done button",
        kind: "button",
        box: { x: 0.78, y: 0.05, w: 0.14, h: 0.09 },
        buttonLabel: "Done",
        buttonVariant: "wood",
      },
      {
        id: "title",
        label: "Title",
        kind: "text",
        box: { x: 0.1, y: 0.1, w: 0.8, h: 0.14 },
        text: heading("SCAN THIS QR CODE\nTO GET YOUR DIGITAL COPIES", 42, {
          fontFamily: 'Arial, Helvetica, "Segoe UI", sans-serif',
          color: "#2c140a",
        }),
      },
      {
        id: "qrFrame",
        label: "QR frame",
        kind: "widget",
        box: { x: 0.36, y: 0.26, w: 0.28, h: 0.5 },
      },
      {
        id: "thankYou",
        label: "Thank you",
        kind: "text",
        box: { x: 0.1, y: 0.78, w: 0.8, h: 0.14 },
        text: heading("THANK YOU!", 86, {
          fontFamily: 'Arial, Helvetica, "Segoe UI", sans-serif',
          color: "#2c140a",
        }),
      },
    ],
  },
];

export function kioskScreenDef(id: KioskScreenId): KioskScreenDef {
  return KIOSK_SCREENS.find((s) => s.id === id) ?? KIOSK_SCREENS[0]!;
}

export function kioskItemDef(
  screenId: KioskScreenId,
  itemId: string,
): KioskItemDef | undefined {
  return kioskScreenDef(screenId).items.find((i) => i.id === itemId);
}

export function kioskFixedIds(screenId: KioskScreenId): string[] {
  return kioskScreenDef(screenId).items.map((i) => i.id);
}

export function isKioskFixedId(screenId: KioskScreenId, id: string): boolean {
  return kioskFixedIds(screenId).includes(id);
}

export function isKioskMovableLayer(
  screenId: KioskScreenId,
  id: string,
): boolean {
  return isKioskFixedId(screenId, id) || isAssetId(id);
}

export function isKioskLockedLayer(
  screenId: KioskScreenId,
  id: string,
): boolean {
  return id === "background" || isKioskFixedId(screenId, id);
}

function isBox(v: unknown): v is WelcomeBox {
  if (!v || typeof v !== "object") return false;
  const b = v as WelcomeBox;
  return [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && isFinite(n));
}

function parseAssets(raw: unknown): WelcomeAsset[] {
  if (!Array.isArray(raw)) return [];
  const out: WelcomeAsset[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Partial<WelcomeAsset>;
    if (typeof a.id !== "string" || !a.id) continue;
    const kind: WelcomeAssetKind =
      a.kind === "video" ? "video" : a.kind === "text" ? "text" : "image";
    if (kind !== "text" && (typeof a.src !== "string" || !a.src)) continue;
    if (!isBox(a)) continue;
    const fallbackName =
      kind === "video" ? "Video" : kind === "text" ? "Text" : "Image";
    out.push({
      id: a.id,
      src: typeof a.src === "string" ? a.src : "",
      name:
        typeof a.name === "string" && a.name.trim() ? a.name : fallbackName,
      kind,
      ...(kind === "text" ? { text: parseTextStyle(a.text) } : {}),
      ...clampBox(a),
    });
  }
  return out;
}

function parseFill(raw: unknown): KioskBackgroundFill {
  if (raw === "color" || raw === "media" || raw === "theme") return raw;
  return "theme";
}

export function defaultKioskLayout(screenId: KioskScreenId): KioskLayout {
  const def = kioskScreenDef(screenId);
  const items: Record<string, WelcomeBox> = {};
  const texts: Record<string, WelcomeTextStyle> = {};
  const buttons: Record<string, KioskButtonStyle> = {};
  const order: string[] = [];
  for (const item of def.items) {
    items[item.id] = { ...item.box };
    if (item.text) texts[item.id] = { ...item.text };
    if (item.kind === "button") {
      buttons[item.id] = { label: item.buttonLabel || item.label };
    }
    order.push(item.id);
  }
  return {
    items,
    texts,
    buttons,
    assets: [],
    order,
    backgroundFill: screenId === "payment" ? "media" : "theme",
    backgroundColor: "#f4ead5",
  };
}

export function knownKioskIds(layout: KioskLayout, screenId: KioskScreenId): string[] {
  return [
    ...kioskFixedIds(screenId),
    ...layout.assets.map((a) => assetItemId(a.id)),
  ];
}

export function normalizeKioskLayout(
  screenId: KioskScreenId,
  layout: KioskLayout,
): KioskLayout {
  const def = kioskScreenDef(screenId);
  const items: Record<string, WelcomeBox> = {};
  const texts: Record<string, WelcomeTextStyle> = {};
  const buttons: Record<string, KioskButtonStyle> = {};
  for (const item of def.items) {
    const box = layout.items?.[item.id];
    items[item.id] = clampBox(box && isBox(box) ? box : item.box);
    if (item.text) {
      texts[item.id] = parseTextStyle(layout.texts?.[item.id] ?? item.text);
    }
    if (item.kind === "button") {
      const saved = layout.buttons?.[item.id];
      buttons[item.id] = {
        label:
          typeof saved?.label === "string" && saved.label.trim()
            ? saved.label
            : item.buttonLabel || item.label,
      };
    }
  }
  const next: KioskLayout = {
    items,
    texts,
    buttons,
    assets: layout.assets || [],
    order: layout.order || [],
    backgroundFill: parseFill(layout.backgroundFill),
    backgroundColor: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(
      layout.backgroundColor || "",
    )
      ? layout.backgroundColor
      : "#f4ead5",
  };
  for (const id of Object.keys(items)) {
    if (isKioskActionButton(screenId, id) && items[id]) {
      items[id] = lockKioskActionButtonSize(items[id]!);
    }
    if (screenId === "camera" && id === "startBtn" && items[id]) {
      items[id] = lockKioskStartButtonSize(items[id]!);
    }
  }
  if (screenId === "camera" || screenId === "printing") {
    const legacy: Record<string, WelcomeBox> =
      screenId === "camera"
        ? {
            strip: { x: 0.03, y: 0.07, w: 0.22, h: 0.7 },
            viewfinder: { x: 0.27, y: 0.05, w: 0.46, h: 0.68 },
            filters: { x: 0.27, y: 0.75, w: 0.46, h: 0.1 },
            startBtn: { x: 0.76, y: 0.28, w: 0.18, h: 0.12 },
            counter: { x: 0.74, y: 0.42, w: 0.22, h: 0.08 },
          }
        : {
            slot: { x: 0.22, y: 0.12, w: 0.56, h: 0.52 },
            status: { x: 0.25, y: 0.66, w: 0.5, h: 0.07 },
            plaque: { x: 0.38, y: 0.74, w: 0.24, h: 0.2 },
          };
    for (const item of def.items) {
      const old = legacy[item.id];
      const cur = items[item.id];
      if (!old || !cur) continue;
      const near =
        Math.abs(cur.x - old.x) < 0.015 &&
        Math.abs(cur.y - old.y) < 0.015 &&
        Math.abs(cur.w - old.w) < 0.015 &&
        Math.abs(cur.h - old.h) < 0.015;
      if (near) items[item.id] = { ...item.box };
    }
  }
  if (screenId === "printing" && items.slot && items.slot.w > 0.28) {
    items.slot = kioskPrintSlotBox();
    items.status = kioskPrintStatusBox();
    items.plaque = kioskPrintPlaqueBox();
  }
  const ids = knownKioskIds(next, screenId);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of next.order) {
    if (ids.includes(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) order.push(id);
  }
  return { ...next, order };
}

export function parseKioskLayout(
  screenId: KioskScreenId,
  raw: unknown,
): KioskLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<KioskLayout>;
  return normalizeKioskLayout(screenId, {
    items: o.items && typeof o.items === "object" ? o.items : {},
    texts: o.texts && typeof o.texts === "object" ? o.texts : {},
    buttons: o.buttons && typeof o.buttons === "object" ? o.buttons : {},
    assets: parseAssets(o.assets),
    order: Array.isArray(o.order)
      ? o.order.filter((id): id is string => typeof id === "string")
      : [],
    backgroundFill: parseFill(o.backgroundFill),
    backgroundColor:
      typeof o.backgroundColor === "string" ? o.backgroundColor : "#f4ead5",
  });
}

export function getKioskItemBox(
  layout: KioskLayout,
  id: string,
): WelcomeBox | null {
  if (isAssetId(id)) {
    const a = layout.assets.find((x) => x.id === assetKey(id));
    return a ? { x: a.x, y: a.y, w: a.w, h: a.h } : null;
  }
  return layout.items[id] ? { ...layout.items[id]! } : null;
}

export function allKioskItemBoxes(
  layout: KioskLayout,
  screenId: KioskScreenId,
): { id: string; box: WelcomeBox }[] {
  return [
    ...kioskFixedIds(screenId).map((id) => ({
      id,
      box: layout.items[id]!,
    })),
    ...layout.assets.map((a) => ({
      id: assetItemId(a.id),
      box: { x: a.x, y: a.y, w: a.w, h: a.h },
    })),
  ].filter((row) => row.box);
}

export function kioskLayerLabel(
  screenId: KioskScreenId,
  id: string,
  layout?: KioskLayout | null,
): string {
  if (id === "background") return "Background";
  const def = kioskItemDef(screenId, id);
  if (def) {
    if (def.kind === "text" && layout?.texts[id]?.content) {
      const line = layout.texts[id]!.content.split("\n")[0].trim();
      return line.slice(0, 28) || def.label;
    }
    return def.label;
  }
  if (isAssetId(id) && layout) {
    const a = layout.assets.find((x) => x.id === assetKey(id));
    if (a?.kind === "text") {
      const line = (a.text?.content || "").split("\n")[0].trim();
      return line.slice(0, 28) || a.name || "Text";
    }
    if (a?.name) return a.name;
    return a?.kind === "video" ? "Video" : "Image";
  }
  return "Layer";
}

export function kioskBoxStyle(
  box: WelcomeBox,
  order: string[],
  id: string,
): Record<string, string> {
  const i = order.indexOf(id);
  return {
    position: "absolute",
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
    zIndex: String(10 + (i < 0 ? 0 : i)),
  };
}

export function kioskTextCss(style: WelcomeTextStyle): Record<string, string> {
  return {
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize}px`,
    fontWeight: String(style.fontWeight),
    fontStyle: style.italic ? "italic" : "normal",
    textDecoration: style.underline ? "underline" : "none",
    color: style.color,
    textAlign: style.align,
    letterSpacing: `${style.letterSpacing}px`,
    lineHeight: String(style.lineHeight),
    opacity: String(style.opacity),
  };
}
