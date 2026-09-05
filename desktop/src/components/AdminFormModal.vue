<script setup lang="ts">
defineProps<{
  /** Modal open state (use with v-model:open) */
  open?: boolean;
  /** Modal title */
  title: string;
  /** Optional description shown below title */
  description?: string;
  /** Size: default (500px), large (900px), wide (studio), or full (viewport) */
  size?: "default" | "large" | "wide" | "full";
  /** Sit above another open dialog (e.g. Photo layout over Templates). */
  nested?: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  close: [];
}>();

function close() {
  emit("update:open", false);
  emit("close");
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains("admin-form-modal__overlay")) {
    close();
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="admin-form-modal__overlay"
        :class="{
          'admin-form-modal__overlay--fill': size === 'wide' || size === 'full',
          'admin-form-modal__overlay--nested': nested,
        }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title ? 'admin-form-modal-title' : undefined"
        @click="onOverlayClick"
      >
        <div
          class="admin-form-modal"
          :class="{
            'admin-form-modal--large': size === 'large',
            'admin-form-modal--wide': size === 'wide',
            'admin-form-modal--full': size === 'full',
            'admin-form-modal--fill': size === 'wide' || size === 'full',
          }"
        >
          <div class="admin-form-modal__header">
            <h2 id="admin-form-modal-title" class="admin-form-modal__title">
              {{ title }}
            </h2>
            <button
              type="button"
              class="admin-form-modal__close"
              aria-label="Close"
              @click="close"
            >
              ×
            </button>
          </div>
          <p
            v-if="description"
            class="admin-form-modal__description"
          >
            {{ description }}
          </p>
          <div class="admin-form-modal__body">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.admin-form-modal__overlay {
  position: fixed;
  inset: 0;
  background: rgba(61, 43, 31, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1.5rem;
}

.admin-form-modal__overlay--nested {
  z-index: 1100;
}

.admin-form-modal {
  background: var(--color-cream);
  border: 2px solid var(--color-brown-dark);
  border-radius: 12px;
  max-width: 500px;
  width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(61, 43, 31, 0.3);
}

.admin-form-modal--large {
  max-width: 900px;
}

.admin-form-modal__overlay--fill {
  padding: 0.6rem;
}

.admin-form-modal--wide,
.admin-form-modal--full {
  width: 100%;
  max-width: none;
  height: 100%;
  max-height: none;
}

.admin-form-modal--fill .admin-form-modal__header {
  padding: 0.75rem 1rem 0;
}

.admin-form-modal--fill .admin-form-modal__description {
  margin: 0.25rem 1rem 0;
  font-size: 0.82rem;
}

.admin-form-modal--fill .admin-form-modal__body {
  padding: 0.65rem 1rem 0.85rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.admin-form-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem 1.25rem 0;
}

.admin-form-modal__title {
  font-family: var(--font-display);
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0;
}

.admin-form-modal__close {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-brown);
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

.admin-form-modal__close:hover {
  background: var(--color-cream-dark);
  color: var(--color-brown-dark);
}

.admin-form-modal__description {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown-light);
  margin: 0.5rem 1.25rem 0;
  padding: 0;
}

.admin-form-modal__body {
  padding: 1.25rem;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .admin-form-modal,
.modal-leave-active .admin-form-modal {
  transition: transform 0.2s ease;
}

.modal-enter-from .admin-form-modal,
.modal-leave-to .admin-form-modal {
  transform: scale(0.96);
}
</style>
