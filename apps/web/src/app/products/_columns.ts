/**
 * P.1l — column registry for the /products grid.
 *
 * Extracted from ProductsWorkspace.tsx so ColumnPickerMenu (and any
 * future column-aware modules) can import the same source of truth
 * without circular reference. Workspace still imports + re-uses
 * these for grid header/cell sizing.
 *
 * `locked` columns keep fixed positions regardless of user order:
 *   - leading lock: `product` (always first)
 *   - trailing lock: `actions` (always last)
 * AM.1: thumb/sku/name are no longer locked so they stay hidden
 * when the combined `product` column is active.
 */

export interface ColumnDef {
  key: string
  /** English fallback label */
  label: string
  /** Optional i18n key resolved via t(labelKey), falls back to label */
  labelKey?: string
  /** AM.1 — Amazon-style two-line header. Rendered below the main label
   *  in smaller, lighter text (e.g. "ASIN | SKU" under "Product"). */
  subLabel?: string
  width: number
  locked?: boolean
}

export const ALL_COLUMNS: ColumnDef[] = [
  // ── Amazon-style primary columns (AM.1) ─────────────────────────────
  {
    key: 'product',
    label: 'Product',
    labelKey: 'products.col.product',
    subLabel: 'ASIN | SKU',
    width: 400,
    locked: true,
  },
  {
    key: 'listing-status',
    label: 'Listing status',
    labelKey: 'products.col.listingStatus',
    subLabel: 'Next steps',
    width: 180,
  },
  {
    key: 'sales',
    label: 'Sales',
    labelKey: 'products.col.sales',
    subLabel: 'Last 30 days',
    width: 110,
  },
  {
    key: 'inventory',
    label: 'Inventory',
    labelKey: 'products.col.inventory',
    subLabel: 'Available units',
    width: 150,
  },
  {
    key: 'price-shipping',
    label: 'Price + shipping',
    labelKey: 'products.col.priceShipping',
    subLabel: 'Featured Offer',
    width: 160,
  },
  {
    key: 'estimated-fees',
    label: 'Estimated fees',
    labelKey: 'products.col.estimatedFees',
    subLabel: 'Per unit',
    width: 120,
  },

  // ── Classic columns (hidden by default, available via column picker) ─
  { key: 'thumb',   label: '',         width: 64 },
  { key: 'sku',     label: 'SKU',      labelKey: 'products.col.sku',     width: 140 },
  { key: 'name',    label: 'Name',     labelKey: 'products.col.name',    width: 280 },
  { key: 'status',  label: 'Status',   labelKey: 'products.col.status',  width: 110 },
  { key: 'price',   label: 'Price',    labelKey: 'products.col.price',   width: 110 },
  { key: 'stock',   label: 'Stock',    labelKey: 'products.col.stock',   width: 90 },
  { key: 'threshold',    label: 'Low @',    labelKey: 'products.col.threshold',    width: 80 },
  { key: 'brand',        label: 'Brand',    labelKey: 'products.col.brand',        width: 120 },
  { key: 'productType',  label: 'Type',     labelKey: 'products.col.productType',  width: 130 },
  { key: 'family',       label: 'Family',   labelKey: 'products.col.family',       width: 140 },
  { key: 'workflowStage',label: 'Stage',    labelKey: 'products.col.workflowStage',width: 130 },
  { key: 'fulfillment',  label: 'FBA/FBM',  labelKey: 'products.col.fulfillment',  width: 80 },
  { key: 'coverage',     label: 'Channels', labelKey: 'products.col.coverage',     width: 180 },
  { key: 'tags',         label: 'Tags',     labelKey: 'products.col.tags',         width: 160 },
  { key: 'photos',       label: 'Photos',   labelKey: 'products.col.photos',       width: 70 },
  { key: 'variants',     label: 'Var.',     labelKey: 'products.col.variants',     width: 70 },
  { key: 'completeness', label: 'Complete', labelKey: 'products.col.completeness', width: 110 },
  { key: 'familyCompleteness', label: 'Family ✓', labelKey: 'products.col.familyCompleteness', width: 110 },
  { key: 'updated',      label: 'Updated',  labelKey: 'products.col.updated',      width: 110 },

  // ── Always-trailing locked column ───────────────────────────────────
  { key: 'actions', label: '', width: 140, locked: true },
]

/** Amazon-style default — 7 columns matching Manage Products. */
export const DEFAULT_VISIBLE = [
  'product',
  'listing-status',
  'sales',
  'inventory',
  'price-shipping',
  'estimated-fees',
  'actions',
]

/** Classic layout preserved for column picker "reset to default". */
export const CLASSIC_VISIBLE = [
  'thumb', 'sku', 'name', 'status', 'price', 'stock',
  'coverage', 'tags', 'photos', 'updated', 'actions',
]
