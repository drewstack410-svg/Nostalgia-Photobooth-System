/**
 * Persist imported .cube / XMP LUTs outside localStorage.
 *
 * A 32³–64³ LUT is hundreds of KB to several MB as text. Putting that
 * on `nostalgia-camera-filters` overflows the origin quota, saveFilters
 * fails silently, and capture later sees a cube filter with no cubeData.
 */

const DB_NAME = "nostalgia-filter-luts";
const STORE = "cubes";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

export function isPackagedCubeRef(cubeData?: string): boolean {
  return !!cubeData && (cubeData.startsWith("/") || cubeData.startsWith("http"));
}

export async function putFilterLut(
  filterId: string,
  cubeText: string,
): Promise<boolean> {
  if (!filterId || !cubeText || isPackagedCubeRef(cubeText)) return false;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("LUT write failed"));
      tx.objectStore(STORE).put(cubeText, filterId);
    });
    db.close();
    return true;
  } catch (e) {
    console.warn("[FilterLut] Failed to persist LUT:", e);
    return false;
  }
}

export async function getFilterLut(filterId: string): Promise<string | null> {
  if (!filterId) return null;
  try {
    const db = await openDb();
    const text = await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(filterId);
      req.onsuccess = () => {
        resolve(typeof req.result === "string" && req.result ? req.result : null);
      };
      req.onerror = () => reject(req.error ?? new Error("LUT read failed"));
    });
    db.close();
    return text;
  } catch (e) {
    console.warn("[FilterLut] Failed to read LUT:", e);
    return null;
  }
}

export async function deleteFilterLut(filterId: string): Promise<void> {
  if (!filterId) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("LUT delete failed"));
      tx.objectStore(STORE).delete(filterId);
    });
    db.close();
  } catch (e) {
    console.warn("[FilterLut] Failed to delete LUT:", e);
  }
}
