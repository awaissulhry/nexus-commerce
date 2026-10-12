/**
 * The bulk Edit's FIELDS (Owner 2026-10-07; v2 2026-10-12) — pure: what the ticked rows may change, on which markets, to
 * which values; the rows as they are NOW (`bulkCurrent`, in the grid's own words); and the preview lines of the changes
 * that need no server answer (Base price, Market price "Use base price", Sale, Status). The Matrix verbs' own preview
 * (Market price, Fulfilment, Quantity, Buffer, Stock sync, Sells from) is turned into the same lines by `verbLines`.
 *
 * Nothing here writes; the runner (`bulkSource.ts`) reaches the page's doors (`MatrixSurface.tsx`). Every number shown
 * comes from the read (a cell, a row) or from the server's preview — never from a guess here.
 */
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import type { StatusTarget } from '@nexus/shared/listing-actions'

import { MATRIX_DASH, matrixCellText, matrixMoney, matrixModeWord, matrixQtyText, matrixSaleText, STATUS_TARGET_WORD } from '@/design-system/grid'

import {
  MATRIX_COPY,
  type CoordinateKey,
  type MatrixCellKind,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixLocation,
  type MatrixRowRead,
  type MatrixVerbParams,
  type MatrixVerbTarget,
  type VerbPreview,
} from '../contract'
import { activeWarehouses, fromCellText } from '../sellsFrom'
import { statusCellText, statusCellValue } from '../../sheet/channel/statusColumn'
import type { BulkChoiceOption, BulkFieldId, BulkFieldSpec, BulkInput, BulkLine, BulkMarketOption, BulkModeId, BulkModeSpec, BulkNotice } from './types'

/* ── words ────────────────────────────────────────────────────────────────────────────────── */

/**
 * WHEN a saved change reaches the market — every sentence that says it, in ONE place: the "Matrix changes wait for
 * Publish" lane (`~/nexus-archive/2026-10-12-matrix-publish/`) switches these words here and nowhere else.
 */
export const BULK_SENT = {
  it: 'Nexus sends it in about 30 seconds.',
  them: 'Nexus sends them in about 30 seconds.',
  prices: 'Nexus sends the new prices in about 30 seconds.',
  followers: 'Markets that follow the base price get it in about 30 seconds.',
  amazonSale: 'Nexus sends the sale and its two dates to Amazon in about 30 seconds.',
  amazonSaleEnd: 'Nexus tells Amazon to end the sale in about 30 seconds.',
} as const
/** `Nexus sends it/them …` for `n` changes; nothing when none changed. */
export const bulkSent = (n: number): string => (n <= 0 ? '' : n === 1 ? BULK_SENT.it : BULK_SENT.them)

export const BULK_EDIT_PERMISSION = 'You do not have permission to edit products'
export const BULK_PRICE_PERMISSION = 'You do not have permission to change prices'
export const BULK_PARENT_ONLY = 'The parent row has no listing of its own — tick its variants'
export const BULK_SAME = (now: string) => `Already ${now}`
export const BULK_HOLD_NOTICE = 'Price and sale changes made while the sync is held stay in Nexus. They are sent when you release it.'
export const BULK_STATUS_NEW_ROW = 'Not on this market yet. Choose its Status in the grid to create the listing'
export const BULK_NO_WAREHOUSE = 'No active warehouse to sell from'
export const BULK_PRICE_ABOVE_0 = 'A price must be more than 0'
export const BULK_NO_BASE_PRICE = 'This row has no base price yet'
export const BULK_FOLLOWS_BASE = MATRIX_COPY.followsBase('').trim()
export const BULK_ALREADY_FOLLOWS = 'Already follows the base price'
export const BULK_FORMULA_PRICE = 'A formula sets this price'
/** Base price: a row the grid does not show (filtered, folded) cannot take the grid's write. */
export const BULK_NOT_ON_SCREEN = 'This row is not on screen. Show it and try again.'
/** The grid's Shared group — where a product-level line (Base price, Case size, Stock source) lives. */
export const BULK_SHARED = 'Shared'
export const BULK_NO_HANDOFF = 'This page cannot open it for these rows'
export const BULK_CASE_PERMISSION = 'You do not have permission to change case sizes (inventory.adjust)'
export const BULK_CASE_NOT_AMAZON = 'This family is not on Amazon. Case sizes are for shipments to Amazon.'
export const BULK_CASE_NO_VARIANT = 'None of these rows is a variant'
export const BULK_CASE_NOT_READ = 'Case sizes are not read for these rows yet. Reload the Matrix and try again.'
export const BULK_OWN_STOCK = 'Own stock'

/* ── the catalogue ────────────────────────────────────────────────────────────────────────── */

const ADJUST_UNITS = ['percent', 'money'] as const

