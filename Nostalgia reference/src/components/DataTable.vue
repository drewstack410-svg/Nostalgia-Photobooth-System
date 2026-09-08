<script setup lang="ts">
export interface DataTableColumn<T = Record<string, unknown>> {
  key: keyof T | string;
  label: string;
  /** Optional formatter for cell display (ignored when slot is used) */
  formatter?: (value: unknown, row: T) => string | number;
  /** Optional class for the column header/cells */
  class?: string;
  /** Optional slot name for custom cell content: use slot "cell-{slot}" with { row, value } */
  slot?: string;
}

defineProps<{
  /** Column definitions: key, label, optional formatter */
  columns: DataTableColumn[];
  /** Array of row objects; keys should match column keys */
  rows: Record<string, unknown>[];
  /** Optional empty message when no rows */
  emptyMessage?: string;
}>();
</script>

<template>
  <div class="data-table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th
            v-for="col in columns"
            :key="String(col.key)"
            :class="col.class"
            scope="col"
          >
            {{ col.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="rows.length === 0">
          <td :colspan="columns.length" class="data-table__empty">
            {{ emptyMessage ?? "No data" }}
          </td>
        </tr>
        <tr v-for="(row, i) in rows" :key="i">
          <td v-for="col in columns" :key="String(col.key)" :class="col.class">
            <slot
              v-if="col.slot"
              :name="`cell-${col.slot}`"
              :row="row"
              :value="row[col.key as string]"
            >
              {{
                col.formatter
                  ? col.formatter(row[col.key as string], row)
                  : row[col.key as string]
              }}
            </slot>
            <template v-else>
              {{
                col.formatter
                  ? col.formatter(row[col.key as string], row)
                  : row[col.key as string]
              }}
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.data-table-wrap {
  overflow-x: auto;
  border-radius: 12px;
  border: 2px solid var(--color-brown-light);
  background: var(--color-cream);
}

.data-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-family: var(--font-body);
  font-size: 0.95rem;
}

.data-table th,
.data-table td {
  padding: 0.75rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--color-brown-light);
}

.data-table th {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--color-brown-dark);
  background: var(--color-cream-dark);
}

.data-table th:not(:last-child),
.data-table td:not(:last-child) {
  border-right: 1px solid var(--color-brown-light);
}

.data-table tbody tr:hover {
  background: rgba(61, 43, 31, 0.04);
}

.data-table tbody tr:last-child td {
  border-bottom: none;
}

.data-table__empty {
  text-align: center !important;
  color: var(--color-brown);
  font-style: italic;
  padding: 2rem;
}

.data-table td.col-number,
.data-table th.col-number {
  text-align: right;
}

.data-table th.col-actions,
.data-table td.col-actions {
  width: 6rem;
  min-width: 6rem;
  white-space: nowrap;
  box-sizing: border-box;
  overflow: visible;
}
</style>
