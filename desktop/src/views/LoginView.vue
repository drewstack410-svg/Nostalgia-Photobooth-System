<script setup lang="ts">
/**
 * Admin login view: PocketBase admin auth via username + password.
 * - Username is mapped to real admin email in auth store (VITE_ADMIN_EMAIL / VITE_ADMIN_USERNAME in .env).
 * - Kiosk-friendly: on-screen keyboard for touch; physical keyboard closes it and Enter submits.
 * - Errors: 'network' (PB unreachable), 'config' (missing .env), 'invalid' (bad credentials).
 */
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import OnScreenKeyboard from "@/components/OnScreenKeyboard.vue";

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

/** First field is "username" in UI; auth store maps it to VITE_ADMIN_EMAIL for PocketBase. */
const email = ref("");
const password = ref("");
const errorMessage = ref("");
const isSubmitting = ref(false);
const activeInput = ref<"email" | "password" | null>(null);
const showKeyboard = ref(false);
const showPassword = ref(false);

/** Used to delay hiding on-screen keyboard so button clicks register; clear on unmount. */
let blurTimeout: ReturnType<typeof setTimeout> | null = null;
/** When true, focus does not open on-screen keyboard (user is typing with physical keyboard). */
let keyboardInputDetected = false;

async function handleLogin() {
  errorMessage.value = "";

  if (!email.value.trim() || !password.value.trim()) {
    errorMessage.value = "Please enter username and password";
    return;
  }

  isSubmitting.value = true;
  closeKeyboard();

  await new Promise((resolve) => setTimeout(resolve, 300));

  const success = await authStore.login(
    email.value.trim(),
    password.value.trim(),
  );

  if (success) {
    const redirect = (route.query.redirect as string) || "/admin";
    router.push(redirect);
  } else {
    const err = authStore.lastLoginError;
    if (err === "network") {
      errorMessage.value =
        "Cannot reach server. Is PocketBase running at " +
        (import.meta.env.VITE_POCKETBASE_URL || "http://127.0.0.1:8090") +
        "?";
    } else if (err === "config") {
      errorMessage.value =
        "Admin login not configured. In .env set VITE_ADMIN_EMAIL to your PocketBase admin email and VITE_ADMIN_USERNAME (e.g. admin), then restart the app.";
    } else {
      errorMessage.value = "Invalid username or password";
    }
    password.value = "";
  }
  isSubmitting.value = false;
}

/** Physical keyboard: mark as detected (so focus won’t open on-screen keyboard) and submit on Enter. */
function handleKeyDown(event: KeyboardEvent) {
  keyboardInputDetected = true;
  if (showKeyboard.value) closeKeyboard();
  if (event.key === "Enter" && !isSubmitting.value) handleLogin();
}

function handleKeyPress(_event: KeyboardEvent) {
  keyboardInputDetected = true;
}

function cancel() {
  router.push("/");
}

/** Mouse/touch on input: show on-screen keyboard and focus field (kiosk flow). */
function handleInputClick(
  inputType: "email" | "password",
  event: MouseEvent | TouchEvent,
) {
  keyboardInputDetected = false;
  if (blurTimeout) {
    clearTimeout(blurTimeout);
    blurTimeout = null;
  }
  activeInput.value = inputType;
  showKeyboard.value = true;
  const input = event.target as HTMLInputElement;
  if (input) input.focus();
}

/** Tab/focus: only show on-screen keyboard if focus came from click/touch, not keyboard nav. */
function handleInputFocus(inputType: "email" | "password") {
  if (keyboardInputDetected) {
    keyboardInputDetected = false;
    return;
  }
  if (blurTimeout) {
    clearTimeout(blurTimeout);
    blurTimeout = null;
  }
  activeInput.value = inputType;
  showKeyboard.value = true;
}

function closeKeyboard() {
  if (blurTimeout) {
    clearTimeout(blurTimeout);
    blurTimeout = null;
  }
  showKeyboard.value = false;
  activeInput.value = null;
  keyboardInputDetected = false;
}