const MODES: Record<BulkFieldId, readonly BulkModeSpec[]> = {
  basePrice: [
    { id: 'set', label: 'Set to', input: 'money', inputLabel: 'New price', hint: 'Every market without its own price moves to this price.' },
    { id: 'raise', label: 'Raise', input: 'adjust', inputLabel: 'Raise by', units: ADJUST_UNITS, hint: 'Each base price goes up by this much.' },
    { id: 'lower', label: 'Lower', input: 'adjust', inputLabel: 'Lower by', units: ADJUST_UNITS, hint: 'Each base price goes down by this much.' },
  ],
  price: [
    { id: 'set', label: 'Set to', input: 'money', inputLabel: 'New price', hint: 'These markets get this price, instead of the base price.' },
    { id: 'raise', label: 'Raise', input: 'adjust', inputLabel: 'Raise by', units: ADJUST_UNITS, hint: 'Each market price goes up by this much.' },
    { id: 'lower', label: 'Lower', input: 'adjust', inputLabel: 'Lower by', units: ADJUST_UNITS, hint: 'Each market price goes down by this much.' },
    { id: 'copy', label: 'Copy from', input: 'choice', inputLabel: 'Copy from', hint: 'Each row takes its price from the market you choose.' },
    { id: 'follow-base', label: 'Use base price', input: 'none', hint: 'These markets drop their own price and follow the base price again.' },
  ],
  salePrice: [
    { id: 'sale-set', label: 'Set a sale', input: 'sale', inputLabel: 'Sale price', hint: 'The market sells at the sale price from the first day to the last.' },
    { id: 'sale-remove', label: 'Remove the sale', input: 'none', hint: 'The market goes back to its normal price.' },
  ],
  listingStatus: [
    { id: 'status', label: 'Set to', input: 'choice', inputLabel: 'New status', hint: 'Saved in Nexus now. Publish sends it to each market.' },
  ],
  fulfilment: [
    { id: 'method', label: 'Set to', input: 'choice', inputLabel: 'Method', hint: 'FBA: Amazon ships from its stock. FBM: you ship from yours. On Amazon the offer itself is switched.' },
  ],
  quantity: [
    { id: 'follow', label: 'Follow stock', input: 'none', hint: 'The market shows your warehouse stock, less the buffer.' },
    { id: 'pin', label: 'Fixed number', input: 'integer', inputLabel: 'Quantity', hint: 'The market shows this number, whatever your stock.' },
  ],
  buffer: [
    { id: 'buffer', label: 'Set to', input: 'integer', inputLabel: 'Buffer', hint: 'Units kept back when the market follows your stock. A fixed number ignores it.' },
  ],
  stockSync: [
    { id: 'hold', label: 'Hold', input: 'none', hint: 'Stops sending quantity, price and sale changes to these markets until you release them.' },
    { id: 'release', label: 'Release', input: 'none', hint: 'Starts sending again and sends what the market should show.' },
    { id: 'push', label: 'Push now', input: 'none', hint: 'Sends the quantity each market should show now.' },
    { id: 'retry', label: 'Retry', input: 'none', hint: 'Sends a failed push again.' },
  ],
  stockSource: [
    { id: 'sources', label: 'Set to', input: 'locations', inputLabel: 'Warehouses', hint: 'Ticked warehouses sell, the top one first. The market shows their sum.' },
    { id: 'default', label: 'Use the default', input: 'none', hint: 'Each market sells from its usual warehouses again (set in Settings).' },
  ],
  casePack: [
    { id: 'open', label: 'Open', input: 'handoff', inputLabel: 'Open case sizes…', hint: 'Case sizes have their own editor. It opens for these variants.' },
  ],
  stockPool: [
    { id: 'open', label: 'Open', input: 'handoff', inputLabel: 'Open stock source…', hint: 'Stock source has its own editor. It opens for these variants.' },
  ],
}

const FIELDS: ReadonlyArray<Omit<BulkFieldSpec, 'modes' | 'held'>> = [
  { id: 'basePrice', label: 'Base price', description: 'The price every market uses by default', group: 'Prices', perMarket: false },
  { id: 'price', label: 'Market price', description: 'Its own price on chosen markets', group: 'Prices', perMarket: true },
  { id: 'salePrice', label: 'Sale', description: 'A lower price between two dates', group: 'Prices', perMarket: true },
  { id: 'listingStatus', label: 'Status', description: 'For sale (Active), paused or ended', group: 'Listing', perMarket: true },
  { id: 'fulfilment', label: 'Fulfilment', description: 'Who ships: Amazon (FBA) or you (FBM)', group: 'Listing', perMarket: true },
  { id: 'quantity', label: 'Quantity', description: 'How many units a market shows', group: 'Stock', perMarket: true },
  { id: 'buffer', label: 'Buffer', description: 'Units held back to avoid overselling', group: 'Stock', perMarket: true },
  { id: 'stockSync', label: 'Stock sync', description: 'Hold, release or resend stock updates', group: 'Stock', perMarket: true },
  { id: 'stockSource', label: 'Sells from', description: 'The warehouses a market sells from', group: 'Stock', perMarket: true },
  { id: 'casePack', label: 'Case size', description: 'Units per case, for Amazon shipments', group: 'Stock', perMarket: false },
  { id: 'stockPool', label: 'Stock source', description: 'Your own stock, or a partner\'s', group: 'Stock', perMarket: false },
]

/** The fields that open their own dialog on the same rows (`BulkEditSource.openElsewhere`). */
export type BulkHandoffField = Extract<BulkFieldId, 'casePack' | 'stockPool'>
export const isHandoffField = (field: BulkFieldId): field is BulkHandoffField => field === 'casePack' || field === 'stockPool'

/** The Matrix cell a per-market field lives in: a market offers the field when its group serves that cell. */
const CELL_OF: Partial<Record<BulkFieldId, MatrixCellKind>> = {
  price: 'price', salePrice: 'salePrice', fulfilment: 'fulfilment', quantity: 'syncMode', buffer: 'syncBuffer', stockSync: 'syncState',
  // Sells from: once per group that carries the quantity (Amazon EU's region group, not its markets).
  stockSource: 'syncQty',
}
const PRICE_FIELDS: readonly BulkFieldId[] = ['basePrice', 'price', 'salePrice']
/** What a market without the field has none of, for `bulkMarketsNote`. */
const FIELD_NOUN: Partial<Record<BulkFieldId, string>> = {
  price: 'price', salePrice: 'sale price', listingStatus: 'Status', fulfilment: 'fulfilment method',
  quantity: 'stock', buffer: 'stock', stockSync: 'stock', stockSource: 'stock',
}
/** The fields that live on a market's listing columns (never on a region's inventory group). */
const LISTING_FIELDS: readonly BulkFieldId[] = ['price', 'salePrice', 'listingStatus']

