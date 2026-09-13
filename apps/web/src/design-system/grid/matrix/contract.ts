/**
 * MX.G — the ENGINE's declaration of the Matrix cell shapes.
 *
 * `apps/web/src/app/products/[id]/edit/_studio/matrix/contract.ts` (MX.C) is the WIRE authority: the
 * page and the future service code against it. This file is the same shapes stated where the grid
 * engine can reach them, and it exists for one measured reason rather than a preference:
 *
 *   · `rg "from '@/app/" apps/web/src/design-system` → **0 hits** in ~200 files. No design-system
 *     file imports an app module, and this one must not be the first.
 *   · Every DS file is mirrored byte-for-byte into `apps/factory/src/design-system/**`
 *     (`scripts/check-ds-fork-drift.mjs`). `apps/factory/tsconfig.json` maps `@/*` → `./src/*` and
 *     `apps/factory/src/app` has no `products/[id]/edit/_studio/` tree, while that workspace
 *     typechecks green today (`npx tsc --noEmit -p tsconfig.json`, exit 0, 0 lines). A mirror
 *     carrying an `@/app/...` import could not resolve there. The mirror rule and the import are
 *     mutually exclusive; the mirror rule wins.
 *
 * 🔴 **This is not a licence to drift.** `matrix/contract.parity.vitest.test.ts` — which lives in
 * `apps/web` only and is therefore free to import both — asserts that every type here is
 * bidirectionally assignable with its counterpart in `_studio/matrix/contract.ts` and that every
 * constant is deep-equal. A field added on one side and not the other is a RED test, not a silent
 * second truth (`reference_two_column_builders_drift`: put the rule in the engine, assert parity in
 * the gate). The collapse to one declaration is a one-line re-export in the app file, recorded as a
 * REQUEST TO MX.P in `docs/pes-claims.md`.
 *
 * 🔴 `MATRIX_COPY` is deliberately NOT copied here. Words are the app's, and a second copy of a
 * sentence table is exactly what the parity test cannot check cheaply (its members are functions).
 * The engine declares the SHAPE of the copy table it reads (`MatrixCopy` below) and the caller
 * supplies the app's own `MATRIX_COPY` — the same split `SheetWriter` already uses for `commit`.
 *
 * Pure types and constants. No React, no AG, no fetch — so every pure rule built on it is reachable
 * from this workspace's node-only vitest.
 */

/* ── cells ─────────────────────────────────────────────────────────────────────────────────── */

/** The eight cell kinds a coordinate group may serve. Order = default column order inside a group. */
export type MatrixCellKind = 'listing' | 'fulfilment' | 'syncMode' | 'syncQty' | 'syncBuffer' | 'syncState' | 'price' | 'salePrice'
export const MATRIX_CELL_KINDS: readonly MatrixCellKind[] = ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice']

