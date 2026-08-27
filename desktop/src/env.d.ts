/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POCKETBASE_URL?: string;
  readonly VITE_KIOSK_ID?: string;
  readonly VITE_ADMIN_EMAIL?: string;
  readonly VITE_ADMIN_USERNAME?: string;
  readonly VITE_CLOUDINARY_CLOUD_NAME?: string;
  readonly VITE_CLOUDINARY_UPLOAD_PRESET?: string;
  readonly VITE_R2_PUBLIC_URL?: string;
  readonly VITE_R2_FOLDER?: string;
  readonly VITE_GALLERY_BASE_URL?: string;
}

interface PhotoInfo {
  name: string;
  path: string;
  created: Date;
}

interface SaveResult {
  success: boolean;
  path?: string;
  error?: string;
}

interface DeleteResult {
  success: boolean;
  error?: string;
}

interface CanonCamera {
  index: number;
  name: string;
  portName: string;
}

interface CanonListResult {
  success: boolean;
  cameras?: CanonCamera[];
  error?: string;
}

interface CanonConnectResult {
  success: boolean;
  cameraName?: string;
  error?: string;
}

interface CanonPhotoResult {
  success: boolean;
  imageData?: string;
  fileName?: string;
  error?: string;
}

interface CanonAvailableResult {
  available: boolean;
  error?: string;
}

interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
}

interface PrintersResult {
  success: boolean;
  printers: PrinterInfo[];
  error?: string;
}

interface PaymentBridgeSignal {
  at: number;
  kind: "paid" | "partial" | "failed" | "other";
  detail: string | null;
}

interface PaymentBridgeStatus {
  /** True once the local listener the middleware calls is up. */
  listening: boolean;
  port: number | null;
  /** e.g. the port is taken by another program. */
  error: string | null;
  lastSignalAt: number | null;
  lastSignalKind: PaymentBridgeSignal["kind"] | null;
  lastSignalDetail: string | null;
  signalCount: number;
  recent: PaymentBridgeSignal[];
}

interface PrintPhotoOptions {
  filePath: string;
  printerName?: string;
  copies?: number;
  paperLayout?: "portrait" | "landscape";
  /**
   * The template's paper size (e.g. "4x6-portrait", "6x8-portrait").
   * Selects the driver's media form; without it every job was forced
   * onto a 4x6 form regardless of the template.
   */
  paperSize?: string;
  cutMode?: "standard" | "dnp-2-inch-cut";
}

/** Shape of the on-disk templates.json. */
interface TemplateStoreData {
  customTemplates: unknown[];
  builtinTemplateOverrides: Record<string, unknown>;
}

interface TemplateLoadResult {
  success: boolean;
  data: TemplateStoreData | null;
  error?: string;
}

interface BoothConfigValues {
  /** Identifies this booth in PocketBase (`kiosk_id` on every record). */
  kioskId: string;
  /** Base URL of the shared PocketBase server. Empty = local default. */
  pocketBaseUrl: string;
}

interface BoothConfig extends Partial<BoothConfigValues> {
  success: boolean;
  error?: string;
}

interface SessionFolderResult {
  success: boolean;
  /** Relative to the photos folder, e.g. "08-06-26/Session 3". */
  folder: string | null;
  /** Absolute path, for logging. */
  path?: string;
  error?: string;
}

interface PrintPhotoResult {
  success: boolean;
  error?: string;
  /** Raw stdout from the PowerShell print script (paper-size diagnostics). */
  stdout?: string;
}