export function bulkModes(field: BulkFieldId): readonly BulkModeSpec[] { return MODES[field] }
export function bulkMode(field: BulkFieldId, mode: BulkModeId): BulkModeSpec | null { return MODES[field].find((m) => m.id === mode) ?? null }

/** The field a Matrix cell kind belongs to — the toolbar's Edit… opens on the column the operator was in. */
export function bulkFieldOfKind(kind: MatrixCellKind): BulkFieldId | null {
  switch (kind) {
    case 'price': return 'price'
    case 'salePrice': return 'salePrice'
    case 'fulfilment': return 'fulfilment'
    case 'syncMode': case 'syncQty': return 'quantity'
    case 'syncBuffer': return 'buffer'
    case 'syncState': return 'stockSync'
    default: return null
  }
}

/* ── the context ──────────────────────────────────────────────────────────────────────────── */

export interface BulkRow {
  id: string
  sku: string
  /** The variant's short name, as the grid's Product cell says it under the SKU (`Nero · S`); null = none. */
  name: string | null
  isParent: boolean
  basePrice: number | null
}

export interface BulkContext {
  /** The rows the dialog opened on (the ticked rows, or one row), in the grid's order. */
  rows: readonly BulkRow[]
  /** The markets on screen (the scope bar's filter), in the read's order. */
  coordinates: readonly MatrixCoordinate[]
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  /** A row's Status cell on a market (the publish actions); null = none read for it. */
  statusCellOf: (rowId: string, coordinate: MatrixCoordinate) => PublishActionCell | null
  /** `products.edit`: every write but a market's Status (the publish actions) needs it. */
  canEdit: boolean
  /** `products.edit` + `products.price.edit`: the server refuses every price write without both. */
  canPrice: boolean
  /** Why the markets' Status cannot be set here now (not read, read failed, the role cannot publish), or null. */
  statusHeld: string | null
  /** May the viewer end listings (`products.delete`)? */
  canDelete: boolean
  /** The market group the operator was in (the focused cell), or null. */
  focusedKey: CoordinateKey | null
  /** The business's warehouses (`MatrixRead.locations`) — Sells from; absent = an older server. */
  locations?: readonly MatrixLocation[]
  /** May the viewer change where stock sells from (`inventory.adjust`)? Absent = allowed (the server's preview refuses per row). */
  canStock?: boolean
  /** A row as the Matrix read holds it (its role, its stock) — the From words and the Stock source line; null = not read. */
  rowOf?: (rowId: string) => Pick<MatrixRowRead, 'role' | 'stock'> | null
  /** The Case cell's words for a row (`12 / case`, `Mixed`; '' = none); absent = the page reads no case sizes. */
  caseTextOf?: (rowId: string) => string
  /** The hand-offs: why each cannot open for these rows now (null = it can). A field missing here is not offered. */
  handoffHeld?: Partial<Record<BulkHandoffField, string | null>>
}

const variants = (ctx: BulkContext) => ctx.rows.filter((r) => !r.isParent)
const servesField = (field: BulkFieldId, c: MatrixCoordinate): boolean => {
  if (!c.connected) return false
  if (field === 'listingStatus') return c.cells.includes('listing')
  const cell = CELL_OF[field]
  return !!cell && c.cells.includes(cell)
}
/** Does this row have something to change for the field on this market? */
function rowOn(ctx: BulkContext, field: BulkFieldId, rowId: string, c: MatrixCoordinate): boolean {
  // Status changes a listing that is ON the market; a row not on it yet is created from its own Status cell, on purpose.
  if (field === 'listingStatus') { const cell = ctx.statusCellOf(rowId, c); return !!cell && !cell.create }
  const cells = ctx.cellsOf(rowId, c.key)
  if (!cells) return false
  if (field === 'price') return !!cells.price
  if (field === 'salePrice') return !!cells.price || !!cells.sale
  if (field === 'fulfilment') return !!cells.fulfilment
  if (field === 'stockSource') return !!cells.source
  return !!cells.sync
}
const chosenOf = (ctx: Pick<BulkContext, 'coordinates'>, keys: readonly CoordinateKey[]) => ctx.coordinates.filter((c) => keys.includes(c.key))
/** `eBay · IT` → `eBay IT` — a market named inside a sentence. */
const marketWords = (c: Pick<MatrixCoordinate, 'label'>) => c.label.replace(/ · /g, ' ')
const lineOf = (r: BulkRow, id: string, where: string, now: string) => ({ id, rowId: r.id, sku: r.sku, name: r.name, where, now })

/** The fields, every one listed; one this selection cannot take carries the reason. */
export function bulkFields(ctx: BulkContext): BulkFieldSpec[] {
  const parentOnly = ctx.rows.length > 0 && variants(ctx).length === 0
  return FIELDS.map((f) => {
    let held: string | null = null
    if (isHandoffField(f.id)) held = ctx.handoffHeld?.[f.id] === undefined ? BULK_NO_HANDOFF : ctx.handoffHeld[f.id] ?? null
    else if (f.id !== 'listingStatus' && !ctx.canEdit) held = BULK_EDIT_PERMISSION
    else if (PRICE_FIELDS.includes(f.id) && !ctx.canPrice) held = BULK_PRICE_PERMISSION
    else if (f.id === 'listingStatus' && ctx.statusHeld) held = ctx.statusHeld
    else if (f.id === 'stockSource' && ctx.canStock === false) held = MATRIX_COPY.sourcePermission
    else if (f.id === 'stockSource' && activeWarehouses(ctx.locations).length === 0) held = BULK_NO_WAREHOUSE
    else if (f.perMarket && parentOnly && f.id !== 'listingStatus') held = BULK_PARENT_ONLY
    else if (f.perMarket) {
      const markets = bulkMarkets(ctx, f.id)
      const what = f.id === 'listingStatus' ? 'a Status' : f.label
      if (markets.length === 0) held = `No market on screen has ${what}`
      else if (markets.every((m) => m.held)) held = `None of these rows has ${what} on a market shown`
    }
    return { ...f, modes: MODES[f.id], held }
  })
}