/** Short delay so clicking a button (e.g. Login) gets the click before keyboard hides. */
function handleInputBlur() {
  if (blurTimeout) {
    clearTimeout(blurTimeout);
    blurTimeout = null;
  }
  blurTimeout = setTimeout(() => {
    if (document.activeElement?.tagName !== "BUTTON") closeKeyboard();
    blurTimeout = null;
  }, 200);
}

function togglePasswordVisibility() {
  showPassword.value = !showPassword.value;
}

/** On-screen keyboard Enter: move to password or submit. */
function handleKeyboardEnter() {
  if (activeInput.value === "email") {
    const passwordInput = document.getElementById(
      "password",
    ) as HTMLInputElement;
    if (passwordInput) {
      passwordInput.focus();
      activeInput.value = "password";
    }
  } else {
    handleLogin();
  }
}

const currentInputValue = computed(() => {
  if (activeInput.value === "email") return email.value;
  if (activeInput.value === "password") return password.value;
  return "";
});

function updateInputValue(value: string) {
  if (activeInput.value === "email") email.value = value;
  else if (activeInput.value === "password") password.value = value;
}

function resetFormState() {
  email.value = "";
  password.value = "";
  errorMessage.value = "";
  isSubmitting.value = false;
  activeInput.value = null;
  showKeyboard.value = false;
  showPassword.value = false;
  keyboardInputDetected = false;
  if (blurTimeout) {
    clearTimeout(blurTimeout);
    blurTimeout = null;
  }
}

watch(
  () => route.path,
  (newPath) => {
    if (newPath !== "/login") resetFormState();
  },
);

onMounted(() => {
  resetFormState();
});

onUnmounted(() => {
  if (blurTimeout) {
    clearTimeout(blurTimeout);
    blurTimeout = null;
  }
  resetFormState();
});
</script>

<template>
  <div class="login-container">
    <div class="login-card">
      <div class="login-header">
        <h1 class="login-title">Admin Login</h1>
        <p class="login-subtitle">
          Enter your credentials to access the admin panel
        </p>
      </div>

      <form @submit.prevent="handleLogin" class="login-form">
        <div class="form-group">
          <label for="email" class="form-label">Username</label>
          <input
            id="email"
            v-model="email"
            type="text"
            class="form-input"
            :class="{
              error: errorMessage,
              'keyboard-active': activeInput === 'email',
            }"
            placeholder="Username"
            autocomplete="username"
            :disabled="isSubmitting"
            @click="handleInputClick('email', $event)"
            @touchstart="handleInputClick('email', $event)"
            @focus="handleInputFocus('email')"
            @blur="handleInputBlur"
            @keydown="handleKeyDown"
            @keypress="handleKeyPress"
          />
        </div>

        <div class="form-group">
          <label for="password" class="form-label">Password</label>
          <div class="password-input-wrapper">
            <input
              id="password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              class="form-input password-input"
              :class="{
                error: errorMessage,
                'keyboard-active': activeInput === 'password',
              }"
              placeholder="Enter password"
              autocomplete="current-password"
              :disabled="isSubmitting"
              @click="handleInputClick('password', $event)"
              @touchstart="handleInputClick('password', $event)"
              @focus="handleInputFocus('password')"
              @blur="handleInputBlur"
              @keydown="handleKeyDown"
              @keypress="handleKeyPress"
            />
            <button
              type="button"
              class="password-toggle"
              :class="{ active: showPassword }"
              @click="togglePasswordVisibility"
              tabindex="-1"
              aria-label="Toggle password visibility"
            >
              <svg
                v-if="showPassword"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg
                v-else
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            </button>
          </div>
        </div>

        <div v-if="errorMessage" class="error-message">
          {{ errorMessage }}
        </div>

        <div class="form-actions">
          <button
            type="button"
            class="btn btn-secondary"
            @click="cancel"
            :disabled="isSubmitting"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="isSubmitting || !email.trim() || !password.trim()"
          >
            {{ isSubmitting ? "Logging in..." : "Login" }}
          </button>
        </div>
      </form>

      <!-- On-Screen Keyboard -->
      <div v-if="showKeyboard && activeInput" class="keyboard-wrapper">
        <OnScreenKeyboard
          :model-value="currentInputValue"
          :input-type="activeInput === 'password' ? 'password' : 'text'"
          @update:model-value="updateInputValue"
          @enter="handleKeyboardEnter"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    135deg,
    var(--color-cream) 0%,
    var(--color-cream-dark) 100%
  );
  padding: 2rem;
}

