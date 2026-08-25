<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { usePhotoboothStore } from '@/stores/photobooth'

const route = useRoute()
const store = usePhotoboothStore()

const currentRoute = computed(() => route.name)

const isElectron = computed(() => !!window.electronAPI)

async function toggleFullscreen() {
  if (window.electronAPI) {
    await window.electronAPI.toggleFullscreen()
  }
}

async function quitApp() {
  if (window.electronAPI) {
    await window.electronAPI.quitApp()
  }
}
</script>

<template>
  <nav class="navbar">
    <div class="nav-brand">
      <span class="brand-icon">📸</span>
      <span class="brand-text">Photobooth</span>
    </div>

    <div class="nav-links">
      <RouterLink to="/" class="nav-link" :class="{ active: currentRoute === 'home' }">
        <span class="nav-icon">🏠</span>
        <span class="nav-label">Home</span>
      </RouterLink>

      <RouterLink to="/camera" class="nav-link" :class="{ active: currentRoute === 'camera' }">
        <span class="nav-icon">📷</span>
        <span class="nav-label">Camera</span>
      </RouterLink>

      <RouterLink to="/gallery" class="nav-link" :class="{ active: currentRoute === 'gallery' }">
        <span class="nav-icon">🖼️</span>
        <span class="nav-label">Gallery</span>
        <span v-if="store.photoCount > 0" class="badge">{{ store.photoCount }}</span>
      </RouterLink>

      <RouterLink to="/settings" class="nav-link" :class="{ active: currentRoute === 'settings' }">
        <span class="nav-icon">⚙️</span>
        <span class="nav-label">Settings</span>
      </RouterLink>
    </div>

    <div class="nav-actions" v-if="isElectron">
      <button class="nav-btn" @click="toggleFullscreen" title="Toggle Fullscreen">
        ⛶
      </button>
      <button class="nav-btn nav-btn-danger" @click="quitApp" title="Quit">
        ✕
      </button>
    </div>
  </nav>
</template>

<style scoped>
.navbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  -webkit-app-region: drag;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.brand-icon {
  font-size: 1.5rem;
}

.brand-text {
  font-size: 1.25rem;
  font-weight: 700;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.nav-links {
  display: flex;
  gap: 0.5rem;
  -webkit-app-region: no-drag;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  text-decoration: none;
  color: #a0aec0;
  transition: all 0.2s ease;
  position: relative;
}

.nav-link:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.nav-link.active {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
}

.nav-icon {
  font-size: 1.1rem;
}

.nav-label {
  font-size: 0.9rem;
  font-weight: 500;
}

.badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #e53e3e;
  color: white;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.nav-actions {
  display: flex;
  gap: 0.5rem;
  -webkit-app-region: no-drag;
}

.nav-btn {
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: #a0aec0;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 1rem;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}

.nav-btn-danger:hover {
  background: rgba(229, 62, 62, 0.8);
  color: #fff;
}
</style>
