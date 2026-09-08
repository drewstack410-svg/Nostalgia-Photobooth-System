import { watch, onMounted } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import { fontFaceCss } from "@/utils/customFonts";

const CUSTOM_FONT_STYLE_ID = "nostalgia-custom-fonts";
const FONT_DISPLAY_FAMILY = "Nostalgia Custom Display";
const FONT_BODY_FAMILY = "Nostalgia Custom Body";

function buildFontCSS(
  displayFontUrl: string | null,
  bodyFontUrl: string | null,
  imported: { family: string; dataUrl: string }[],
): string {
  const blocks: string[] = [];

  if (displayFontUrl) {
    blocks.push(fontFaceCss(FONT_DISPLAY_FAMILY, displayFontUrl, 900));
  }

  if (bodyFontUrl) {
    blocks.push(fontFaceCss(FONT_BODY_FAMILY, bodyFontUrl, 700));
  }

  for (const font of imported) {
    blocks.push(fontFaceCss(font.family, font.dataUrl, 900));
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
      store.customBodyFontUrl,
      store.importedFonts,
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
    () => [
      store.customDisplayFontUrl,
      store.customBodyFontUrl,
      store.importedFonts.map((f) => f.id + f.family + f.dataUrl.length),
    ],
    update,
  );
}

export function useCustomFonts() {
  applyCustomFonts();
}
