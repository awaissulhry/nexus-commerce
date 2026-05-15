// CatalogNode is the data shape returned by GET /api/products/command-matrix.
// Masters have subRows (variants); variants have subRows = undefined.
// Both extend the BulkProduct interface so the editor surface works
// across the same PATCH /api/products/bulk endpoint.

export type SyncStatus = 'SYNCED' | 'OVERRIDE' | 'ERROR' | 'UNLISTED'

export type SupportedLocale = 'en' | 'de' | 'it'

export interface CatalogNode {
  id: string
  isMaster: boolean
  name: string
  sku: string
  thumbnailUrl: string | null
  // Core PIM (editor)
  basePrice: number | null
  costPrice: number | null
  minMargin: number | null
  minPrice: number | null
  maxPrice: number | null
  totalStock: number
  lowStockThreshold: number
  status: string
  isParent: boolean
  parentId: string | null
  brand: string | null
  manufacturer: string | null
  upc: string | null
  ean: string | null
  gtin: string | null
  weightValue: number | null
  weightUnit: string | null
  dimLength: number | null
  dimWidth: number | null
  dimHeight: number | null
  dimUnit: string | null
  fulfillmentChannel: 'FBA' | 'FBM' | null
  productType: string | null
  categoryAttributes: Record<string, unknown> | null
  amazonAsin: string | null
  ebayItemId: string | null
  updatedAt: string
  syncChannels: string[]
  variantAttributes: unknown
  // Matrix columns
  locales: Record<SupportedLocale, number> | null // null = variant (render '--')
  channels: {
    amazonDe: SyncStatus
    ebayUk: SyncStatus
    shopify: SyncStatus
  }
  subRows?: CatalogNode[]
  [k: string]: unknown
}

// ─── View filters ─────────────────────────────────────────────────────────────

export type ViewId =
  | 'global'
  | 'translation-gaps'
  | 'sync-errors'
  | 'unlisted-variants'

export interface ViewDef {
  id: ViewId
  label: string
}

export const CATALOG_VIEWS: ViewDef[] = [
  { id: 'global', label: 'Global Catalog' },
  { id: 'translation-gaps', label: 'Translation Gaps' },
  { id: 'sync-errors', label: 'Sync Errors' },
  { id: 'unlisted-variants', label: 'Unlisted Variants' },
]

// ─── Highlight modes ──────────────────────────────────────────────────────────

export type HighlightMode =
  | 'none'
  | 'sync-errors'
  | 'translation-gaps'
  | 'pricing-overrides'

export interface HighlightDef {
  id: HighlightMode
  label: string
}

export const HIGHLIGHT_MODES: HighlightDef[] = [
  { id: 'none', label: 'None' },
  { id: 'sync-errors', label: 'Sync Errors' },
  { id: 'translation-gaps', label: 'Translation Gaps' },
  { id: 'pricing-overrides', label: 'Pricing Overrides' },
]
