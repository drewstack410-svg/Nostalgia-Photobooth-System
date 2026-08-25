<script setup lang="ts">
/**
 * Dashboard view: sales summary, date filter, Sales by Item (with add/remove),
 * Sales by Template, and Excel export (single sheet with styling).
 */
import { computed, onMounted, ref } from "vue";
import * as XLSX from "xlsx-js-style";
import DataTable from "@/components/DataTable.vue";
import type { DataTableColumn } from "@/components/DataTable.vue";
import { useDashboardStore } from "@/stores/dashboard";
import { pb } from "@/lib/pocketbase";

const dashboard = useDashboardStore();

const showResetModal = ref(false);
const resetPassword = ref("");
const resetError = ref("");
const resetSubmitting = ref(false);

function openResetModal() {
  showResetModal.value = true;
  resetPassword.value = "";
  resetError.value = "";
}

function closeResetModal() {
  showResetModal.value = false;
  resetPassword.value = "";
  resetError.value = "";
}

async function confirmReset() {
  const pwd = resetPassword.value.trim();
  if (!pwd) {
    resetError.value = "Please enter your password.";
    return;
  }
  const envEmail =
    typeof import.meta.env?.VITE_ADMIN_EMAIL === "string"
      ? import.meta.env.VITE_ADMIN_EMAIL.trim()
      : "";
  if (!envEmail) {
    resetError.value = "Admin email not configured.";
    return;
  }
  resetError.value = "";
  resetSubmitting.value = true;
  try {
    await pb.admins.authWithPassword(envEmail, pwd);
  } catch {
    resetError.value = "Wrong password.";
    resetSubmitting.value = false;
    return;
  }
  try {
    await dashboard.resetDashboard();
    closeResetModal();
  } catch {
    resetError.value = "Failed to reset database.";
  } finally {
    resetSubmitting.value = false;
  }
}

const COLUMNS = {
  item: "Item",
  template: "Template",
  piecesSold: "Pieces sold",
  pricePerUnit: "Price per unit",
  totalSales: "Total sales",
} as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const years = computed(() => {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2, y - 3, y - 4];
});

const daysInMonth = computed(() => {
  const m = dashboard.selectedMonth;
  const y = dashboard.selectedYear;
  if (m == null || y == null) return 31;
  return new Date(y, m, 0).getDate();
});

const dayOptions = computed(() => {
  const n = daysInMonth.value;
  return Array.from({ length: n }, (_, i) => i + 1);
});

const filterLabel = computed(() => {
  const m = dashboard.selectedMonth;
  const y = dashboard.selectedYear;
  const d = dashboard.selectedDay;
  if (m == null || y == null) return "All time";
  const monthName = MONTHS[m - 1];
  const maxDay = new Date(y, m, 0).getDate();
  if (d != null && d >= 1 && d <= maxDay) return `${monthName} ${d}, ${y}`;
  return `${monthName} ${y}`;
});

function onDayChange(e: Event) {
  const el = e.target as HTMLSelectElement;
  const v = el.value === "" ? null : Number(el.value);
  dashboard.setMonthYear(dashboard.selectedMonth, dashboard.selectedYear, v);
}

// Resetting day to null when month/year change avoids invalid dates (e.g. Feb 31).
function onMonthChange(e: Event) {
  const el = e.target as HTMLSelectElement;
  const v = el.value === "" ? null : Number(el.value);
  dashboard.setMonthYear(v, dashboard.selectedYear, null);
}

function onYearChange(e: Event) {
  const el = e.target as HTMLSelectElement;
  const v = el.value === "" ? null : Number(el.value);
  dashboard.setMonthYear(dashboard.selectedMonth, v, null);
}

onMounted(() => {
  if (dashboard.selectedMonth === null && dashboard.selectedYear === null) {
    const d = new Date();
    dashboard.setMonthYear(d.getMonth() + 1, d.getFullYear(), d.getDate());
  }
});

/** PHP currency; zero shown as em dash. */
function formatCurrency(value: unknown): string {
  const n = Number(value ?? 0);
  return n === 0
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "PHP",
      }).format(n);
}

