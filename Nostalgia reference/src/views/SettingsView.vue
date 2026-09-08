<script setup lang="ts">
import { computed } from 'vue'
import { usePhotoboothStore } from '@/stores/photobooth'

const store = usePhotoboothStore()

const isElectron = computed(() => !!window.electronAPI)

const filters = [
  { value: 'none', label: 'No Filter' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'vintage', label: 'Vintage' },
  { value: 'cool', label: 'Cool' },
  { value: 'warm', label: 'Warm' },
  { value: 'dramatic', label: 'Dramatic' }
]

function updateSetting<K extends keyof typeof store.settings>(key: K, value: typeof store.settings[K]) {
  store.updateSettings({ [key]: value })
}

function resetSettings() {
  if (confirm('Reset all settings to defaults?')) {
    store.updateSettings({
      countdownSeconds: 3,
      flashEffect: true,
      autoSave: true,
      photoFormat: 'png',
      photoQuality: 0.95,
      filterName: 'none',
      mirrorMode: true
    })
  }
}

function clearSession() {
  if (confirm('Clear all session photos? This cannot be undone.')) {
    store.clearSessionPhotos()
  }
}
</script>

<template>
  <div class="settings-view">
    <div class="settings-container">
      <h1>⚙️ Settings</h1>

      <!-- Camera Settings -->
      <section class="settings-section">
        <h2>📷 Camera</h2>
        
        <div class="setting-item">
          <div class="setting-info">
            <label>Mirror Mode</label>
            <p>Flip the camera horizontally (selfie mode)</p>
          </div>
          <label class="toggle">
            <input 
              type="checkbox" 
              :checked="store.settings.mirrorMode"
              @change="updateSetting('mirrorMode', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <label>Default Filter</label>
            <p>Apply a filter by default when capturing</p>
          </div>
          <select 
            :value="store.settings.filterName"
            @change="updateSetting('filterName', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="filter in filters" :key="filter.value" :value="filter.value">
              {{ filter.label }}
            </option>
          </select>
        </div>
      </section>

      <!-- Capture Settings -->
      <section class="settings-section">
        <h2>⏱️ Capture</h2>

        <div class="setting-item">
          <div class="setting-info">
            <label>Countdown Duration</label>
            <p>Seconds before photo is taken</p>
          </div>
          <div class="number-input">
            <button 
              @click="updateSetting('countdownSeconds', Math.max(1, store.settings.countdownSeconds - 1))"
              :disabled="store.settings.countdownSeconds <= 1"
            >
              −
            </button>
            <span>{{ store.settings.countdownSeconds }}s</span>
            <button 
              @click="updateSetting('countdownSeconds', Math.min(10, store.settings.countdownSeconds + 1))"
              :disabled="store.settings.countdownSeconds >= 10"
            >
              +
            </button>
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <label>Flash Effect</label>
            <p>Show a flash animation when capturing</p>
          </div>
          <label class="toggle">
            <input 
              type="checkbox" 
              :checked="store.settings.flashEffect"
              @change="updateSetting('flashEffect', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </section>

      <!-- Save Settings -->
      <section class="settings-section">
        <h2>💾 Save</h2>

        <div class="setting-item" v-if="isElectron">
          <div class="setting-info">
            <label>Auto Save</label>
            <p>Automatically save photos to disk</p>
          </div>
          <label class="toggle">
            <input 
              type="checkbox" 
              :checked="store.settings.autoSave"
              @change="updateSetting('autoSave', ($event.target as HTMLInputElement).checked)"
            />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <label>Photo Format</label>
            <p>File format for saved photos</p>
          </div>
          <select 
            :value="store.settings.photoFormat"
            @change="updateSetting('photoFormat', ($event.target as HTMLSelectElement).value as 'png' | 'jpeg')"
          >
            <option value="png">PNG (Higher Quality)</option>
            <option value="jpeg">JPEG (Smaller Size)</option>
          </select>
        </div>

        <div class="setting-item" v-if="store.settings.photoFormat === 'jpeg'">
          <div class="setting-info">
            <label>JPEG Quality</label>
            <p>{{ Math.round(store.settings.photoQuality * 100) }}%</p>
          </div>
          <input 
            type="range" 
            min="0.5" 
            max="1" 
            step="0.05"
            :value="store.settings.photoQuality"
            @input="updateSetting('photoQuality', parseFloat(($event.target as HTMLInputElement).value))"
            class="range-input"
          />
        </div>
      </section>

      <!-- Danger Zone -->
      <section class="settings-section danger-section">
        <h2>⚠️ Danger Zone</h2>

        <div class="setting-item">
          <div class="setting-info">
            <label>Clear Session Photos</label>
            <p>Remove all unsaved photos from this session</p>
          </div>
          <button class="btn btn-danger" @click="clearSession">
            Clear ({{ store.photoCount }})
          </button>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <label>Reset Settings</label>
            <p>Restore all settings to defaults</p>
          </div>
          <button class="btn btn-outline" @click="resetSettings">
            Reset
          </button>
        </div>
      </section>

      <!-- App Info -->
      <section class="settings-section app-info">
        <h2>ℹ️ About</h2>
        <p>Photobooth App v1.0.0</p>
        <p>Built with Vue 3 + Electron</p>
        <p v-if="isElectron">Running in Electron</p>
        <p v-else>Running in Browser</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-view {
  height: 100%;
  overflow-y: auto;
  background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
  padding: 1.5rem;
}

.settings-container {
  max-width: 600px;
  margin: 0 auto;
}

h1 {
  color: white;
  font-size: 1.75rem;
  margin-bottom: 1.5rem;
}

.settings-section {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}

.settings-section h2 {
  color: #a0aec0;
  font-size: 0.9rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 1rem;
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info label {
  color: white;
  font-weight: 500;
  display: block;
  margin-bottom: 0.25rem;
}

.setting-info p {
  color: #718096;
  font-size: 0.85rem;
  margin: 0;
}

/* Toggle Switch */
.toggle {
  position: relative;
  display: inline-block;
  width: 50px;
  height: 28px;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(255, 255, 255, 0.1);
  transition: 0.3s;
  border-radius: 28px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 22px;
  width: 22px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

.toggle input:checked + .toggle-slider {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.toggle input:checked + .toggle-slider:before {
  transform: translateX(22px);
}

/* Select */
select {
  padding: 0.5rem 1rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-size: 0.9rem;
  cursor: pointer;
  min-width: 150px;
}

select:focus {
  outline: none;
  border-color: #667eea;
}

/* Number Input */
.number-input {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.number-input button {
  width: 32px;
  height: 32px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-size: 1.2rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.number-input button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
}

.number-input button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.number-input span {
  color: white;
  font-weight: 600;
  min-width: 40px;
  text-align: center;
}

/* Range Input */
.range-input {
  width: 150px;
  height: 6px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  outline: none;
}

.range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 50%;
  cursor: pointer;
}

/* Buttons */
.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-danger {
  background: rgba(229, 62, 62, 0.2);
  color: #fc8181;
  border: 1px solid rgba(229, 62, 62, 0.3);
}

.btn-danger:hover {
  background: rgba(229, 62, 62, 0.4);
}

.btn-outline {
  background: transparent;
  color: #a0aec0;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.btn-outline:hover {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}

/* Danger Section */
.danger-section {
  border-color: rgba(229, 62, 62, 0.3);
}

.danger-section h2 {
  color: #fc8181;
}

/* App Info */
.app-info {
  text-align: center;
}

.app-info p {
  color: #718096;
  font-size: 0.85rem;
  margin: 0.25rem 0;
}
</style>
