/** Welcome-screen layout as fractions of a 1920×1080 canvas. */

export const WELCOME_CANVAS_W = 1920;
export const WELCOME_CANVAS_H = 1080;
export const WELCOME_LOGO_NATIVE_W = 1208;
export const WELCOME_LOGO_NATIVE_H = 317;
export const WELCOME_START_NATIVE_W = 414.8;
export const WELCOME_START_NATIVE_H = 86.9;

export type WelcomeItemId = "logo" | "start";

export type WelcomeBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type WelcomeLayout = {
  logo: WelcomeBox;
  start: WelcomeBox;
};

export function clampBox(box: WelcomeBox): WelcomeBox {
  const w = Math.min(0.95, Math.max(0.05, box.w));
  const h = Math.min(0.95, Math.max(0.04, box.h));
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, box.x)),
    y: Math.min(1 - h, Math.max(0, box.y)),
  };
}

export function defaultWelcomeLayout(
  logoScale = 1,
  btnScale = 0.8,
): WelcomeLayout {
  const logoW = (WELCOME_LOGO_NATIVE_W * logoScale) / WELCOME_CANVAS_W;
  const logoH = (WELCOME_LOGO_NATIVE_H * logoScale) / WELCOME_CANVAS_H;
  const logo = clampBox({
    x: (1 - logoW) / 2,
    y: 0.288,
    w: logoW,
    h: logoH,
  });
  const btnW = (WELCOME_START_NATIVE_W * btnScale) / WELCOME_CANVAS_W;
  const btnH = (WELCOME_START_NATIVE_H * btnScale) / WELCOME_CANVAS_H;
  const gap = (77 * btnScale) / WELCOME_CANVAS_H;
  const start = clampBox({
    x: (1 - btnW) / 2,
    y: logo.y + logo.h + gap,
    w: btnW,
    h: btnH,
  });
  return { logo, start };
}

function isBox(v: unknown): v is WelcomeBox {
  if (!v || typeof v !== "object") return false;
  const b = v as WelcomeBox;
  return [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && isFinite(n));
}

export function parseWelcomeLayout(raw: unknown): WelcomeLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<WelcomeLayout>;
  if (!isBox(o.logo) || !isBox(o.start)) return null;
  return { logo: clampBox(o.logo), start: clampBox(o.start) };
}

export function resizeBox(
  start: WelcomeBox,
  handle: "nw" | "ne" | "sw" | "se",
  dx: number,
  dy: number,
): WelcomeBox {
  const aspect = start.w / start.h || 1;
  let { x, y, w, h } = start;

  if (handle.includes("e")) w = start.w + dx;
  if (handle.includes("w")) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (handle.includes("s")) h = start.h + dy;
  if (handle.includes("n")) {
    h = start.h - dy;
    y = start.y + dy;
  }

  w = Math.max(0.05, w);
  h = w / aspect;

  if (handle.includes("n")) y = start.y + start.h - h;
  if (handle.includes("w")) x = start.x + start.w - w;

  return clampBox({ x, y, w, h });
}
