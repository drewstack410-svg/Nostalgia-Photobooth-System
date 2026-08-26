/**
 * PocketBase client for the dashboard and admin panel.
 *
 * Set VITE_POCKETBASE_URL in .env (e.g. http://127.0.0.1:8090).
 * Run PocketBase server separately: download from https://pocketbase.io/docs/
 * or: npx pocketbase serve (if using the optional CLI).
 */
import PocketBase from "pocketbase";

const url =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_POCKETBASE_URL
    ? (import.meta.env.VITE_POCKETBASE_URL as string).replace(/\/$/, "")
    : "http://127.0.0.1:8090";

export const pb = new PocketBase(url);

/**
 * Repoints PocketBase at the shared server for this booth.
 *
 * The URL used to come from VITE_POCKETBASE_URL, which Vite inlines at BUILD
 * time — so a fleet compiled from one build all talked to the same hardcoded
 * address (in practice `127.0.0.1`, i.e. each booth to its own local database,
 * with no consolidated reporting possible). It is now read per machine at
 * startup; see electron/main.js `booth:get-config`.
 */
export function setPocketBaseUrl(next: string) {
  const trimmed = (next || "").trim().replace(/\/$/, "");
  if (!trimmed || trimmed === pb.baseURL) return;
  pb.baseURL = trimmed;
  console.log("[PocketBase] Base URL set to", trimmed);
}

const HEALTH_TIMEOUT_MS = 4000;

/**
 * Pings PocketBase `/api/health` and logs whether this app can reach it.
 * Does not throw — a down server must never stall the kiosk.
 */
export async function checkPocketBaseConnection(): Promise<boolean> {
  const url = (pb.baseURL || "").replace(/\/$/, "");
  if (!url) {
    console.warn(
      "[PocketBase] No URL configured. Set VITE_POCKETBASE_URL in .env or Admin → Settings → Booth.",
    );
    return false;
  }

  console.log(`[PocketBase] Checking connection to ${url} ...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!res.ok) {
      console.error(
        `[PocketBase] Not connected — health check returned HTTP ${res.status} (${url})`,
      );
      return false;
    }
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      code?: number;
    };
    console.log(
      `[PocketBase] Connected. Server healthy at ${url}` +
        (body.message ? ` — ${body.message}` : ""),
    );
    return true;
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    const reason = timedOut
      ? `timed out after ${HEALTH_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    console.error(
      `[PocketBase] Not connected to ${url} — ${reason}. Is pocketbase.exe serve running?`,
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export default pb;
