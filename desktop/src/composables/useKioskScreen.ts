import { computed, type CSSProperties } from "vue";
import { usePhotoboothStore } from "@/stores/photobooth";
import {
  kioskBoxStyle,
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

  const colorBg = computed(() =>
    layout.value?.backgroundFill === "color"
      ? layout.value.backgroundColor
      : null,
  );

  const mediaBg = computed(() => {
    if (layout.value?.backgroundFill === "color") return null;
    if (layout.value?.backgroundFill === "theme") return null;
    if (layout.value?.backgroundFill === "media") {
      return {
        url: store.kioskBackgroundUrl(screenId),
        type: store.kioskBackgroundType(screenId),
      };
    }
    return null;
  });

  return {
    layout,
    laidOut,
    boxStyle,
    textOf,
    textStyle,
    buttonLabel,
    colorBg,
    mediaBg,
  };
}
