/**
 * PocketBase sync for dashboard data.
 * - Creates new records only when values differ from the latest in the DB
 *   (avoids duplicate entries on edit/refresh).
 * - Multi-kiosk: all collections filter by `kiosk_id` (from `VITE_KIOSK_ID`).
 * @module dashboardPb
 */
import { pb } from "./pocketbase";

// -----------------------------------------------------------------------------
// Kiosk identity
// -----------------------------------------------------------------------------

/** Resolved once at load; falls back to "default" if VITE_KIOSK_ID is missing or empty. */
let KIOSK_ID = ((): string => {
  const id =
    typeof import.meta !== "undefined" && import.meta.env?.VITE_KIOSK_ID;
  return typeof id === "string" && id.trim() ? id.trim() : "default";
})();

/**
 * Sets which booth this machine reports as.
 *
 * This MUST be per machine. It used to come only from VITE_KIOSK_ID, which
 * Vite inlines at build time, so every booth built from the same package
 * reported the identical id — and since every collection here filters on
 * `kiosk_id`, a whole fleet's sales collapsed into one indistinguishable
 * bucket. Giving each booth its own identity would otherwise have meant a
 * separate build per booth. Now it is read at startup from
 * userData/booth-config.json (Admin -> Settings -> Booth).
 */
export function setKioskId(id: string) {
  const trimmed = (id || "").trim();
  if (!trimmed || trimmed === KIOSK_ID) return;
  KIOSK_ID = trimmed;
  console.log("[Dashboard] Kiosk ID set to", trimmed);
}

/**
 * Returns the current kiosk identifier used for all PocketBase filters.
 * @returns Kiosk ID string (e.g. from env or "default").
 */
export function getKioskId(): string {
  return KIOSK_ID;
}

// -----------------------------------------------------------------------------
// Types & state shape
// -----------------------------------------------------------------------------

/** Single custom item as stored in PocketBase and used in dashboard state. */
interface CustomItemPb {
  id: string;
  name: string;
  price: number;
}

/**
 * In-memory dashboard state synced to/from PocketBase.
 * All time-series data is keyed by date in YYYY-MM-DD (local date from record `created`).
 */
export interface DashboardPbState {
  salesByTemplateIdByMonth: Record<string, Record<string, number>>;
  priceByTemplateId: Record<string, number>;
  reprintSalesByMonth: Record<string, number>;
  reprintTotalByMonth: Record<string, number>;
  customItems: CustomItemPb[];
  customItemSalesByMonth: Record<string, Record<string, number>>;
  templateNames?: Record<string, string>;
}

/** Empty dashboard state; use as initial value or reset. */
const emptyState: DashboardPbState = {
  salesByTemplateIdByMonth: {},
  priceByTemplateId: {},
  reprintSalesByMonth: {},
  reprintTotalByMonth: {},
  customItems: [],
  customItemSalesByMonth: {},
};

// -----------------------------------------------------------------------------
// PocketBase collection names
// -----------------------------------------------------------------------------

const COLLECTIONS = {
  template_sales: "template_sales",
  template_prices: "template_prices",
  reprint_sales: "reprint_sales",
  custom_items: "custom_items",
  custom_sales: "custom_sales",
} as const;

// -----------------------------------------------------------------------------
// PocketBase helpers (filter, fetch, parse)
// -----------------------------------------------------------------------------

/**
 * Builds a PocketBase filter string for the given kiosk, with backslash and quote escaped.
 * @param kioskId - Current kiosk identifier.
 * @returns Filter string e.g. `kiosk_id = "my-kiosk"`.
 */
function safeFilter(kioskId: string): string {
  const escaped = kioskId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `kiosk_id = "${escaped}"`;
}

/**
 * Fetches all records for the given kiosk from a collection (newest first).
 * PocketBase returns `id` and `created` on each record.
 *
 * @param collection - PocketBase collection name.
 * @param kioskId - Kiosk to filter by.
 * @returns Up to 500 items, sorted by `-created`.
 */
async function getAll<T extends Record<string, unknown>>(
  collection: string,
  kioskId: string,
): Promise<(T & { id: string; created?: string })[]> {
  const list = await pb.collection(collection).getList(1, 500, {
    filter: safeFilter(kioskId),
    sort: "-created",
  });
  return (
    (list.items as unknown as (T & { id: string; created?: string })[]) ?? []
  );
}

/**
 * Converts a PocketBase `created` (ISO string) to local date YYYY-MM-DD.
 * Uses local time so it aligns with dashboard date keys.
 *
 * @param created - ISO date string or undefined.
 * @returns YYYY-MM-DD or empty string if missing.
 */