/** The markets that serve the field; one that none of the rows is on is shown, held. */
export function bulkMarkets(ctx: BulkContext, field: BulkFieldId): BulkMarketOption[] {
  const spec = FIELDS.find((f) => f.id === field)
  if (!spec?.perMarket) return []
  return ctx.coordinates.filter((c) => servesField(field, c)).map((c) => ({
    key: c.key,
    label: c.label,
    held: ctx.rows.some((r) => rowOn(ctx, field, r.id, c)) ? null : 'None of these rows is on this market',
  }))
}

/**
 * The markets on screen that do not take the field at all, said once: `Not on eBay IT · Etsy: no sale price there`. A
 * market whose inventory another group carries (Amazon IT under Amazon EU) is not one of them for a stock field, nor a
 * region's inventory group for a listing field; a market with no listing (`Not listed`) neither. Null = none.
 */
export function bulkMarketsNote(ctx: BulkContext, field: BulkFieldId): string | null {
  const noun = FIELD_NOUN[field]
  if (!noun) return null
  const listing = LISTING_FIELDS.includes(field)
  const missing = ctx.coordinates.filter((c) => c.connected && c.cells.length > 0 && !servesField(field, c) && (listing ? c.kind !== 'region-inventory' : !c.inventoryOn))
  return missing.length ? `Not on ${missing.map(marketWords).join(' · ')}: no ${noun} there` : null
}

/**
 * The focused market when it serves the field, else every market the rows are on — for Fulfilment, every AMAZON market:
 * FBA / FBM is Amazon's choice, and an eBay market (FBM / MCF) is ticked only on purpose.
 */
export function bulkDefaultMarkets(ctx: BulkContext, field: BulkFieldId): CoordinateKey[] {
  const open = bulkMarkets(ctx, field).filter((m) => !m.held)
  const focused = ctx.focusedKey ? open.find((m) => m.key === ctx.focusedKey) : undefined
  if (focused) return [focused.key]
  if (field === 'fulfilment') {
    const amazon = open.filter((m) => ctx.coordinates.find((c) => c.key === m.key)?.channel === 'AMAZON')
    if (amazon.length > 0) return amazon.map((m) => m.key)
  }
  return open.map((m) => m.key)
}

/** The cells of the ticked variants on these markets where they have the field, in row then market order. */
function targetCells(ctx: BulkContext, field: BulkFieldId, keys: readonly CoordinateKey[]): MatrixCells[] {
  const chosen = chosenOf(ctx, keys)
  return variants(ctx).flatMap((r) => chosen.filter((c) => rowOn(ctx, field, r.id, c)).map((c) => ctx.cellsOf(r.id, c.key)!).filter(Boolean))
}

/**
 * The mode most likely to change something: Quantity → Fixed number when every listing already follows its stock, else
 * Follow stock; Stock sync → Retry when a push failed, Release when a sync is held, else Hold. Null = the first mode.
 */
export function bulkDefaultMode(ctx: BulkContext, field: BulkFieldId, keys: readonly CoordinateKey[]): BulkModeId | null {
  if (field === 'quantity') {
    const syncs = targetCells(ctx, field, keys).map((c) => c.sync!).filter((s) => s.kind !== 'FBA_EXCLUDED' && s.kind !== 'CLOSED')
    if (syncs.length === 0) return null
    return syncs.every((s) => s.mode === 'FOLLOW') ? 'pin' : 'follow'
  }
  if (field === 'stockSync') {
    const cells = targetCells(ctx, field, keys)
    if (cells.length === 0) return null
    if (cells.some((c) => c.queue?.state === 'failed' || c.queue?.state === 'dead')) return 'retry'
    if (cells.some((c) => c.queue?.state === 'paused' || c.sync?.kind === 'PAUSED')) return 'release'
    return 'hold'
  }
  return null
}

/* ── the rows as they are now ─────────────────────────────────────────────────────────────── */

const STATUS_READ = { loaded: true, failed: false, lockedReason: null } as const

/** The price cell's own mark, as its tooltip says it: `Follows the base price` · `Set here` · `Formula =…`. */
export function priceMark(price: MatrixCells['price']): string | null {
  if (!price) return null
  if (price.source === 'master') return BULK_FOLLOWS_BASE
  if (price.source === 'formula') return MATRIX_COPY.formula(price.formula ?? '').trim()
  return MATRIX_COPY.setHere
}

/** The Quantity line: the Mode word and the Qty word (`Follow · 6`, `Pinned · 5`); one word when there is no mode. */
export function quantityWords(cells: MatrixCells | null | undefined): string {
  const mode = matrixModeWord(cells?.sync)
  const qty = matrixQtyText(cells, MATRIX_COPY)
  return mode === MATRIX_DASH ? qty : `${mode} · ${qty}`
}

/** The Stock source line: `Own stock`, or `Shared · <lender>` (the grid's Stock cell wears a `Shared` pill). */
export const stockPoolWords = (row: Pick<MatrixRowRead, 'stock'>): string =>
  row.stock.source ? `Shared · ${row.stock.source.lenderName}` : BULK_OWN_STOCK

