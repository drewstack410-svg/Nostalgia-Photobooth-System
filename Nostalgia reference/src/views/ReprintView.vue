<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { usePhotoboothStore } from "@/stores/photobooth";
import TemplatePreview from "@/components/TemplatePreview.vue";

// Customer-facing "print more copies" screen (v2 "Qty" design).
// Reached from the QR/Done screen after a session prints. Reuses the
// current session's captures + template — so it must be visited before
// the session is reset (the QR "Done" button resets it).
const router = useRouter();
const store = usePhotoboothStore();

const qty = ref(1);
const MAX_QTY = 10;

const template = computed(() => store.selectedTemplate);
// If we somehow land here with no live session (e.g. a refresh), send
// the guest back to the QR screen rather than showing an empty stepper.
const hasSession = computed(
  () => !!store.selectedTemplate && store.capturedPhotos.length > 0,
);

function dec() {
  if (qty.value > 1) qty.value--;
}
function inc() {
  if (qty.value < MAX_QTY) qty.value++;
}

function goBack() {
  router.push("/qr");
}

function reprint() {
  if (!hasSession.value) {
    router.push("/qr");
    return;
  }
  // Arms the reprint path (returns to /qr afterward) and hands off to
  // PrintingView, which rebuilds the exact print sheet and prints `qty`
  // copies.
  if (store.reprintCurrentSession(qty.value)) {
    router.push("/printing");
  }
}

onMounted(() => {
  if (!hasSession.value) router.push("/qr");
});
</script>

<template>
  <div class="reprint-screen">
    <div class="reprint-content">
      <!-- Qty stepper -->
      <div class="qty-stepper">
        <button
          type="button"
          class="qty-btn"
          aria-label="Fewer copies"
          :disabled="qty <= 1"
          @click="dec"
        >
          −
        </button>
        <div class="qty-value">{{ qty }}</div>
        <button
          type="button"
          class="qty-btn"
          aria-label="More copies"
          :disabled="qty >= MAX_QTY"
          @click="inc"
        >
          +
        </button>
      </div>

      <!-- Strip preview (the template being reprinted) -->
      <div class="reprint-preview">
        <TemplatePreview v-if="template" :template="template" size="full" />
      </div>

      <!-- Reprint action -->
      <button type="button" class="wood-btn reprint-btn" @click="reprint">
        Reprint
      </button>
    </div>

    <button type="button" class="ghost-btn reprint-back-btn" @click="goBack">Back</button>
  </div>
</template>

<style scoped>
.reprint-screen {
  height: 100%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 3rem;
}

.reprint-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4rem;
  width: 100%;
  max-width: 1100px;
}

/* Qty stepper — v2: round −/+ buttons flanking a pill showing the count. */
.qty-stepper {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  flex-shrink: 0;
}

/* Glossy taupe-silver round buttons with a gray ring + bevel — matches
   the Figma Qty stepper. */
.qty-btn {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 3px solid #a99e88;
  background: radial-gradient(circle at 50% 35%, #ece2cf 0%, #d2c8b2 55%, #bcb29b 100%);
  color: #2a2620;
  font-family: var(--font-display);
  font-size: 2.2rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  box-shadow:
    inset 0 2px 3px rgba(255, 255, 255, 0.55),
    inset 0 -3px 5px rgba(0, 0, 0, 0.12),
    0 3px 5px rgba(61, 43, 31, 0.22);
  transition: all 0.12s ease;
  touch-action: manipulation;
}

.qty-btn:active:not(:disabled) {
  transform: translateY(2px);
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.2),
    0 1px 3px rgba(61, 43, 31, 0.22);
}

.qty-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Cream stadium pill with a gray border (Figma). */
.qty-value {
  min-width: 110px;
  height: 66px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 1.25rem;
  border-radius: 33px;
  border: 2px solid #b0a68e;
  background: linear-gradient(180deg, #ece4d4 0%, #dcd2be 100%);
  color: #2a2620;
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 700;
  box-shadow: inset 0 2px 3px rgba(255, 255, 255, 0.5);
}

.reprint-preview {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Gold Reprint button — appearance from shared .wood-btn; layout here. */
.reprint-btn {
  flex-shrink: 0;
  font-size: 1.75rem;
  padding: 0.85rem 3rem;
}

.reprint-back-btn {
  position: absolute;
  /* Inset past the corner ornaments (~170px) so it never overlaps them. */
  bottom: 3rem;
  left: 7rem;
  font-size: 1.7rem;
  padding: 0.95rem 3.4rem;
  /* Every other anchored button carries z-index:10 so it stays above
     .frame-border (z-index:5); this was the only one without it. */
  z-index: 10;
}
</style>
