/**
 * The Matrix's ONE bulk Edit (Owner 2026-10-07): tick rows, choose what to change, where, and to what — see every
 * `Now → New` before anything is written, apply, and Undo.
 *
 * This file is the contract between the dialog (`BulkEditDialog.tsx`, pure UI and its own state) and the page's runner
 * (`useBulkEdit.ts`, which owns every write door). The dialog never writes, and never computes a number it shows: each
 * line of the preview comes from the runner, which asks the server (the Matrix verbs) or reads the cell it would change.
 *
 * The doors, per field (measured 2026-10-07):
 *   Base price      the master sheet writer — one `PATCH /api/products/bulk`; the markets that follow it move after 30 s
 *   Price           the verbs set-price · adjust-prices · copy-prices (server preview, revertible)
 *   Sale price      Matrix cell writes (`salePrice`) — a sale needs a price, a start and an end date
 *   Listing status  each market's Status column (the publish actions) — staged, sent by Publish
 *   Fulfilment      the verb set-fulfilment — Nexus only, nothing is sent to Amazon
 *   Quantity        the verbs set-follow · pin-quantity
 *   Buffer          the verb set-buffer
 *   Stock sync      the verbs pause-sync · resume-sync · push-now · retry-sync
 *   Sells from      the verb set-source (Step 2): the warehouses each listing sells from, in sale order
 */
import type { CoordinateKey, MatrixLocation } from '../contract'

export type BulkFieldId = 'basePrice' | 'price' | 'salePrice' | 'listingStatus' | 'fulfilment' | 'quantity' | 'buffer' | 'stockSync' | 'stockSource'

/** The headings the field list is grouped under. */
export type BulkGroup = 'Prices' | 'Listing' | 'Stock'

export type BulkModeId =
  | 'set' | 'adjust' | 'copy' // Base price, Price
  | 'sale-set' | 'sale-remove' // Sale price
  | 'status' // Listing status: the choice is the target (active · inactive · ended · not_listed)
  | 'method' // Fulfilment: the choice is FBA · FBM · MCF
  | 'follow' | 'pin' // Quantity
  | 'buffer' // Buffer
  | 'hold' | 'release' | 'push' | 'retry' // Stock sync
  | 'sources' | 'default' // Sells from: the warehouses ticked, or the market default again

/**
 * What a mode needs from the operator:
 *   none        nothing (Follow stock, Hold, Push now…)
 *   money       an amount in the markets' currency (`currencyFor`)
 *   percent     a signed percentage (−5 lowers by 5 %)
 *   integer     a whole number, 0 or more
 *   choice      one of `choicesFor(...)` (a status, a method, a market to copy from)
 *   sale        a sale price, a start date and an end date (YYYY-MM-DD)
 *   locations   warehouses ticked in sale order (`SellsFromPicker`)
 */
export type BulkInputKind = 'none' | 'money' | 'percent' | 'integer' | 'choice' | 'sale' | 'locations'

export interface BulkModeSpec {
  id: BulkModeId
  /** The segment's word: `Set to` · `Change by %` · `Copy from` · `Follow stock` · `Fixed number` · `Hold` … */
  label: string
  input: BulkInputKind
  /** The input's label, e.g. `New price`, `Change by`, `Quantity`, `Copy from`, `Method`, `Status`. */
  inputLabel?: string
  /** One plain sentence under the controls: what this mode does and where it lands. */
  hint: string
}

export interface BulkFieldSpec {
  id: BulkFieldId
  /** The field's name as the column says it: `Base price` · `Price` · `Sale price` · `Status` · `Fulfilment` … */
  label: string
  group: BulkGroup
  /** False for a product-level field (Base price): no market choice is shown. */
  perMarket: boolean
  modes: readonly BulkModeSpec[]
  /** Why this selection cannot take the field (it stays in the list, with this as its second line); null = offered. */
  held: string | null
}

/** A market the field can be changed on, for the market choice (only markets that serve the field are offered). */
export interface BulkMarketOption {
  key: CoordinateKey
  /** `Amazon · IT` · `Amazon EU · IT DE FR ES SE` · `eBay · IT` */
  label: string
  /** Why this market cannot take the field for these rows (shown, not hidden); null = it can. */
  held: string | null
}

export interface BulkChoiceOption { value: string; label: string; title?: string }

