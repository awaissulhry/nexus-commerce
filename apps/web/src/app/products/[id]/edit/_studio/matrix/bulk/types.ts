/**
 * The Matrix's ONE bulk Edit (Owner 2026-10-07): tick rows, choose what to change, where, and to what — see every
 * `Now → New` before anything is written, apply, and Undo.
 *
 * This file is the contract between the dialog (`BulkEditDialog.tsx`, pure UI and its own state) and the page's runner
 * (`bulkSource.ts` with the page's doors in `MatrixSurface.tsx`). The dialog never writes, and never computes a number it
 * shows: each line — the rows as they are now, and the preview — comes from the runner, which asks the server (the
 * Matrix verbs) or reads the cell it would change.
 *
 * The doors, per field (measured 2026-10-12):
 *   Base price      the master sheet writer — one `PATCH /api/products/bulk`; the markets that follow it move after 30 s
 *   Market price    the verbs set-price · adjust-prices (a percentage or an amount) · copy-prices (server preview,
 *                   revertible); "Use the base price" = Matrix cell writes of `price: null` (the door hands the listing
 *                   back to the base price)
 *   Sale price      Matrix cell writes (`salePrice`) — a sale needs a price, a start and an end date
 *   Listing status  each market's Status column (the publish actions) — staged, sent by Publish
 *   Fulfilment      the verb set-fulfilment — on Amazon the offer is converted (sent per market, confirmed from
 *                   Amazon's report); on eBay it is set in Nexus
 *   Quantity        the verbs set-follow · pin-quantity
 *   Buffer          the verb set-buffer
 *   Stock sync      the verbs pause-sync · resume-sync · push-now · retry-sync
 *   Sells from      the verb set-source: the warehouses each listing sells from, in sale order
 *   B2B price       the verb set-business-price (Amazon Business): % below the price (the live rule) · an exact price ·
 *                   Raise / Lower an exact price by % · remove — through the business price door, sent to Amazon
 *   B2B tiers       the verb set-business-tiers: the same quantity discounts on each listing (its B2B price kept) · remove
 *   Case size       its own dialog (`CaseDialog`), opened on the same rows (`openElsewhere`)
 *   Stock source    its own dialog (`StockSourceDialog`), opened on the same rows (`openElsewhere`)
 */
import type { CoordinateKey, MatrixLocation } from '../contract'

export type BulkFieldId =
  | 'basePrice' | 'price' | 'salePrice'
  | 'businessPrice' | 'businessTiers' // Amazon Business: the B2B price and the quantity discounts
  | 'listingStatus' | 'fulfilment'
  | 'quantity' | 'buffer' | 'stockSync' | 'stockSource'
  // Hand-offs: listed so every bulk change is found in ONE list; each opens its own dialog on the same rows.
  | 'casePack' | 'stockPool'

/** The headings the field list is grouped under. */
export type BulkGroup = 'Prices' | 'Amazon Business' | 'Listing' | 'Stock'

export type BulkModeId =
  | 'set' | 'raise' | 'lower' // Base price, Market price; B2B price: Raise · Lower an exact business price by %
  | 'b2b-percent' | 'b2b-exact' | 'b2b-remove' // B2B price: % below the price · an exact price · none
  | 'tiers-set' | 'tiers-remove' // B2B tiers
  | 'copy' | 'follow-base' // Market price: copy another market's price · use the base price again
  | 'sale-set' | 'sale-remove' // Sale price
  | 'status' // Listing status: the choice is the target (active · inactive · ended · not_listed)
  | 'method' // Fulfilment: the choice is FBA · FBM · MCF
  | 'follow' | 'pin' // Quantity
  | 'buffer' // Buffer
  | 'hold' | 'release' | 'push' | 'retry' // Stock sync
  | 'sources' | 'default' // Sells from: the warehouses ticked, or the market default again
  | 'open' // Case size, Stock source: opens the field's own dialog on the same rows

/**
 * What a mode needs from the operator:
 *   none        nothing (Follow stock, Hold, Push now, Use the base price…)
 *   money       a price in the markets' currency (`currencyFor`), more than 0
 *   adjust      an unsigned number and its unit (`units`: % or the currency) — the mode (Raise · Lower) is the sign
 *   integer     a whole number, 0 or more
 *   choice      one of `choicesFor(...)` (a status, a method, a market to copy from)
 *   sale        a sale price, a start date and an end date (YYYY-MM-DD)
 *   locations   warehouses ticked in sale order (`SellsFromPicker`)
 *   percent     a percentage from 0 to 99, unsigned (B2B price: how far below the price)
 *   tiers       up to 5 quantity discounts: from N units, a percent off or a price per unit (`BusinessTiersInput`)
 *   handoff     nothing here: the primary button opens the field's own dialog (`openElsewhere`)
 */
export type BulkInputKind = 'none' | 'money' | 'adjust' | 'integer' | 'choice' | 'sale' | 'locations' | 'percent' | 'tiers' | 'handoff'

/** The units an `adjust` input offers: a percentage, or an amount in the markets' currency. */
export type BulkAdjustUnit = 'percent' | 'money'