const columns: DataTableColumn[] = [
  { key: "item", label: COLUMNS.template },
  {
    key: "piecesSold",
    label: COLUMNS.piecesSold,
    formatter: (v) => Number(v ?? 0),
    class: "col-number",
  },
  {
    key: "pricePerUnit",
    label: COLUMNS.pricePerUnit,
    formatter: formatCurrency,
    class: "col-number",
  },
  {
    key: "totalSales",
    label: COLUMNS.totalSales,
    formatter: formatCurrency,
    class: "col-number",
  },
  {
    key: "action",
    label: "Action",
    slot: "template-action",
    class: "col-actions",
  },
];

const rows = computed(() =>
  dashboard.salesPerTemplate.map((s) => ({
    templateId: s.templateId,
    item: s.templateName,
    piecesSold: s.piecesSold,
    pricePerUnit: s.pricePerTemplate,
    totalSales: s.total,
  })),
);

// Edit template modal
const showEditTemplateModal = ref(false);
const editTemplateRow = ref<{
  templateId: string;
  item: string;
  piecesSold: number;
  pricePerUnit: number;
  totalSales: number;
} | null>(null);
const editTemplatePieces = ref(0);
const editTemplatePrice = ref(0);

function openEditTemplateModal(row: {
  templateId: string;
  item: string;
  piecesSold: number;
  pricePerUnit: number;
  totalSales: number;
}) {
  editTemplateRow.value = row;
  editTemplatePieces.value = row.piecesSold;
  editTemplatePrice.value = row.pricePerUnit;
  showEditTemplateModal.value = true;
}

function closeEditTemplateModal() {
  editTemplateRow.value = null;
  showEditTemplateModal.value = false;
}

function saveEditTemplate() {
  if (!editTemplateRow.value) return;
  const now = new Date();
  const y = dashboard.selectedYear ?? now.getFullYear();
  const m = dashboard.selectedMonth ?? now.getMonth() + 1;
  const day = dashboard.selectedDay ?? now.getDate();
  dashboard.setPiecesSold(
    editTemplateRow.value.templateId,
    Math.max(0, Math.floor(editTemplatePieces.value)),
    y,
    m,
    day,
  );
  if (editTemplatePrice.value >= 0)
    dashboard.setPricePerTemplate(
      editTemplateRow.value.templateId,
      editTemplatePrice.value,
    );
  closeEditTemplateModal();
}

// Item table: display-only cells, Action column with Edit (and Remove for custom)
const itemColumns = computed<DataTableColumn[]>(() => [
  { key: "item", label: COLUMNS.item },
  {
    key: "piecesSold",
    label: COLUMNS.piecesSold,
    formatter: (v) => Number(v ?? 0),
    class: "col-number",
  },
  {
    key: "pricePerUnit",
    label: COLUMNS.pricePerUnit,
    formatter: (v, row) => {
      const t = (row as { itemType: string }).itemType;
      return t === "photo_strip" ? "—" : formatCurrency(v);
    },
    class: "col-number",
  },
  {
    key: "totalSales",
    label: COLUMNS.totalSales,
    formatter: formatCurrency,
    class: "col-number",
  },
  {
    key: "action",
    label: "Action",
    slot: "item-actions",
    class: "col-actions",
  },
]);

const itemRows = computed(() =>
  dashboard.itemSalesSummary.map((s) => ({
    itemType: s.itemType,
    itemId: s.itemId,
    item: s.itemName,
    piecesSold: s.piecesSold,
    pricePerUnit: s.pricePerUnit,
    totalSales: s.total,
  })),
);

// Edit item modal
const showEditItemModal = ref(false);
const editItemRow = ref<{
  itemType: string;
  itemId?: string;
  item: string;
  piecesSold: number;
  pricePerUnit: number;
  totalSales: number;
} | null>(null);
const editItemName = ref("");
const editItemPieces = ref(0);
const editItemPrice = ref(0);
const editItemTotal = ref(0);

function openEditItemModal(row: {
  itemType: string;
  itemId?: string;
  item: string;
  piecesSold: number;
  pricePerUnit: number;
  totalSales: number;
}) {
  editItemRow.value = row;
  editItemName.value = row.item;
  editItemPieces.value = row.piecesSold;
  editItemPrice.value = row.pricePerUnit;
  editItemTotal.value = row.totalSales;
  showEditItemModal.value = true;
}

