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
import type { FbaPlanStatus } from './fba-send.js'

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
  listing: 196, fulfilment: 112, syncMode: 96, syncQty: 88, syncBuffer: 76, syncState: 96, price: 104, salePrice: 190,
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
  /**
   * The selling state the sheet's Status column shows (`SellingState` of @nexus/shared/listing-actions: active · paused ·
   * mixed · ended · draft · not_listed · unknown — read "Active · Inactive · Mixed · Ended · Not listed"), and why.
   * The Matrix shows the word; it changes nothing (no selling verbs here — Status column + Publish does).
   */
  selling?: { state: string; reason: string | null }
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
  /**
   * Amazon fulfilment conversion (2026-10-07): where the newest FBA ⇄ FBM change Nexus SENT Amazon for this coordinate
   * stands — sent, confirmed by Amazon's merchant listings report, still old, refused. Null/absent = none was sent.
   */
  conversion?: FulfilmentConversionStatus | null
}

/** A conversion's state: SENDING → SENT | REFUSED; SENT → CONFIRMED | STILL_OLD | NOT_IN_REPORT. */
export type FulfilmentConversionState = 'SENDING' | 'SENT' | 'CONFIRMED' | 'STILL_OLD' | 'REFUSED' | 'NOT_IN_REPORT'

export interface FulfilmentConversionStatus {
  status: FulfilmentConversionState
  /** The method sent. */
  to: 'FBA' | 'FBM'
  /** ISO time of this status (sent, confirmed, refused, last report read). */
  at: string
  /** The markets the change was sent to (the coordinate's rows). */
  markets: readonly string[]
  /** Amazon's or the report's own sentence, when there is one. */
  message: string | null
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
  /**
   * 2026-10-08 (Owner: the Sync column folds into Qty): this listing's newest STOCK push failed. Null/absent = it did not
   * (success shows nothing). Never sent on an Amazon-managed, held or Inactive listing — nothing is pushed there.
   */
  pushFailed?: PushFailure | null
  /**
   * Amazon EU: the EU markets' quantity settings disagree, so the push guard refuses the stock push (the sentence, whole).
   * Only on the region inventory cell; null/absent = they agree.
   */
  euConflict?: string | null
}

/**
 * The newest push of ONE lane (stock or price) of a listing, when it FAILED — the queue row's own outcome, read per lane
 * (`QUANTITY_UPDATE` · `PRICE_UPDATE`), eBay's shared-stock pushes (saved without a listing id) matched by product, item
 * and market. Amazon EU's region cell: the markets whose newest stock push failed, the newest failure's words.
 */
export interface PushFailure {
  /** The server's failure sentence. */
  reason: string
  /** ISO time the push failed, when known. */
  at: string | null
  /** `true` = no retry is left; `false` = it is tried again by itself. */
  final: boolean
  /** Amazon EU region cell: the markets whose newest stock push failed. `[]` elsewhere (the cell is one market). */
  markets: readonly string[]
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
  /**
   * A product sheet change saved on a LIVE Amazon listing that goes to Amazon only on Publish (D4=B). Tooltip only: the
   * cell keeps showing `value`, the live price (`MATRIX_COPY.waitingForPublish`). `value: null` = back to the base price.
   */
  waiting?: { value: number | null } | null
  /** 2026-10-08: this listing's newest PRICE push failed. Null/absent = it did not (success shows nothing). */
  pushFailed?: PushFailure | null
}

export interface SaleCell {
  value: number | null
  /** ISO dates, inclusive. */
  start: string | null
  end: string | null
  /** As `PriceCell.waiting`: the saved sale, sent on Publish (`value: null` = remove the sale). Tooltip only. */
  waiting?: { value: number | null; start: string | null; end: string | null } | null
}

/**
 * "Sells from" (Step 2, Owner 2026-10-07): which of this business's warehouses a coordinate's listing sells from, IN SALE
 * ORDER (a sale takes stock from the first that has it; the listing shows the SUM). One per market group — once on the
 * Amazon EU inventory group, for every EU market. Carried beside the inventory cells, never a `MatrixCellKind` (the Status
 * column's precedent): the page renders it as the group's From column and writes it through the door as `cell: 'source'`.
 */