.login-card {
  background: white;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(61, 43, 31, 0.2);
  padding: 3rem;
  width: 100%;
  max-width: 800px;
  border: 3px solid var(--color-brown);
}

.login-header {
  text-align: center;
  margin-bottom: 2rem;
}

.login-title {
  font-family: var(--font-display);
  font-size: 2.5rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  margin-bottom: 0.5rem;
}

.login-subtitle {
  font-size: 1rem;
  color: var(--color-brown);
  margin: 0;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: center;
}

.password-input-wrapper {
  position: relative;
  width: 100%;
  max-width: 400px;
  margin: 0 auto;
}

.password-input {
  padding-right: 3rem;
}

.password-toggle {
  position: absolute;
  right: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-brown-light);
  transition: color 0.2s ease;
  z-index: 1;
}

.password-toggle:hover {
  color: var(--color-brown-dark);
}

.password-toggle.active {
  color: var(--color-brown-dark);
}

.password-toggle svg {
  width: 20px;
  height: 20px;
}

.form-label {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-brown-dark);
}

.form-input {
  padding: 0.875rem 1rem;
  border: 2px solid var(--color-brown);
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
  background: white;
  color: var(--color-brown-dark);
  transition: all 0.2s ease;
  max-width: 400px;
  width: 100%;
  margin: 0 auto;
}

.form-input:focus {
  outline: none;
  border-color: var(--color-brown-dark);
  box-shadow: 0 0 0 3px rgba(61, 43, 31, 0.1);
}

.form-input:disabled {
  background: #f5f5f5;
  cursor: not-allowed;
  opacity: 0.7;
}

.form-input.error {
  border-color: #dc3545;
}

.form-input.keyboard-active {
  border-color: var(--color-brown-dark);
  box-shadow: 0 0 0 3px rgba(61, 43, 31, 0.15);
}

.keyboard-wrapper {
  margin-top: 1.5rem;
  width: 100%;
  max-width: 100%;
  padding: 0;
  box-sizing: border-box;
  overflow: hidden;
}

.error-message {
  padding: 0.75rem 1rem;
  background: #fee;
  border: 2px solid #dc3545;
  border-radius: 6px;
  color: #dc3545;
  font-size: 0.9rem;
  text-align: center;
}

.form-actions {
  display: flex;
  gap: 1rem;
  margin-top: 0.5rem;
}

.btn {
  flex: 1;
  padding: 0.875rem 1.5rem;
  border: none;
  border-radius: 6px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: inherit;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background: linear-gradient(
    180deg,
    #f5d77a 0%,
    #e8c44d 30%,
    #c9a227 70%,
    #a68520 100%
  );
  color: var(--color-brown-dark);
  border: 2px solid var(--color-brown);
  box-shadow: 0 2px 0 var(--color-brown);
}

.btn-primary:hover:not(:disabled) {
  box-shadow: 0 4px 0 var(--color-brown);
  transform: translateY(-1px);
}

.btn-primary:active:not(:disabled) {
  box-shadow: 0 1px 0 var(--color-brown);
  transform: translateY(1px);
}

.btn-secondary {
  background: white;
  color: var(--color-brown-dark);
  border: 2px solid var(--color-brown);
}

.btn-secondary:hover:not(:disabled) {
  background: #f9f9f9;
}

@media (max-width: 480px) {
  .login-card {
    padding: 2rem 1.5rem;
  }

  .login-title {
    font-size: 2rem;
  }
}
</style>