function closeEditItemModal() {
  editItemRow.value = null;
  showEditItemModal.value = false;
}

function saveEditItem() {
  if (!editItemRow.value) return;
  const r = editItemRow.value;
  if (r.itemType === "photo_strip") {
    closeEditItemModal();
    return;
  }
  if (r.itemType === "reprint") {
    dashboard.setReprintPiecesForMonth(
      Math.max(0, Math.floor(editItemPieces.value)),
    );
    dashboard.setReprintTotalForMonth(Math.max(0, editItemTotal.value));
    if (editItemPrice.value >= 0)
      dashboard.setReprintPricePerUnit(editItemPrice.value);
  } else if (r.itemType === "custom" && r.itemId) {
    dashboard.setCustomItemPieces(
      r.itemId,
      Math.max(0, Math.floor(editItemPieces.value)),
    );
    if (editItemName.value.trim())
      dashboard.setCustomItemName(r.itemId, editItemName.value.trim());
    if (editItemPrice.value >= 0)
      dashboard.setCustomItemPrice(r.itemId, editItemPrice.value);
  }
  closeEditItemModal();
}

const editItemShowPricePerUnit = computed(
  () =>
    editItemRow.value && editItemRow.value.itemType !== "photo_strip",
);
const editItemShowTotal = computed(
  () => editItemRow.value && editItemRow.value.itemType === "reprint",
);
const editItemShowName = computed(
  () => editItemRow.value && editItemRow.value.itemType === "custom",
);
const editItemIsPhotoStrip = computed(
  () => editItemRow.value && editItemRow.value.itemType === "photo_strip",
);

const showAddItemModal = ref(false);
const newItemName = ref("");
const newItemPrice = ref<number>(0);
const newItemPieces = ref<number>(0);

function openAddItemModal() {
  newItemName.value = "";
  newItemPrice.value = 0;
  newItemPieces.value = 0;
  showAddItemModal.value = true;
}

function closeAddItemModal() {
  showAddItemModal.value = false;
}

function addItem() {
  const name = newItemName.value.trim() || "New item";
  const id = dashboard.addCustomItem(name, newItemPrice.value);
  const pieces = Math.max(0, Math.floor(Number(newItemPieces.value) || 0));
  // Pieces are stored for the selected month/year (or current month when "All").
  if (pieces > 0) dashboard.setCustomItemPieces(id, pieces);
  newItemName.value = "";
  newItemPrice.value = 0;
  newItemPieces.value = 0;
  closeAddItemModal();
}

