<script setup lang="ts">
import { onMounted, computed } from "vue";
import { useRoute } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import { applyBoothConfig } from "@/lib/boothConfig";
import { checkPocketBaseConnection } from "@/lib/pocketbase";
import { checkR2Connection } from "@/services/r2";
import { useCustomFonts } from "@/composables/useCustomFonts";
import VintageTheme from "@/components/VintageTheme.vue";

const route = useRoute();
const store = usePhotoboothStore();

/**
 * True when THIS screen renders its own full-bleed background media.
 *
 * The client's background videos already contain the wooden frame, the
 * corner ornaments and the cream paper. Drawing the app's own chrome as
 * well produced the doubled border they reported ("may naiwan padin
 * border kaya nag doble") — two wooden frames and two sets of
 * ornaments, one inside the other.
 *
 * This previously only considered the TITLE screen with a CUSTOM upload,
 * so the payment screen — and both screens once the supplied videos
 * became the defaults — kept drawing the app's frame underneath.
 */
const screenHasOwnBackground = computed(
  () =>
    (route.name === "title" &&
      (store.welcomeBackgroundFill === "color" ||
        !!store.effectiveTitleBackgroundUrl)) ||
    (route.name === "bill-acceptor" && !!store.effectivePaymentBackgroundUrl),
);

const showFrame = computed(
  () => route.name !== "admin" && !screenHasOwnBackground.value,
);

const hideWoodenFrame = computed(() => screenHasOwnBackground.value);

const showVintageBg = computed(() => !screenHasOwnBackground.value);

// Decorative film strips appear on the Home (title) screen and the
// Payment screen — matching the v2 designs. Home uses the parallel
// diagonal arrangement; Payment uses the symmetric "V".
// A screen's own background media (if the operator uploaded one)
// replaces the CSS film strips on that screen.
// The client's animated background now ships as the default for both
// screens, so the CSS film strips are effectively retired — they only
// return if a background is somehow unavailable.
const showFilmRoll = computed(
  () =>
    (route.name === "title" &&
      store.welcomeBackgroundFill !== "color" &&
      !store.effectiveTitleBackgroundUrl) ||
    (route.name === "bill-acceptor" && !store.effectivePaymentBackgroundUrl),
);

const filmRollVariant = computed<"home" | "payment">(() =>
  route.name === "bill-acceptor" ? "payment" : "home",
);

useCustomFonts();

onMounted(async () => {
  // Booth identity first, before anything reads or writes PocketBase — this
  // machine's kiosk id and the shared server address are per-machine runtime
  // settings, not values baked into the build.
  await applyBoothConfig();
  // Fire-and-forget so a down PocketBase never delays the title screen.
  void checkPocketBaseConnection();
  void checkR2Connection();
  // Templates next: they come off disk now (localStorage could not hold
  // them), and this must land before the operator can reach /templates.
  await store.hydrateTemplatesFromDisk();
  store.loadRecentStrips();
  await store.loadSavedPhotos();
  await store.loadTitleBackgroundFromDisk();
  await store.loadPaymentBackgroundFromDisk();
  await store.loadFilterOverlayMediaFromDisk();
});
</script>

<template>
  <VintageTheme
    :show-frame="showFrame"
    :hide-wooden-frame="hideWoodenFrame"
    :show-vintage-bg="showVintageBg"
    :show-film-roll="showFilmRoll"
    :film-roll-variant="filmRollVariant"
  >
    <RouterView v-slot="{ Component }">
      <transition name="page" mode="out-in">
        <component :is="Component" />
      </transition>
    </RouterView>
  </VintageTheme>
</template>

<style scoped>
/* Page transition (applies to router view content) */
.page-enter-active,
.page-leave-active {
  transition:
    opacity 0.4s ease,
    transform 0.4s ease;
}

.page-enter-from {
  opacity: 0;
  transform: scale(0.98);
}

.page-leave-to {
  opacity: 0;
  transform: scale(1.02);
}
</style>
