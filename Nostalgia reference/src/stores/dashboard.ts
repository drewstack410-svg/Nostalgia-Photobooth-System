/**
 * Pinia store for dashboard sales and sync with PocketBase.
 *
 * - Holds template sales, prices, reprint sales/totals, custom items and their sales.
 * - Persists to localStorage and syncs to PocketBase (debounced); loads from PB on init when logged in.
 * - Date keys are YYYY-MM-DD; legacy YYYY-MM keys are migrated to YYYY-MM-01.
 *
 * @module stores/dashboard
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useAuthStore } from "./auth";
import { usePhotoboothStore } from "./photobooth";
import {
  loadDashboardFromPb,
  saveDashboardToPb,
  deleteAllDashboardDataFromPb,
  type DashboardPbState,
} from "@/lib/dashboardPb";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** One template row in the sales table (filtered by selected day/month/year). */
export interface TemplateSale {
  templateId: string;
  templateName: string;
  piecesSold: number;
  pricePerTemplate: number;
  total: number;
}

/** Discriminator for item types in the combined sales summary. */
export type ItemType = "photo_strip" | "reprint" | "custom";

/** One row in the combined item sales summary (photo strip, reprint, or custom). */
export interface ItemSaleRow {
  itemType: ItemType;
  itemId?: string;
  itemName: string;
  piecesSold: number;
  pricePerUnit: number;
  total: number;
}

/** Custom sellable item (id, name, price). */
export interface CustomItem {
  id: string;
  name: string;
  price: number;
}

// -----------------------------------------------------------------------------
// localStorage keys
// -----------------------------------------------------------------------------

const DASHBOARD_SALES_KEY = "nostalgia-dashboard-sales";
const DASHBOARD_PRICES_KEY = "nostalgia-dashboard-prices";
const DASHBOARD_REPRINT_KEY = "nostalgia-dashboard-reprint";
const DASHBOARD_REPRINT_TOTALS_KEY = "nostalgia-dashboard-reprint-totals";
const DASHBOARD_REPRINT_PRICE_KEY = "nostalgia-dashboard-reprint-price";
const DASHBOARD_CUSTOM_ITEMS_KEY = "nostalgia-dashboard-custom-items";
const DASHBOARD_CUSTOM_SALES_KEY = "nostalgia-dashboard-custom-sales";
/** Used once to rekey custom sales after migrating item IDs to item_1, item_2, … */
const CUSTOM_ITEM_ID_MIGRATION_KEY = "nostalgia-custom-item-id-migration";

// -----------------------------------------------------------------------------
// Helpers: date keys and period aggregation
// -----------------------------------------------------------------------------

/** Builds YYYY-MM-DD string for use as date key in by-date maps. */
function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Sums values from a by-date map for the given period.
 * - If day/month/year all set: returns value for that single date.
 * - If only month/year: returns sum of all days in that month.
 * - Otherwise: returns sum over all dates.
 */
function getValueForPeriod(
  byDate: Record<string, number>,
  day: number | null,
  month: number | null,
  year: number | null,
): number {
  if (day != null && month != null && year != null) {
    return byDate[dateKey(year, month, day)] ?? 0;
  }
  if (month != null && year != null) {
    const prefix = `${year}-${String(month).padStart(2, "0")}-`;
    return Object.entries(byDate).reduce(
      (sum, [k, v]) => sum + (k.startsWith(prefix) ? v : 0),
      0,
    );
  }
  return Object.values(byDate).reduce((sum, n) => sum + n, 0);
}

/**
 * Migrates legacy month-only keys (YYYY-MM) to date keys (YYYY-MM-01).
 * Other keys are left unchanged.
 */
function migrateMonthKeysToDateKeys(
  byDate: Record<string, number>,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(byDate)) {
    if (k.length === 7 && /^\d{4}-\d{2}$/.test(k)) {
      next[k + "-01"] = v;
    } else {
      next[k] = v;
    }
  }
  return next;
}