export interface SourceCell {
  /** This listing's own choice in sale order; `[]` = it follows the market default. A choice equal to the default is stored `[]`. */
  own: readonly string[]
  /** The market's list (`marketSourceKey`), or — when the market has none yet — the active warehouses its routes allow (default first, then by code). */
  marketDefault: readonly string[]
  /** `market` = the business set a list for this market; `routes` = none yet, `syncRoutes` decide. */
  defaultOrigin: 'market' | 'routes'
  /** What sells now, in sale order, with this SKU's available units per location. */
  effective: ReadonlyArray<{ code: string; available: number }>
  writable: boolean
  /** The sentence when `writable` is false (parent, FBA, shared stock, no `inventory.adjust`); null when writable. */
  blockedReason: string | null
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
  /** "Sells from" — on a coordinate whose cells include `syncQty` (absent elsewhere and on an older server). */
  source?: SourceCell | null
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
  stock: {
    available: number | null
    uncounted: boolean
    locations: ReadonlyArray<{ code: string; available: number }>
    /**
     * Shared stock by SKU (2026-10-01): where this SKU's listings take their number. Null (or absent) = this
     * business's own warehouses; `pool` = the stock another business lends (the locations above are its).
     * A parent: the source its variations share, when they all share one.
     */
    source?: { kind: 'pool'; grantId: string; lenderName: string } | null
  }
  /**
   * Amazon FBA stock (Owner 2026-10-06): the units Amazon holds for this SKU, as Nexus mirrors them — Σ `StockLevel.quantity`
   * at this business's AMAZON_FBA locations, the number the FBA guard reads (`ProductLedger.fbaBucket`). READ-ONLY on every
   * surface: Amazon owns it, nothing in Nexus writes it. A parent: the family total of its variations.
   * `null` = no FBA stock row for this SKU, never `0`; absent = an older server that did not read it.
   */
  fba?: MatrixFbaStock | null
  /**
   * Case pack (Step 3, Owner D2 = B): this SKU's units per case, case size and weight, and who preps and labels for FBA
   * (`ProductPackage`). `null` = none set; absent = an older server that did not read it. A parent carries its own row
   * (normally null); the page sums up its variations. Sealed counts are not here (the stock editor shows them).
   */
  pack?: MatrixCasePack | null
  /**
   * Inbound to Amazon FBA (Step 4): Amazon's own inbound numbers for this SKU (`FbaInventoryDetail` rows with
   * `condition = 'INBOUND'`, `fulfillmentCenterId = 'ALL'`) and the units in open Nexus Send-to-FBA plans not shipped yet.
   * The FBA qty cell shows "92 +24": `fba.units` stays the value, `units` is the muted "+N". A parent: the family sum.
   * `null` = nothing inbound and nothing planned; absent = an older server that did not read it.
   */
  fbaInbound?: MatrixFbaInbound | null
  basePrice: number | null
  status: string
  cells: Record<CoordinateKey, MatrixCells>
}

/** One SKU's inbound to Amazon FBA (Step 4). Amazon owns every number but `planned`; Nexus never writes FBA quantities. */
export interface MatrixFbaInbound {
  /** Amazon's inbound units = working + shipped + receiving. */
  units: number
  working: number
  shipped: number
  receiving: number
  /** ISO time of Amazon's last read of these numbers; null = never read. */
  readAt: string | null
  /** Units in open Nexus plans (not CLOSED / CANCELLED) not marked Shipped yet: Σ (quantity − shippedQuantity). */
  planned: number
  /**
   * Units Nexus marked Shipped in plans Amazon is not receiving yet (status READY_TO_SHIP — some of several shipments
   * marked — or SHIPPED): Σ shippedQuantity of their lines. The "+N" is the bigger of this and `units` (`fbaInboundShown`), so it shows right
   * after "Mark shipped", before Amazon's next read. Absent = an older server that did not send it.
   */
  sent?: number
}

/** An open Send-to-FBA plan of this family (Step 4) — the toolbar's "FBA plans · N" and the FBA cell's tooltip. */
export interface MatrixFbaPlan {
  /** FbaInboundPlanV2.id */
  id: string
  name: string
  status: FbaPlanStatus
  /** Units of this family in the plan. */
  units: number
}

