// Shared types for the bulk-edit surface (bulk-operations + command-matrix).

export interface BulkProduct {
  id: string
  sku: string
  name: string
  basePrice: number
  costPrice: number | null
  minMargin: number | null
  minPrice: number | null
  maxPrice: number | null
  totalStock: number
  lowStockThreshold: number
  brand: string | null
  manufacturer: string | null
  upc: string | null
  ean: string | null
  weightValue: number | null
  weightUnit: string | null
  status: string
  fulfillmentChannel: 'FBA' | 'FBM' | null
  isParent: boolean
  parentId: string | null
  amazonAsin: string | null
  ebayItemId: string | null
  syncChannels: string[]
  variantAttributes: unknown
  updatedAt: string
  productType?: string | null
  categoryAttributes?: Record<string, unknown> | null
  buyBoxPrice?: number | null
  competitorPrice?: number | null
  parentAsin?: string | null
  shippingTemplate?: string | null
  dimLength?: number | null
  dimWidth?: number | null
  dimHeight?: number | null
  dimUnit?: string | null
  gtin?: string | null
  [k: string]: unknown
}

export interface CellChange {
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  cascade: boolean
  timestamp: number
}

export interface CascadeModalState {
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  parentSku: string
  fieldLabel: string
  children: Array<{ id: string; sku: string }>
}

export interface ApiError {
  id: string
  field: string
  error: string
}

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; count: number; at: number }
  | { kind: 'partial'; saved: number; failed: number }
  | { kind: 'error'; message: string }

export interface CellCoord {
  rowIdx: number
  colIdx: number
}

export interface SelectionState {
  /** Where the range starts (first click). */
  anchor: CellCoord | null
  /** Active cell — where typing/edits land; the moving end of the range. */
  active: CellCoord | null
}

export interface FilterState {
  status: string[]
  channels: string[]
  stockLevel: 'all' | 'out' | 'low' | 'in'
  // T.5 — additional dimensions on the filter dropdown.
  productTypes: string[]
  parentage: 'any' | 'parent' | 'variant'
  hasAsin: 'any' | 'yes' | 'no'
  hasGtin: 'any' | 'yes' | 'no'
  missingRequired: boolean
}

export const EMPTY_FILTER_STATE: FilterState = {
  status: [],
  channels: [],
  stockLevel: 'all',
  productTypes: [],
  parentage: 'any',
  hasAsin: 'any',
  hasGtin: 'any',
  missingRequired: false,
}

export interface HistoryDelta {
  rowId: string
  columnId: string
  before: CellChange | null
  after: CellChange | null
}

export interface HistoryEntry {
  cells: HistoryDelta[]
  timestamp: number
}

export interface FillState {
  source: { minRow: number; maxRow: number; minCol: number; maxCol: number }
  target: CellCoord
}

export interface FillExtension {
  minRow: number
  maxRow: number
  minCol: number
  maxCol: number
  axis: 'row' | 'col'
}

export interface SelectionMetrics {
  count: number
  isLarge?: boolean
  numericCount?: number
  sum?: number
  avg?: number
  min?: number
  max?: number
}

export interface Rect {
  top: number
  left: number
  width: number
  height: number
}

// C.5 — bumped from 36 to 44px so cells meet WCAG / iOS HIG touch
// target minimums on tablets + iPads (the operator's secondary
// device). 44px is the canonical Apple HIG minimum and the default
// Material guideline. The virtualizer + range-overlay calculations
// derive every position from this constant, so a single change
// rescales every row + selection rectangle in lockstep.
export const ROW_HEIGHT = 44
export const HEADER_HEIGHT = 36

// ─── FieldDef (PIM column metadata, originally in ColumnSelector.tsx) ────────

export interface FieldDef {
  id: string
  label: string
  type: string
  category: string
  channel?: string
  productTypes?: string[]
  options?: string[]
  width?: number
  editable: boolean
  required?: boolean
  helpText?: string
}

// ─── Paste types (originally in PastePreviewModal.tsx) ───────────────────────

export interface PasteCell {
  rowIdx: number
  colIdx: number
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  sku: string
  fieldLabel: string
}

export interface PasteError {
  rowIdx: number
  colIdx: number
  sku: string
  fieldLabel: string
  reason: string
}

export interface PastePreview {
  plan: PasteCell[]
  errors: PasteError[]
}