interface ElectronAPI {
  savePhoto: (imageData: string, filename?: string) => Promise<SaveResult>;
  uploadToR2?: (payload: {
    imageData: string;
    folder?: string;
    publicId?: string;
  }) => Promise<{
    success: boolean;
    url?: string;
    publicId?: string;
    error?: string;
  }>;
  getR2Status?: () => Promise<{
    configured: boolean;
    connected?: boolean;
    apiOk?: boolean;
    publicOk?: boolean;
    bucket?: string;
    publicUrl?: string;
    missing?: string[];
    error?: string;
  }>;
  /**
   * Save a transient image to the OS temp directory. Use for the print
   * sheet so it doesn't pollute the user's Pictures/NostalgiaPhotobooth
   * folder — only individual captures belong in the canonical location.
   */
  saveTempPhoto: (imageData: string, filename?: string) => Promise<SaveResult>;
  /**
   * Per-machine identity, read at runtime from userData/booth-config.json
   * (or KIOSK_ID / POCKETBASE_URL env vars). Deliberately NOT a VITE_* var:
   * those are inlined at build time, which would force one build per booth.
   */
  getBoothConfig: () => Promise<BoothConfig>;
  setBoothConfig: (patch: Partial<BoothConfigValues>) => Promise<BoothConfig>;
  /**
   * Claims the next "<MM-DD-YY>/Session N" folder under the photos
   * directory and returns its RELATIVE path. Use it as a filename prefix
   * for savePhoto/saveSessionBytes so one sitting's strip, captures and
   * GIF are filed together. Main owns the numbering so a restart
   * mid-event continues rather than overwriting Session 1.
   */
  /**
   * Templates live in userData/templates.json rather than localStorage —
   * imported artwork is base64 and overruns the ~5MB origin quota, after
   * which saves throw and layouts are lost on restart.
   */
  loadTemplates: () => Promise<TemplateLoadResult>;
  saveTemplates: (data: TemplateStoreData) => Promise<SaveResult>;
  beginSession: () => Promise<SessionFolderResult>;
  /**
   * Write raw bytes (the session GIF) relative to the photos directory.
   * Avoids the ~33% base64 tax of routing a binary through savePhoto.
   */
  saveSessionBytes: (opts: {
    bytes: Uint8Array;
    filename: string;
  }) => Promise<SaveResult>;
  getPhotosDirectory: () => Promise<string>;
  listSavedPhotos: () => Promise<PhotoInfo[]>;
  readPhoto: (filePath: string) => Promise<string | null>;
  deletePhoto: (filePath: string) => Promise<DeleteResult>;
  /**
   * Title screen background (image or video), stored on disk in the
   * app's userData folder instead of localStorage — video files can
   * be tens of MB as base64, well past localStorage's quota.
   */
  /** Live state of the local payment bridge, for the admin panel. */
  getPaymentBridgeStatus?: () => Promise<PaymentBridgeStatus>;
  /** Subscribe to bridge updates; returns an unsubscribe function. */
  onPaymentBridgeStatus?: (cb: (s: PaymentBridgeStatus) => void) => () => void;
  /** Starts the client's middleware app (a separate Windows program). */
  launchMiddleware?: () => Promise<{ success: boolean; path?: string; error?: string }>;
  /** Windows whose title looks like the middleware (for the live view). */
  listMiddlewareWindows?: () => Promise<{
    success: boolean;
    error?: string;
    matches: { id: string; name: string }[];
    all: { id: string; name: string }[];
  }>;
  /** Brings the middleware's real window forward so staff can use it. */
  focusMiddlewareWindow?: () => Promise<{ success: boolean; error?: string }>;
  saveTitleBackground: (dataUrl: string) => Promise<SaveResult>;
  /**
   * Preferred over saveTitleBackground for video: sends the raw file
   * bytes instead of a base64 data URL (which is ~33% larger and has to
   * be built as one giant JS string first).
   */
  saveTitleBackgroundBytes: (payload: {
    bytes: Uint8Array;
    mime: string;
    /** Which screen's background: 'title' (default) or 'payment'. */
    slot?: "title" | "payment";
  }) => Promise<SaveResult>;
  /**
   * Returns the raw bytes so the renderer can wrap them in a Blob and
   * use an object URL. A `data:` URL cannot be used here: the CSP's
   * media-src allows only 'self' and blob:, and Chromium will not play
   * video from a large data URL anyway.
   */
  getTitleBackground: (slot?: "title" | "payment") => Promise<{
    success: boolean;
    bytes: Uint8Array | null;
    mime: string | null;
    mediaType: "image" | "video" | null;
    error?: string;
  }>;
  clearTitleBackground: (
    slot?: "title" | "payment",
  ) => Promise<{ success: boolean; error?: string }>;
  getPrinters: () => Promise<PrintersResult>;
  printPhoto: (opts: PrintPhotoOptions) => Promise<PrintPhotoResult>;
  /**
   * Opens the Windows "Printer properties" dialog for the given printer so
   * the operator can enable DNP-specific options (like "2inch cut") without
   * navigating Control Panel. Returns success:true when the dialog opens
   * (not when the user clicks OK — that's fire-and-forget).
   */
  openPrinterProperties: (
    printerName: string,
  ) => Promise<{ success: boolean; error?: string; printerName?: string }>;
  toggleFullscreen: () => Promise<boolean>;
  quitApp: () => Promise<void>;
  // Canon EDSDK API
  canonCheckAvailable: () => Promise<CanonAvailableResult>;
  canonListCameras: () => Promise<CanonListResult>;
  canonConnect: (cameraIndex: number) => Promise<CanonConnectResult>;
  canonTakePhoto: () => Promise<CanonPhotoResult>;
  canonDisconnect: () => Promise<{ success: boolean; error?: string }>;
  canonStartLiveView: () => Promise<{ success: boolean; error?: string }>;
  canonStopLiveView: () => Promise<{ success: boolean; error?: string }>;
  onLiveViewFrame: (callback: (dataUrl: string) => void) => void;
  offLiveViewFrame: () => void;
  /**
   * Bill-acceptor / payment bridge (LumaBooth Middleware integration).
   * Subscribe to credit events pushed by the main process — which
   * impersonates the LumaBooth API on localhost:1500 and forwards the
   * middleware's /api/start calls here. Returns an unsubscribe
   * function. Consumed by src/services/billAcceptor.ts.
   */
  onPaymentCredit?: (
    callback: (payload: {
      amount?: number;
      error?: string;
      /** LumaBooth Middleware reported a COMPLETED sale (one
       *  /api/start call = one fully-paid session). */
      paidInFull?: boolean;
      /** Signal origin, e.g. "lumabooth-middleware". */
      source?: string;
      /** The middleware's mode param ("print", "block", …). */
      mode?: string;
    }) => void,
  ) => () => void;
  /**
   * Tell the main process a payment session began/ended. In PULL mode
   * (PAYMENT_API_URL set) this drives the middleware API: `begin`
   * creates a payment intent and starts polling, `reset` voids it.
   * See electron/paymentMiddleware.js.
   */
  notifyPaymentSession?: (state: {
    phase: "begin" | "consume" | "reset";
    required?: number;
    templateId?: string | null;
  }) => Promise<{
    success: boolean;
    mode?: string;
    /** Middleware transaction id, when it returns one. */
    intentId?: string;
    /** QR image/URL from the middleware, when it supplies one. */
    qr?: string | null;
    error?: string;
  }>;
  platform: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// Template types (all templates are user-added)
interface Template {
  id: string;
  name: string;
  isActive?: boolean;
  photoCount: number;
  layout: "vertical" | "horizontal";
  frameImageUrl?: string;
  frameRows?: number;
  frameCols?: number;
  thumbnailDefaultUrl?: string;
  thumbnailActiveUrl?: string;
}

export {};
