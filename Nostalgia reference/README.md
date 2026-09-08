# 📸 Nostalgia Photobooth

A beautiful vintage-themed photobooth application designed for touchscreen kiosk use. Built with Vue 3 and Electron.

## Features

- **🎨 Vintage Design** - Beautiful cream/sepia tones with decorative ornaments
- **📱 Touchscreen Optimized** - Large buttons and touch-friendly controls
- **🖼️ Multiple Templates** - Classic strip (4x1), Hearts (3x1), and Grid (2x2)
- **🎬 Film Roll Animation** - Dynamic film strips on title screen showing recent photos
- **📷 Sepia/Color Toggle** - Choose between color or vintage sepia photos
- **🪞 Mirror Mode** - Selfie-friendly mirrored camera view
- **💾 Offline Ready** - Works completely offline
- **🖥️ Fullscreen Kiosk** - Starts in fullscreen for dedicated photo booths

## Screens

1. **Title Screen** - "Nostalgia Photobooth" with animated film rolls
2. **Template Selection** - Carousel to choose photo layout
3. **Camera View** - Live camera with countdown and capture
4. **Printing Screen** - Shows delivery message with countdown

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Run in development mode
npm run electron:dev

# Build for production
npm run electron:build
```

### Development

```bash
# Run Vite dev server only (for web preview)
npm run dev

# Run with Electron
npm run electron:dev
```

## Photo Storage

Photos are automatically saved to:

- **Windows**: `Pictures/NostalgiaPhotobooth/`
- **macOS**: `Pictures/NostalgiaPhotobooth/`
- **Linux**: `Pictures/NostalgiaPhotobooth/`

### Cloudinary Cloud Storage (Optional)

The app can optionally upload photos to Cloudinary for cloud backup and remote access.

#### Setup

1. **Create a free account** at [Cloudinary](https://cloudinary.com/)

2. **Get your Cloud Name** from the [Cloudinary Dashboard](https://console.cloudinary.com/settings/general)

3. **Create an Upload Preset:**
   - Go to [Upload Presets](https://console.cloudinary.com/settings/upload_presets)
   - Click **"Add upload preset"** button
   - Configure the preset:
     - **Preset name**: `nostalgia-photobooth` (or any name you prefer)
     - **Signing mode**: Select **"Unsigned"** (this is required for browser uploads)
     - **Folder**: `nostalgia-photobooth` (optional, but recommended for organization)
     - **Format**: `png` (optional)
     - Click **"Save"**

4. **Create a `.env` file** in the project root (copy from `.env.example`):

   ```bash
   cp .env.example .env
   ```

5. **Add your Cloudinary credentials** to `.env`:

   ```env
   VITE_CLOUDINARY_CLOUD_NAME=your_cloud_name
   VITE_CLOUDINARY_UPLOAD_PRESET=nostalgia-photobooth
   ```

   Replace `your_cloud_name` with your actual Cloudinary cloud name and `nostalgia-photobooth` with the preset name you created.

6. **Restart the development server**:
   - Stop the current server (Ctrl+C)
   - Run `npm run electron:dev` again

#### How It Works

- Photos are saved locally first (always)
- After local save, photos are automatically uploaded to Cloudinary
- If Cloudinary upload fails, the local save still succeeds
- Cloudinary URLs are stored with each photo strip for future use
- Photos are organized in the `nostalgia-photobooth` folder in your Cloudinary account
- View uploaded photos in your [Cloudinary Media Library](https://console.cloudinary.com/console/media_library)

#### Troubleshooting

- **"Upload preset not found"**: Make sure the preset name in `.env` matches exactly (case-sensitive)
- **"Upload preset must be unsigned"**: Make sure you selected "Unsigned" when creating the preset
- **"Invalid upload preset"**: Verify the preset exists and is active in your Cloudinary dashboard
- **Check browser console**: Look for `[Cloudinary]` logs to see upload status and errors

**Note**: Cloudinary upload is optional. If credentials are not configured, the app will work normally with local saves only.

### PocketBase (Dashboard / Admin)

The admin panel uses [PocketBase](https://pocketbase.io/) to sync dashboard data (sales, custom items, reprints) across devices. Data lives in **localStorage** on each device and **syncs to PocketBase** when an admin logs in—local data is pushed to the server, then the app loads from PocketBase as the source of truth.

#### 1. Install and run PocketBase

- **Download** the single executable from [pocketbase.io/docs](https://pocketbase.io/docs/) or the [releases page](https://github.com/pocketbase/pocketbase/releases), or install via Go:
  ```bash
  go install github.com/pocketbase/pocketbase
  pocketbase serve
  ```
- Open **http://127.0.0.1:8090/_/** and create your **admin account** (email + password). You will use this email in step 2.

#### 2. Configure the app

Copy `.env.example` to `.env` and set:

```env
VITE_POCKETBASE_URL=http://127.0.0.1:8090
VITE_ADMIN_EMAIL=your-admin@example.com   # same email you created in PocketBase (_/)
VITE_ADMIN_USERNAME=admin                 # what you type on the login screen
```

- Log in to the app admin panel with **username** `admin` (or your chosen value) and your **password**. The app authenticates to PocketBase using `VITE_ADMIN_EMAIL`.
- **Restart the app** after changing `.env` so Vite picks up the new values.

#### 3. Create PocketBase collections

The dashboard expects **5 collections** with specific fields and **Admin only** API rules. You can create them automatically with the included migration: run PocketBase from the project root with `./pocketbase serve --migrationsDir=./pb_migrations`. Or create them manually; see **[docs/DASHBOARD_POCKETBASE_SETUP.md](docs/DASHBOARD_POCKETBASE_SETUP.md)** for both options and how sync works.

#### 4. Optional: use the client in code

To call PocketBase directly (e.g. custom collections or auth), import the shared client:

```ts
import { pb } from "@/lib/pocketbase";
// e.g. pb.collection("my_collection").getList(), pb.authStore, etc.
```

The admin panel syncs localStorage to PocketBase when you open it while logged in; without the 5 collections, it still works with localStorage only.

## Customization

### Colors

Edit CSS variables in `src/assets/main.css`:

```css
:root {
  --color-cream: #f5f0e1;
  --color-brown-dark: #3d2b1f;
  --color-gold: #c9a227;
  /* ... */
}
```

### Templates

Add new templates in `src/stores/photobooth.ts`:

```typescript
export const TEMPLATES: Template[] = [
  {
    id: "custom-template",
    name: "My Custom Template",
    photoCount: 6,
    layout: "grid",
    frameShape: "rectangle",
  },
];
```

## Kiosk Mode

The app automatically starts in fullscreen kiosk mode when built for production. For development, you can toggle fullscreen or modify `electron/main.js`.

## Tech Stack

- **Vue 3** - Composition API
- **Pinia** - State management
- **Vue Router** - Navigation
- **Electron** - Desktop app wrapper
- **Vite** - Build tool
- **TypeScript** - Type safety
- **Cloudinary** - Cloud image storage (optional)

## License

MIT