function dateFromCreated(created?: string): string {
  if (!created) return "";
  const d = new Date(created);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Builds a map of latest value per logical key from records assumed newest-first.
 * First occurrence of each key wins (so "latest" by sort order).
 *
 * @param records - List sorted by created descending.
 * @param keyFn - Extracts the logical key (e.g. template_id).
 * @param valueFn - Extracts the numeric value to store.
 * @returns Record from key to latest value.
 */
function latestByKey<T, K extends string>(
  records: (T & { created?: string })[],
  keyFn: (r: T) => K,
  valueFn: (r: T) => number,
): Record<K, number> {
  const out = {} as Record<string, number>;
  const seen = new Set<string>();
  for (const r of records) {
    const k = keyFn(r) as string;
    if (seen.has(k)) continue;
    seen.add(k);
    out[k] = valueFn(r);
  }
  return out as Record<K, number>;
}

// -----------------------------------------------------------------------------
// Load: PocketBase → in-memory state
// -----------------------------------------------------------------------------

/**
 * Loads full dashboard state from PocketBase for the current kiosk.
 * Fetches all relevant collections in parallel; for each logical key (e.g. template+date),
 * the latest record (by `created`) wins. Requires valid auth.
 *
 * @returns Filled {@link DashboardPbState} or `null` if not authenticated or on error.
 */
export async function loadDashboardFromPb(): Promise<DashboardPbState | null> {
  if (!pb.authStore.isValid) return null;
  const kioskId = getKioskId();
  try {
    const [
      templateSalesRows,
      templatePricesRows,
      reprintSalesRows,
      customItemsRows,
      customSalesRows,
    ] = await Promise.all([
      getAll<{ template_id: string; pieces_sold: number; created?: string }>(
        COLLECTIONS.template_sales,
        kioskId,
      ),
      getAll<{ template_id: string; price: number }>(
        COLLECTIONS.template_prices,
        kioskId,
      ),
      getAll<{ pieces_sold: number; total_sales?: number; created?: string }>(
        COLLECTIONS.reprint_sales,
        kioskId,
      ),
      getAll<{ item_id: string; item_name: string; price: number }>(
        COLLECTIONS.custom_items,
        kioskId,
      ),
      getAll<{ item_id: string; pieces_sold: number; created?: string }>(
        COLLECTIONS.custom_sales,
        kioskId,
      ),
    ]);

    // Template sales: latest per template_id + date (rows are newest first).
    const salesByTemplateIdByMonth: Record<string, Record<string, number>> = {};
    const seenTemplateDate = new Set<string>();
    for (const r of templateSalesRows) {
      if (!r.template_id) continue;
      const date = dateFromCreated(r.created);
      if (!date) continue;
      const k = `${r.template_id}\0${date}`; // \0 safe composite key (no in IDs/dates)
      if (seenTemplateDate.has(k)) continue;
      seenTemplateDate.add(k);
      if (!salesByTemplateIdByMonth[r.template_id])
        salesByTemplateIdByMonth[r.template_id] = {};
      salesByTemplateIdByMonth[r.template_id][date] = r.pieces_sold ?? 0;
    }

    const priceByTemplateId = latestByKey(
      templatePricesRows,
      (r) => r.template_id,
      (r) => r.price ?? 0,
    );

    // Reprint: latest pieces_sold and total_sales per date.
    const reprintSalesByMonth: Record<string, number> = {};
    const reprintTotalByMonth: Record<string, number> = {};
    const seenReprint = new Set<string>();
    for (const r of reprintSalesRows) {
      const date = dateFromCreated(r.created);
      if (!date || seenReprint.has(date)) continue;
      seenReprint.add(date);
      reprintSalesByMonth[date] = r.pieces_sold ?? 0;
      reprintTotalByMonth[date] =
        (r as { total_sales?: number }).total_sales ?? 0;
    }

    // Custom items: dedupe by item_id, latest wins.
    const customItems: CustomItemPb[] = [];
    const seenItem = new Set<string>();
    for (const r of customItemsRows) {
      if (seenItem.has(r.item_id)) continue;
      seenItem.add(r.item_id);
      customItems.push({
        id: r.item_id,
        name: r.item_name ?? "",
        price: r.price ?? 0,
      });
    }

    // Custom sales: latest per item_id + date.
    const customItemSalesByMonth: Record<string, Record<string, number>> = {};
    const seenCustomSale = new Set<string>();
    for (const r of customSalesRows) {
      const date = dateFromCreated(r.created);
      if (!r.item_id || !date) continue;
      const k = `${r.item_id}\0${date}`;
      if (seenCustomSale.has(k)) continue;
      seenCustomSale.add(k);
      if (!customItemSalesByMonth[r.item_id])
        customItemSalesByMonth[r.item_id] = {};
      customItemSalesByMonth[r.item_id][date] = r.pieces_sold ?? 0;
    }

    return {
      salesByTemplateIdByMonth,
      priceByTemplateId,
      reprintSalesByMonth,
      reprintTotalByMonth,
      customItems,
      customItemSalesByMonth,
    };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Save: in-memory state → PocketBase (create-only when value changed)
// -----------------------------------------------------------------------------

/**
 * Creates a single record in the given collection. Body must include `kiosk_id`.
 *
 * @param collection - PocketBase collection name.
 * @param body - Record fields (e.g. kiosk_id, template_id, pieces_sold).
 */
async function createRecord(
  collection: string,
  body: Record<string, unknown>,
): Promise<void> {
  await pb.collection(collection).create(body);
}

/**
 * Coerces a value to a number for comparison. PocketBase may return numbers as strings;
 * using this when comparing with app state avoids unnecessary duplicate creates.
 *
 * @param v - Any value (number, string, etc.).
 * @returns Numeric value, or 0 if not a valid number.
 */
function toNum(v: unknown): number {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Builds latest pieces_sold per template_id+date from existing PB rows (newest first).
 * Key format: `template_id + \0 + date` (YYYY-MM-DD from created).
 *
 * @param rows - Template sales rows from PocketBase, sorted -created.
 * @returns Map from composite key to pieces_sold.
 */
function latestTemplateSales(
  rows: { template_id: string; pieces_sold?: unknown; created?: string }[],
): Map<string, number> {
  const map = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.template_id) continue;
    const date = dateFromCreated(r.created);
    if (!date) continue;
    const k = `${r.template_id}\0${date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    map.set(k, toNum(r.pieces_sold));
  }
  return map;
}

/**
 * Builds latest pieces_sold per item_id+date from existing PB rows (newest first).
 * Key format: `item_id + \0 + date` (YYYY-MM-DD from created).
 *
 * @param rows - Custom sales rows from PocketBase, sorted -created.
 * @returns Map from composite key to pieces_sold.
 */
function latestCustomSales(
  rows: { item_id: string; pieces_sold?: unknown; created?: string }[],
): Map<string, number> {
  const map = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of rows) {
    const date = dateFromCreated(r.created);
    if (!r.item_id || !date) continue;
    const k = `${r.item_id}\0${date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    map.set(k, toNum(r.pieces_sold));
  }
  return map;
}

/**
 * Persists current dashboard state to PocketBase. Only creates new records when
 * the value differs from the latest already in the DB (avoids duplicates on
 * re-save or refresh). Requires valid auth. Custom items are replaced in full:
 * existing custom_items are deleted, then recreated from state.
 *
 * @param state - Current in-memory {@link DashboardPbState}.
 * @returns `true` if save completed, `false` if not authenticated or on error.
 */
export async function saveDashboardToPb(
  state: DashboardPbState,
): Promise<boolean> {
  if (!pb.authStore.isValid) return false;
  const kioskId = getKioskId();
  try {
    const [
      existingTemplateSales,
      existingTemplatePrices,
      existingReprintSales,
      existingCustomItems,
      existingCustomSales,
    ] = await Promise.all([
      getAll<{ template_id: string; date: string; pieces_sold: number }>(
        COLLECTIONS.template_sales,
        kioskId,
      ),
      getAll<{ template_id: string; price: number }>(
        COLLECTIONS.template_prices,
        kioskId,
      ),
      getAll<{ date: string; pieces_sold: number; total_sales: number }>(
        COLLECTIONS.reprint_sales,
        kioskId,
      ),
      getAll<{ id: string }>(COLLECTIONS.custom_items, kioskId),
      getAll<{ item_id: string; date: string; pieces_sold: number }>(
        COLLECTIONS.custom_sales,
        kioskId,
      ),
    ]);

    const latestTemplateSalesMap = latestTemplateSales(existingTemplateSales);
    const latestTemplatePrices = latestByKey(
      existingTemplatePrices,
      (r) => r.template_id,
      (r) => toNum((r as { price?: unknown }).price),
    );
    const latestReprintByDate: Record<
      string,
      { pieces: number; total: number }
    > = {};
    const seenReprint = new Set<string>();
    for (const r of existingReprintSales) {
      const date = dateFromCreated(r.created);
      if (!date || seenReprint.has(date)) continue;
      seenReprint.add(date);
      const row = r as { pieces_sold?: unknown; total_sales?: unknown };
      latestReprintByDate[date] = {
        pieces: toNum(row.pieces_sold),
        total: toNum(row.total_sales),
      };
    }
    const latestCustomSalesMap = latestCustomSales(existingCustomSales);

    // Template sales: create only when value differs from latest in DB.
    for (const [templateId, byDate] of Object.entries(
      state.salesByTemplateIdByMonth,
    )) {
      for (const [date, pieces] of Object.entries(byDate)) {
        if (pieces <= 0) continue;
        const key = `${templateId}\0${date}`;
        if (toNum(latestTemplateSalesMap.get(key)) === pieces) continue;
        const templatePrice = state.priceByTemplateId[templateId] ?? 0;
        await createRecord(COLLECTIONS.template_sales, {
          kiosk_id: kioskId,
          template_id: templateId,
          template_name: (state.templateNames ?? {})[templateId] ?? "",
          pieces_sold: pieces,
          total_sales: pieces * templatePrice,
        });
      }
    }
    // Template prices: create only when price changed.
    const templateNames = state.templateNames ?? {};
    for (const [templateId, price] of Object.entries(state.priceByTemplateId)) {
      if (price < 0) continue;
      if (toNum(latestTemplatePrices[templateId]) === price) continue;
      await createRecord(COLLECTIONS.template_prices, {
        kiosk_id: kioskId,
        template_id: templateId,
        template_name: templateNames[templateId] ?? "",
        price,
      });
    }
    // Reprint: create only when pieces/total differ from latest for that date.
    const reprintDates = new Set([
      ...Object.keys(state.reprintSalesByMonth),
      ...Object.keys(state.reprintTotalByMonth),
    ]);
    for (const date of reprintDates) {
      const pieces = state.reprintSalesByMonth[date] ?? 0;
      const total = state.reprintTotalByMonth[date] ?? 0;
      if (pieces <= 0 && total <= 0) continue;
      const existing = latestReprintByDate[date];
      if (
        existing &&
        toNum(existing.pieces) === pieces &&
        toNum(existing.total) === total
      )
        continue;
      await createRecord(COLLECTIONS.reprint_sales, {
        kiosk_id: kioskId,
        pieces_sold: pieces,
        total_sales: total,
      });
    }

    // Custom items: replace in full (delete existing, then create from state).
    for (const r of existingCustomItems) {
      await pb.collection(COLLECTIONS.custom_items).delete(r.id);
    }
    const itemNameById: Record<string, string> = {};
    const itemPriceById: Record<string, number> = {};
    for (const item of state.customItems) {
      itemNameById[item.id] = item.name;
      itemPriceById[item.id] = item.price;
      await createRecord(COLLECTIONS.custom_items, {
        kiosk_id: kioskId,
        item_id: item.id,
        item_name: item.name,
        price: item.price,
      });
    }

    // Custom sales: create only when value differs from latest in DB.
    for (const [itemId, byDate] of Object.entries(
      state.customItemSalesByMonth,
    )) {
      for (const [date, pieces] of Object.entries(byDate)) {
        if (pieces <= 0) continue;
        const key = `${itemId}\0${date}`;
        if (toNum(latestCustomSalesMap.get(key)) === pieces) continue;
        const itemPrice = itemPriceById[itemId] ?? 0;
        await createRecord(COLLECTIONS.custom_sales, {
          kiosk_id: kioskId,
          item_id: itemId,
          item_name: itemNameById[itemId] ?? "",
          pieces_sold: pieces,
          total_sales: pieces * itemPrice,
        });
      }
    }
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Reset: delete all dashboard data for current kiosk
// -----------------------------------------------------------------------------

/**
 * Deletes all dashboard records for the current kiosk from PocketBase.
 * Use after a "reset" so the database reflects the cleared state. Requires valid auth.
 *
 * @returns `true` if all collections were cleared, `false` if not authenticated or on error.
 */
export async function deleteAllDashboardDataFromPb(): Promise<boolean> {
  if (!pb.authStore.isValid) return false;
  const kioskId = getKioskId();
  const collections = [
    COLLECTIONS.template_sales,
    COLLECTIONS.template_prices,
    COLLECTIONS.reprint_sales,
    COLLECTIONS.custom_items,
    COLLECTIONS.custom_sales,
  ];
  try {
    for (const collection of collections) {
      const items = await getAll<{ id: string }>(collection, kioskId);
      for (const item of items) {
        await pb.collection(collection).delete(item.id);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export { emptyState };