/** What one row's field says on one market now, in the grid's words, and its mark. */
function nowOn(ctx: BulkContext, field: BulkFieldId, r: BulkRow, c: MatrixCoordinate): { now: string; note: string | null } {
  if (field === 'listingStatus') {
    const cell = ctx.statusCellOf(r.id, c)
    return { now: statusCellText(statusCellValue(cell, STATUS_READ)) || MATRIX_DASH, note: cell?.status.target ? 'Waits for Publish' : null }
  }
  const cells = ctx.cellsOf(r.id, c.key)
  switch (field) {
    case 'price': return { now: matrixCellText('price', cells, c, MATRIX_COPY), note: priceMark(cells?.price ?? null) }
    case 'salePrice': return { now: matrixCellText('salePrice', cells, c, MATRIX_COPY), note: null }
    case 'fulfilment': return { now: matrixCellText('fulfilment', cells, c, MATRIX_COPY), note: null }
    case 'quantity': return { now: quantityWords(cells), note: null }
    case 'buffer': return { now: matrixCellText('syncBuffer', cells, c, MATRIX_COPY), note: null }
    case 'stockSync': return { now: matrixCellText('syncState', cells, c, MATRIX_COPY), note: null }
    case 'stockSource': {
      const row = ctx.rowOf?.(r.id) ?? { role: r.isParent ? 'parent' as const : 'variant' as const, stock: { available: null, uncounted: false, locations: [] } }
      return { now: fromCellText(row, cells, c) ?? MATRIX_DASH, note: null }
    }
    default: return { now: MATRIX_DASH, note: null }
  }
}

/**
 * The rows as they are NOW for a field on these markets: one line per row (and market) in the grid's own words, rows in
 * the grid's order, then markets in the read's order. A row not on a chosen market has no line. Base price, Case size and
 * Stock source are one line per row in the Shared group.
 */
export function bulkCurrent(ctx: BulkContext, field: BulkFieldId, keys: readonly CoordinateKey[]): BulkLine[] {
  const shared = (r: BulkRow, now: string): BulkLine => ({ ...lineOf(r, `${field}|now|${r.id}|shared`, BULK_SHARED, now), next: null, note: null, skipped: null })
  if (field === 'basePrice') {
    const currency = bulkCurrency(ctx, field, [])
    return ctx.rows.map((r) => shared(r, matrixMoney(r.basePrice, currency)))
  }
  if (field === 'casePack') return ctx.caseTextOf ? ctx.rows.map((r) => shared(r, ctx.caseTextOf!(r.id) || MATRIX_DASH)) : []
  if (field === 'stockPool') return ctx.rowOf ? ctx.rows.flatMap((r) => { const m = ctx.rowOf!(r.id); return m ? [shared(r, stockPoolWords(m))] : [] }) : []
  const chosen = chosenOf(ctx, keys)
  const out: BulkLine[] = []
  for (const r of ctx.rows) {
    if (r.isParent && field !== 'listingStatus') continue
    for (const c of chosen) {
      if (!rowOn(ctx, field, r.id, c)) continue
      const { now, note } = nowOn(ctx, field, r, c)
      out.push({ ...lineOf(r, `${field}|now|${r.id}|${c.key}`, c.label, now), next: null, note, skipped: null })
    }
  }
  return out
}

/* ── choices and currency ─────────────────────────────────────────────────────────────────── */

const STATUS_ORDER: readonly StatusTarget[] = ['active', 'inactive', 'ended', 'not_listed']

/** The choices of a `choice` mode on these markets. */
export function bulkChoices(ctx: BulkContext, field: BulkFieldId, mode: BulkModeId, keys: readonly CoordinateKey[]): BulkChoiceOption[] {
  const chosen = chosenOf(ctx, keys)
  if (field === 'price' && mode === 'copy') {
    // EVERY market on screen where these rows have a price — the ticked ones too: the one chosen is left out of the targets.
    return ctx.coordinates
      .filter((c) => c.connected && c.cells.includes('price') && variants(ctx).some((r) => !!ctx.cellsOf(r.id, c.key)?.price))
      .map((c) => ({ value: c.key, label: c.label }))
  }
  if (field === 'fulfilment') {
    const seen = new Set<string>()
    for (const c of chosen) for (const m of c.vocabulary.fulfilment ?? []) seen.add(m)
    return (['FBA', 'FBM', 'MCF'] as const).filter((m) => seen.has(m)).map((m) => ({
      value: m, label: m,
      title: m === 'FBA' ? 'Fulfilled by Amazon — Amazon ships from its stock' : m === 'FBM' ? 'Fulfilled by you — Nexus sends your stock' : 'Multi-Channel Fulfilment — Amazon ships an eBay order',
    }))
  }
  if (field === 'listingStatus') {
    const offered = new Set<StatusTarget>()
    for (const c of chosen) for (const r of ctx.rows) {
      const cell = ctx.statusCellOf(r.id, c)
      if (!cell || cell.create) continue
      for (const o of cell.statusOptions) if (o.offered) offered.add(o.target)
    }
    return STATUS_ORDER.filter((t) => offered.has(t)).map((t) => ({ value: t, label: STATUS_TARGET_WORD[t] }))
  }
  return []
}

/** The currency a money input is in: the markets' own when they agree, else the first; EUR when none is chosen. */
export function bulkCurrency(ctx: BulkContext, field: BulkFieldId, keys: readonly CoordinateKey[]): string {
  if (field === 'basePrice') {
    const amazon = ctx.coordinates.find((c) => c.connected && c.cells.includes('price'))
    return amazon?.currency ?? 'EUR'
  }
  const chosen = chosenOf(ctx, keys)
  return chosen[0]?.currency ?? 'EUR'
}

/* ── the verbs ────────────────────────────────────────────────────────────────────────────── */

/** Raise is up, Lower is down — whatever sign the number came with. */
const signed = (mode: BulkModeId, n: number) => (mode === 'lower' ? -Math.abs(n) : Math.abs(n))

