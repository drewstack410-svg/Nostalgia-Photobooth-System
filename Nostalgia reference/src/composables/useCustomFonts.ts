import { watch, onMounted } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";

const CUSTOM_FONT_STYLE_ID = "nostalgia-custom-fonts";
const FONT_DISPLAY_FAMILY = "Nostalgia Custom Display";
const FONT_BODY_FAMILY = "Nostalgia Custom Body";

/** Get @font-face format from a data URL (e.g. data:font/woff2;base64,...) */
function getFontFormat(dataUrl: string): string {
  const fontMatch = dataUrl.match(/^data:font\/(\w+);/);
  if (fontMatch) {
    const subtype = fontMatch[1].toLowerCase();
    if (subtype === "ttf") return "truetype";
    if (subtype === "otf") return "opentype";
    return subtype;
  }
  const appMatch = dataUrl.match(/^data:application\/(?:x-)?font-(\w+);/);
  if (appMatch) {
    const subtype = appMatch[1].toLowerCase();
    if (subtype === "ttf" || subtype === "truetype") return "truetype";
    if (subtype === "otf" || subtype === "opentype") return "opentype";
    return subtype;
  }
  return "woff2";
}

function buildFontCSS(
  displayFontUrl: string | null,
  bodyFontUrl: string | null
): string {
  const blocks: string[] = [];

  if (displayFontUrl) {
    const format = getFontFormat(displayFontUrl);
    const safeUrl = displayFontUrl.replace(/"/g, '\\"');
    blocks.push(`
@font-face {
  font-family: "${FONT_DISPLAY_FAMILY}";
  src: url("${safeUrl}") format("${format}");
  font-style: normal;
  font-weight: 400 900;
  font-display: swap;
}`);
  }

  if (bodyFontUrl) {
    const format = getFontFormat(bodyFontUrl);
    const safeUrl = bodyFontUrl.replace(/"/g, '\\"');
    blocks.push(`
@font-face {
  font-family: "${FONT_BODY_FAMILY}";
  src: url("${safeUrl}") format("${format}");
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
}`);
  }

  const displayValue = displayFontUrl
    ? `"${FONT_DISPLAY_FAMILY}", Georgia, serif`
    : '"Playfair Display", Georgia, serif';
  const bodyValue = bodyFontUrl
    ? `"${FONT_BODY_FAMILY}", Georgia, serif`
    : '"Cormorant Garamond", Georgia, serif';

  blocks.push(`
:root {
  --font-display: ${displayValue};
  --font-body: ${bodyValue};
}`);

  return blocks.join("\n");
}

function applyCustomFonts() {
  const store = usePhotoboothStore();
  let styleEl = document.getElementById(CUSTOM_FONT_STYLE_ID) as HTMLStyleElement | null;

  const update = () => {
    const css = buildFontCSS(
      store.customDisplayFontUrl,
      store.customBodyFontUrl
    );
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = CUSTOM_FONT_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  };

  update();
  onMounted(update);
  watch(
    () => [store.customDisplayFontUrl, store.customBodyFontUrl],
    update,
    { deep: true }
  );
}

export function useCustomFonts() {
  applyCustomFonts();
}
