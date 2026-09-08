/**
 * Auth store: PocketBase admin (superuser) login for the admin panel.
 * - Login uses username in the UI; .env must set VITE_ADMIN_EMAIL (real PB admin email) and optionally VITE_ADMIN_USERNAME.
 * - Create the admin in PocketBase dashboard (http://127.0.0.1:8090/_/) and use that email in VITE_ADMIN_EMAIL.
 * - lastLoginError: 'config' = missing .env, 'network' = PB unreachable, 'invalid' = wrong username/password.
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { pb } from "@/lib/pocketbase";

export const useAuthStore = defineStore("auth", () => {
  const isAuthenticated = ref(pb.authStore.isValid);

  pb.authStore.onChange(() => {
    isAuthenticated.value = pb.authStore.isValid;
  });

  const lastLoginError = ref<"invalid" | "network" | "config" | null>(null);

  /** Requires VITE_ADMIN_EMAIL in .env. If VITE_ADMIN_USERNAME is set, typed username must match. Sends envEmail to PB, not the typed username. */
  async function login(username: string, password: string): Promise<boolean> {
    lastLoginError.value = null;
    const envEmail = typeof import.meta.env?.VITE_ADMIN_EMAIL === "string" ? import.meta.env.VITE_ADMIN_EMAIL.trim() : "";
    const envUsername = typeof import.meta.env?.VITE_ADMIN_USERNAME === "string" ? import.meta.env.VITE_ADMIN_USERNAME.trim() : "";

    const usernameTrimmed = username.trim();
    if (!usernameTrimmed || !password) {
      lastLoginError.value = "invalid";
      return false;
    }

    if (!envEmail) {
      lastLoginError.value = "config";
      return false;
    }
    if (envUsername && usernameTrimmed !== envUsername) {
      lastLoginError.value = "invalid";
      return false;
    }

    try {
      await pb.admins.authWithPassword(envEmail, password);
      return true;
    } catch (err: unknown) {
      const msg = err && typeof err === "object" && "status" in err ? (err as { status: number }).status : 0;
      lastLoginError.value = msg === 0 || msg >= 500 ? "network" : "invalid";
      return false;
    }
  }

  function logout() {
    pb.authStore.clear();
    isAuthenticated.value = false;
  }

  /** Use when mounting admin panel to know if PB session is still valid (e.g. before calling initFromPocketBase). */
  function checkAuth(): boolean {
    return pb.authStore.isValid;
  }

  return {
    isAuthenticated: computed(() => isAuthenticated.value),
    lastLoginError: computed(() => lastLoginError.value),
    login,
    logout,
    checkAuth,
  };
});
