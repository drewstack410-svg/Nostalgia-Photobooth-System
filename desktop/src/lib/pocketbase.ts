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

export default pb;
