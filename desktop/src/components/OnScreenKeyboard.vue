<script setup lang="ts">
import { ref } from "vue";

interface Props {
  modelValue: string;
  inputType?: "text" | "password";
  placeholder?: string;
}

interface Emits {
  (e: "update:modelValue", value: string): void;
  (e: "enter"): void;
}

const props = withDefaults(defineProps<Props>(), {
  inputType: "text",
  placeholder: "",
});

const emit = defineEmits<Emits>();

const isShift = ref(false);
const isCapsLock = ref(false);

const rows = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

const numbers = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const symbols = ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"];
const showNumbers = ref(false);

/**
 * Handles key press
 */
function handleKeyPress(key: string) {
  if (key === "shift") {
    isShift.value = !isShift.value;
    return;
  }

  if (key === "caps") {
    isCapsLock.value = !isCapsLock.value;
    return;
  }

  if (key === "space") {
    emit("update:modelValue", props.modelValue + " ");
    return;
  }

  if (key === "backspace") {
    emit("update:modelValue", props.modelValue.slice(0, -1));
    return;
  }

  if (key === "enter") {
    emit("enter");
    return;
  }

  if (key === "numbers") {
    showNumbers.value = !showNumbers.value;
    return;
  }

  // Determine case
  let char = key;
  if (showNumbers.value) {
    // Handle numbers/symbols
    const numIndex = numbers.indexOf(key);
    if (numIndex !== -1) {
      char = isShift.value ? symbols[numIndex] : numbers[numIndex];
    }
  } else {
    // Handle letters
    if (isShift.value || isCapsLock.value) {
      char = key.toUpperCase();
    }
    if (isShift.value) {
      isShift.value = false; // Auto-disable shift after use
    }
  }

  emit("update:modelValue", props.modelValue + char);
}

/**
 * Gets display character for key
 */
function getDisplayChar(key: string): string {
  if (showNumbers.value && numbers.includes(key)) {
    const numIndex = numbers.indexOf(key);
    return isShift.value ? symbols[numIndex] : numbers[numIndex];
  }
  if (isShift.value || isCapsLock.value) {
    return key.toUpperCase();
  }
  return key;
}
</script>

<template>
  <div class="keyboard-container">
    <div class="keyboard">
      <!-- Numbers/Symbols Row -->
      <div v-if="showNumbers" class="keyboard-row">
        <button
          type="button"
          v-for="num in numbers"
          :key="num"
          class="key"
          @click="handleKeyPress(num)"
        >
          <span class="key-main">{{ getDisplayChar(num) }}</span>
          <span v-if="symbols[numbers.indexOf(num)]" class="key-alt">{{
            symbols[numbers.indexOf(num)]
          }}</span>
        </button>
        <button
          type="button"
          class="key key-special"
          @click="showNumbers = false"
        >
          ABC
        </button>
      </div>

      <!-- Letter Rows -->
      <template v-else>
        <div
          v-for="(row, rowIndex) in rows"
          :key="rowIndex"
          class="keyboard-row"
        >
          <button
            type="button"
            v-for="key in row"
            :key="key"
            class="key"
            @click="handleKeyPress(key)"
          >
            {{ getDisplayChar(key) }}
          </button>
          <button
            type="button"
            v-if="rowIndex === 0"
            class="key key-special"
            @click="handleKeyPress('backspace')"
          >
            ⌫
          </button>
        </div>
      </template>

      <!-- Bottom Row -->
      <div class="keyboard-row">
        <button
          type="button"
          class="key key-special key-wide"
          @click="handleKeyPress('caps')"
          :class="{ active: isCapsLock }"
        >
          ⇪ Caps
        </button>
        <button
          type="button"
          class="key key-special"
          @click="handleKeyPress('shift')"
          :class="{ active: isShift }"
        >
          ⇧ Shift
        </button>
        <button
          type="button"
          class="key key-special key-space"
          @click="handleKeyPress('space')"
        >
          Space
        </button>
        <button
          type="button"
          class="key key-special"
          @click="handleKeyPress('numbers')"
          :class="{ active: showNumbers }"
        >
          {{ showNumbers ? "ABC" : "123" }}
        </button>
        <button
          type="button"
          class="key key-special key-enter"
          @click="handleKeyPress('enter')"
        >
          Enter
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.keyboard-container {
  width: 100%;
  padding: 1rem 0;
  max-width: 100%;
  margin: 0;
  box-sizing: border-box;
}

.keyboard {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  background: var(--color-cream-dark);
  border: 2px solid var(--color-brown-light);
  border-radius: 12px;
  padding: 1rem;
  box-shadow: 0 4px 12px rgba(61, 43, 31, 0.15);
  width: 100%;
  max-width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  overflow: hidden;
}

.keyboard-row {
  display: flex;
  gap: 0.4rem;
  justify-content: center;
  align-items: stretch;
  width: 100%;
  flex-wrap: nowrap;
  box-sizing: border-box;
}

.key {
  min-width: 50px;
  height: 56px;
  padding: 0.5rem 0.75rem;
  background: white;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  font-family: var(--font-body);
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  touch-action: manipulation;
  user-select: none;
  flex: 1 1 auto;
  max-width: calc((100% - (0.4rem * 9)) / 10);
  box-sizing: border-box;
}

.key:hover {
  background: var(--color-cream);
  border-color: var(--color-brown);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(61, 43, 31, 0.2);
}

.key:active {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgba(61, 43, 31, 0.1);
  background: var(--color-cream-dark);
}

.key.active {
  background: linear-gradient(
    180deg,
    #f5d77a 0%,
    #e8c44d 30%,
    #c9a227 70%,
    #a68520 100%
  );
  border-color: var(--color-brown-dark);
  color: var(--color-brown-dark);
}

.key-main {
  font-size: 1rem;
  line-height: 1;
}

.key-alt {
  font-size: 0.7rem;
  line-height: 1;
  margin-top: 0.1rem;
  color: var(--color-brown-light);
}

.key-special {
  background: var(--color-cream-dark);
  font-size: 0.85rem;
}

.key-wide {
  min-width: 80px;
  flex: 1.2 1 auto;
  max-width: 120px;
}

.key-space {
  flex: 2.5 1 auto;
  min-width: 150px;
  max-width: 300px;
}

.key-enter {
  background: linear-gradient(
    180deg,
    #f5d77a 0%,
    #e8c44d 30%,
    #c9a227 70%,
    #a68520 100%
  );
  border-color: var(--color-brown-dark);
  color: var(--color-brown-dark);
  font-weight: 700;
  min-width: 80px;
  flex: 1.2 1 auto;
  max-width: 120px;
}

.key-enter:hover {
  filter: brightness(1.05);
}
</style>
