<script setup lang="ts">
import { onMounted, computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import { applyBoothConfig } from "@/lib/boothConfig";
import { checkPocketBaseConnection } from "@/lib/pocketbase";
import { checkR2Connection } from "@/services/r2";
import { startUploadQueueWatcher } from "@/services/uploadQueue";
import { useCustomFonts } from "@/composables/useCustomFonts";
import VintageTheme from "@/components/VintageTheme.vue";

const route = useRoute();
const router = useRouter();
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
const screenHasOwnBackground = computed(() => {
  const name = String(route.name || "");
  const kioskMap: Record<string, "templates" | "payment" | "camera" | "printing" | "qr"> = {
    templates: "templates",
    "bill-acceptor": "payment",
    camera: "camera",
    printing: "printing",
    qr: "qr",
  };
  const kiosk = kioskMap[name];
  if (kiosk) {
    const layout = store.kioskLayoutOf(kiosk);
    if (!layout || layout.backgroundFill === "theme") return false;
    if (layout.backgroundFill === "color") return true;
    if (kiosk === "payment") return store.hasLoadedPaymentBackground;
    return (
      store.kioskHasCustomBackground(kiosk) || store.hasLoadedTitleBackground
    );
  }
  return (
    (route.name === "title" &&
      (store.welcomeBackgroundFill === "color" ||
        (store.welcomeBackgroundFill === "media" &&
          store.hasLoadedTitleBackground))) ||
    (route.name === "bill-acceptor" && store.hasLoadedPaymentBackground)
  );
});

const isAdmin = computed(() => route.name === "admin");

const liveShowFrame = computed(
  () => !isAdmin.value && !screenHasOwnBackground.value,
);

const liveHideWoodenFrame = computed(
  () => isAdmin.value || screenHasOwnBackground.value,
);

const liveShowVintageBg = computed(() => !screenHasOwnBackground.value);

// Decorative CSS film strips only return when a title background isn't available.
const liveShowFilmRoll = computed(() => {
  if (route.name !== "title") return false;
  if (store.welcomeBackgroundFill === "color") return false;
  if (store.welcomeBackgroundFill === "theme") return true;
  return !store.effectiveTitleBackgroundUrl;
});

const liveFilmRollVariant = computed<"home" | "payment">(() =>
  route.name === "bill-acceptor" ? "payment" : "home",
);

const frozenChrome = ref<{
  showFrame: boolean;
  hideWoodenFrame: boolean;
  showVintageBg: boolean;
  showFilmRoll: boolean;
  filmRollVariant: "home" | "payment";
} | null>(null);

const showFrame = computed(
  () => frozenChrome.value?.showFrame ?? liveShowFrame.value,
);
const hideWoodenFrame = computed(
  () => frozenChrome.value?.hideWoodenFrame ?? liveHideWoodenFrame.value,
);
const showVintageBg = computed(
  () => frozenChrome.value?.showVintageBg ?? liveShowVintageBg.value,
);
const showFilmRoll = computed(
  () => frozenChrome.value?.showFilmRoll ?? liveShowFilmRoll.value,
);
const filmRollVariant = computed<"home" | "payment">(
  () => frozenChrome.value?.filmRollVariant ?? liveFilmRollVariant.value,
);

function releaseOutgoingChrome() {
  frozenChrome.value = null;
}

router.beforeEach((to, from) => {
  if (to.name === "admin" || from.name === "admin") return true;
  if (!from.name || to.name === from.name) return true;
  frozenChrome.value = {
    showFrame: liveShowFrame.value,
    hideWoodenFrame: liveHideWoodenFrame.value,
    showVintageBg: liveShowVintageBg.value,
    showFilmRoll: liveShowFilmRoll.value,
    filmRollVariant: liveFilmRollVariant.value,
  };
  return true;
});

useCustomFonts();

onMounted(async () => {
  // Booth identity first, before anything reads or writes PocketBase — this
  // machine's kiosk id and the shared server address are per-machine runtime
  // settings, not values baked into the build.
  await applyBoothConfig();
  // Fire-and-forget so a down PocketBase never delays the title screen.
  void checkPocketBaseConnection();
  void checkR2Connection();
  startUploadQueueWatcher();
  // Templates next: they come off disk now (localStorage could not hold
  // them), and this must land before the operator can reach /templates.
  await store.hydrateTemplatesFromDisk();
  store.loadRecentStrips();
  await store.loadSavedPhotos();
  await store.loadTitleBackgroundFromDisk();
  await store.loadPaymentBackgroundFromDisk();
  if (typeof store.loadKioskBackgroundsFromDisk === "function") {
    await store.loadKioskBackgroundsFromDisk();
  }
  await store.loadFilterOverlayMediaFromDisk();
  await store.loadFilterLuts();
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
      <transition
        :name="isAdmin ? '' : 'page'"
        :mode="isAdmin ? undefined : 'out-in'"
        @after-leave="releaseOutgoingChrome"
        @after-enter="releaseOutgoingChrome"
      >
        <component :is="Component" />
      </transition>
    </RouterView>
  </VintageTheme>
</template>

<style scoped>
/* Fade only — scaling the page left a gap around the static inner
   border, so the cream line sat on the film strip / wood. Keep the
   leaving screen above the frame ornaments while it fades out. */
:deep(.page-enter-active),
:deep(.page-leave-active) {
  position: relative;
  z-index: 30;
  transition: opacity 0.4s ease;
}

:deep(.page-enter-from),
:deep(.page-leave-to) {
  opacity: 0;
}
</style>