/** One SKU's case pack as the Matrix reads it (`ProductPackage`). Sizes in cm, weight in kg; owners null = not set. */
export interface MatrixCasePack {
  unitsPerCase: number | null
  caseLengthCm: number | null
  caseWidthCm: number | null
  caseHeightCm: number | null
  caseWeightKg: number | null
  fbaPrepOwner: 'AMAZON' | 'SELLER' | null
  fbaLabelOwner: 'AMAZON' | 'SELLER' | null
}

export interface MatrixFbaStock {
  units: number
  locations: ReadonlyArray<{ code: string; units: number }>
  /** ISO time Nexus last wrote one of these rows (`StockLevel.lastUpdatedAt`, the newest). */
  updatedAt: string | null
}

export interface MatrixRead {
  /** `Product.version` of the family root — the CAS discriminator for master cells. */
  version: number
  productId: string
  /**
   * `live` = the Matrix service answered — the only value the page's read boundary produces. `preview` = the grid lab's
   * and the tests' deterministic fixture (`_studio/matrix/fixtures.ts`); the page has no preview mode (Owner 2026-10-08).
   */
  source: 'live' | 'preview'
  generatedAt: string
  coordinates: MatrixCoordinate[]
  rows: MatrixRowRead[]
  /** `sourceLocationCodes` = the market's "Sells from" list (Step 2), in sale order; absent or `[]` = none (routes decide). */
  policies: ReadonlyArray<{ channel: string; market: string; pushesPaused: boolean; sourceLocationCodes?: readonly string[] }>
  /**
   * "Sells from" (Step 2): this business's WAREHOUSE locations — the ones a Sells from list may name. `active: false` =
   * switched off (never chosen, never sold from). `isDefault` = the business's default warehouse. Absent = an older server.
   */
  locations?: ReadonlyArray<MatrixLocation>
  /**
   * Send to FBA (Step 4): this family's OPEN plans (not CLOSED / CANCELLED), newest first. `[]` = none; absent = an
   * older server. The drawer reads the full plans from `GET /api/fba/inbound/plans?productId=<family root>&open=1`.
   */
  fbaPlans?: ReadonlyArray<MatrixFbaPlan>
}

export interface MatrixLocation { code: string; name: string; active: boolean; isDefault?: boolean }

/* ── writes: one door ───────────────────────────────────────────────────────────────────────── */

export type MatrixWritableKind = Extract<MatrixCellKind, 'fulfilment' | 'syncMode' | 'syncQty' | 'syncBuffer' | 'price' | 'salePrice'>
/** What the one door writes: the writable cell kinds plus "Sells from" (`value`: the codes in sale order; `[]` = the market default). */
export type MatrixDoorKind = MatrixWritableKind | 'source'

export interface MatrixWriteCell {
  rowId: string
  coordinateKey: CoordinateKey
  cell: MatrixDoorKind
  value: unknown
  expectedVersion: number
  /** The listing the caller saw on this coordinate (`MatrixCells.listingId`); another listing there now is a `conflict`. */
  expectedListingId?: string
}

/** `accountId` = the account the caller's read used (the GET's `?accountId=`), so the write resolves the same listings. */
export interface MatrixWriteRequest { cells: MatrixWriteCell[]; accountId?: string | null }

export type WriteOutcome = 'applied' | 'refused' | 'noop' | 'conflict'

export interface MatrixWriteOutcome {
  rowId: string
  coordinateKey: CoordinateKey
  cell: MatrixDoorKind
  outcome: WriteOutcome
  reason?: string
  /** The listing's version AFTER the write (unchanged on refused/noop; the CURRENT one on conflict). */
  version: number
  /** A region-inventory write lands on every market it carries. */
  expandedTo?: readonly CoordinateKey[]
  /** Every listing row the write moved, with its version AFTER the write (an EU cell: every EU row it landed on). */
  listings?: MatrixListingVersion[]
}

export interface MatrixListingVersion { listingId: string; productId: string; version: number }

export interface MatrixWriteResult { results: MatrixWriteOutcome[]; version: number }

/* ── verbs: preview → confirm → run → revert ────────────────────────────────────────────────── */

export type MatrixVerbId =
  | 'set-price' | 'adjust-prices' | 'copy-prices'
  | 'pin-quantity' | 'set-follow' | 'set-buffer'
  | 'pause-sync' | 'resume-sync' | 'push-now' | 'retry-sync'
  | 'set-fulfilment'
  | 'set-source'

