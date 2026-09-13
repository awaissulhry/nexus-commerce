/**
 * MX — the Matrix page's WIRE CONTRACT, ONE declaration for both apps (`@nexus/shared/matrix-contract`).
 *
 * MX.1 (2026-09-13) moved this here from `apps/web/src/app/products/[id]/edit/_studio/matrix/contract.ts`, which is
 * now a one-line re-export, so the API serves EXACTLY the shape the page reads — types, constants and `MATRIX_COPY`
 * (the refusal sentences the server answers with are the page's words, one source). The design-system's engine
 * copy (`apps/web/src/design-system/grid/matrix/contract.ts`) is held equal by its parity test against the app file.
 *
 * `docs/2026-09-13-matrix-page-design.md` §3.6 (read) and §3.7 (writes) are the prose; THIS FILE is the one
 * source both the page and the service code against. Every number a cell shows arrives here — the
 * page derives nothing that the server owns. In particular:
 *
 *   - `SyncCell.kind` IS `resolveIntendedQuantity`'s verdict (`apps/api/src/services/sync-control-core.ts`),
 *     carried verbatim: FBA_EXCLUDED → CLOSED → PAUSED (policy | listing) → PINNED → FOLLOW → UNCOUNTED.
 *   - `PriceCell.value` is the number the PUSH reads (`ChannelListing.price`), never the pricing engine's chain.
 *   - a region-inventory coordinate (`kind: 'region-inventory'`, e.g. `AMAZON:EU`) carries the inventory cells
 *     ONCE for every market in `sharedInventoryWith`; those markets' own coordinates carry `inventoryOn` and
 *     serve NO inventory cells. That is design §3.5 made unrepresentable rather than guarded.
 *
 * 🔴 Pure types and constants only — no React, no AG, no fetch, no Prisma — so this module is reachable from
 * both workspaces' node-only vitest and from the API's services.
 */
/* ── cells ─────────────────────────────────────────────────────────────────────────────────── */

/** The eight cell kinds a coordinate group may serve. Order = default column order inside a group. */
export type MatrixCellKind = 'listing' | 'fulfilment' | 'syncMode' | 'syncQty' | 'syncBuffer' | 'syncState' | 'price' | 'salePrice'
export const MATRIX_CELL_KINDS: readonly MatrixCellKind[] = ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice']

/** The cell kinds that make up the INVENTORY lane — the ones a region-inventory coordinate owns. */
export const INVENTORY_CELL_KINDS: readonly MatrixCellKind[] = ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState']
/** The cell kinds an operator can write from the grid (the rest are facts). */
export const WRITABLE_CELL_KINDS: readonly MatrixCellKind[] = ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'price', 'salePrice']

/** Column header per kind — Appendix A, verbatim. */
export const MATRIX_CELL_LABELS: Readonly<Record<MatrixCellKind, string>> = {
  listing: 'Listing', fulfilment: 'Fulfilment', syncMode: 'Mode', syncQty: 'Qty', syncBuffer: 'Buffer', syncState: 'Sync', price: 'Price', salePrice: 'Sale',
}
/** Design §3.3 widths (px). */
export const MATRIX_CELL_WIDTHS: Readonly<Record<MatrixCellKind, number>> = {
  listing: 150, fulfilment: 96, syncMode: 96, syncQty: 88, syncBuffer: 76, syncState: 96, price: 104, salePrice: 190,
}

/**
 * MX.F (2026-09-13, ruled): the cells a coordinate may declare ABSENT — the eight kinds plus the two business-pricing
 * cells design §3.11 reserves (`B2B price` · `Tiers`). Absence-only today: `cells` never carries them, so the grid renders
 * nothing for them, and Customise lists them greyed with the sentence the server derived from the coordinate's cached
 * product-type schema (D-MX5 — never hardcoded).
 */
export type MatrixAbsentCellKind = MatrixCellKind | 'businessPrice' | 'businessTiers'
/** Customise's label per absent-capable kind — the eight headers plus Appendix A's `B2B price` · `Tiers`. */
export const MATRIX_ABSENT_CELL_LABELS: Readonly<Record<MatrixAbsentCellKind, string>> = {
  ...MATRIX_CELL_LABELS, businessPrice: 'B2B price', businessTiers: 'Tiers',
}

/** The projection words the Variants page fixed (five) plus the three the Matrix adds (design §3.4). */
export type ListingState = 'listed' | 'draft' | 'excluded' | 'not-set-up' | 'needs-value' | 'suppressed' | 'closed' | 'error' | 'ended'