/** The cell kinds that make up the INVENTORY lane — the ones a region-inventory coordinate owns. */
export const INVENTORY_CELL_KINDS: readonly MatrixCellKind[] = ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState']
/** The cell kinds an operator can write from the grid (the rest are facts). */
export const WRITABLE_CELL_KINDS: readonly MatrixCellKind[] = ['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'price', 'salePrice']

/** Column header per kind — design Appendix A, verbatim. */
export const MATRIX_CELL_LABELS: Readonly<Record<MatrixCellKind, string>> = {
  listing: 'Listing', fulfilment: 'Fulfilment', syncMode: 'Mode', syncQty: 'Qty', syncBuffer: 'Buffer', syncState: 'Sync', price: 'Price', salePrice: 'Sale',
}
/** Design §3.3 widths (px). */
export const MATRIX_CELL_WIDTHS: Readonly<Record<MatrixCellKind, number>> = {
  listing: 150, fulfilment: 96, syncMode: 96, syncQty: 88, syncBuffer: 76, syncState: 96, price: 104, salePrice: 190,
}

/** MX.F (ruled): the absent-capable kinds — the eight plus the reserved business cells (design §3.11). Absence-only today. */
export type MatrixAbsentCellKind = MatrixCellKind | 'businessPrice' | 'businessTiers'
/** Customise's label per absent-capable kind — the eight headers plus Appendix A's `B2B price` · `Tiers`. */
export const MATRIX_ABSENT_CELL_LABELS: Readonly<Record<MatrixAbsentCellKind, string>> = {
  ...MATRIX_CELL_LABELS, businessPrice: 'B2B price', businessTiers: 'Tiers',
}

/** The projection words the Variants page fixed (five) plus the four the Matrix adds (design §3.4). */
export type ListingState = 'listed' | 'draft' | 'excluded' | 'not-set-up' | 'needs-value' | 'suppressed' | 'closed' | 'error' | 'ended'

export interface ListingCell {
  state: ListingState
  externalId: string | null
  detail: string | null
  published: boolean
}

export type FulfilmentMethod = 'FBA' | 'FBM' | 'MCF'

export interface FulfilmentCell {
  method: FulfilmentMethod | null
  source: 'set' | 'derived'
  guard: 'FBA' | 'FBM' | null
  reported: 'AFN' | 'MFN' | null
}

/** `resolveIntendedQuantity`'s verdict, verbatim. */
export type SyncKind = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'FBA_EXCLUDED' | 'UNCOUNTED' | 'CLOSED'
export type SyncMode = 'FOLLOW' | 'PINNED'

export interface SyncCell {
  kind: SyncKind
  via: 'POLICY' | 'LISTING' | null
  mode: SyncMode
  intended: number | null
  held: number | null
  buffer: number
  poolAvailable: number | null
  routedLocations: readonly string[]
  fbaAtAmazon: number | null
  oversold: boolean
}

export type QueueState = 'sent' | 'queued' | 'sending' | 'failed' | 'dead' | 'paused' | 'never'

export interface QueueCell {
  state: QueueState
  at: string | null
  reason: string | null
  syncType: 'QUANTITY_UPDATE' | 'PRICE_UPDATE' | null
  via: 'POLICY' | 'LISTING' | null
}

export type PriceSource = 'master' | 'override' | 'formula'

export interface PriceCell {
  value: number | null
  currency: string
  source: PriceSource
  formula: string | null
  clamped: 'floor' | 'ceiling' | null
}

export interface SaleCell {
  value: number | null
  start: string | null
  end: string | null
}

/** Everything one row says about one coordinate. */
export interface MatrixCells {
  listingId: string | null
  /** `ChannelListing.version` — the CAS discriminator for every write on this coordinate. */
  version: number
  listing: ListingCell | null
  fulfilment: FulfilmentCell | null
  sync: SyncCell | null
  queue: QueueCell | null
  price: PriceCell | null
  sale: SaleCell | null
  writable: Partial<Record<MatrixCellKind, boolean>>
  writeBlockedReason: Partial<Record<MatrixCellKind, string>>
}

/* ── coordinates ────────────────────────────────────────────────────────────────────────────── */

export type CoordinateKey = string
export type CoordinateKind = 'market' | 'region-inventory' | 'global'

export interface MatrixCoordinate {
  key: CoordinateKey
  kind: CoordinateKind
  channel: string
  market: string
  label: string
  region: string | null
  alias: { id: string; label: string; position: number } | null
  accountId: string | null
  currency: string
  connected: boolean
  listed: number | null
  draft: number | null
  cells: readonly MatrixCellKind[]
  absent: ReadonlyArray<{ cell: MatrixAbsentCellKind; reason: string }>
  sharedInventoryWith: readonly string[] | null
  inventoryOn: CoordinateKey | null
  vocabulary: { fulfilment: readonly FulfilmentMethod[] | null }
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

/* ── verbs ──────────────────────────────────────────────────────────────────────────────────── */

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

/* The verb PREVIEW — what `previewVerb` (preview mode) and `POST …/verbs commit:false` (live)
   answer, and what the registry adapter in `actions/matrixActions.ts` turns into an `ActionImpact`.
   Restated here for the same measured reason as everything above; gated by the parity test. */

export type RefusalKind = 'amazon-managed' | 'no-listing' | 'formula' | 'permission' | 'not-applicable' | 'guard' | 'currency'

export interface VerbChange {
  rowId: string
  sku: string
  coordinateKey: CoordinateKey
  cell: MatrixCellKind
  from: unknown
  to: unknown
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
  notices: string[]
  confirm: ConfirmLevel
  confirmWord: string | null
  simulated: boolean
}

/* ── the copy table the engine READS (the app supplies the words) ───────────────────────────── */

/**
 * The members of the app's `MATRIX_COPY` that engine code actually reads.
 *
 * Declared as a REQUIREMENT, not a copy: `matrix/contract.parity.vitest.test.ts` proves
 * `MATRIX_COPY satisfies MatrixCopy`, so a word that changes in the app changes on screen without
 * anything here moving, and a member the app drops is a compile error rather than an undefined
 * tooltip. Deliberately structural and readonly — nothing in the engine may write to it.
 */
export interface MatrixCopy {
  readonly amazonManaged: string
  readonly uncounted: string
  readonly closed: string
  readonly notListed: string
  readonly sharedEu: (markets: readonly string[]) => string
  readonly followsPool: (n: number, locations: readonly string[], buffer: number) => string
  readonly pinnedAt: (n: number) => string
  readonly pausedBy: (via: 'POLICY' | 'LISTING', would: number | null) => string
  readonly uncountedHint: string
  readonly closedHint: string
  readonly guardFba: string
  readonly reported: (r: 'AFN' | 'MFN') => string
  readonly followsBase: (price: string) => string
  readonly setHere: string
  readonly formula: (expr: string) => string
  readonly clamped: (which: 'floor' | 'ceiling') => string
}