/**
 * The Matrix verb behind a field and mode, with its parameter; null = this field and mode is not a verb (Market price
 * "Use base price" is cell writes), or the input is missing. `currency` = the chosen markets' (`bulkCurrency`), for a
 * Raise / Lower by an amount.
 */
export function verbParams(field: BulkFieldId, mode: BulkModeId, input: BulkInput, currency = 'EUR'): MatrixVerbParams | null {
  switch (field) {
    case 'price':
      if (mode === 'set') return input.amount != null ? { verb: 'set-price', value: input.amount } : null
      if (mode === 'raise' || mode === 'lower') {
        if (input.percent != null) return { verb: 'adjust-prices', percent: signed(mode, input.percent) }
        if (input.delta != null) return { verb: 'adjust-prices', amount: signed(mode, input.delta), currency }
        return null
      }
      if (mode === 'copy') return input.choice ? { verb: 'copy-prices', fromCoordinateKey: input.choice } : null
      return null
    case 'fulfilment':
      return input.choice === 'FBA' || input.choice === 'FBM' || input.choice === 'MCF' ? { verb: 'set-fulfilment', method: input.choice } : null
    case 'quantity':
      if (mode === 'follow') return { verb: 'set-follow' }
      return input.amount != null ? { verb: 'pin-quantity', value: input.amount } : null
    case 'buffer':
      return input.amount != null ? { verb: 'set-buffer', value: input.amount } : null
    case 'stockSync':
      return mode === 'hold' ? { verb: 'pause-sync' } : mode === 'release' ? { verb: 'resume-sync' } : mode === 'push' ? { verb: 'push-now' } : mode === 'retry' ? { verb: 'retry-sync' } : null
    case 'stockSource':
      // `[]` = the market default again (the shared normaliser stores a choice equal to the default as `[]` too).
      if (mode === 'default') return { verb: 'set-source', codes: [] }
      return mode === 'sources' && input.codes?.length ? { verb: 'set-source', codes: [...input.codes] } : null
    default:
      return null
  }
}

/** Every ticked row on every chosen market where it has the field; `exclude` = a market left out (Copy from: the source). */
export function verbTargets(ctx: BulkContext, field: BulkFieldId, keys: readonly CoordinateKey[], exclude?: CoordinateKey | null): MatrixVerbTarget[] {
  const chosen = chosenOf(ctx, keys).filter((c) => c.key !== exclude)
  return variants(ctx).flatMap((r) => chosen.filter((c) => rowOn(ctx, field, r.id, c)).map((c) => ({ rowId: r.id, coordinateKey: c.key })))
}

/** A line id's own parts: the request's field and mode first, so two previews never share an id. */
const lineId = (field: BulkFieldId, mode: BulkModeId, ...parts: Array<string | number>) => [field, mode, ...parts].join('|')

/** A verb line's market and kind (`verbLines` ids are `field|mode|c|row|coordinate|cell|n` and `field|mode|r|row|coordinate|n`). */
export const coordinateOfVerbLine = (l: Pick<BulkLine, 'id'>): CoordinateKey => l.id.split('|')[4] ?? ''
export const isVerbChangeLine = (l: Pick<BulkLine, 'id'>): boolean => l.id.split('|')[2] === 'c'

/**
 * The server's preview as table lines — each change and each refusal (skipped, with its reason, its Now from the rows as
 * they are), in the grid's row order, then the markets' order.
 */
export function verbLines(
  preview: Pick<VerbPreview, 'changes' | 'refusals'>,
  ctx: Pick<BulkContext, 'rows' | 'coordinates'>,
  request: { field: BulkFieldId; mode: BulkModeId },
  nowOf: (rowId: string, key: CoordinateKey) => string | null = () => null,
): BulkLine[] {
  const labelOf = (key: CoordinateKey) => ctx.coordinates.find((c) => c.key === key)?.label ?? key
  const nameOf = (rowId: string) => ctx.rows.find((r) => r.id === rowId)?.name ?? null
  const changes = preview.changes.map((c, i): BulkLine => ({
    id: lineId(request.field, request.mode, 'c', c.rowId, c.coordinateKey, c.cell, i), rowId: c.rowId, sku: c.sku, name: nameOf(c.rowId),
    where: labelOf(c.coordinateKey), now: c.fromLabel, next: c.toLabel, note: c.note ?? null, skipped: null,
  }))
  const refusals = preview.refusals.map((r, i): BulkLine => ({
    id: lineId(request.field, request.mode, 'r', r.rowId, r.coordinateKey, i), rowId: r.rowId, sku: r.sku, name: nameOf(r.rowId),
    where: labelOf(r.coordinateKey), now: nowOf(r.rowId, r.coordinateKey) ?? MATRIX_DASH, next: null, note: null, skipped: r.reason,
  }))
  const rowAt = new Map(ctx.rows.map((r, i) => [r.id, i]))
  const coordAt = new Map(ctx.coordinates.map((c, i) => [c.key, i]))
  const rank = (l: BulkLine) => [rowAt.get(l.rowId) ?? Number.MAX_SAFE_INTEGER, coordAt.get(coordinateOfVerbLine(l)) ?? Number.MAX_SAFE_INTEGER] as const
  return [...changes, ...refusals].map((l, i) => ({ l, i })).sort((a, b) => {
    const [ra, ca] = rank(a.l), [rb, cb] = rank(b.l)
    return ra - rb || ca - cb || a.i - b.i
  }).map(({ l }) => l)
}

/**
 * The notices a verb's preview carries: the server's facts (info), and for a fulfilment change its sentences as warnings
 * (an Amazon conversion is a risk to read). Holding the sync adds what else it holds (a warning).
 */
