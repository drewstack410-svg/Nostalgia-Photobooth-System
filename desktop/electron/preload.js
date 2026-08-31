const { contextBridge, ipcRenderer } = require('electron');

function cloneBytesForIpc(bytes) {
  if (!bytes) return bytes;
  if (bytes instanceof Uint8Array) {
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return out;
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return bytes;
}

console.log('[Preload] Preload script loaded');

try {
  contextBridge.exposeInMainWorld('electronAPI', {
    savePhoto: (imageData, filename) => {
      console.log('[Preload] savePhoto called');
      return ipcRenderer.invoke('save-photo', { imageData, filename });
    },

    uploadToR2: (payload) => ipcRenderer.invoke('r2:upload', payload),
    uploadToR2Bytes: (payload) => ipcRenderer.invoke('r2:upload-bytes', {
      ...payload,
      bytes: cloneBytesForIpc(payload?.bytes),
    }),
    getR2Status: () => ipcRenderer.invoke('r2:status'),

    // Temp-folder save for transient print sheets — file ends up in
    // the OS temp dir, NOT in the user's Pictures/NostalgiaPhotobooth
    // folder. Use this for the print composite so the user's saved
    // photos folder only contains actual captures.
    saveTempPhoto: (imageData, filename) => {
      console.log('[Preload] saveTempPhoto called');
      return ipcRenderer.invoke('save-temp-photo', { imageData, filename });
    },
    
    // Per-machine identity (kiosk id + PocketBase URL). Runtime, not baked in
    // at build time — one build has to serve every booth in the fleet.
    getBoothConfig: () => ipcRenderer.invoke('booth:get-config'),
    setBoothConfig: (patch) => ipcRenderer.invoke('booth:set-config', patch),

    // Templates (custom layouts + built-in overrides) live in a JSON file
    // under userData, NOT localStorage — an imported template carries its
    // artwork as base64 and blows the ~5MB origin quota, after which saves
    // throw and layouts silently vanish on restart.
    loadTemplates: () => {
      console.log('[Preload] loadTemplates called');
      return ipcRenderer.invoke('templates:load');
    },

    saveTemplates: (data) => {
      return ipcRenderer.invoke('templates:save', data);
    },

    // Claims the next "<MM-DD-YY>/Session N" folder and returns its path
    // relative to the photos folder. Pass that as a prefix to savePhoto /
    // saveSessionBytes to file everything from one sitting together.
    beginSession: () => {
      console.log('[Preload] beginSession called');
      return ipcRenderer.invoke('session:begin');
    },

    // Raw-bytes save (used for the session GIF), relative to the photos folder.
    saveSessionBytes: ({ bytes, filename }) => {
      const payload = cloneBytesForIpc(bytes);
      console.log(`[Preload] saveSessionBytes (${filename}, ${payload?.byteLength ?? payload?.length} bytes)`);
      return ipcRenderer.invoke('save-session-bytes', { bytes: payload, filename });
    },

    saveHighlightVideo: ({ bytes, filename }) => {
      const payload = cloneBytesForIpc(bytes);
      console.log(`[Preload] saveHighlightVideo (${filename}, ${payload?.byteLength ?? payload?.length} bytes)`);
      return ipcRenderer.invoke('save-highlight-video', { bytes: payload, filename });
    },

    getPhotosDirectory: () => {
      console.log('[Preload] getPhotosDirectory called');
      return ipcRenderer.invoke('get-photos-directory');
    },
    
    listSavedPhotos: () => {
      console.log('[Preload] listSavedPhotos called');
      return ipcRenderer.invoke('list-saved-photos');
    },
    
    readPhoto: (filePath) => {
      console.log('[Preload] readPhoto called');
      return ipcRenderer.invoke('read-photo', filePath);
    },
    
    deletePhoto: (filePath) => {
      console.log('[Preload] deletePhoto called');
      return ipcRenderer.invoke('delete-photo', filePath);
    },

    // Title screen background (image or video) — stored on disk, not
    // localStorage, since video files can be far too large for it.
    // ── Payment middleware bridge (admin panel visibility) ──
    getPaymentBridgeStatus: () => ipcRenderer.invoke('payment:get-bridge-status'),
    onPaymentBridgeStatus: (cb) => {
      const handler = (_e, status) => cb(status);
      ipcRenderer.on('payment:bridge-status', handler);
      return () => ipcRenderer.removeListener('payment:bridge-status', handler);
    },
    launchMiddleware: () => ipcRenderer.invoke('payment:launch-middleware'),
    listMiddlewareWindows: () => ipcRenderer.invoke('middleware:list-windows'),
    focusMiddlewareWindow: () => ipcRenderer.invoke('middleware:focus-window'),

    saveTitleBackground: (dataUrl) => {
      console.log('[Preload] saveTitleBackground called');
      return ipcRenderer.invoke('save-title-background', { dataUrl });
    },

    // Preferred for video: raw bytes, no base64 round trip.
    // `slot` selects which screen's background: 'title' (default) or 'payment'.
    saveTitleBackgroundBytes: ({ bytes, mime, slot }) => {
      console.log(`[Preload] saveTitleBackgroundBytes (${slot || 'title'}, ${bytes?.length} bytes, ${mime})`);
      return ipcRenderer.invoke('save-title-background-bytes', { bytes, mime, slot });
    },

    getTitleBackground: (slot) => {
      console.log(`[Preload] getTitleBackground called (${slot || 'title'})`);
      return ipcRenderer.invoke('get-title-background', { slot });
    },

    getPackagedBackground: (slot) => {
      return ipcRenderer.invoke('get-packaged-background', { slot });
    },

    clearTitleBackground: (slot) => {
      console.log(`[Preload] clearTitleBackground called (${slot || 'title'})`);
      return ipcRenderer.invoke('clear-title-background', { slot });
    },

    saveFilterOverlayMedia: ({ filterId, bytes, mime, filename }) => {
      console.log(`[Preload] saveFilterOverlayMedia (${filterId}, ${bytes?.length} bytes, ${mime})`);
      return ipcRenderer.invoke('save-filter-overlay-media', { filterId, bytes, mime, filename });
    },
    getFilterOverlayMedia: (filterId) => {
      return ipcRenderer.invoke('get-filter-overlay-media', { filterId });
    },
    clearFilterOverlayMedia: (filterId) => {
      return ipcRenderer.invoke('clear-filter-overlay-media', { filterId });
    },

    getPrinters: () => {
      console.log('[Preload] getPrinters called');
      return ipcRenderer.invoke('get-printers');
    },

    printPhoto: (opts) => {
      console.log('[Preload] printPhoto called', opts?.filePath);
      return ipcRenderer.invoke('print-photo', opts);
    },

    openPrinterProperties: (printerName) => {
      console.log('[Preload] openPrinterProperties called', printerName);
      return ipcRenderer.invoke('open-printer-properties', printerName);
    },

    toggleFullscreen: () => {
      console.log('[Preload] toggleFullscreen called');
      return ipcRenderer.invoke('toggle-fullscreen');
    },
    
    quitApp: () => {
      console.log('[Preload] quitApp called');
      return ipcRenderer.invoke('quit-app');
    },
    
    // Canon EDSDK API
    canonCheckAvailable: () => {
      return ipcRenderer.invoke('canon-check-available');
    },
    
    canonListCameras: () => {
      return ipcRenderer.invoke('canon-list-cameras');
    },
    
    canonConnect: (cameraIndex) => {
      return ipcRenderer.invoke('canon-connect', cameraIndex);
    },
    
    canonTakePhoto: () => {
      return ipcRenderer.invoke('canon-take-photo');
    },
    
    canonDisconnect: () => {
      return ipcRenderer.invoke('canon-disconnect');
    },

    canonStartLiveView: () => {
      return ipcRenderer.invoke('canon-start-liveview');
    },

    canonStopLiveView: () => {
      return ipcRenderer.invoke('canon-stop-liveview');
    },

    onLiveViewFrame: (callback) => {
      ipcRenderer.on('liveview-frame', (_event, dataUrl) => callback(dataUrl));
    },

    offLiveViewFrame: () => {
      ipcRenderer.removeAllListeners('liveview-frame');
    },

    // ─────────────────────────────────────────────────────────────
    // Bill-acceptor / payment bridge — LUMABOOTH INTEGRATION SEAM
    // ─────────────────────────────────────────────────────────────
    // The renderer (src/services/billAcceptor.ts → IpcBillAcceptorAdapter)
    // subscribes to credit events here. The MAIN process is where the
    // LumaBooth-side helper / hardware reader will eventually push
    // those events from — see electron/main.js `payment:*` STUB.
    //
    // `onPaymentCredit` returns an unsubscribe function so the
    // adapter can cleanly detach on screen teardown (mirrors how the
    // payment store/adapter expect it).
    onPaymentCredit: (callback) => {
      const handler = (_event, payload) => callback(payload || {});
      ipcRenderer.on('payment:credit', handler);
      return () => ipcRenderer.removeListener('payment:credit', handler);
    },

    // Optional: let the renderer tell main "a sale started / ended"
    // so a future LumaBooth helper can arm/disarm the physical
    // acceptor. No-op until the main-process stub is implemented.
    notifyPaymentSession: (state) => {
      // state: { phase: 'begin' | 'consume' | 'reset', required?: number }
      return ipcRenderer.invoke('payment:session', state);
    },

    platform: process.platform
  });
  
  console.log('[Preload] electronAPI exposed successfully');
} catch (error) {
  console.error('[Preload] Error exposing electronAPI:', error);
}