export interface ListingCell {
  state: ListingState
  /** ASIN / eBay item id / Shopify product id, when the channel has one. */
  externalId: string | null
  /** A short mono detail beside the word — `not buyable`, `1 listing`. */
  detail: string | null
  published: boolean
}

export type FulfilmentMethod = 'FBA' | 'FBM' | 'MCF'

export interface FulfilmentCell {
  /** What Nexus holds for this coordinate (`ChannelListing.fulfillmentMethod`, or the derivation). */
  method: FulfilmentMethod | null
  /** `set` = the typed column is persisted; `derived` = the server derived it (channel default / product flag). */
  source: 'set' | 'derived'
  /** The fail-closed guard's verdict (`isFbaListing`). When it differs from `method`, the cell says so. */
  guard: 'FBA' | 'FBM' | null
  /** Amazon's own last reported channel from the merchant listings report, when known. */
  reported: 'AFN' | 'MFN' | null
}

/** `resolveIntendedQuantity`'s verdict, verbatim. */
export type SyncKind = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'FBA_EXCLUDED' | 'UNCOUNTED' | 'CLOSED'
export type SyncMode = 'FOLLOW' | 'PINNED'

export interface SyncCell {
  kind: SyncKind
  /** Which lever holds a PAUSED listing. Policy beats listing. */
  via: 'POLICY' | 'LISTING' | null
  /** The stored mode under any pause: `followMasterQuantity` (true → FOLLOW). */
  mode: SyncMode
  /** What would be pushed now: pool − buffer on FOLLOW, the pinned number on PINNED, null otherwise. */
  intended: number | null
  /** The number the channel currently holds (its live quantity), when known. */
  held: number | null
  buffer: number
  /** The routed WAREHOUSE pool for this SKU that FOLLOW derives from; null = uncounted. */
  poolAvailable: number | null
  routedLocations: readonly string[]
  /** Amazon-managed units, for the `—` tooltip on FBA rows. */
  fbaAtAmazon: number | null
  /** The channel holds more than the pool can back. */
  oversold: boolean
}

export type QueueState = 'sent' | 'queued' | 'sending' | 'failed' | 'dead' | 'paused' | 'never'

export interface QueueCell {
  state: QueueState
  /** ISO time of the newest queue row, or null. */
  at: string | null
  /** The server's failure sentence, verbatim. */
  reason: string | null
  /** Which lane the newest row belongs to. */
  syncType: 'QUANTITY_UPDATE' | 'PRICE_UPDATE' | null
  /** For `paused`: the lever. */
  via: 'POLICY' | 'LISTING' | null
}

export type PriceSource = 'master' | 'override' | 'formula'

export interface PriceCell {
  /** The number the push reads. */
  value: number | null
  currency: string
  source: PriceSource
  /** The `=` expression when `source === 'formula'`. */
  formula: string | null
  clamped: 'floor' | 'ceiling' | null
}

export interface SaleCell {
  value: number | null
  /** ISO dates, inclusive. */
  start: string | null
  end: string | null
}

/** Everything one row says about one coordinate. */
export interface MatrixCells {
  /** The listing row this coordinate's cells belong to; null on a coordinate with no listing for this row. */
  listingId: string | null
  /** `ChannelListing.version` — the CAS discriminator for every write on this coordinate. */
  version: number
  listing: ListingCell | null
  fulfilment: FulfilmentCell | null
  sync: SyncCell | null
  queue: QueueCell | null
  price: PriceCell | null
  sale: SaleCell | null
  /** Per kind: may the operator write it here? Absent = false. */
  writable: Partial<Record<MatrixCellKind, boolean>>
  /** The sentence for every `writable: false` the operator can see — never a silent lock. */
  writeBlockedReason: Partial<Record<MatrixCellKind, string>>
}

/* ── coordinates ────────────────────────────────────────────────────────────────────────────── */

/** `AMAZON:IT` · `AMAZON:EU` (region inventory) · `EBAY:IT` · `EBAY:IT#<aliasId>` · `SHOPIFY:GLOBAL`. */
export type CoordinateKey = string

export type CoordinateKind = 'market' | 'region-inventory' | 'global'

