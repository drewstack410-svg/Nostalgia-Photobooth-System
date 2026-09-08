<script setup lang="ts">
import { ref } from "vue";

const props = withDefaults(
  defineProps<{
    marginTop?: string;
    svgSrc?: string;
    size?: "default" | "small";
  }>(),
  { size: "default" },
);

const emit = defineEmits<{
  click: [];
}>();

const isPressed = ref(false);

function onPointerDown() {
  isPressed.value = true;
}

function onPointerUp() {
  isPressed.value = false;
}

function onClick() {
  emit("click");
}
</script>

<template>
  <div
    class="box-button-container"
    :class="{
      'is-pressed': isPressed,
      'box-button-container--small': props.size === 'small',
    }"
    :style="props.marginTop ? { marginTop: props.marginTop } : undefined"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
  >
    <button type="button" class="box-button" @click="onClick">
      <img v-if="svgSrc" :src="svgSrc" alt="" class="box-button-svg" />
      <slot v-else>Button</slot>
    </button>
  </div>
</template>

<style scoped>
.box-button-container {
  position: relative;
  width: fit-content;
  height: fit-content !important;
  /* Measured off the client's Figma export (Home.svg): the bezel is a
     uniform 8.38px around the gold face, radius 5.51px, with a HORIZONTAL
     (90deg) brown gradient and a solid #301207 shadow offset +4.6/+4.5. */
  padding: 8.4px;
  background: linear-gradient(90deg, #6b3b11 81%, #915824 100%);
  border-radius: 5.5px;
  cursor: pointer;
  overflow: hidden;
  box-shadow:
    4.6px 4.5px 0 #301207,
    4.6px 0px 0 #301207,
    0px 4.5px 0 #301207,
    0px 0px 0 rgba(48, 18, 7, 0.15);
  transition:
    box-shadow 0.15s ease,
    transform 0.15s ease;
}

.box-button-container--small .box-button {
  padding: 0.9rem 1.6rem;
  font-size: 1.1rem;
}

.box-button-container--small .box-button-svg,
.box-button-container--small .box-button :deep(img),
.box-button-container--small .box-button :deep(svg) {
  height: 1.1em;
}

.box-button-container--small {
  padding: 4px;
}

.box-button {
  position: relative;
  font-family: var(--font-display);
  font-size: 1.4rem;
  font-weight: 700;
  padding: 1.5rem 2.5rem;
  border-radius: 2px !important;
  border: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;

  /* Figma: gold face shadow is #301207 at +2.98/+2.91. Gradient stops
     match the export exactly (#fcaf4a → #ffdd8f 52% → #fcaf4a); 150deg is
     the design's 330deg reversed, which is identical since the stops are
     symmetric. */
  box-shadow:
    3px 2.9px 0 #301207,
    3px 0px 0 #301207,
    0px 2.9px 0 #301207,
    0px 0px 0 rgba(48, 18, 7, 0.15);
  background: linear-gradient(150deg, #fcaf4a 0%, #ffdd8f 52%, #fcaf4a 100%);
  color: var(--color-brown-dark);
  overflow: hidden;
  transition: all 0.15s ease;
  touch-action: manipulation;
}

.box-button::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    150deg,
    transparent 0%,
    transparent 35%,
    rgba(255, 255, 255, 0.4) 50%,
    transparent 65%,
    transparent 100%
  );
  transform: translateX(-100%);
  transition: transform 0.6s ease;
  pointer-events: none;
}

.box-button:hover::before {
  transform: translateX(100%);
}

/* Hover & pressed: same look */
.box-button-container:hover .box-button,
.box-button-container.is-pressed .box-button {
  box-shadow:
    1px 1px 0 #301207,
    1px 0px 0 #301207,
    0px 1px 0 #301207,
    0px 0px 0 rgba(48, 18, 7, 0.15);
  transform: translate(1px, 1px);
}

.box-button-container:hover,
.box-button-container.is-pressed {
  box-shadow:
    2px 2px 0 #301207,
    2px 0px 0 #301207,
    0px 2px 0 #301207,
    0px 0px 0 rgba(48, 18, 7, 0.15);
  transform: translate(3px, 3px);
}

/* SVG content (via svgSrc prop or slot) */
.box-button-svg {
  height: 1.4em;
  width: auto;
  object-fit: contain;
  display: block;
  pointer-events: none;
}

.box-button :deep(img),
.box-button :deep(svg) {
  height: 1.4em;
  width: auto;
  object-fit: contain;
  display: block;
}
</style>
