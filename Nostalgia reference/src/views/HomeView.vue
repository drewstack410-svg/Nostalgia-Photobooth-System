<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

function startCamera() {
  router.push('/camera')
}

function openGallery() {
  router.push('/gallery')
}
</script>

<template>
  <div class="home-view">
    <div class="hero">
      <div class="hero-content">
        <h1 class="hero-title">
          <span class="title-icon">📸</span>
          Welcome to Photobooth
        </h1>
        <p class="hero-subtitle">
          Capture memories, create fun moments, and share smiles!
        </p>

        <div class="hero-actions">
          <button class="btn btn-primary btn-lg" @click="startCamera">
            <span class="btn-icon">📷</span>
            Start Camera
          </button>
          <button class="btn btn-secondary btn-lg" @click="openGallery">
            <span class="btn-icon">🖼️</span>
            View Gallery
          </button>
        </div>
      </div>

      <div class="features">
        <div class="feature-card">
          <div class="feature-icon">⏱️</div>
          <h3>Countdown Timer</h3>
          <p>Get ready with customizable countdown</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🎨</div>
          <h3>Fun Filters</h3>
          <p>Apply creative filters to your photos</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">💾</div>
          <h3>Offline Ready</h3>
          <p>Works completely offline</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">⚡</div>
          <h3>Instant Save</h3>
          <p>Photos saved automatically to your device</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-view {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
  overflow-y: auto;
}

.hero {
  text-align: center;
  max-width: 900px;
}

.hero-content {
  margin-bottom: 3rem;
}

.hero-title {
  font-size: 3rem;
  font-weight: 800;
  color: #fff;
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
}

.title-icon {
  font-size: 3.5rem;
}

.hero-subtitle {
  font-size: 1.25rem;
  color: #a0aec0;
  margin-bottom: 2rem;
}

.hero-actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.btn-lg {
  padding: 1rem 2rem;
  font-size: 1.1rem;
}

.btn-primary {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.2);
  transform: translateY(-2px);
}

.btn-icon {
  font-size: 1.25rem;
}

.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1.5rem;
}

.feature-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 1.5rem;
  transition: all 0.3s ease;
}

.feature-card:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateY(-4px);
}

.feature-icon {
  font-size: 2.5rem;
  margin-bottom: 0.75rem;
}

.feature-card h3 {
  color: #fff;
  font-size: 1.1rem;
  margin-bottom: 0.5rem;
}

.feature-card p {
  color: #a0aec0;
  font-size: 0.9rem;
}
</style>
