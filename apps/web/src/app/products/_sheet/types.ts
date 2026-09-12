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
  languages?: string[]
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
  /**
   * `| null` is DELIBERATELY WIDER THAN THE CONTRACT, and that is the whole justification — there is
   * no measurement behind it.
   *
   * 🔴 Corrected 2026-09-02 (DS.1 challenged it, AG.1 traced it). An earlier version of this comment
   * claimed "the server SENDS null, measured on `product_description`: `maxLength: null`". **That is
   * false on this path**, and I had not measured it — I copied the claim from `_studio/sheet/master/
   * types.ts` and restated it as my own. Traced end to end instead:
   *   `schema-caps.ts:99`  `typeof v.maxLength === 'number' && v.maxLength > 0 ? v.maxLength : undefined`
   *   `schema-caps.ts:26`  `maxLength?: number`
   *   `sheet-columns.service.ts:306` → `SheetColumn.maxLength?: number` (:73)
   * and the route (`/products/:id/studio/columns`) declares NO response schema, so Fastify applies
   * no serializer coercion and `JSON.stringify` OMITS an undefined. On this path the field is a
   * positive number or ABSENT. It is never `null`.
   *
   * The nullable `maxLength: number | null` that does exist belongs to `EbayAspect`
   * (`sheet-columns.service.ts:130`) and the eBay/feed/catalogue paths — a different type that
   * happens to share the field name. Reaching for it was a type-name homonym.
   *
   * So why keep `| null`? Because a consumer may be wider than its producer but must never be
   * narrower: tolerating a state that cannot arrive costs nothing, while failing to represent one
   * that can makes the true shape unrepresentable and pushes the next person toward a cast. If
   * anyone later "corrects" this to `?: number` to match the server, that is a NARROWING dressed as
   * drift-cleanup — the direction that produced the bug this file was fixed for.
   */
  maxLength?: number | null
  maxBytes?: number | null
  capFrom?: string | null
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