/** Builds a single Excel sheet: summary, Sales by Item table, Sales by Template table; applies header/section styles. */
function exportToExcel() {
  const m = dashboard.selectedMonth;
  const y = dashboard.selectedYear;
  const d = dashboard.selectedDay;
  let periodLabel = "All time";
  if (m != null && y != null) {
    const monthName = MONTHS[m - 1];
    periodLabel = d != null ? `${monthName} ${d}, ${y}` : `${monthName} ${y}`;
  }
  let period = "All-time";
  if (m != null && y != null) {
    const monthName = MONTHS[m - 1];
    period =
      d != null
        ? `${monthName}-${String(d).padStart(2, "0")}-${y}`
        : `${monthName}-${y}`;
  }

  const aoa: (string | number)[][] = [];

  aoa.push(["Sales Summary"]);
  aoa.push(["Period", periodLabel]);
  aoa.push(["Total pieces sold", dashboard.totalPiecesSold]);
  aoa.push(["Total sales", formatCurrency(dashboard.totalSales)]);
  aoa.push([]);

  aoa.push(["Sales by Item"]);
  aoa.push([
    COLUMNS.item,
    COLUMNS.piecesSold,
    COLUMNS.pricePerUnit,
    COLUMNS.totalSales,
  ]);
  itemRows.value.forEach((r) => {
    aoa.push([
      r.item,
      r.piecesSold,
      r.pricePerUnit === 0 ? "—" : r.pricePerUnit,
      r.totalSales,
    ]);
  });
  aoa.push([]);

  aoa.push(["Sales by Template"]);
  aoa.push([
    COLUMNS.template,
    COLUMNS.piecesSold,
    COLUMNS.pricePerUnit,
    COLUMNS.totalSales,
  ]);
  rows.value.forEach((r) => {
    aoa.push([r.item, r.piecesSold, r.pricePerUnit, r.totalSales]);
  });

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  const colWidth = 20;
  sheet["!cols"] = [
    { wch: colWidth },
    { wch: colWidth },
    { wch: colWidth },
    { wch: colWidth },
  ];

  const sectionTitleStyle = {
    font: { bold: true, sz: 12 },
  };
  const tableHeaderStyle = {
    font: { bold: true, sz: 11 },
    fill: { fgColor: { rgb: "E8DED4" } },
    alignment: { horizontal: "left" },
  };
  const summaryLabelStyle = { font: { bold: true } };

  // 1-based Excel rows: 1=summary title, 6=Sales by Item title, 7=item headers; template block starts after item rows + blank.
  const itemHeaderRow = 7;
  const templateTitleRow = 9 + itemRows.value.length;
  const templateHeaderRow = 10 + itemRows.value.length;

  for (const ref of Object.keys(sheet)) {
    if (ref.startsWith("!")) continue;
    const cell = sheet[ref];
    if (!cell || typeof cell !== "object") continue;
    const rowNum = parseInt(ref.replace(/^[A-Z]+/i, ""), 10);
    if (Number.isNaN(rowNum)) continue;

    if (rowNum === 1 || rowNum === 6 || rowNum === templateTitleRow) {
      cell.s = sectionTitleStyle;
    } else if (rowNum >= 2 && rowNum <= 4 && ref.replace(/\d+$/, "") === "A") {
      cell.s = summaryLabelStyle;
    } else if (rowNum === itemHeaderRow || rowNum === templateHeaderRow) {
      cell.s = tableHeaderStyle;
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sales Summary");
  XLSX.writeFile(wb, `Dashboard-${period}.xlsx`);
}
</script>

<template>
  <div class="tab-content dashboard-content">
    <div
      v-if="showResetModal"
      class="dashboard-reset-overlay"
      @click.self="closeResetModal"
    >
      <div class="dashboard-reset-modal">
        <h3 class="dashboard-reset-modal__title">Reset Dashboard</h3>
        <p class="dashboard-reset-modal__message">
          Are you sure you want to reset all dashboard data? All sales, prices,
          reprint totals, and custom items will be cleared. This cannot be
          undone.
        </p>
        <p class="dashboard-reset-modal__hint">
          Enter your admin password to confirm.
        </p>
        <input
          v-model="resetPassword"
          type="password"
          class="dashboard-reset-modal__input"
          placeholder="Admin password"
          autocomplete="current-password"
          :disabled="resetSubmitting"
          @keydown.enter="confirmReset"
        />
        <p v-if="resetError" class="dashboard-reset-modal__error">
          {{ resetError }}
        </p>
        <div class="dashboard-reset-modal__actions">
          <button
            type="button"
            class="dashboard-reset-modal__btn dashboard-reset-modal__btn--cancel"
            :disabled="resetSubmitting"
            @click="closeResetModal"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dashboard-reset-modal__btn dashboard-reset-modal__btn--confirm"
            :disabled="resetSubmitting"
            @click="confirmReset"
          >
            {{ resetSubmitting ? "Resetting…" : "Confirm reset" }}
          </button>
        </div>
      </div>
    </div>
    <section class="section dashboard-section">
      <div v-if="dashboard.lastSyncError" class="dashboard-sync-error">
        Could not sync to PocketBase. Custom items and sales may not have
        updated. Make sure you're logged in and PocketBase is running (check the
        browser console for details).
      </div>
      <div class="dashboard-header">
        <div class="dashboard-title-row">
          <h2 class="section-title">Sales Summary</h2>
          <div class="dashboard-title-actions">
            <button
              type="button"
              class="dashboard-reset-btn"
              @click="openResetModal"
            >
              Reset
            </button>
            <button
              type="button"
              class="dashboard-export-btn"
              @click="exportToExcel"
            >
              Export to Excel
            </button>
          </div>
        </div>
        <div class="dashboard-summary-card">
          <p class="dashboard-summary-period">{{ filterLabel }}</p>
          <div class="dashboard-summary-stats">
            <div class="dashboard-stat">
              <span class="dashboard-stat-label">Total pieces sold</span>
              <span class="dashboard-stat-value">{{
                dashboard.totalPiecesSold
              }}</span>
            </div>
            <div class="dashboard-stat">
              <span class="dashboard-stat-label">Total sales</span>
              <span class="dashboard-stat-value">{{
                formatCurrency(dashboard.totalSales)
              }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="dashboard-filters">
        <label class="dashboard-filter-label">
          <span class="dashboard-filter-text">Month</span>
          <select
            :value="dashboard.selectedMonth ?? ''"
            class="dashboard-select"
            aria-label="Select month"
            @change="onMonthChange"
          >
            <option value="">All</option>
            <option v-for="(name, i) in MONTHS" :key="i" :value="i + 1">
              {{ name }}
            </option>
          </select>
        </label>
        <label class="dashboard-filter-label">
          <span class="dashboard-filter-text">Day</span>
          <select
            :value="dashboard.selectedDay ?? ''"
            class="dashboard-select"
            aria-label="Select day"
            :disabled="
              dashboard.selectedMonth == null || dashboard.selectedYear == null
            "
            @change="onDayChange"
          >
            <option value="">All</option>
            <option v-for="day in dayOptions" :key="day" :value="day">
              {{ day }}
            </option>
          </select>
        </label>
        <label class="dashboard-filter-label">
          <span class="dashboard-filter-text">Year</span>
          <select
            :value="dashboard.selectedYear ?? ''"
            class="dashboard-select"
            aria-label="Select year"
            @change="onYearChange"
          >
            <option value="">All</option>
            <option v-for="y in years" :key="y" :value="y">
              {{ y }}
            </option>
          </select>
        </label>
      </div>
      <div class="dashboard-item-header">
        <h2 class="section-title section-title--secondary">Sales by Item</h2>
        <button
          type="button"
          class="dashboard-add-item-btn"
          @click="openAddItemModal"
        >
          Add item
        </button>
      </div>
      <DataTable
        :columns="itemColumns"
        :rows="itemRows"
        empty-message="No item data."
      >
        <template #cell-item-actions="{ row }">
          <div class="dashboard-row-actions">
            <button
              type="button"
              class="dashboard-edit-btn"
              aria-label="Edit row"
              @click="
                openEditItemModal(
                  row as {
                    itemType: string;
                    itemId?: string;
                    item: string;
                    piecesSold: number;
                    pricePerUnit: number;
                    totalSales: number;
                  },
                )
              "
            >
              Edit
            </button>
            <button
              v-if="(row as { itemType: string }).itemType === 'custom'"
              type="button"
              class="dashboard-remove-item-btn"
              aria-label="Remove item"
              @click="
                dashboard.removeCustomItem((row as { itemId: string }).itemId)
              "
            >
              Remove
            </button>
          </div>
        </template>
      </DataTable>

      <h2 class="section-title section-title--secondary">Sales by Template</h2>
      <DataTable
        :columns="columns"
        :rows="rows"
        empty-message="No templates yet. Add templates in Settings to see sales summary here."
      >
        <template #cell-template-action="{ row }">
          <button
            type="button"
            class="dashboard-edit-btn"
            aria-label="Edit row"
            @click="
              openEditTemplateModal(
                row as {
                  templateId: string;
                  item: string;
                  piecesSold: number;
                  pricePerUnit: number;
                  totalSales: number;
                },
              )
            "
          >
            Edit
          </button>
        </template>
      </DataTable>
    </section>

    <!-- Edit template modal -->
    <Teleport to="body">
      <div
        v-if="showEditTemplateModal && editTemplateRow"
        class="add-item-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-template-modal-title"
        @click.self="closeEditTemplateModal"
      >
        <div class="add-item-modal">
          <h3 id="edit-template-modal-title" class="add-item-modal__title">
            Edit template
          </h3>
          <p class="add-item-modal__subtitle">{{ editTemplateRow.item }}</p>
          <div class="add-item-modal__form">
            <label class="add-item-modal__label">
              <span class="add-item-modal__label-text">Pieces sold</span>
              <input
                v-model.number="editTemplatePieces"
                type="number"
                min="0"
                step="1"
                class="add-item-modal__input"
              />
            </label>
            <label class="add-item-modal__label">
              <span class="add-item-modal__label-text">Price per unit (₱)</span>
              <input
                v-model.number="editTemplatePrice"
                type="number"
                min="0"
                step="0.01"
                class="add-item-modal__input"
              />
            </label>
          </div>
          <div class="add-item-modal__actions">
            <button
              type="button"
              class="add-item-modal__btn add-item-modal__btn--secondary"
              @click="closeEditTemplateModal"
            >
              Cancel
            </button>
            <button
              type="button"
              class="add-item-modal__btn add-item-modal__btn--primary"
              @click="saveEditTemplate"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Edit item modal -->
    <Teleport to="body">
      <div
        v-if="showEditItemModal && editItemRow"
        class="add-item-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-item-modal-title"
        @click.self="closeEditItemModal"
      >
        <div class="add-item-modal">
          <h3 id="edit-item-modal-title" class="add-item-modal__title">
            Edit item
          </h3>
          <p v-if="editItemIsPhotoStrip" class="add-item-modal__help">
            Photo strip total is the sum of Sales by Template. Edit templates
            there.
          </p>
          <template v-else>
            <div class="add-item-modal__form">
              <label v-if="editItemShowName" class="add-item-modal__label">
                <span class="add-item-modal__label-text">Item name</span>
                <input
                  v-model="editItemName"
                  type="text"
                  class="add-item-modal__input"
                />
              </label>
              <label class="add-item-modal__label">
                <span class="add-item-modal__label-text">Pieces sold</span>
                <input
                  v-model.number="editItemPieces"
                  type="number"
                  min="0"
                  step="1"
                  class="add-item-modal__input"
                />
              </label>
              <label
                v-if="editItemShowPricePerUnit"
                class="add-item-modal__label"
              >
                <span class="add-item-modal__label-text"
                  >Price per unit (₱)</span
                >
                <input
                  v-model.number="editItemPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  class="add-item-modal__input"
                />
              </label>
              <label v-if="editItemShowTotal" class="add-item-modal__label">
                <span class="add-item-modal__label-text">Total sales (₱)</span>
                <input
                  v-model.number="editItemTotal"
                  type="number"
                  min="0"
                  step="0.01"
                  class="add-item-modal__input"
                />
              </label>
            </div>
            <div class="add-item-modal__actions">
              <button
                type="button"
                class="add-item-modal__btn add-item-modal__btn--secondary"
                @click="closeEditItemModal"
              >
                Cancel
              </button>
              <button
                type="button"
                class="add-item-modal__btn add-item-modal__btn--primary"
                @click="saveEditItem"
              >
                Save
              </button>
            </div>
          </template>
          <div v-if="editItemIsPhotoStrip" class="add-item-modal__actions">
            <button
              type="button"
              class="add-item-modal__btn add-item-modal__btn--primary"
              @click="closeEditItemModal"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Add item modal: name, pieces sold, price; teleported to body for correct stacking. -->
    <Teleport to="body">
      <div
        v-if="showAddItemModal"
        class="add-item-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-item-modal-title"
        @click.self="closeAddItemModal"
      >
        <div class="add-item-modal">
          <h3 id="add-item-modal-title" class="add-item-modal__title">
            Add item
          </h3>
          <div class="add-item-modal__form">
            <label class="add-item-modal__label">
              <span class="add-item-modal__label-text">Item name</span>
              <input
                v-model="newItemName"
                type="text"
                class="add-item-modal__input"
                placeholder="e.g. Keychain, Mug"
                @keydown.enter.prevent="addItem"
              />
            </label>
            <label class="add-item-modal__label">
              <span class="add-item-modal__label-text">Pieces sold</span>
              <input
                v-model.number="newItemPieces"
                type="number"
                min="0"
                step="1"
                class="add-item-modal__input"
                placeholder="0"
                @keydown.enter.prevent="addItem"
              />
            </label>
            <label class="add-item-modal__label">
              <span class="add-item-modal__label-text">Price (₱)</span>
              <input
                v-model.number="newItemPrice"
                type="number"
                min="0"
                step="0.01"
                class="add-item-modal__input"
                placeholder="0.00"
                @keydown.enter.prevent="addItem"
              />
            </label>
          </div>
          <div class="add-item-modal__actions">
            <button
              type="button"
              class="add-item-modal__btn add-item-modal__btn--secondary"
              @click="closeAddItemModal"
            >
              Cancel
            </button>
            <button
              type="button"
              class="add-item-modal__btn add-item-modal__btn--primary"
              @click="addItem"
            >
              Add item
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tab-content {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.dashboard-content {
  padding: 1.25rem;
}

.section {
  background: transparent;
  border-radius: 12px;
  padding: 0;
}

.section-title {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0 0 0.5rem 0;
}

.section-title--secondary {
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
}

.dashboard-sync-error {
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  background: rgba(180, 60, 50, 0.12);
  border: 1px solid rgba(180, 60, 50, 0.4);
  border-radius: 8px;
  font-size: 0.9rem;
  color: var(--color-brown-dark);
}

.dashboard-header {
  margin-bottom: 1rem;
}

.dashboard-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.dashboard-title-row .section-title {
  margin: 0;
}

.dashboard-title-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.dashboard-reset-btn {
  padding: 0.5rem 1rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.dashboard-reset-btn:hover {
  background: rgba(92, 64, 51, 0.06);
  border-color: var(--color-brown);
}

.dashboard-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  margin-bottom: 0.75rem;
}

.dashboard-filter-label {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.dashboard-filter-text {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown);
  font-weight: 600;
}

.dashboard-select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown-dark);
  min-width: 7rem;
  cursor: pointer;
}

.dashboard-select:focus {
  outline: none;
  border-color: var(--color-brown);
  box-shadow: 0 0 0 2px rgba(92, 64, 51, 0.15);
}

.dashboard-summary-card {
  background: var(--color-cream);
  border: 1px solid var(--color-brown-light);
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  margin-top: 0.5rem;
  box-shadow: 0 1px 3px rgba(92, 64, 51, 0.06);
}

.dashboard-summary-period {
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--color-brown);
  font-weight: 600;
  margin: 0 0 1rem 0;
  letter-spacing: 0.02em;
}

