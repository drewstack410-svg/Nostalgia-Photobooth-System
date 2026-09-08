<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useDashboardStore } from "@/stores/dashboard";
import { usePhotoboothStore } from "@/stores/photobooth";
import SettingsView from "./SettingsView.vue";
import DashboardView from "./DashboardView.vue";
import GalleryView from "./GalleryView.vue";

// Login was removed — the admin panel is reached directly via the
// three-tap badge gesture on the Title screen. No `authStore` here
// because there's nothing to authenticate against.
const router = useRouter();
const dashboardStore = useDashboardStore();
const activeTab = ref<"settings" | "dashboard" | "gallery">("dashboard");

function goBack() {
  router.push("/");
}

onMounted(() => {
  // Ensure photobooth has loaded (template id migration runs on
  // store creation) before dashboard applies it.
  usePhotoboothStore();
  dashboardStore.initFromPocketBase();
});
</script>

<template>
  <div class="admin-panel">
    <aside class="admin-sidebar">
      <div class="admin-sidebar__brand">
        <h1 class="admin-sidebar__title">Admin</h1>
      </div>
      <nav class="admin-sidebar__nav">
        <button
          type="button"
          class="admin-sidebar__item admin-sidebar__item--back"
          @click="goBack"
        >
          <svg
            class="admin-sidebar__back-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <button
          type="button"
          class="admin-sidebar__item"
          :class="{ active: activeTab === 'dashboard' }"
          @click="activeTab = 'dashboard'"
        >
          Dashboard
        </button>
        <button
          type="button"
          class="admin-sidebar__item"
          :class="{ active: activeTab === 'gallery' }"
          @click="activeTab = 'gallery'"
        >
          Gallery
        </button>
        <button
          type="button"
          class="admin-sidebar__item"
          :class="{ active: activeTab === 'settings' }"
          @click="activeTab = 'settings'"
        >
          Settings
        </button>
        <!-- Logout button removed — no login flow means nothing to
             log out from. The "Back" button at the top of the
             sidebar returns to the Title screen. -->
      </nav>
    </aside>

    <main class="admin-main">
      <header class="admin-main__header">
        <h1 class="admin-main__title">
          {{
            activeTab === "dashboard"
              ? "Dashboard"
              : activeTab === "settings"
                ? "Settings"
                : "Gallery"
          }}
        </h1>
      </header>

      <DashboardView v-show="activeTab === 'dashboard'" />
      <SettingsView v-show="activeTab === 'settings'" />
      <GalleryView v-show="activeTab === 'gallery'" />
    </main>
  </div>
</template>

<style scoped>
.admin-panel {
  height: 100%;
  display: flex;
  background: transparent;
  overflow: hidden;
  position: relative;
}

.admin-sidebar {
  flex-shrink: 0;
  width: 220px;
  display: flex;
  flex-direction: column;
  background: var(--color-cream-dark);
  border-right: 2px solid var(--color-brown-light);
}

.admin-sidebar__brand {
  display: flex;
  align-items: center;
  padding: 1.25rem;
  border-bottom: 2px solid var(--color-brown-light);
  margin-bottom: 1rem;
}

.admin-sidebar__title,
.admin-main__title {
  font-family: var(--font-display);
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0;
}

.admin-sidebar__nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0 0.75rem;
}

.admin-sidebar__item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.65rem 1rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-family: var(--font-display);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-brown);
  cursor: pointer;
  text-align: left;
  transition:
    background 0.2s ease,
    color 0.2s ease;
}

.admin-sidebar__item:hover {
  background: rgba(61, 43, 31, 0.08);
  color: var(--color-brown-dark);
}

.admin-sidebar__item.active {
  background: var(--color-brown-dark);
  color: var(--color-cream);
}

.admin-sidebar__item--back {
  margin-bottom: 0.5rem;
  border: 1px solid var(--color-brown-light);
}

.admin-sidebar__item--back:hover {
  background: rgba(61, 43, 31, 0.06);
  border-color: var(--color-brown);
}

.admin-sidebar__item--logout {
  margin-top: 0.75rem;
  border: 1px solid var(--color-brown-light);
}

.admin-sidebar__item--logout:hover {
  background: rgba(61, 43, 31, 0.08);
  border-color: var(--color-brown);
}

.admin-sidebar__back-icon {
  width: 1.1rem;
  height: 1.1rem;
  flex-shrink: 0;
}

.admin-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.admin-main__header {
  flex-shrink: 0;
  padding: 1.25rem;
  border-bottom: 2px solid var(--color-brown-light);
}
</style>
