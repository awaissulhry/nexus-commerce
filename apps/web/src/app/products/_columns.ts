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
  /** English fallback label — used when labelKey is unset or i18n catalog misses. */
  label: string
  /**
   * Optional i18n catalog key. When set, consumers (GridView header +
   * ColumnPickerMenu) call `t(labelKey)` to resolve the localised label
   * and fall back to `label` if the key is missing. Hand-keyed under
   * the `products.col.*` namespace.
   */
  labelKey?: string
  width: number
  locked?: boolean
}

export const ALL_COLUMNS: ColumnDef[] = [
  // AM.1 — combined Amazon-style "Product" cell: thumbnail + name + ASIN · SKU.
  // Replaces the separate thumb/sku/name trio as the default first column.
  // The individual columns remain for operators who prefer the classic layout.
  { key: 'product', label: 'Product', labelKey: 'products.col.product', width: 400, locked: true },
  { key: 'thumb', label: '', width: 64, locked: true },
  { key: 'sku', label: 'SKU', labelKey: 'products.col.sku', width: 140, locked: true },
  { key: 'name', label: 'Name', labelKey: 'products.col.name', width: 280, locked: true },
  // AM.1 — richer listing-status column: badge + coverage dots + readiness hint.
  { key: 'listing-status', label: 'Listing status', labelKey: 'products.col.listingStatus', width: 180 },
  { key: 'status', label: 'Status', labelKey: 'products.col.status', width: 110 },
  { key: 'price', label: 'Price', labelKey: 'products.col.price', width: 110 },
  { key: 'stock', label: 'Stock', labelKey: 'products.col.stock', width: 90 },
  { key: 'threshold', label: 'Low @', labelKey: 'products.col.threshold', width: 80 },
  { key: 'brand', label: 'Brand', labelKey: 'products.col.brand', width: 120 },
  { key: 'productType', label: 'Type', labelKey: 'products.col.productType', width: 130 },
  // W2.12 — PIM family chip. Hidden by default until the operator
  // starts attaching families; surfaced via the Cols picker.
  { key: 'family', label: 'Family', labelKey: 'products.col.family', width: 140 },
  // W3.9 — Workflow stage chip. Hidden by default; same opt-in
  // visibility pattern as the family column.
  { key: 'workflowStage', label: 'Stage', labelKey: 'products.col.workflowStage', width: 130 },
  { key: 'fulfillment', label: 'FBA/FBM', labelKey: 'products.col.fulfillment', width: 80 },
  { key: 'coverage', label: 'Channels', labelKey: 'products.col.coverage', width: 180 },
  { key: 'tags', label: 'Tags', labelKey: 'products.col.tags', width: 160 },
  { key: 'photos', label: 'Photos', labelKey: 'products.col.photos', width: 70 },
  { key: 'variants', label: 'Var.', labelKey: 'products.col.variants', width: 70 },
  // F.2 — per-row completeness % computed from name/brand/type/
  // photos/channel-coverage/tags. Hidden by default; operators
  // who care about data quality enable it via the Cols picker.
  { key: 'completeness', label: 'Complete', labelKey: 'products.col.completeness', width: 110 },
  // W5.1 — Family-driven completeness (W2.14 score). Different
  // semantics from the legacy 10-factor 'completeness' column:
  // this one scores against the product's family's required
  // attributes. Hidden by default; PIM operators enable via Cols.
  // Empty for products without a family attached.
  { key: 'familyCompleteness', label: 'Family ✓', labelKey: 'products.col.familyCompleteness', width: 110 },
  { key: 'updated', label: 'Updated', labelKey: 'products.col.updated', width: 110 },
  { key: 'actions', label: '', width: 140, locked: true },
]

export const DEFAULT_VISIBLE = [
  'product',
  'listing-status',
  'price',
  'stock',
  'coverage',
  'tags',
  'updated',
  'actions',
]

// Classic layout (pre-AM.1). Kept for reference; operators who saved
// views with this set will see it restored from localStorage.
export const CLASSIC_VISIBLE = [
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