.dashboard-summary-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
}

.dashboard-stat {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 10rem;
}

.dashboard-stat-label {
  font-family: var(--font-body);
  font-size: 0.875rem;
  color: var(--color-brown);
  font-weight: 500;
}

.dashboard-stat-value {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  line-height: 1.2;
}

.dashboard-export-btn {
  flex-shrink: 0;
  padding: 0.5rem 1rem;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.dashboard-export-btn:hover {
  background: var(--color-cream-dark);
  border-color: var(--color-brown);
}

.dashboard-reset-overlay {
  position: fixed;
  inset: 0;
  background: rgba(61, 43, 31, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.dashboard-reset-modal {
  background: var(--color-cream);
  border: 2px solid var(--color-brown-light);
  border-radius: 12px;
  padding: 1.5rem 2rem;
  max-width: 420px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(61, 43, 31, 0.2);
}

.dashboard-reset-modal__title {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0 0 1rem 0;
}

.dashboard-reset-modal__message {
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--color-brown-dark);
  margin: 0 0 0.75rem 0;
  line-height: 1.45;
}

.dashboard-reset-modal__hint {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown);
  font-weight: 600;
  margin: 0 0 0.5rem 0;
}

.dashboard-reset-modal__input {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  background: white;
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--color-brown-dark);
  margin-bottom: 0.75rem;
  box-sizing: border-box;
}

