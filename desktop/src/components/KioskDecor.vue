<script setup lang="ts">
import { usePhotoboothStore } from "@/stores/photobooth";
import { useKioskScreen } from "@/composables/useKioskScreen";
import {
  kioskBoxStyle,
  kioskTextCss,
  type KioskScreenId,
} from "@/utils/kioskLayout";
import {
  assetItemId,
  parseTextStyle,
  type WelcomeAsset,
} from "@/utils/welcomeLayout";

const props = defineProps<{
  screenId: KioskScreenId;
}>();

const store = usePhotoboothStore();
const { layout, colorBg, mediaBg } = useKioskScreen(props.screenId);

function assetStyle(asset: WelcomeAsset) {
  const laid = layout.value;
  if (!laid) return undefined;
  const id = assetItemId(asset.id);
  const t = asset.kind === "text" ? parseTextStyle(asset.text) : null;
  return {
    ...kioskBoxStyle(asset, laid.order, id),
    position: "absolute" as const,
    ...(t
      ? {
          display: "flex",
          flexDirection: "column" as const,
          justifyContent:
            t.valign === "top"
              ? "flex-start"
              : t.valign === "bottom"
                ? "flex-end"
                : "center",
        }
      : {}),
  };
}
</script>

<template>
  <div v-if="colorBg" class="kiosk-decor-bg" :style="{ backgroundColor: colorBg }" />
  <div v-else-if="mediaBg?.url" class="kiosk-decor-bg">
    <img
      v-if="mediaBg.type === 'image'"
      :src="mediaBg.url"
      alt=""
      class="kiosk-decor-media"
    />
    <video
      v-else
      :src="mediaBg.url"
      class="kiosk-decor-media"
      autoplay
      muted
      loop
      playsinline
    />
  </div>
  <div
    v-for="asset in layout?.assets || []"
    :key="asset.id"
    class="kiosk-decor-asset"
    :style="assetStyle(asset)"
  >
    <div
      v-if="asset.kind === 'text'"
      class="kiosk-decor-text"
      :style="kioskTextCss(parseTextStyle(asset.text))"
    >
      {{ parseTextStyle(asset.text).content }}
    </div>
    <video
      v-else-if="asset.kind === 'video'"
      :src="asset.src"
      muted
      loop
      playsinline
      autoplay
    />
    <img v-else :src="asset.src" :alt="asset.name" />
  </div>
</template>

<style scoped>
.kiosk-decor-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.kiosk-decor-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.kiosk-decor-asset {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
  z-index: 40;
}

.kiosk-decor-asset img,
.kiosk-decor-asset video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.kiosk-decor-text {
  width: 100%;
  height: 100%;
  white-space: pre-wrap;
  overflow: hidden;
}
</style>
