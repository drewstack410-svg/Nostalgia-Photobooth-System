import { computed, type CSSProperties } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import {
  kioskBoxStyle,
  kioskButtonCssVars,
  kioskItemDef,
  kioskTextCss,
  type KioskScreenId,
} from "@/utils/kioskLayout";
import { parseTextStyle } from "@/utils/welcomeLayout";

/** Guest-side helper: apply a saved Screen Editor layout, or keep CSS. */
export function useKioskScreen(screenId: KioskScreenId) {
  const store = usePhotoboothStore();
  const layout = computed(() => store.kioskLayoutOf(screenId));
  const laidOut = computed(() => !!layout.value);

  function boxStyle(itemId: string): CSSProperties | undefined {
    const laid = layout.value;
    if (!laid) return undefined;
    const box = laid.items[itemId];
    if (!box) return undefined;
    return kioskBoxStyle(box, laid.order, itemId);
  }

  function textOf(itemId: string) {
    const saved = layout.value?.texts[itemId];
    if (saved) return parseTextStyle(saved);
    return kioskItemDef(screenId, itemId)?.text ?? parseTextStyle(undefined);
  }

  function textStyle(itemId: string): CSSProperties | undefined {
    if (!layout.value) return undefined;
    return kioskTextCss(textOf(itemId));
  }

  function buttonLabel(itemId: string, fallback: string) {
    return layout.value?.buttons[itemId]?.label?.trim() || fallback;
  }

  function buttonLook(itemId: string): CSSProperties | undefined {
    const laid = layout.value;
    if (!laid) return undefined;
    const box = laid.items[itemId];
    const style = laid.buttons[itemId];
    if (!box) return undefined;
    return {
      ...kioskBoxStyle(box, laid.order, itemId),
      ...(style ? kioskButtonCssVars(style) : {}),
    };
  }

  function buttonArt(itemId: string): string | undefined {
    return layout.value?.buttons[itemId]?.imageSrc;
  }

  const colorBg = computed(() =>
    layout.value?.backgroundFill === "color"
      ? layout.value.backgroundColor
      : null,
  );

  const mediaBg = computed(() => {
    if (!layout.value || layout.value.backgroundFill === "color") return null;
    const url =
      layout.value.backgroundFill === "theme"
        ? store.kioskThemeBackgroundUrl(screenId)
        : store.kioskBackgroundUrl(screenId);
    if (!url) return null;
    return {
      url,
      type:
        layout.value.backgroundFill === "theme"
          ? store.kioskThemeBackgroundType(screenId)
          : store.kioskBackgroundType(screenId),
    };
  });

  return {
    layout,
    laidOut,
    boxStyle,
    textOf,
    textStyle,
    buttonLabel,
    buttonLook,
    buttonArt,
    colorBg,
    mediaBg,
  };
}