export interface MatrixCoordinate {
  key: CoordinateKey
  kind: CoordinateKind
  channel: string
  /** A market code, a region code for `region-inventory`, or `GLOBAL`. */
  market: string
  /** Strip label — Appendix A: `Amazon · IT`, `Amazon EU · Inventory · IT DE FR ES`, `eBay · IT ①`. */
  label: string
  region: string | null
  alias: { id: string; label: string; position: number } | null
  accountId: string | null
  currency: string
  connected: boolean
  /** Roll-up counts for the strip tag; null = not counted. */
  listed: number | null
  draft: number | null
  /** The kinds this coordinate SERVES, in column order. */
  cells: readonly MatrixCellKind[]
  /** Kinds the channel has no store for, each with the operator's sentence (Customise shows them greyed) — the eight kinds plus the reserved business cells. */
  absent: ReadonlyArray<{ cell: MatrixAbsentCellKind; reason: string }>
  /** region-inventory: the market codes whose inventory this group carries. */
  sharedInventoryWith: readonly string[] | null
  /** market in a shared region: the region-inventory key that carries its inventory cells. */
  inventoryOn: CoordinateKey | null
  vocabulary: { fulfilment: readonly FulfilmentMethod[] | null }
}

/* ── the read ───────────────────────────────────────────────────────────────────────────────── */

export interface MatrixRowRead {
  id: string
  sku: string
  role: 'parent' | 'variant'
  stock: { available: number | null; uncounted: boolean; locations: ReadonlyArray<{ code: string; available: number }> }
  basePrice: number | null
  status: string
  cells: Record<CoordinateKey, MatrixCells>
}

export interface MatrixRead {
  /** `Product.version` of the family root — the CAS discriminator for master cells. */
  version: number
  productId: string
  /** `live` = the Matrix service answered; `preview` = deterministic fixture cells on the real rows (the banner says so). */
  source: 'live' | 'preview'
  generatedAt: string
  coordinates: MatrixCoordinate[]
  rows: MatrixRowRead[]
  policies: ReadonlyArray<{ channel: string; market: string; pushesPaused: boolean }>
}

/* ── writes: one door ───────────────────────────────────────────────────────────────────────── */

export type MatrixWritableKind = Extract<MatrixCellKind, 'fulfilment' | 'syncMode' | 'syncQty' | 'syncBuffer' | 'price' | 'salePrice'>

export interface MatrixWriteCell {
  rowId: string
  coordinateKey: CoordinateKey
  cell: MatrixWritableKind
  value: unknown
  expectedVersion: number
}

export interface MatrixWriteRequest { cells: MatrixWriteCell[] }

export type WriteOutcome = 'applied' | 'refused' | 'noop' | 'conflict'

export interface MatrixWriteOutcome {
  rowId: string
  coordinateKey: CoordinateKey
  cell: MatrixWritableKind
  outcome: WriteOutcome
  reason?: string
  /** The listing's version AFTER the write (unchanged on refused/noop; the CURRENT one on conflict). */
  version: number
  /** A region-inventory write lands on every market it carries. */
  expandedTo?: readonly CoordinateKey[]
}

export interface MatrixWriteResult { results: MatrixWriteOutcome[]; version: number }

/* ── verbs: preview → confirm → run → revert ────────────────────────────────────────────────── */

export type MatrixVerbId =
  | 'set-price' | 'adjust-prices' | 'copy-prices'
  | 'pin-quantity' | 'set-follow' | 'set-buffer'
  | 'pause-sync' | 'resume-sync' | 'push-now' | 'retry-sync'
  | 'set-fulfilment'

export const MATRIX_VERB_LABELS: Readonly<Record<MatrixVerbId, string>> = {
  'set-price': 'Set price…', 'adjust-prices': 'Adjust prices by %…', 'copy-prices': 'Copy prices from…',
  'pin-quantity': 'Pin quantity…', 'set-follow': 'Set to Follow', 'set-buffer': 'Set buffer…',
  'pause-sync': 'Pause sync', 'resume-sync': 'Resume sync', 'push-now': 'Push quantity now', 'retry-sync': 'Retry',
  'set-fulfilment': 'Set fulfilment…',
}

export interface MatrixVerbTarget { rowId: string; coordinateKey: CoordinateKey }

export type MatrixVerbParams =
  | { verb: 'set-price'; value: number }
  | { verb: 'adjust-prices'; percent: number }
  | { verb: 'copy-prices'; fromCoordinateKey: CoordinateKey }
  | { verb: 'pin-quantity'; value: number }
  | { verb: 'set-follow' }
  | { verb: 'set-buffer'; value: number }
  | { verb: 'pause-sync' }
  | { verb: 'resume-sync' }
  | { verb: 'push-now' }
  | { verb: 'retry-sync' }
  | { verb: 'set-fulfilment'; method: FulfilmentMethod }

export interface MatrixVerbRequest { params: MatrixVerbParams; targets: MatrixVerbTarget[]; commit: boolean }

export type RefusalKind = 'amazon-managed' | 'no-listing' | 'formula' | 'permission' | 'not-applicable' | 'guard' | 'currency'