export interface BulkModeSpec {
  id: BulkModeId
  /** The segment's word: `Set to` · `Raise` · `Lower` · `Copy from` · `Follow stock` · `Fixed number` · `Hold` … */
  label: string
  input: BulkInputKind
  /**
   * The input's label, e.g. `New price`, `Raise by`, `Quantity`, `Copy from`, `Method`, `Status`. For a `handoff` mode:
   * the primary button's words (`Open case sizes…`).
   */
  inputLabel?: string
  /** An `adjust` input's units, the first one chosen when the mode is. */
  units?: readonly BulkAdjustUnit[]
  /** One plain sentence under the controls: what this mode does and where it lands. */
  hint: string
}

export interface BulkFieldSpec {
  id: BulkFieldId
  /** The field's name: `Base price` · `Market price` · `Sale` · `Status` · `Fulfilment` · `Quantity` … */
  label: string
  /** One short plain line under the name in the field list: `Who ships: Amazon (FBA) or you (FBM)`. */
  description: string
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
  /** A price (`money`) or a whole number (`integer`). */
  amount?: number
  /** Raise · Lower by a percentage, signed (Lower 5 % = −5); a `percent` entry as typed (B2B price: 5 = 5 % below the price). */
  percent?: number
  /** Raise · Lower by an amount in the markets' currency, signed (Lower €2.50 = −2.5). */
  delta?: number
  choice?: string
  sale?: { value: number; start: string; end: string }
  /** Sells from: warehouse codes in sale order. */
  codes?: string[]
  /** B2B tiers: the quantity discounts, read (`businessTiersProblems` holds). */
  tiers?: { type: 'percent' | 'fixed'; levels: Array<{ minQty: number; value: number }> }
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
  /** The variant's short name, as the grid's Product cell says it under the SKU (`Nero · S`); null = none. */
  name?: string | null
  /** `Amazon · IT` · `Amazon EU · IT DE FR ES SE` · `Shared` (Base price, the grid's Shared group) */
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

/** A sentence above the table. `info` = a fact worth knowing; `warning` = a risk to read before applying. */
export interface BulkNotice { text: string; tone: 'info' | 'warning' }

export interface BulkPreview {
  /** The request this preview answers — the dialog applies a preview only when it matches what is on screen. */
  request: BulkRequest
  lines: readonly BulkLine[]
  /** Lines that change (`skipped === null`). */
  changes: number
  /** Lines that are skipped. */
  skipped: number
  /**
   * Sentences shown above the table — only facts the mode's hint does not already say. `Amazon EU: this covers IT DE FR
   * ES` is info; `Holding the stock sync also holds price changes` is a warning.
   */
  notices: readonly BulkNotice[]
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
  /** `Edit 12 variants` · `Edit GALE-JACKET-BLACK-MEN-XS` */
  title: string
  /** `GALE-JACKET · 12 of 20 variants` */
  subtitle: string
  fields: readonly BulkFieldSpec[]
  /** The markets that serve a field (empty for a product-level field). */
  marketsFor: (field: BulkFieldId) => readonly BulkMarketOption[]
  /**
   * The markets on screen that do not take the field at all, said once under the market boxes: `Not on eBay IT · Etsy:
   * they have no sale price in Nexus`. Null = every market on screen takes it (or the field is product-level).
   */
  marketsNote: (field: BulkFieldId) => string | null
  /** The markets ticked when a field is chosen (the focused market when it serves the field, else every offered one). */
  defaultMarkets: (field: BulkFieldId) => readonly CoordinateKey[]
  /**
   * The mode a field opens on for these rows and markets — the one most likely to change something (Quantity opens on
   * Fixed number when every row already follows its stock). Null = the field's first mode.
   */
  defaultMode: (field: BulkFieldId, coordinateKeys: readonly CoordinateKey[]) => BulkModeId | null
  /**
   * The rows as they are NOW for a field on these markets, before anything is typed: one line per row (and market) with
   * `now` in the grid's own words, `next: null`, `skipped: null`. A row not on a chosen market has no line. Read from the
   * cells the page holds, never from the server.
   */
  current: (field: BulkFieldId, coordinateKeys: readonly CoordinateKey[]) => readonly BulkLine[]
  /** The choices of a `choice` mode for these markets (status targets, methods, markets to copy from). */
  choicesFor: (field: BulkFieldId, mode: BulkModeId, coordinateKeys: readonly CoordinateKey[]) => readonly BulkChoiceOption[]
  /** The currency of a money input on these markets (`EUR` when they disagree or none is chosen). */
  currencyFor: (field: BulkFieldId, coordinateKeys: readonly CoordinateKey[]) => string
  /** The business's warehouses, for a `locations` input (Sells from). */
  locations: readonly MatrixLocation[]
  preview: (request: BulkRequest) => Promise<BulkPreview>
  apply: (preview: BulkPreview) => Promise<BulkResult>
  /**
   * A `handoff` field's door: closes this dialog and opens the field's own dialog on the same rows (Case size, Stock
   * source). Absent = the page offers no hand-off (those fields are then held, with the reason).
   */
  openElsewhere?: (field: BulkFieldId) => void
}