.dashboard-reset-modal__input:focus {
  outline: none;
  border-color: var(--color-brown);
}

.dashboard-reset-modal__input::placeholder {
  color: var(--color-brown-light);
}

.dashboard-reset-modal__error {
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: #b91c1c;
  margin: -0.25rem 0 0.75rem 0;
}

.dashboard-reset-modal__actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  margin-top: 0.5rem;
}

.dashboard-reset-modal__btn {
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.dashboard-reset-modal__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dashboard-reset-modal__btn--cancel {
  background: white;
  border: 2px solid var(--color-brown-light);
  color: var(--color-brown-dark);
}

.dashboard-reset-modal__btn--cancel:hover:not(:disabled) {
  background: var(--color-cream);
  border-color: var(--color-brown);
}

.dashboard-reset-modal__btn--confirm {
  background: var(--color-brown-dark);
  border: 2px solid var(--color-brown-dark);
  color: var(--color-cream);
}

.dashboard-reset-modal__btn--confirm:hover:not(:disabled) {
  background: var(--color-brown);
  border-color: var(--color-brown);
}

.dashboard-price-input {
  width: 5.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  background: var(--color-cream);
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown-dark);
  text-align: right;
}

.dashboard-price-input:focus {
  outline: none;
  border-color: var(--color-brown);
  box-shadow: 0 0 0 2px rgba(92, 64, 51, 0.15);
}