export const useDashboardStore = defineStore("dashboard", () => {
  // -------------------------------------------------------------------------
  // State: sales and filters
  // -------------------------------------------------------------------------

  /** template_id → { dateKey → pieces_sold } */
  const salesByTemplateIdByMonth = ref<Record<string, Record<string, number>>>(
    {},
  );
  /** template_id → price */
  const priceByTemplateId = ref<Record<string, number>>({});
  /** dateKey → reprint pieces_sold */
  const reprintSalesByMonth = ref<Record<string, number>>({});
  /** dateKey → reprint total_sales */
  const reprintTotalByMonth = ref<Record<string, number>>({});
  /** Price per reprint (used when recording reprint sales to add to total). */
  const reprintPricePerUnit = ref<number>(0);
  /** Custom items (id format item_1, item_2, …). */
  const customItems = ref<CustomItem[]>([]);
  /** item_id → { dateKey → pieces_sold } */
  const customItemSalesByMonth = ref<Record<string, Record<string, number>>>(
    {},
  );

  /** Selected date filter (null = all). */
  const selectedDay = ref<number | null>(null);
  const selectedMonth = ref<number | null>(null);
  const selectedYear = ref<number | null>(null);

  const photobooth = usePhotoboothStore();

  // -------------------------------------------------------------------------
  // PocketBase sync (debounced save + flush)
  // -------------------------------------------------------------------------

  let saveToPbTimeout: ReturnType<typeof setTimeout> | null = null;
  const PB_SAVE_DELAY_MS = 1200;

  /** True after a sync to PocketBase failed (e.g. not logged in). */
  const lastSyncError = ref<boolean>(false);

  /** Schedules a single save to PocketBase after a short delay to batch rapid edits. */
  function scheduleSaveToPb() {
    if (saveToPbTimeout) clearTimeout(saveToPbTimeout);
    saveToPbTimeout = setTimeout(async () => {
      saveToPbTimeout = null;
      const authStore = useAuthStore();
      if (!authStore.checkAuth()) {
        lastSyncError.value = true;
        return;
      }
      const ok = await saveDashboardToPb(getCurrentState());
      lastSyncError.value = !ok;
    }, PB_SAVE_DELAY_MS);
  }

  /**
   * Saves current state to PocketBase immediately (no debounce).
   * Use when closing or when custom items change so PB is up to date.
   * @returns true if save succeeded.
   */
  async function flushSaveToPb(): Promise<boolean> {
    const authStore = useAuthStore();
    if (!authStore.checkAuth()) {
      lastSyncError.value = true;
      return false;
    }
    const ok = await saveDashboardToPb(getCurrentState());
    lastSyncError.value = !ok;
    if (!ok) {
      console.error(
        "[Dashboard] Sync to PocketBase failed. Check console above for details. Ensure you are logged in and PocketBase is running.",
      );
    }
    return ok;
  }

  /** Applies loaded PocketBase state to store refs and migrates month keys; persists to localStorage and triggers PB save. */
  function applyPbState(state: DashboardPbState) {
    const s = state as DashboardPbState & {
      reprintTotalByMonth?: Record<string, number>;
    };
    const migrate = (r: Record<string, Record<string, number>>) => {
      const out: Record<string, Record<string, number>> = {};
      for (const [id, byKey] of Object.entries(r)) {
        if (typeof byKey === "object" && byKey !== null)
          out[id] = migrateMonthKeysToDateKeys(byKey);
      }
      return out;
    };
    salesByTemplateIdByMonth.value = migrate(s.salesByTemplateIdByMonth ?? {});
    priceByTemplateId.value = s.priceByTemplateId ?? {};
    reprintSalesByMonth.value = migrateMonthKeysToDateKeys(
      s.reprintSalesByMonth ?? {},
    );
    reprintTotalByMonth.value = migrateMonthKeysToDateKeys(
      s.reprintTotalByMonth ?? {},
    );
    customItems.value = s.customItems ?? [];
    const customSales = s.customItemSalesByMonth ?? {};
    const migratedCustom: Record<string, Record<string, number>> = {};
    for (const [id, byKey] of Object.entries(customSales)) {
      if (typeof byKey === "object" && byKey !== null)
        migratedCustom[id] = migrateMonthKeysToDateKeys(byKey);
    }
    customItemSalesByMonth.value = migratedCustom;
    persistSales();
    persistPrices();
    persistReprint();
    persistReprintTotals();
    persistCustomItems();
    persistCustomSales();
  }

  /** Builds DashboardPbState from current store refs (includes templateNames from photobooth). */
  function getCurrentState(): DashboardPbState {
    const templateNames: Record<string, string> = {};
    for (const t of photobooth.templates) templateNames[t.id] = t.name;
    return {
      salesByTemplateIdByMonth: salesByTemplateIdByMonth.value,
      priceByTemplateId: priceByTemplateId.value,
      reprintSalesByMonth: reprintSalesByMonth.value,
      reprintTotalByMonth: reprintTotalByMonth.value,
      customItems: customItems.value,
      customItemSalesByMonth: customItemSalesByMonth.value,
      templateNames,
    } as DashboardPbState;
  }

  /**
   * Loads dashboard from PocketBase and applies to store. Call when user is logged in.
   * @returns true if load succeeded, false if not authenticated or error.
   */
  async function initFromPocketBase(): Promise<boolean> {
    const state = await loadDashboardFromPb();
    if (state) {
      applyPbState(state);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Computed: sales per template and item summary
  // -------------------------------------------------------------------------

  /** Pieces sold for one template in the selected period (day, month, or all). */
  function getPiecesForTemplate(
    templateId: string,
    day: number | null,
    month: number | null,
    year: number | null,
  ): number {
    const byDate = salesByTemplateIdByMonth.value[templateId];
    if (!byDate) return 0;
    return getValueForPeriod(byDate, day, month, year);
  }

  /** Template rows for the selected period (each template's pieces, price, total). */
  const salesPerTemplate = computed<TemplateSale[]>(() => {
    const templates = photobooth.templates;
    const prices = priceByTemplateId.value;
    const day = selectedDay.value;
    const month = selectedMonth.value;
    const year = selectedYear.value;
    return templates.map((t) => {
      const pieces = getPiecesForTemplate(t.id, day, month, year);
      const price = prices[t.id] ?? 0;
      return {
        templateId: t.id,
        templateName: t.name,
        piecesSold: pieces,
        pricePerTemplate: price,
        total: pieces * price,
      };
    });
  });

  function getPiecesForItemByDate(
    byDate: Record<string, number>,
    day: number | null,
    month: number | null,
    year: number | null,
  ): number {
    return getValueForPeriod(byDate, day, month, year);
  }

  /** Combined rows: Photo strip, Reprint, then one row per custom item (for selected period). */
  const itemSalesSummary = computed<ItemSaleRow[]>(() => {
    const day = selectedDay.value;
    const month = selectedMonth.value;
    const year = selectedYear.value;
    const photoPieces = salesPerTemplate.value.reduce(
      (sum, row) => sum + row.piecesSold,
      0,
    );
    const photoTotal = salesPerTemplate.value.reduce(
      (sum, row) => sum + row.total,
      0,
    );
    const reprintPieces = getPiecesForItemByDate(
      reprintSalesByMonth.value,
      day,
      month,
      year,
    );
    const reprintTotal = getPiecesForItemByDate(
      reprintTotalByMonth.value,
      day,
      month,
      year,
    );
    const rows: ItemSaleRow[] = [
      {
        itemType: "photo_strip",
        itemName: "Photo strip",
        piecesSold: photoPieces,
        pricePerUnit: 0,
        total: photoTotal,
      },
      {
        itemType: "reprint",
        itemName: "Reprint",
        piecesSold: reprintPieces,
        pricePerUnit: reprintPricePerUnit.value,
        total: reprintTotal,
      },
    ];
    customItems.value.forEach((item) => {
      const pieces = getPiecesForItemByDate(
        customItemSalesByMonth.value[item.id] ?? {},
        day,
        month,
        year,
      );
      rows.push({
        itemType: "custom",
        itemId: item.id,
        itemName: item.name,
        piecesSold: pieces,
        pricePerUnit: item.price,
        total: pieces * item.price,
      });
    });
    return rows;
  });

  /** Sum of pieces sold across all item types for the selected period. */
  const totalPiecesSold = computed(() =>
    itemSalesSummary.value.reduce((sum, row) => sum + row.piecesSold, 0),
  );

  /** Sum of total sales (revenue) across all item types for the selected period. */
  const totalSales = computed(() =>
    itemSalesSummary.value.reduce((sum, row) => sum + row.total, 0),
  );

  // -------------------------------------------------------------------------
  // Mutations: template sales and prices
  // -------------------------------------------------------------------------

  /**
   * Sets pieces sold for a template on a given date (or selected date if omitted).
   * Removes the key if count <= 0. Persists and schedules PB save.
   */
  function setPiecesSold(
    templateId: string,
    count: number,
    forYear?: number,
    forMonth?: number,
    forDay?: number,
  ) {
    const now = new Date();
    const y = forYear ?? selectedYear.value ?? now.getFullYear();
    const m = forMonth ?? selectedMonth.value ?? now.getMonth() + 1;
    const d = forDay ?? selectedDay.value ?? now.getDate();
    const key = dateKey(y, m, d);
    const next = { ...salesByTemplateIdByMonth.value };
    if (!next[templateId]) next[templateId] = {};
    const nextTemplate = { ...next[templateId] };
    if (count <= 0) {
      delete nextTemplate[key];
    } else {
      nextTemplate[key] = count;
    }
    if (Object.keys(nextTemplate).length === 0) {
      delete next[templateId];
    } else {
      next[templateId] = nextTemplate;
    }
    salesByTemplateIdByMonth.value = next;
    persistSales();
  }

  /** Sets or clears price for a template (0 removes the entry). Persists and schedules PB save. */
  function setPricePerTemplate(templateId: string, price: number) {
    if (price < 0) return;
    if (price === 0) {
      const next = { ...priceByTemplateId.value };
      delete next[templateId];
      priceByTemplateId.value = next;
    } else {
      priceByTemplateId.value = {
        ...priceByTemplateId.value,
        [templateId]: price,
      };
    }
    persistPrices();
  }

  /** Increments pieces sold for the template by 1 for today. Persists and schedules PB save. */
  function recordSale(templateId: string) {
    const now = new Date();
    const key = dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const next = { ...salesByTemplateIdByMonth.value };
    if (!next[templateId]) next[templateId] = {};
    next[templateId] = {
      ...next[templateId],
      [key]: (next[templateId][key] ?? 0) + 1,
    };
    salesByTemplateIdByMonth.value = next;
    persistSales();
  }

  /**
   * Increments reprint pieces sold by quantity for today and adds quantity * price to total sales.
   * @param quantity - Number of reprints (pieces sold).
   * @param pricePerUnit - Optional. Price per reprint for this sale (e.g. from template). If not provided, uses reprintPricePerUnit.
   */
  function recordReprintSale(quantity = 1, pricePerUnit?: number) {
    const now = new Date();
    const key = dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
    reprintSalesByMonth.value = {
      ...reprintSalesByMonth.value,
      [key]: (reprintSalesByMonth.value[key] ?? 0) + quantity,
    };
    const price =
      pricePerUnit !== undefined && pricePerUnit >= 0
        ? pricePerUnit
        : reprintPricePerUnit.value;
    reprintTotalByMonth.value = {
      ...reprintTotalByMonth.value,
      [key]: (reprintTotalByMonth.value[key] ?? 0) + quantity * price,
    };
    persistReprintTotals();
    persistReprint();
  }

  /** Increments pieces sold for a custom item for today. Persists and schedules PB save. */
  function recordCustomItemSale(itemId: string, quantity = 1) {
    const now = new Date();
    const key = dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const next = { ...customItemSalesByMonth.value };
    if (!next[itemId]) next[itemId] = {};
    next[itemId] = {
      ...next[itemId],
      [key]: (next[itemId][key] ?? 0) + quantity,
    };
    customItemSalesByMonth.value = next;
    persistCustomSales();
  }

  /** Sets reprint pieces for the selected date (or today). <= 0 removes the key. */
  function setReprintPiecesForMonth(pieces: number) {
    const now = new Date();
    const y = selectedYear.value ?? now.getFullYear();
    const m = selectedMonth.value ?? now.getMonth() + 1;
    const d = selectedDay.value ?? now.getDate();
    const key = dateKey(y, m, d);
    if (pieces <= 0) {
      const next = { ...reprintSalesByMonth.value };
      delete next[key];
      reprintSalesByMonth.value = next;
    } else {
      reprintSalesByMonth.value = {
        ...reprintSalesByMonth.value,
        [key]: pieces,
      };
    }
    persistReprint();
  }

  /** Sets reprint price per unit. Used when recording reprint sales to add to total. Persists to localStorage. */
  function setReprintPricePerUnit(price: number) {
    if (price < 0) return;
    reprintPricePerUnit.value = price;
    persistReprintPrice();
  }

  /** Sets reprint total sales for the selected date (or today). <= 0 removes the key. */
  function setReprintTotalForMonth(total: number) {
    const now = new Date();
    const y = selectedYear.value ?? now.getFullYear();
    const m = selectedMonth.value ?? now.getMonth() + 1;
    const d = selectedDay.value ?? now.getDate();
    const key = dateKey(y, m, d);
    if (total <= 0) {
      const next = { ...reprintTotalByMonth.value };
      delete next[key];
      reprintTotalByMonth.value = next;
    } else {
      reprintTotalByMonth.value = {
        ...reprintTotalByMonth.value,
        [key]: total,
      };
    }
    persistReprintTotals();
  }

  /**
   * Adds a new custom item with id item_N (N = next free number). Returns the new id.
   * Persists and flushes to PocketBase.
   */
  function addCustomItem(name: string, price = 0): string {
    const existing = customItems.value;
    let nextNum = 1;
    for (const item of existing) {
      const m = item.id.match(/^item_(\d+)$/);
      if (m) nextNum = Math.max(nextNum, parseInt(m[1], 10) + 1);
    }
    const id = `item_${nextNum}`;
    customItems.value = [
      ...existing,
      { id, name: name.trim() || "New item", price },
    ];
    persistCustomItems();
    return id;
  }

  /** Removes a custom item and its sales data. Persists and syncs to PB. */
  function removeCustomItem(id: string) {
    customItems.value = customItems.value.filter((item) => item.id !== id);
    const next = { ...customItemSalesByMonth.value };
    delete next[id];
    customItemSalesByMonth.value = next;
    persistCustomItems();
    persistCustomSales();
  }

  /** Updates custom item name (ignored if trimmed empty). Persists and schedules PB save. */
  function setCustomItemName(id: string, name: string) {
    const next = name.trim();
    if (!next) return;
    customItems.value = customItems.value.map((item) =>
      item.id === id ? { ...item, name: next } : item,
    );
    persistCustomItems();
  }

  /** Updates custom item price (negative ignored). Persists and schedules PB save. */
  function setCustomItemPrice(id: string, price: number) {
    if (price < 0) return;
    const item = customItems.value.find((i) => i.id === id);
    if (!item) return;
    item.price = price;
    persistCustomItems();
  }

  /** Sets pieces sold for a custom item for the selected date (or today). <= 0 removes the key. */
  function setCustomItemPieces(id: string, pieces: number) {
    const now = new Date();
    const y = selectedYear.value ?? now.getFullYear();
    const m = selectedMonth.value ?? now.getMonth() + 1;
    const d = selectedDay.value ?? now.getDate();
    const key = dateKey(y, m, d);
    const next = { ...customItemSalesByMonth.value };
    if (!next[id]) next[id] = {};
    const nextItem = { ...next[id] };
    if (pieces <= 0) {
      delete nextItem[key];
    } else {
      nextItem[key] = pieces;
    }
    if (Object.keys(nextItem).length === 0) {
      delete next[id];
    } else {
      next[id] = nextItem;
    }
    customItemSalesByMonth.value = next;
    persistCustomSales();
  }

  // -------------------------------------------------------------------------
  // Persistence: localStorage load/persist (and legacy migrations)
  // -------------------------------------------------------------------------

  /** Loads template sales from localStorage; migrates old number-per-template and YYYY-MM keys. */
  function loadSales() {
    try {
      const raw = localStorage.getItem(DASHBOARD_SALES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        let data: Record<string, Record<string, number>> = {};
        if (parsed && typeof parsed === "object") {
          const isOldNumberFormat = Object.values(parsed).some(
            (v) => typeof v === "number",
          );
          if (isOldNumberFormat) {
            const now = new Date();
            const key = dateKey(
              now.getFullYear(),
              now.getMonth() + 1,
              now.getDate(),
            );
            for (const [id, val] of Object.entries(parsed)) {
              if (typeof val === "number") data[id] = { [key]: val };
              else if (typeof val === "object" && val !== null)
                data[id] = migrateMonthKeysToDateKeys(
                  val as Record<string, number>,
                );
            }
          } else {
            for (const [id, byKey] of Object.entries(parsed)) {
              if (typeof byKey === "object" && byKey !== null)
                data[id] = migrateMonthKeysToDateKeys(
                  byKey as Record<string, number>,
                );
            }
          }
        }
        salesByTemplateIdByMonth.value = data;
      }
    } catch (e) {
      console.error("Failed to load dashboard sales:", e);
    }
  }

  /** Saves template sales to localStorage and schedules PB sync. */
  function persistSales() {
    localStorage.setItem(
      DASHBOARD_SALES_KEY,
      JSON.stringify(salesByTemplateIdByMonth.value),
    );
    scheduleSaveToPb();
  }

  /** Loads reprint pieces from localStorage; migrates YYYY-MM keys. */
  function loadReprint() {
    try {
      const raw = localStorage.getItem(DASHBOARD_REPRINT_KEY);
      if (raw)
        reprintSalesByMonth.value = migrateMonthKeysToDateKeys(JSON.parse(raw));
    } catch (e) {
      console.error("Failed to load reprint sales:", e);
    }
  }

  /** Saves reprint pieces to localStorage and schedules PB sync. */
  function persistReprint() {
    localStorage.setItem(
      DASHBOARD_REPRINT_KEY,
      JSON.stringify(reprintSalesByMonth.value),
    );
    scheduleSaveToPb();
  }

  /** Loads reprint totals from localStorage; migrates YYYY-MM keys. */
  function loadReprintTotals() {
    try {
      const raw = localStorage.getItem(DASHBOARD_REPRINT_TOTALS_KEY);
      if (raw)
        reprintTotalByMonth.value = migrateMonthKeysToDateKeys(JSON.parse(raw));
    } catch (e) {
      console.error("Failed to load reprint totals:", e);
    }
  }

  /** Saves reprint totals to localStorage and schedules PB sync. */
  function persistReprintTotals() {
    localStorage.setItem(
      DASHBOARD_REPRINT_TOTALS_KEY,
      JSON.stringify(reprintTotalByMonth.value),
    );
    scheduleSaveToPb();
  }

  function loadReprintPrice() {
    try {
      const raw = localStorage.getItem(DASHBOARD_REPRINT_PRICE_KEY);
      if (raw != null) {
        const n = Number(raw);
        if (!Number.isNaN(n) && n >= 0) reprintPricePerUnit.value = n;
      }
    } catch (e) {
      console.error("Failed to load reprint price:", e);
    }
  }

  function persistReprintPrice() {
    localStorage.setItem(
      DASHBOARD_REPRINT_PRICE_KEY,
      String(reprintPricePerUnit.value),
    );
    scheduleSaveToPb();
  }

  /** Loads custom items from localStorage; migrates non-item_N IDs to item_1, item_2, … and stores mapping for sales rekey. */
  function loadCustomItems() {
    try {
      const raw = localStorage.getItem(DASHBOARD_CUSTOM_ITEMS_KEY);
      if (raw) customItems.value = JSON.parse(raw);
      const needsMigration = customItems.value.some(
        (t) => !/^item_\d+$/.test(t.id),
      );
      if (needsMigration && customItems.value.length > 0) {
        const mapping: Record<string, string> = {};
        customItems.value = customItems.value.map((item, i) => {
          const newId = `item_${i + 1}`;
          mapping[item.id] = newId;
          return { ...item, id: newId };
        });
        persistCustomItems();
        try {
          localStorage.setItem(
            CUSTOM_ITEM_ID_MIGRATION_KEY,
            JSON.stringify(mapping),
          );
        } catch (_) {}
      }
    } catch (e) {
      console.error("Failed to load custom items:", e);
    }
  }

  /** Saves custom items to localStorage, schedules PB sync, and flushes to PB (custom items replace in PB). */
  function persistCustomItems() {
    localStorage.setItem(
      DASHBOARD_CUSTOM_ITEMS_KEY,
      JSON.stringify(customItems.value),
    );
    scheduleSaveToPb();
    flushSaveToPb().catch(() => {});
  }

  /** Loads custom item sales from localStorage; migrates keys and applies item ID migration if present. */
  function loadCustomSales() {
    try {
      const raw = localStorage.getItem(DASHBOARD_CUSTOM_SALES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<
          string,
          Record<string, number>
        >;
        const migrated: Record<string, Record<string, number>> = {};
        for (const [id, byKey] of Object.entries(parsed)) {
          if (typeof byKey === "object" && byKey !== null)
            migrated[id] = migrateMonthKeysToDateKeys(byKey);
        }
        const mappingRaw = localStorage.getItem(CUSTOM_ITEM_ID_MIGRATION_KEY);
        if (mappingRaw) {
          try {
            const mapping = JSON.parse(mappingRaw) as Record<string, string>;
            if (mapping && typeof mapping === "object") {
              const rekeyed: Record<string, Record<string, number>> = {};
              for (const [oldId, byDate] of Object.entries(migrated)) {
                const newId = mapping[oldId] ?? oldId;
                rekeyed[newId] = byDate;
              }
              customItemSalesByMonth.value = rekeyed;
              localStorage.removeItem(CUSTOM_ITEM_ID_MIGRATION_KEY);
              persistCustomSales();
              return;
            }
          } catch (_) {}
        }
        customItemSalesByMonth.value = migrated;
      }
    } catch (e) {
      console.error("Failed to load custom item sales:", e);
    }
  }

  /** Saves custom item sales to localStorage, schedules PB sync, and flushes to PB. */
  function persistCustomSales() {
    localStorage.setItem(
      DASHBOARD_CUSTOM_SALES_KEY,
      JSON.stringify(customItemSalesByMonth.value),
    );
    scheduleSaveToPb();
    flushSaveToPb().catch(() => {});
  }

  /** Sets the selected period filter (month/year and optionally day). Used by dashboard UI. */
  function setMonthYear(
    month: number | null,
    year: number | null,
    day?: number | null,
  ) {
    selectedMonth.value = month;
    selectedYear.value = year;
    if (day !== undefined) selectedDay.value = day;
  }

  /** Clears all dashboard data in memory and localStorage, then deletes all records for this kiosk in PocketBase. */
  async function resetDashboard(): Promise<void> {
    salesByTemplateIdByMonth.value = {};
    priceByTemplateId.value = {};
    reprintSalesByMonth.value = {};
    reprintTotalByMonth.value = {};
    reprintPricePerUnit.value = 0;
    customItems.value = [];
    customItemSalesByMonth.value = {};
    persistSales();
    persistPrices();
    persistReprint();
    persistReprintTotals();
    persistReprintPrice();
    persistCustomItems();
    persistCustomSales();
    await deleteAllDashboardDataFromPb();
  }

  /** Loads template prices from localStorage. */
  function loadPrices() {
    try {
      const raw = localStorage.getItem(DASHBOARD_PRICES_KEY);
      if (raw) priceByTemplateId.value = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to load dashboard prices:", e);
    }
  }

  /** Saves template prices to localStorage and schedules PB sync. */
  function persistPrices() {
    localStorage.setItem(
      DASHBOARD_PRICES_KEY,
      JSON.stringify(priceByTemplateId.value),
    );
    scheduleSaveToPb();
  }

  // Load from localStorage on store creation (PB load is done by app when logged in).
  loadSales();
  loadPrices();
  loadReprint();
  loadReprintTotals();
  loadReprintPrice();
  loadCustomItems();
  loadCustomSales();

  return {
    selectedDay,
    selectedMonth,
    selectedYear,
    salesByTemplateIdByMonth,
    priceByTemplateId,
    reprintSalesByMonth,
    reprintTotalByMonth,
    reprintPricePerUnit,
    customItems,
    customItemSalesByMonth,
    salesPerTemplate,
    itemSalesSummary,
    totalPiecesSold,
    totalSales,
    setPiecesSold,
    setPricePerTemplate,
    recordSale,
    recordReprintSale,
    recordCustomItemSale,
    setReprintPiecesForMonth,
    setReprintTotalForMonth,
    setReprintPricePerUnit,
    addCustomItem,
    removeCustomItem,
    setCustomItemName,
    setCustomItemPrice,
    setCustomItemPieces,
    setMonthYear,
    loadSales,
    loadPrices,
    initFromPocketBase,
    resetDashboard,
    lastSyncError,
  };
});
