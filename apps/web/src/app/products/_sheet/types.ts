/**
 * MS.3 — the wire contract of the master sheet, mirroring
 * `apps/api/src/services/pim/sheet-{columns,rows}.service.ts`.
 *
 * Kept as a hand-written mirror rather than an import because apps/web does not import from apps/api;
 * the shapes are asserted against a live response in the lab (`?tab=sheet`).
 */

export type SheetChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE' | 'ETSY'
export type SheetColumnKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean' | 'date'
export type SheetStorage = 'column' | 'categoryAttributes' | 'localizedContent'
export type ReadinessState = 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'

export interface SheetCoordinate {
  channel: SheetChannel
  marketplace: string
  label: string
  /** False for the webstore, which is seeded GLOBAL and is not in any country market. */
  inMarket: boolean
}

export interface SheetColumn {
  key: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field`. */
  writeField: string
  label: string
  group: string
  kind: SheetColumnKind
  storage: SheetStorage
  scope: 'global' | 'per_variant'
  options?: string[]
  optionLabels?: Record<string, string>
  mode?: 'strict' | 'open'
  requiredBy: string[]
  maxLength?: number
  maxBytes?: number
  capFrom?: string
  applicableProductTypes?: string[]
  requiredForProductTypes?: string[]
  editable: boolean
  width?: number
  helpText?: string
  defaultVisible: boolean
  deprecatedOptions?: string[]
}

export interface ReadinessIssue {
  key: string
  label: string
  message: string
  severity: 'error' | 'warn'
}

export interface SheetReadiness {
  state: ReadinessState
  issues: ReadinessIssue[]
  ref?: string
}

export interface SheetListing {
  id: string
  listingStatus: string
  isPublished: boolean
  price: number | null
  quantity: number | null
  externalListingId: string | null
  follows: Record<string, boolean>
}

export interface SheetCellValue {
  value: unknown
  source: string
  inheritedFrom: string | null
  /** The value comes from the parent and this row has none of its own. */
  inherited: boolean
}

export interface MasterCompleteness {
  overall: { filled: number; total: number; pct: number }
  required: { filled: number; total: number; missing: Array<{ key: string; label: string }> }
  byGroup: Array<{ group: string; filled: number; total: number }>
}

export interface SheetRow {
  id: string
  sku: string
  name: string | null
  parentId: string | null
  isParent: boolean
  status: string
  productType: string | null
  version: number
  basePrice: number | null
  childCount: number
  values: Record<string, SheetCellValue>
  listings: Record<string, SheetListing>
  readiness: Record<string, SheetReadiness>
  completeness: MasterCompleteness
}

export interface SheetPage {
  market: string
  locale: string
  coordinates: SheetCoordinate[]
  columns: SheetColumn[]
  rows: SheetRow[]
  /** Number of FAMILIES, not rows. */
  total: number
  page: number
  limit: number
  droppedKeys: string[]
  schemaMissing: string[]
  schemaAge: Array<{ productType: string; fetchedAt: string }>
  availableMarkets: string[]
}

export const coordKey = (c: { channel: string; marketplace: string }) => `${c.channel}:${c.marketplace}`

/** The six fields that actually carry a follow-master flag; JSONB attributes have none. */
export const FOLLOW_FLAGS: Record<string, string> = {
  title: 'followMasterTitle',
  description: 'followMasterDescription',
  price: 'followMasterPrice',
  quantity: 'followMasterQuantity',
  images: 'followMasterImages',
  bulletPoints: 'followMasterBulletPoints',
}