/** What the operator entered, parsed — the dialog never sends a string it could not read. */
export interface BulkInput {
  amount?: number
  percent?: number
  choice?: string
  sale?: { value: number; start: string; end: string }
  /** Sells from: warehouse codes in sale order. */
  codes?: string[]
}

/** One change the operator asked for. The rows are the page's (the ticked rows, bound when the dialog opened). */
export interface BulkRequest {
  field: BulkFieldId
  mode: BulkModeId
  input: BulkInput
  /** The markets chosen; empty for a product-level field. */
  coordinateKeys: readonly CoordinateKey[]
}

/** One line of the preview table: one row on one market (or on every market, for Base price). */
export interface BulkLine {
  /** Unique within the preview. */
  id: string
  rowId: string
  sku: string
  /** `Amazon · IT` · `Amazon EU · IT DE FR ES SE` · `Every market` */
  where: string
  /** What the cell says now: `€105.00` · `FBA` · `Follow · 6` · `Active`. */
  now: string
  /** What it will say; null when this line is skipped. */
  next: string | null
  /** A consequence worth reading, e.g. `Follow → 7 pushed from WH-T2`, `Waits for Publish`. */
  note: string | null
  /** Why this line is skipped (a refusal, said plainly); null = it changes. */
  skipped: string | null
}

export interface BulkPreview {
  /** The request this preview answers — the dialog applies a preview only when it matches what is on screen. */
  request: BulkRequest
  lines: readonly BulkLine[]
  /** Lines that change (`skipped === null`). */
  changes: number
  /** Lines that are skipped. */
  skipped: number
  /** Sentences the operator must read before applying (shown as banners): `Amazon EU: one quantity for IT DE FR ES SE`. */
  notices: readonly string[]
  /** A word the operator types to confirm (a fulfilment change, a large change); null = the Apply button is enough. */
  confirmWord: string | null
  /** False when the change cannot be called back (Push now, Retry): the dialog says so before Apply. */
  undoable: boolean
  /** The runner's own payload, applied exactly as previewed. The dialog never reads it. */
  payload: unknown
}

export interface BulkResult {
  applied: number
  skipped: number
  /** The plain result: `10 prices saved · 2 skipped. Amazon gets them in about 30 seconds.` */
  sentence: string
  tone: 'success' | 'warning' | 'danger'
  /** Puts the change back; resolves with the receipt sentence. Null when it cannot be called back. */
  undo: (() => Promise<string>) | null
  /**
   * The preview's lines as the server ANSWERED them: a line refused at Apply is skipped, with the server's reason.
   * Absent = the runner could not tell the lines apart (then the table keeps the preview's words).
   */
  lines?: readonly BulkLine[]
}

/** What a dialog opens on. Every member is optional: the dialog defaults the rest (the first offered field and mode). */
export interface BulkInitial {
  field?: BulkFieldId
  mode?: BulkModeId
  input?: BulkInput
  coordinateKeys?: readonly CoordinateKey[]
}

/** Everything the page supplies to the dialog for ONE opening (one set of rows). */
export interface BulkEditSource {
  /** `Edit 12 rows` · `Edit GALE-JACKET-BLACK-MEN-XS` */
  title: string
  /** `GALE-JACKET · 12 of 20 variants` */
  subtitle: string
  fields: readonly BulkFieldSpec[]
  /** The markets that serve a field (empty for a product-level field). */
  marketsFor: (field: BulkFieldId) => readonly BulkMarketOption[]
  /** The markets ticked when a field is chosen (the focused market when it serves the field, else every offered one). */
  defaultMarkets: (field: BulkFieldId) => readonly CoordinateKey[]
  /** The choices of a `choice` mode for these markets (status targets, methods, markets to copy from). */
  choicesFor: (field: BulkFieldId, mode: BulkModeId, coordinateKeys: readonly CoordinateKey[]) => readonly BulkChoiceOption[]
  /** The currency of a money input on these markets (`EUR` when they disagree or none is chosen). */
  currencyFor: (field: BulkFieldId, coordinateKeys: readonly CoordinateKey[]) => string
  /** The business's warehouses, for a `locations` input (Sells from). */
  locations: readonly MatrixLocation[]
  preview: (request: BulkRequest) => Promise<BulkPreview>
  apply: (preview: BulkPreview) => Promise<BulkResult>
}
