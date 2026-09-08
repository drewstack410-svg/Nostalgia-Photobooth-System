/**
 * Per-machine booth identity.
 *
 * WHY THIS EXISTS
 * ---------------
 * The kiosk id and PocketBase URL were `VITE_*` env vars. Vite inlines those
 * at BUILD time, which is invisible with one booth and fatal with a fleet:
 *
 *  - every booth installed from the same build reports the same `kiosk_id`,
 *    and since every dashboard collection filters on it, all their sales
 *    collapse into one indistinguishable bucket;
 *  - the only way to give each booth its own identity would be to produce a
 *    separate build per booth — and rebuild all of them for every fix.
 *
 * So identity is read at runtime instead, from userData/booth-config.json
 * (or the KIOSK_ID / POCKETBASE_URL env vars). It is set once per machine and
 * survives app updates, because userData is not touched by a reinstall.
 */
import { setKioskId } from "@/lib/dashboardPb";
import { setPocketBaseUrl } from "@/lib/pocketbase";

export interface BoothSettings {
  kioskId: string;
  pocketBaseUrl: string;
}

const current: BoothSettings = { kioskId: "", pocketBaseUrl: "" };

/** The values in force right now (after applyBoothConfig has run). */
export function getBoothSettings(): BoothSettings {
  return { ...current };
}

/** Reads this machine's config and applies it. Safe to call outside Electron. */
export async function applyBoothConfig(): Promise<BoothSettings> {
  const api = window.electronAPI;
  if (!api?.getBoothConfig) {
    console.warn("[Booth] No electronAPI — keeping build-time defaults");
    return getBoothSettings();
  }
  try {
    const cfg = await api.getBoothConfig();
    if (cfg?.kioskId) {
      current.kioskId = cfg.kioskId;
      setKioskId(cfg.kioskId);
    } else {
      // Loud on purpose: unset means this booth is indistinguishable from
      // every other one in the fleet's sales data.
      console.warn(
        '[Booth] No kiosk id set — this machine reports as "default". ' +
          "Set it in Admin → Settings → Booth before the booth goes out.",
      );
    }
    if (cfg?.pocketBaseUrl) {
      current.pocketBaseUrl = cfg.pocketBaseUrl;
      setPocketBaseUrl(cfg.pocketBaseUrl);
    }
  } catch (e) {
    console.error("[Booth] Could not read booth config:", e);
  }
  return getBoothSettings();
}

/** Persists a change and applies it immediately. */
export async function saveBoothConfig(
  patch: Partial<BoothSettings>,
): Promise<boolean> {
  const api = window.electronAPI;
  if (!api?.setBoothConfig) return false;
  const res = await api.setBoothConfig(patch);
  if (!res?.success) {
    console.error("[Booth] Save failed:", res?.error);
    return false;
  }
  if (typeof patch.kioskId === "string" && patch.kioskId.trim()) {
    current.kioskId = patch.kioskId.trim();
    setKioskId(current.kioskId);
  }
  if (typeof patch.pocketBaseUrl === "string" && patch.pocketBaseUrl.trim()) {
    current.pocketBaseUrl = patch.pocketBaseUrl.trim();
    setPocketBaseUrl(current.pocketBaseUrl);
  }
  return true;
}
