<script setup lang="ts">
/**
 * Booth chrome for a 1920×1080 stage: wood inset, inner line, corner flourishes.
 * Matches VintageTheme on the guest kiosk. Pointer-events none so the editor
 * can still select layers underneath.
 */
import CornerOrnament from "@/components/CornerOrnament.vue";
</script>

<template>
  <div class="vintage-chrome" aria-hidden="true">
    <div class="vintage-chrome__wood" />
    <div class="vintage-chrome__border">
      <div class="vintage-chrome__edge vintage-chrome__edge--top" />
      <div class="vintage-chrome__edge vintage-chrome__edge--right" />
      <div class="vintage-chrome__edge vintage-chrome__edge--bottom" />
      <div class="vintage-chrome__edge vintage-chrome__edge--left" />
    </div>
    <CornerOrnament position="top-left" />
    <CornerOrnament position="top-right" />
    <CornerOrnament position="bottom-left" />
    <CornerOrnament position="bottom-right" />
  </div>
</template>

<style scoped>
.vintage-chrome {
  position: absolute;
  inset: 0;
  z-index: 25;
  pointer-events: none;
}

.vintage-chrome__wood {
  position: absolute;
  inset: 0;
  background: url("/wood.svg") center / cover no-repeat;
  padding: 10px;
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: exclude;
}

.vintage-chrome__border {
  --frame-inset-top: 26px;
  --frame-inset-right: 26px;
  --frame-inset-bottom: 26px;
  --frame-inset-left: 25px;
  --frame-corner-gap: 150px;
  --frame-width-top-bottom: 4px;
  --frame-width-left-right: 5px;
  position: absolute;
  top: var(--frame-inset-top);
  right: var(--frame-inset-right);
  bottom: var(--frame-inset-bottom);
  left: var(--frame-inset-left);
}

.vintage-chrome__edge {
  position: absolute;
  background: var(--color-cream-dark);
  border-radius: 9999px;
}

.vintage-chrome__edge--top {
  top: 0;
  left: var(--frame-corner-gap);
  right: var(--frame-corner-gap);
  height: var(--frame-width-top-bottom);
}

.vintage-chrome__edge--right {
  top: var(--frame-corner-gap);
  right: 0;
  bottom: var(--frame-corner-gap);
  width: var(--frame-width-left-right);
}

.vintage-chrome__edge--bottom {
  bottom: 0;
  left: var(--frame-corner-gap);
  right: var(--frame-corner-gap);
  height: var(--frame-width-top-bottom);
}

.vintage-chrome__edge--left {
  top: var(--frame-corner-gap);
  bottom: var(--frame-corner-gap);
  left: 0;
  width: var(--frame-width-left-right);
}
</style>