.dashboard-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
}

.dashboard-item-header .section-title {
  margin: 0;
}

.dashboard-add-item-btn {
  padding: 0.5rem 1rem;
  border: 2px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.dashboard-add-item-btn:hover {
  background: var(--color-cream-dark);
  border-color: var(--color-brown);
}

.dashboard-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.dashboard-edit-btn {
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  background: var(--color-cream);
  font-family: var(--font-body);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-brown-dark);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.dashboard-edit-btn:hover {
  background: var(--color-cream-dark);
  border-color: var(--color-brown);
}

.add-item-modal__subtitle {
  font-size: 0.95rem;
  color: var(--color-brown);
  margin: -0.5rem 0 1rem 0;
}

.add-item-modal__help {
  font-size: 0.9rem;
  color: var(--color-brown);
  margin: 0 0 1rem 0;
  line-height: 1.4;
}

.add-item-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(61, 43, 31, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 2rem;
}

.add-item-modal {
  background: var(--color-cream);
  border: 2px solid var(--color-brown-dark);
  border-radius: 12px;
  padding: 1.5rem;
  max-width: 400px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(61, 43, 31, 0.2);
}

.add-item-modal__title {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--color-brown-dark);
  margin: 0 0 1.25rem 0;
}

.add-item-modal__form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.add-item-modal__label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.add-item-modal__label-text {
  font-family: var(--font-body);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-brown);
}

