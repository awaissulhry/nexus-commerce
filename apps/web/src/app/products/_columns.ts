/**
 * P.1l — column registry for the /products grid.
 *
 * Extracted from ProductsWorkspace.tsx so ColumnPickerMenu (and any
 * future column-aware modules) can import the same source of truth
 * without circular reference. Workspace still imports + re-uses
 * these for grid header/cell sizing.
 *
 * `locked` columns (thumb/sku/name/actions) keep fixed positions in
 * the rendered grid regardless of the user's saved order.
 */

export interface ColumnDef {
  key: string
  label: string
  width: number
  locked?: boolean
}

export const ALL_COLUMNS: ColumnDef[] = [
  // U.35 — column width bumped from 56 → 64 to give the larger
  // 48px thumbnail breathing room while keeping the cell's px-2
  // padding readable.
  { key: 'thumb', label: '', width: 64, locked: true },
  { key: 'sku', label: 'SKU', width: 140, locked: true },
  { key: 'name', label: 'Name', width: 280, locked: true },
  { key: 'status', label: 'Status', width: 110 },
  { key: 'price', label: 'Price', width: 110 },
  { key: 'stock', label: 'Stock', width: 90 },
  { key: 'threshold', label: 'Low @', width: 80 },
  { key: 'brand', label: 'Brand', width: 120 },
  { key: 'productType', label: 'Type', width: 130 },
  // W2.12 — PIM family chip. Hidden by default until the operator
  // starts attaching families; surfaced via the Cols picker.
  { key: 'family', label: 'Family', width: 140 },
  // W3.9 — Workflow stage chip. Hidden by default; same opt-in
  // visibility pattern as the family column.
  { key: 'workflowStage', label: 'Stage', width: 130 },
  { key: 'fulfillment', label: 'FBA/FBM', width: 80 },
  { key: 'coverage', label: 'Channels', width: 180 },
  { key: 'tags', label: 'Tags', width: 160 },
  { key: 'photos', label: 'Photos', width: 70 },
  { key: 'variants', label: 'Var.', width: 70 },
  // F.2 — per-row completeness % computed from name/brand/type/
  // photos/channel-coverage/tags. Hidden by default; operators
  // who care about data quality enable it via the Cols picker.
  { key: 'completeness', label: 'Complete', width: 110 },
  // W5.1 — Family-driven completeness (W2.14 score). Different
  // semantics from the legacy 10-factor 'completeness' column:
  // this one scores against the product's family's required
  // attributes. Hidden by default; PIM operators enable via Cols.
  // Empty for products without a family attached.
  { key: 'familyCompleteness', label: 'Family ✓', width: 110 },
  { key: 'updated', label: 'Updated', width: 110 },
  { key: 'actions', label: '', width: 110, locked: true },
]

export const DEFAULT_VISIBLE = [
  'thumb',
  'sku',
  'name',
  'status',
  'price',
  'stock',
  'coverage',
  'tags',
  'photos',
  'updated',
  'actions',
]