export const MATRIX_VERB_LABELS: Readonly<Record<MatrixVerbId, string>> = {
  'set-price': 'Set price…', 'adjust-prices': 'Adjust prices by %…', 'copy-prices': 'Copy prices from…',
  'pin-quantity': 'Pin quantity…', 'set-follow': 'Set to Follow', 'set-buffer': 'Set buffer…',
  'pause-sync': 'Hold stock sync', 'resume-sync': 'Release stock sync', 'push-now': 'Push quantity now', 'retry-sync': 'Retry',
  'set-fulfilment': 'Set fulfilment…',
  'set-source': 'Set sells from…',
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
  /** "Sells from" in sale order; `[]` = use the market default. */
  | { verb: 'set-source'; codes: string[] }

export interface MatrixVerbRequest { params: MatrixVerbParams; targets: MatrixVerbTarget[]; commit: boolean }

export type RefusalKind = 'amazon-managed' | 'no-listing' | 'formula' | 'permission' | 'not-applicable' | 'guard' | 'currency'

export interface VerbChange {
  rowId: string
  sku: string
  coordinateKey: CoordinateKey
  /** `source` = "Sells from" (`set-source`; from/to are code lists, `[]` = the market default). */
  cell: MatrixCellKind | 'source'
  from: unknown
  to: unknown
  /** The operator-facing rendering of `from` → `to` (`€105.00 → €99.75`, `Follow 403 → Pinned 10`). */
  fromLabel: string
  toLabel: string
  note?: string
}

export interface VerbRefusal { rowId: string; sku: string; coordinateKey: CoordinateKey; kind: RefusalKind; reason: string }

/** 2026-10-08: two levels — the old `confirm` was read by no dialog (the Edit dialog asks only for a typed word). */
export type ConfirmLevel = 'none' | 'type-to-confirm'

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
  amazonManaged: 'Amazon-managed',
  uncounted: 'Uncounted',
  /** Build shape v2: the Sync cell of a listing whose selling is paused (the wire's CLOSED). Selling words, not sync words. */
  closed: 'Inactive',
  notListed: 'Not listed',
  sharedEu: (markets: readonly string[]) => `Shared by ${markets.join(' ')} — one quantity per SKU on Amazon EU`,
  euNotice: (markets: readonly string[]) => `Amazon EU: this covers ${markets.join(' ')}`,
  /** The region Qty cell's ⚠ (`SyncCell.euConflict`): the guard's own detail (`detectEuIntentConflict`), whole. */
  euConflict: (detail: string) => `EU shared-quantity conflict: ${detail}. The stock push is refused until the EU markets agree`,
  followsPool: (n: number, locations: readonly string[], buffer: number) => `Follows the pool · ${n} available at ${locations.join(', ') || 'no routed location'} − ${buffer} buffer`,
  pinnedAt: (n: number) => `Pinned at ${n}`,
  pausedBy: (via: 'POLICY' | 'LISTING', would: number | null) => `Stock sync held by ${via === 'POLICY' ? 'the channel policy' : 'this listing'} — would push ${would ?? '—'} · Release to push`,
  uncountedHint: 'No routed location holds this SKU — nothing is pushed',
  closedHint: 'Selling is paused here — set Active in the sheet\'s Status column and Publish',
  guardFba: 'Guard reads FBA — the quantity is not pushed',
  /** The FBA qty column (Shared group): locked on every row, and this is why. */
  fbaLocked: 'Amazon-managed — Nexus shows this number and never changes it',
  fbaNone: 'No Amazon FBA stock for this SKU in Nexus',
  fbaNotRead: 'FBA stock was not read',
  fbaUnits: (units: number, locations: readonly string[]) => `${units} ${units === 1 ? 'unit' : 'units'} at Amazon${locations.length ? ` (${locations.join(' · ')})` : ''}`,
  reported: (r: 'AFN' | 'MFN') => `Amazon reports ${r} — differs from Nexus`,
  followsBase: (price: string) => `Follows the base price ${price}`,
  setHere: 'Set here',
  formula: (expr: string) => `Formula ${expr}`,
  clamped: (which: 'floor' | 'ceiling') => `Clamped to the ${which}`,
  absentSaleEbay: 'eBay sale prices are promotions — Volume pricing',
  absentSaleEtsy: 'Etsy has no sale price on a listing; sales are set on Etsy (Marketing → Sales and discounts)',
  absentFulfilmentShopify: 'Shopify has no fulfilment method',
  absentFulfilment: (channelLabel: string) => `${channelLabel} has no fulfilment method`,
  /* 2026-10-08: the sentence names no market — it is said per coordinate, and Customise groups the markets that share it. */
  absentBusiness: (pt: string) => `Amazon has not enabled business pricing for this account (checked against the ${pt} schema)`,
  absentBusinessUnchecked: () => 'Business pricing could not be checked — no product-type schema is cached for this family',
  absentBusinessNotBuilt: (pt: string) => `Amazon allows business pricing here (the ${pt} schema) — the B2B cells are not built yet`,
  noListingYet: 'No listing on this coordinate yet',
  /** A write whose listing moved since the caller read it (CAS on `ChannelListing.version`, or another listing there now). */
  changedElsewhere: 'Changed elsewhere — reloaded',
  /** A sheet row whose listing is not the one the Matrix read holds for its market (another account). */
  accountMismatch: "The Matrix shows another account's listing for this market, so this cell cannot be changed here",
  /** The tooltip line of a Price or Sale cell whose product sheet change waits for Publish (`PriceCell.waiting`). */
  waitingForPublish: (value: string) => `Product sheet change waits for Publish: ${value}`,
  noAccountConnected: 'No account is connected',
  simulated: 'Preview — nothing is sent',
  /** The Fulfilment cell's one tooltip line for the newest conversion Nexus sent Amazon (2026-10-07). */
  conversion: (c: FulfilmentConversionStatus) => conversionLine(c),
  /** Set fulfilment on Amazon: what the run does, said once above the table. */
  fulfilmentSent: (markets: readonly string[]) => `Sent to Amazon on ${markets.join(' ')}: each market's offer is converted, then checked against Amazon's merchant listings report within minutes — the Fulfilment cell shows when Amazon confirms it`,
  fulfilmentEuQuantity: 'Amazon EU keeps ONE merchant quantity per SKU: the FBM quantity sent sells on every open EU market',
  fulfilmentFbaOutOfStock: 'After the switch to FBA the offer shows out of stock on Amazon until Amazon receives units at its fulfilment centres',
  fulfilmentNexusOnly: 'Nexus only — nothing is sent to the channel; the quantity pushes follow the new method',
  /** A direct write of an Amazon Fulfilment cell (not the confirmed verb). */
  fulfilmentViaVerb: 'On Amazon the method is changed with Set fulfilment… (type the method to confirm): it converts the offer on Amazon',
  /* "Sells from" (Step 2, 2026-10-07): why the From cell cannot be changed, and the door's refusals. */
  sourceParent: 'Set on the variants — the parent has no listing of its own',
  sourceFba: 'Amazon-managed — Amazon ships FBA orders from its own stock',
  sourcePermission: 'You do not have permission to change where stock sells from (inventory.adjust)',
  sourceNone: 'This coordinate carries no inventory',
  sourceTooMany: 'At most 20 locations',
  sourceTwice: (code: string) => `${code} is listed twice`,
  sourceUnknown: (code: string) => `${code} is not a warehouse of this business`,
  sourceInactive: (code: string) => `${code} is switched off — switch it on in Locations first`,
  /** The change's label for a verb row: `Default (IT-MAIN)` or the own list. */
  sourceLabel: (own: readonly string[], marketDefault: readonly string[]) =>
    own.length ? own.join(' + ') : `Default (${marketDefault.join(' + ') || 'none'})`,
} as const

const hhmm = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** PURE — the one line a conversion reads as ("Sent to Amazon 12:04 · waiting for Amazon's report"). */
function conversionLine(c: FulfilmentConversionStatus): string {
  const old = c.to === 'FBM' ? 'FBA' : 'FBM'
  switch (c.status) {
    case 'SENDING': return `Sending ${c.to} to Amazon ${hhmm(c.at)}`
    case 'SENT': return `Sent to Amazon ${hhmm(c.at)} · waiting for Amazon's report`
    case 'CONFIRMED': return `Confirmed by Amazon ${hhmm(c.at)}`
    case 'STILL_OLD': return `Amazon still reports ${old} — check Seller Central`
    case 'NOT_IN_REPORT': return `Not in Amazon's report — check Seller Central`
    case 'REFUSED': return `${c.to} not sent — ${c.message ?? 'refused'}`
  }
}
