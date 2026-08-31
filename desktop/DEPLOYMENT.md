# Deployment Guide for Intel NUC Kiosk

This guide explains how to deploy the Nostalgia Photobooth application to your Intel NUC kiosk device.

## Current Build Status

The production build has been created successfully. The application is located in:
```
dist-electron\win-unpacked\
```

This directory contains the complete, ready-to-run application including:
- `Nostalgia Photobooth.exe` - The main executable
- All required Electron runtime files
- All application resources

## Deployment Options

### Option 1: Copy Unpacked Directory (Recommended)

1. **Copy the entire folder** `dist-electron\win-unpacked` to your Intel NUC
   - You can use a USB drive, network share, or remote desktop
   - Copy the entire folder, not just the .exe file

2. **On the Intel NUC:**
   - Navigate to the copied folder
   - Double-click `Nostalgia Photobooth.exe` to run the application
   - The app will start in fullscreen kiosk mode automatically

3. **Set up auto-start (optional):**
   - Create a shortcut to `Nostalgia Photobooth.exe`
   - Copy the shortcut to the Windows Startup folder:
     - Press `Win + R`
     - Type: `shell:startup`
     - Paste the shortcut there
   - The app will now start automatically when Windows boots

### Option 2: Create a ZIP Archive

1. **Create a ZIP file** of the `dist-electron\win-unpacked` folder
   ```powershell
   Compress-Archive -Path "dist-electron\win-unpacked\*" -DestinationPath "NostalgiaPhotobooth.zip"
   ```

2. **Transfer the ZIP** to your Intel NUC

3. **Extract and run** on the Intel NUC

## Building for Production

To rebuild the application:

```bash
npm run build
npx electron-builder --win --dir
```

**Note:** The build process may show errors related to code signing, but the unpacked directory (`dist-electron\win-unpacked`) will still be created successfully and is fully functional.

## Kiosk Mode Configuration

The application is configured to:
- Start in fullscreen mode
- Run in kiosk mode (no window controls)
- Disable right-click context menu
- Save photos to `Pictures\NostalgiaPhotobooth\`

## Troubleshooting

### White Screen Issue (Fixed)
If you see a white screen after running the app, this has been fixed in the latest build. The issue was with path resolution in production builds. 

**Solution:** Use the latest build (`NostalgiaPhotobooth-Portable-Fixed.zip`) which includes:
- Fixed path resolution for production builds
- Better error logging
- DevTools enabled for debugging (you'll see a console window)

**To debug further:**
- Check the DevTools console (press F12 or it may open automatically) for any error messages
- Look for console errors that might indicate missing files or path issues

### If the app doesn't start:
1. Ensure all files in `win-unpacked` are present (don't copy just the .exe)
2. Check Windows Defender or antivirus isn't blocking the app
3. Try running as administrator if needed
4. Check the DevTools console for error messages

### If camera doesn't work:
1. Check Windows camera permissions
2. Ensure no other application is using the camera
3. Verify camera drivers are installed

### To exit kiosk mode:
- Press `Alt + F4` (if enabled)
- Or use Task Manager (`Ctrl + Shift + Esc`) to close the app

## File Locations

- **Application:** `dist-electron\win-unpacked\`
- **Photos saved to:** `C:\Users\[Username]\Pictures\NostalgiaPhotobooth\`
- **Application data:** Stored in Electron's app data directory
- **PocketBase database:** `%APPDATA%\nostalgia-photobooth\pocketbase\` (survives app updates)

## PocketBase (bundled)

The installer includes `pocketbase.exe`. The kiosk starts it automatically on `http://127.0.0.1:8090` and stops it when the app quits.

1. Install and run **Nostalgia Photobooth**.
2. On first launch, open `http://127.0.0.1:8090/_/` in a browser on the kiosk and create the admin account (same email as `VITE_ADMIN_EMAIL` in the build).
3. Dashboard collections are created by the bundled migration.
4. In the app: Admin → Settings → Booth — leave **PocketBase server** blank (this machine). Set a unique Booth ID.

To use a shared PocketBase on another PC, set PocketBase server to that URL. The kiosk will not start a local copy.

Do not keep the database inside `win-unpacked` — reinstalls would wipe it. Back up the AppData `pocketbase` folder.

## System Requirements

- Windows 10/11 (64-bit)
- Camera/webcam
- Touchscreen (recommended)
- Minimum 2GB RAM
- ~200MB disk space