.add-item-modal__input {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 8px;
  background: var(--color-cream);
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--color-brown-dark);
}

.add-item-modal__input:focus {
  outline: none;
  border-color: var(--color-brown);
  box-shadow: 0 0 0 2px rgba(92, 64, 51, 0.15);
}

.add-item-modal__input::placeholder {
  color: var(--color-brown-light);
}

.add-item-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.add-item-modal__btn {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.add-item-modal__btn--secondary {
  border: 2px solid var(--color-brown-light);
  background: var(--color-cream);
  color: var(--color-brown-dark);
}

.add-item-modal__btn--secondary:hover {
  background: var(--color-cream-dark);
  border-color: var(--color-brown);
}

.add-item-modal__btn--primary {
  border: 2px solid var(--color-brown-dark);
  background: var(--color-brown-dark);
  color: var(--color-cream);
}

.add-item-modal__btn--primary:hover {
  background: var(--color-brown);
  border-color: var(--color-brown);
}

.dashboard-pieces-input {
  width: 4rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  background: var(--color-cream);
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: var(--color-brown-dark);
  text-align: right;
}

.dashboard-pieces-input:focus {
  outline: none;
  border-color: var(--color-brown);
  box-shadow: 0 0 0 2px rgba(92, 64, 51, 0.15);
}

.dashboard-remove-item-btn {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--color-brown-light);
  border-radius: 6px;
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.8rem;
  color: var(--color-brown);
  cursor: pointer;
}

.dashboard-remove-item-btn:hover {
  background: var(--color-cream);
  border-color: var(--color-brown);
}

.col-actions {
  width: 1%;
  white-space: nowrap;
}
</style>