export function verbNotices(preview: Pick<VerbPreview, 'verb' | 'notices'>): BulkNotice[] {
  // Facts stay info on every verb: Amazon EU's one quantity, and a preview that sends nothing.
  const fact = (text: string) => text.startsWith(MATRIX_COPY.euNotice([]).trim()) || text === MATRIX_COPY.simulated
  const server = preview.notices.map((text): BulkNotice => ({ text, tone: preview.verb === 'set-fulfilment' && !fact(text) ? 'warning' : 'info' }))
  if (preview.verb === 'pause-sync') return [...server, { text: BULK_HOLD_NOTICE, tone: 'warning' }]
  if (preview.verb === 'set-price' || preview.verb === 'adjust-prices' || preview.verb === 'copy-prices') return [...server, { text: BULK_SENT.prices, tone: 'info' }]
  return server
}

/** Channels whose price sender sends no sale price (the server's promotion scheduler says the same). */
const SALE_NOT_SENT: Readonly<Record<string, string>> = { SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce' }

/** The Sale's notices, by the channels of the markets chosen — never a sentence about a channel that is not among them. */
export function saleNotices(ctx: Pick<BulkContext, 'coordinates'>, mode: BulkModeId, keys: readonly CoordinateKey[]): BulkNotice[] {
  const chosen = chosenOf(ctx, keys)
  const out: BulkNotice[] = []
  if (chosen.some((c) => c.channel === 'AMAZON')) out.push({ text: mode === 'sale-remove' ? BULK_SENT.amazonSaleEnd : BULK_SENT.amazonSale, tone: 'info' })
  const notSent = [...new Set(chosen.map((c) => SALE_NOT_SENT[c.channel]).filter((n): n is string => !!n))]
  if (notSent.length) out.push({ text: `Nexus does not send a sale price to ${notSent.join(' or ')}: there the sale stays in Nexus only.`, tone: 'warning' })
  return out
}

/* ── the lines the page works out itself ──────────────────────────────────────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100

/** The type-to-confirm word a large change asks for — the verbs' own rule (100 changes, or −30 % or more). */
export function largeChangeWord(changes: number, percent?: number): string | null {
  return changes >= 100 || (percent != null && percent <= -30) ? 'APPLY' : null
}

/** Does any changing line drop by 30 % or more? (The large-change rule, for a change the page works out itself.) */
export function dropsBy30(lines: ReadonlyArray<{ skipped: string | null; value: number | null; before: number | null }>): boolean {
  return lines.some((l) => l.skipped === null && l.value != null && l.before != null && l.before > 0 && l.value <= l.before * 0.7 + 0.005)
}

export type BasePriceLine = BulkLine & { value: number | null; before: number | null }

/** Base price: one line per row in the Shared group (every market that follows it moves with it). */
export function basePriceLines(ctx: BulkContext, mode: BulkModeId, input: BulkInput, currency: string): BasePriceLine[] {
  return ctx.rows.map((r) => {
    const now = matrixMoney(r.basePrice, currency)
    const base = { ...lineOf(r, lineId('basePrice', mode, 'b', r.id), BULK_SHARED, now), note: null, before: r.basePrice }
    const skip = (why: string): BasePriceLine => ({ ...base, next: null, skipped: why, value: null })
    let next: number | null = null
    if (mode === 'set') next = input.amount ?? null
    else if (mode === 'raise' || mode === 'lower') {
      if (r.basePrice == null) return skip(BULK_NO_BASE_PRICE)
      if (input.percent != null) next = round2(r.basePrice * (1 + signed(mode, input.percent) / 100))
      else if (input.delta != null) next = round2(r.basePrice + signed(mode, input.delta))
    }
    if (next == null) return skip('No new value')
    if (next <= 0) return skip(BULK_PRICE_ABOVE_0)
    if (r.basePrice != null && round2(r.basePrice) === round2(next)) return skip(BULK_SAME(now))
    return { ...base, next: matrixMoney(next, currency), skipped: null, value: next }
  })
}

export interface FollowBaseLine extends BulkLine {
  coordinateKey: CoordinateKey
  /** The coordinate's cells as previewed — what Undo puts back (`matrixReplay`). */
  before: MatrixCells
}

/**
 * Market price "Use base price": one line per row and market with a price. A price that already follows the base price,
 * or that a formula sets, is skipped; a cell that cannot be written says its own reason.
 */
export function followBaseLines(ctx: BulkContext, keys: readonly CoordinateKey[]): FollowBaseLine[] {
  const out: FollowBaseLine[] = []
  for (const r of variants(ctx)) for (const c of chosenOf(ctx, keys)) {
    const cells = ctx.cellsOf(r.id, c.key)
    if (!cells?.price) continue
    const line = { ...lineOf(r, lineId('price', 'follow-base', 'f', r.id, c.key), c.label, matrixCellText('price', cells, c, MATRIX_COPY)), note: null, coordinateKey: c.key, before: JSON.parse(JSON.stringify(cells)) as MatrixCells }
    const skip = (why: string) => out.push({ ...line, next: null, skipped: why })
    if (cells.price.source === 'master') skip(BULK_ALREADY_FOLLOWS)
    else if (cells.price.source === 'formula') skip(BULK_FORMULA_PRICE)
    else if (cells.writable.price !== true) skip(cells.writeBlockedReason.price ?? 'The price cannot be changed on this market')
    else out.push({ ...line, next: BULK_FOLLOWS_BASE, skipped: null })
  }
  return out
}

type SaleValue = { value: number | null; start: string | null; end: string | null }
export interface SaleLine extends BulkLine { coordinateKey: CoordinateKey; value: SaleValue; before: SaleValue }

const isoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')

/** Sale: one line per row and market, in the grid's words (`—`, `€89.00 · 12 Sep → 30 Sep`). The cell's own lock says why a line is skipped. */
export function saleLines(ctx: BulkContext, mode: BulkModeId, input: BulkInput, keys: readonly CoordinateKey[]): SaleLine[] {
  const out: SaleLine[] = []
  for (const r of variants(ctx)) for (const c of chosenOf(ctx, keys)) {
    const cells = ctx.cellsOf(r.id, c.key)
    if (!cells || (!cells.price && !cells.sale)) continue
    const currency = cells.price?.currency || c.currency
    const before = { value: cells.sale?.value ?? null, start: cells.sale?.start ?? null, end: cells.sale?.end ?? null }
    const value = mode === 'sale-set' && input.sale ? { value: input.sale.value, start: input.sale.start, end: input.sale.end } : { value: null, start: null, end: null }
    const now = matrixSaleText(before, currency)
    const line = { ...lineOf(r, lineId('salePrice', mode, 's', r.id, c.key), c.label, now), note: null, coordinateKey: c.key, value, before }
    const skip = (why: string) => out.push({ ...line, next: null, skipped: why })
    if (cells.writable.salePrice !== true) { skip(cells.writeBlockedReason.salePrice ?? 'The sale cannot be changed on this market'); continue }
    if (mode === 'sale-set' && !input.sale) { skip('No sale entered'); continue }
    if (mode === 'sale-remove' && before.value == null) { skip('No sale to remove'); continue }
    const price = cells.price?.value ?? null
    if (mode === 'sale-set' && price != null && input.sale && input.sale.value >= price) { skip(`The sale price must be below the price (${matrixMoney(price, currency)})`); continue }
    if (before.value === value.value && isoDay(before.start) === isoDay(value.start) && isoDay(before.end) === isoDay(value.end)) { skip(BULK_SAME(now)); continue }
    out.push({ ...line, next: matrixSaleText(value, currency), skipped: null })
  }
  return out
}

export interface StatusLine extends BulkLine { coordinateKey: CoordinateKey; target: StatusTarget; before: StatusTarget | null }

/** What a Status cell holds for the bulk: its own new-listing choice, the waiting target, else its live state's target — in the grid's word. */
export function statusNow(cell: PublishActionCell): { target: StatusTarget | null; word: string } {
  const word = statusCellText(statusCellValue(cell, STATUS_READ)) || MATRIX_DASH
  if (cell.create) return { target: cell.create.target, word }
  if (cell.status.target) return { target: cell.status.target, word }
  const live = cell.state === 'active' ? 'active' : cell.state === 'paused' ? 'inactive' : cell.state === 'ended' ? 'ended' : null
  return { target: live, word }
}

/** The markets' Status: one line per row and market with a Status cell. A choice the cell does not offer is skipped with its reason. */
export function statusLines(ctx: BulkContext, target: StatusTarget, keys: readonly CoordinateKey[]): StatusLine[] {
  const out: StatusLine[] = []
  for (const r of ctx.rows) for (const c of chosenOf(ctx, keys)) {
    const cell = ctx.statusCellOf(r.id, c)
    if (!cell) continue
    const now = statusNow(cell)
    const before = cell.create ? (cell.create.source === 'own' ? cell.status.target : null) : cell.status.target
    const line = { ...lineOf(r, lineId('listingStatus', 'status', 't', r.id, c.key), c.label, now.word), coordinateKey: c.key, target, before }
    const skip = (why: string) => out.push({ ...line, next: null, note: null, skipped: why })
    const option = cell.statusOptions.find((o) => o.target === target)
    if (cell.create) { skip(BULK_STATUS_NEW_ROW); continue }
    if (now.target === target) { skip(BULK_SAME(STATUS_TARGET_WORD[target])); continue }
    if (!option || !option.offered) { skip(option?.reason ?? `${STATUS_TARGET_WORD[target]} is not offered here`); continue }
    if (target === 'ended' && !ctx.canDelete) { skip('Your role cannot end or delete listings'); continue }
    out.push({ ...line, next: STATUS_TARGET_WORD[target], note: option.warning ?? 'Waits for Publish', skipped: null })
  }
  return out
}

/* ── hand-offs ────────────────────────────────────────────────────────────────────────────── */

/** Why the Case size hand-off cannot open for these rows, or null. `packsRead` = every member's case sizes were read. */
export function caseHandoffHeld(s: { canStock: boolean; onAmazon: boolean; members: number; packsRead: boolean }): string | null {
  if (!s.canStock) return BULK_CASE_PERMISSION
  if (!s.onAmazon) return BULK_CASE_NOT_AMAZON
  if (s.members === 0) return BULK_CASE_NO_VARIANT
  if (!s.packsRead) return BULK_CASE_NOT_READ
  return null
}

/* ── counting and words ───────────────────────────────────────────────────────────────────── */

/** The table's count of each kind. */
export function countLines(lines: readonly BulkLine[]): { changes: number; skipped: number } {
  const changes = lines.filter((l) => l.skipped === null).length
  return { changes, skipped: lines.length - changes }
}

/** `10 prices`, `1 status` — the noun a result sentence counts, per field. */
export function bulkNoun(field: BulkFieldId, n: number): string {
  const one: Record<BulkFieldId, [string, string]> = {
    basePrice: ['base price', 'base prices'], price: ['price', 'prices'], salePrice: ['sale', 'sales'], listingStatus: ['status', 'statuses'],
    fulfilment: ['fulfilment method', 'fulfilment methods'], quantity: ['quantity', 'quantities'], buffer: ['buffer', 'buffers'], stockSync: ['listing', 'listings'],
    stockSource: ['listing', 'listings'], casePack: ['case size', 'case sizes'], stockPool: ['SKU', 'SKUs'],
  }
  return `${n} ${one[field][n === 1 ? 0 : 1]}`
}