export interface VerbChange {
  rowId: string
  sku: string
  coordinateKey: CoordinateKey
  cell: MatrixCellKind
  from: unknown
  to: unknown
  /** The operator-facing rendering of `from` → `to` (`€105.00 → €99.75`, `Follow 403 → Pinned 10`). */
  fromLabel: string
  toLabel: string
  note?: string
}

export interface VerbRefusal { rowId: string; sku: string; coordinateKey: CoordinateKey; kind: RefusalKind; reason: string }

export type ConfirmLevel = 'none' | 'confirm' | 'type-to-confirm'

export interface VerbPreview {
  verb: MatrixVerbId
  changes: VerbChange[]
  refusals: VerbRefusal[]
  /** Sentences the dialog shows above the table — `Amazon EU: this covers IT DE FR ES`. */
  notices: string[]
  confirm: ConfirmLevel
  /** The word to type when `confirm === 'type-to-confirm'`. */
  confirmWord: string | null
  /** `true` in preview mode: nothing is sent to a channel. */
  simulated: boolean
}

export interface VerbOperation {
  /** The revert point — one BulkOperation on the server, one entry in the preview store. */
  id: string
  verb: MatrixVerbId
  appliedAt: string
  applied: number
  refused: number
  /** Enough to restore by VALUE: the exact prior cells. */
  before: ReadonlyArray<{ rowId: string; coordinateKey: CoordinateKey; cells: MatrixCells }>
}

/* ── endpoints (the future service; the page's source module maps these) ──────────────────── */

export const MATRIX_ENDPOINTS = {
  read: (productId: string) => `/api/products/${encodeURIComponent(productId)}/studio/matrix`,
  write: (productId: string) => `/api/products/${encodeURIComponent(productId)}/studio/matrix`,
  verbs: (productId: string) => `/api/products/${encodeURIComponent(productId)}/studio/matrix/verbs`,
  revert: (productId: string, operationId: string) => `/api/products/${encodeURIComponent(productId)}/studio/matrix/verbs/${encodeURIComponent(operationId)}/revert`,
} as const

/* ── copy (Appendix A, verbatim) ────────────────────────────────────────────────────────────── */

export const MATRIX_COPY = {
  previewBanner: 'Preview data — the Matrix service is not built yet. Rows are this family; every cell below is a fixture and nothing is sent to a channel.',
  amazonManaged: 'Amazon-managed',
  uncounted: 'Uncounted',
  closed: 'Closed',
  notListed: 'Not listed',
  sharedEu: (markets: readonly string[]) => `Shared by ${markets.join(' ')} — one quantity per SKU on Amazon EU`,
  euNotice: (markets: readonly string[]) => `Amazon EU: this covers ${markets.join(' ')}`,
  followsPool: (n: number, locations: readonly string[], buffer: number) => `Follows the pool · ${n} available at ${locations.join(', ') || 'no routed location'} − ${buffer} buffer`,
  pinnedAt: (n: number) => `Pinned at ${n}`,
  pausedBy: (via: 'POLICY' | 'LISTING', would: number | null) => `Paused by ${via === 'POLICY' ? 'the channel policy' : 'this listing'} — would push ${would ?? '—'} · Resume to push`,
  uncountedHint: 'No routed location holds this SKU — nothing is pushed',
  closedHint: 'Offer closed — reopen in Sync Control',
  guardFba: 'Guard reads FBA — the quantity is not pushed',
  reported: (r: 'AFN' | 'MFN') => `Amazon reports ${r} — differs from Nexus`,
  followsBase: (price: string) => `Follows the base price ${price}`,
  setHere: 'Set here',
  formula: (expr: string) => `Formula ${expr}`,
  clamped: (which: 'floor' | 'ceiling') => `Clamped to the ${which}`,
  absentSaleEbay: 'eBay sale prices are promotions — Volume pricing',
  absentFulfilmentShopify: 'Shopify has no fulfilment method',
  absentFulfilment: (channelLabel: string) => `${channelLabel} has no fulfilment method`,
  absentBusiness: (pt: string, market: string) => `Amazon has not enabled business pricing for this account (checked against the ${pt} schema on ${market})`,
  absentBusinessUnchecked: (market: string) => `Business pricing could not be checked on ${market} — no product-type schema is cached for this family`,
  absentBusinessNotBuilt: (pt: string, market: string) => `Amazon allows business pricing here (the ${pt} schema on ${market}) — the B2B cells are not built yet`,
  noListingYet: 'No listing on this coordinate yet',
  noAccountConnected: 'No account is connected',
  pinnedThisSession: (n: number) => `${n} pinned this session · Undo`,
  simulated: 'Preview — nothing is sent',
} as const
