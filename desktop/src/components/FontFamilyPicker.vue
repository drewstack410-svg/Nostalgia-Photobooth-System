<script setup lang="ts">
import { computed } from "vue";
import type { ImportedFont } from "@/utils/customFonts";
import { cssFontFamilyForImported } from "@/utils/customFonts";

const props = defineProps<{
  modelValue: string;
  groups: { label: string; fonts: { label: string; value: string }[] }[];
  imported: ImportedFont[];
}>();

const emit = defineEmits<{
  "update:modelValue": [string];
  checkpoint: [];
  import: [];
  remove: [id: string];
}>();

const knownValues = computed(() => {
  const values = new Set<string>();
  for (const group of props.groups) {
    for (const font of group.fonts) values.add(font.value);
  }
  return values;
});
</script>

<template>
  <div class="font-picker">
    <select
      class="text-select"
      :value="modelValue"
      @pointerdown="emit('checkpoint')"
      @change="
        emit(
          'update:modelValue',
          ($event.target as HTMLSelectElement).value,
        )
      "
    >
      <option v-if="!knownValues.has(modelValue)" :value="modelValue">
        Custom
      </option>
      <optgroup
        v-for="group in groups"
        :key="group.label"
        :label="group.label"
      >
        <option
          v-for="font in group.fonts"
          :key="font.value"
          :value="font.value"
          :style="{ fontFamily: font.value }"
        >
          {{ font.label }}
        </option>
      </optgroup>
    </select>
    <button
      type="button"
      class="font-picker__import"
      @click="emit('import')"
    >
      Import font
    </button>
    <ul v-if="imported.length" class="font-picker__list">
      <li v-for="font in imported" :key="font.id" class="font-picker__item">
        <span
          class="font-picker__name"
          :style="{ fontFamily: cssFontFamilyForImported(font.family) }"
        >
          {{ font.family }}
        </span>
        <button
          type="button"
          class="font-picker__remove"
          :aria-label="`Remove ${font.family}`"
          @click="emit('remove', font.id)"
        >
          ×
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.font-picker {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.font-picker .text-select {
  width: 100%;
}

.font-picker__import {
  align-self: flex-start;
  padding: 0.3rem 0.65rem;
  font-family: var(--font-display);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  cursor: pointer;
}

.font-picker__import:hover {
  border-color: var(--color-brown);
}

.font-picker__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.font-picker__item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.font-picker__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9rem;
  color: var(--color-brown-dark);
}

.font-picker__remove {
  flex-shrink: 0;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-brown);
  font-size: 1.05rem;
  line-height: 1;
  cursor: pointer;
}

.font-picker__remove:hover {
  background: var(--color-cream);
  color: #b23b3b;
}
</style>
