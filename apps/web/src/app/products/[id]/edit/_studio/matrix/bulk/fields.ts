/**
 * The bulk Edit's FIELDS (Owner 2026-10-07) — pure: what the ticked rows may change, on which markets, to which values,
 * and the preview lines of the changes that need no server answer (Base price, Sale price, Status). The Matrix verbs'
 * own preview (Price, Fulfilment, Quantity, Buffer, Stock sync) is turned into the same lines by `verbLines`.
 *
 * Nothing here writes; `useBulkEdit.ts` owns the doors. Every number shown comes from the read (a cell, a row) or from
 * the server's preview — never from a guess here.
 */
import type { PublishActionCell } from '@nexus/shared/publish-actions'
import type { StatusTarget } from '@nexus/shared/listing-actions'

import { MATRIX_COPY, type CoordinateKey, type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixLocation, type MatrixVerbParams, type MatrixVerbTarget, type VerbPreview } from '../contract'
import { activeWarehouses } from '../sellsFrom'
import type { BulkChoiceOption, BulkFieldId, BulkFieldSpec, BulkInput, BulkLine, BulkMarketOption, BulkModeId, BulkModeSpec } from './types'

/* ── words ────────────────────────────────────────────────────────────────────────────────── */

export const BULK_PRICE_PERMISSION = 'You do not have permission to change prices'
export const BULK_PARENT_ONLY = 'The parent row has no listing of its own — tick its variants'
export const BULK_NOT_ON_MARKET = 'Not on this market'
export const BULK_SAME = (now: string) => `Already ${now}`
export const BULK_HOLD_NOTICE = 'Holding the stock sync also holds price and sale changes on these listings: they are kept in Nexus and sent when the stock sync is released.'
export const BULK_BASE_PRICE_NOTICE = 'Markets that follow the base price get the new price too. Nexus sends it about 30 seconds after saving.'
export const BULK_STATUS_NEW_ROW = 'Not on this market yet. Choose its Status in the grid to create the listing'
export const BULK_STATUS_NOTICE = 'Nothing is sent now. Publish sends each new status to its market.'
export const BULK_SALE_NOTICE = 'Amazon runs a sale between its two dates. Nexus sends it about 30 seconds after saving.'
export const BULK_NO_WAREHOUSE = 'No active warehouse to sell from'

const STATUS_WORD: Record<StatusTarget, string> = { active: 'Active', inactive: 'Inactive', ended: 'Ended', not_listed: 'Not listed' }
const STATUS_ORDER: readonly StatusTarget[] = ['active', 'inactive', 'ended', 'not_listed']

/* ── the catalogue ────────────────────────────────────────────────────────────────────────── */

const MODES: Record<BulkFieldId, readonly BulkModeSpec[]> = {
  basePrice: [
    { id: 'set', label: 'Set to', input: 'money', inputLabel: 'New base price', hint: 'The price every market follows unless it has a price of its own.' },
    { id: 'adjust', label: 'Change by %', input: 'percent', inputLabel: 'Change by', hint: 'Raises or lowers each base price by a percentage. −5 lowers it by 5 %.' },
  ],
  price: [
    { id: 'set', label: 'Set to', input: 'money', inputLabel: 'New price', hint: 'Gives each market a price of its own. Nexus sends it about 30 seconds after saving.' },
    { id: 'adjust', label: 'Change by %', input: 'percent', inputLabel: 'Change by', hint: 'Raises or lowers each market price by a percentage. −5 lowers it by 5 %.' },
    { id: 'copy', label: 'Copy from', input: 'choice', inputLabel: 'Copy from', hint: 'Each row takes the price it has on another market.' },
  ],
  salePrice: [
    { id: 'sale-set', label: 'Set a sale', input: 'sale', inputLabel: 'Sale price', hint: 'The market sells at the sale price between the two dates.' },
    { id: 'sale-remove', label: 'Remove the sale', input: 'none', hint: 'Removes the sale. The market goes back to its normal price.' },
  ],
  listingStatus: [
    { id: 'status', label: 'Set to', input: 'choice', inputLabel: 'New status', hint: 'Saved in Nexus now. Publish sends it to each market.' },
  ],
  fulfilment: [
    { id: 'method', label: 'Set to', input: 'choice', inputLabel: 'Method', hint: 'FBA: Amazon ships from its own stock. FBM: you ship, and Nexus sends your stock. On Amazon the offer itself is switched, and Amazon\'s report confirms it.' },
  ],
  quantity: [
    { id: 'follow', label: 'Follow stock', input: 'none', hint: 'The market shows your warehouse stock, less the buffer, and moves with it.' },
    { id: 'pin', label: 'Fixed number', input: 'integer', inputLabel: 'Quantity', hint: 'The market shows this number until you set Follow stock again.' },
  ],
  buffer: [
    { id: 'buffer', label: 'Set to', input: 'integer', inputLabel: 'Buffer', hint: 'Units kept back from the market when it follows your stock.' },
  ],
  stockSync: [
    { id: 'hold', label: 'Hold', input: 'none', hint: 'Stops quantity pushes to these markets until you release them.' },
    { id: 'release', label: 'Release', input: 'none', hint: 'Starts the pushes again and sends the quantity the market should show.' },
    { id: 'push', label: 'Push quantity now', input: 'none', hint: 'Sends the quantity the market should show now.' },
    { id: 'retry', label: 'Retry', input: 'none', hint: 'Sends a failed push again.' },
  ],
  stockSource: [
    { id: 'sources', label: 'Set to', input: 'locations', inputLabel: 'Warehouses', hint: 'Ticked warehouses sell, the top one first. Listings show the sum.' },
    { id: 'default', label: 'Use the default', input: 'none', hint: 'Each listing sells from its market\'s default again.' },
  ],
}

const FIELDS: ReadonlyArray<Omit<BulkFieldSpec, 'modes' | 'held'>> = [
  { id: 'basePrice', label: 'Base price', group: 'Prices', perMarket: false },
  { id: 'price', label: 'Price', group: 'Prices', perMarket: true },
  { id: 'salePrice', label: 'Sale price', group: 'Prices', perMarket: true },
  { id: 'listingStatus', label: 'Status', group: 'Listing', perMarket: true },
  { id: 'fulfilment', label: 'Fulfilment', group: 'Listing', perMarket: true },
  { id: 'quantity', label: 'Quantity', group: 'Stock', perMarket: true },
  { id: 'buffer', label: 'Buffer', group: 'Stock', perMarket: true },
  { id: 'stockSync', label: 'Stock sync', group: 'Stock', perMarket: true },
  { id: 'stockSource', label: 'Sells from', group: 'Stock', perMarket: true },
]

/** The Matrix cell a per-market field lives in: a market offers the field when its group serves that cell. */
const CELL_OF: Partial<Record<BulkFieldId, MatrixCellKind>> = {
  price: 'price', salePrice: 'salePrice', fulfilment: 'fulfilment', quantity: 'syncMode', buffer: 'syncBuffer', stockSync: 'syncState',
  // Sells from: once per group that carries the quantity (Amazon EU's region group, not its markets).
  stockSource: 'syncQty',
}
const PRICE_FIELDS: readonly BulkFieldId[] = ['basePrice', 'price', 'salePrice']

export function bulkModes(field: BulkFieldId): readonly BulkModeSpec[] { return MODES[field] }
export function bulkMode(field: BulkFieldId, mode: BulkModeId): BulkModeSpec | null { return MODES[field].find((m) => m.id === mode) ?? null }

/* ── the context ──────────────────────────────────────────────────────────────────────────── */

export interface BulkRow { id: string; sku: string; isParent: boolean; basePrice: number | null }

export interface BulkContext {
  /** The rows the dialog opened on (the ticked rows, or one row). */
  rows: readonly BulkRow[]
  /** The markets on screen (the scope bar's filter), in the read's order. */
  coordinates: readonly MatrixCoordinate[]
  cellsOf: (rowId: string, key: CoordinateKey) => MatrixCells | null
  /** A row's Status cell on a market (the publish actions); null = none read for it. */
  statusCellOf: (rowId: string, coordinate: MatrixCoordinate) => PublishActionCell | null
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

/** The fields, every one listed; one this selection cannot take carries the reason. */
export function bulkFields(ctx: BulkContext): BulkFieldSpec[] {
  const parentOnly = ctx.rows.length > 0 && variants(ctx).length === 0
  return FIELDS.map((f) => {
    let held: string | null = null
    if (PRICE_FIELDS.includes(f.id) && !ctx.canPrice) held = BULK_PRICE_PERMISSION
    else if (f.id === 'listingStatus' && ctx.statusHeld) held = ctx.statusHeld
    else if (f.id === 'stockSource' && ctx.canStock === false) held = MATRIX_COPY.sourcePermission
    else if (f.id === 'stockSource' && activeWarehouses(ctx.locations).length === 0) held = BULK_NO_WAREHOUSE
    else if (f.perMarket && parentOnly && f.id !== 'listingStatus') held = BULK_PARENT_ONLY
    else if (f.perMarket) {
      const markets = bulkMarkets(ctx, f.id)
      if (markets.length === 0) held = `No market on screen has ${f.id === 'listingStatus' ? 'a Status' : f.label}`
      else if (markets.every((m) => m.held)) held = `None of these rows has ${f.id === 'listingStatus' ? 'a Status' : f.label} on a market shown`
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

/** The choices of a `choice` mode on these markets. */
export function bulkChoices(ctx: BulkContext, field: BulkFieldId, mode: BulkModeId, keys: readonly CoordinateKey[]): BulkChoiceOption[] {
  const chosen = ctx.coordinates.filter((c) => keys.includes(c.key))
  if (field === 'price' && mode === 'copy') {
    return ctx.coordinates
      .filter((c) => c.connected && c.cells.includes('price') && !keys.includes(c.key))
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
    return STATUS_ORDER.filter((t) => offered.has(t)).map((t) => ({ value: t, label: STATUS_WORD[t] }))
  }
  return []
}

/** The currency a money input is in: the markets' own when they agree, else the first; EUR when none is chosen. */
export function bulkCurrency(ctx: BulkContext, field: BulkFieldId, keys: readonly CoordinateKey[]): string {
  if (field === 'basePrice') {
    const amazon = ctx.coordinates.find((c) => c.connected && c.cells.includes('price'))
    return amazon?.currency ?? 'EUR'
  }
  const chosen = ctx.coordinates.filter((c) => keys.includes(c.key))
  return chosen[0]?.currency ?? 'EUR'
}

/* ── the verbs ────────────────────────────────────────────────────────────────────────────── */

/** The Matrix verb behind a field and mode, with its parameter; null = this field is not a verb, or the input is missing. */
export function verbParams(field: BulkFieldId, mode: BulkModeId, input: BulkInput): MatrixVerbParams | null {
  switch (field) {
    case 'price':
      if (mode === 'set') return input.amount != null ? { verb: 'set-price', value: input.amount } : null
      if (mode === 'adjust') return input.percent != null ? { verb: 'adjust-prices', percent: input.percent } : null
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

/** Every ticked row on every chosen market where it has the field. */
export function verbTargets(ctx: BulkContext, field: BulkFieldId, keys: readonly CoordinateKey[]): MatrixVerbTarget[] {
  const chosen = ctx.coordinates.filter((c) => keys.includes(c.key))
  return ctx.rows.filter((r) => !r.isParent).flatMap((r) => chosen.filter((c) => rowOn(ctx, field, r.id, c)).map((c) => ({ rowId: r.id, coordinateKey: c.key })))
}

/** The server's preview as table lines: each change, then each refusal (skipped, with its reason). */
export function verbLines(preview: Pick<VerbPreview, 'changes' | 'refusals'>, labelOf: (key: CoordinateKey) => string): BulkLine[] {
  const changes = preview.changes.map((c, i): BulkLine => ({
    id: `c|${c.rowId}|${c.coordinateKey}|${c.cell}|${i}`, rowId: c.rowId, sku: c.sku, where: labelOf(c.coordinateKey),
    now: c.fromLabel, next: c.toLabel, note: c.note ?? null, skipped: null,
  }))
  const refusals = preview.refusals.map((r, i): BulkLine => ({
    id: `r|${r.rowId}|${r.coordinateKey}|${i}`, rowId: r.rowId, sku: r.sku, where: labelOf(r.coordinateKey),
    now: '', next: null, note: null, skipped: r.reason,
  }))
  return [...changes, ...refusals]
}

/**
 * The notices a verb's preview carries, plus the sentence the operator must read for this verb. A fulfilment change says
 * its own (the server's preview: what is sent to Amazon and where, Amazon EU's one quantity, eBay's Nexus-only method).
 */
export function verbNotices(preview: Pick<VerbPreview, 'verb' | 'notices'>): string[] {
  const own = preview.verb === 'pause-sync' ? [BULK_HOLD_NOTICE] : []
  return [...preview.notices, ...own]
}

/* ── the lines the page works out itself ──────────────────────────────────────────────────── */

export function money(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return '—'
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value) } catch { return `${value.toFixed(2)} ${currency}` }
}
const round2 = (n: number) => Math.round(n * 100) / 100

/** The type-to-confirm word a large change asks for — the verbs' own rule (100 changes, or −30 % or more). */
export function largeChangeWord(changes: number, percent?: number): string | null {
  return changes >= 100 || (percent != null && percent <= -30) ? 'APPLY' : null
}

/** Base price: one line per row (every market that follows it moves with it). */
export function basePriceLines(ctx: BulkContext, mode: BulkModeId, input: BulkInput, currency: string): Array<BulkLine & { value: number | null; before: number | null }> {
  return ctx.rows.map((r) => {
    const now = money(r.basePrice, currency)
    const base = { id: `b|${r.id}`, rowId: r.id, sku: r.sku, where: 'Every market', now, note: null }
    let next: number | null = null
    if (mode === 'set') next = input.amount ?? null
    else if (mode === 'adjust') {
      if (r.basePrice == null) return { ...base, next: null, skipped: 'No base price to change by a percentage', value: null, before: r.basePrice }
      next = input.percent != null ? round2(r.basePrice * (1 + input.percent / 100)) : null
    }
    if (next == null) return { ...base, next: null, skipped: 'No new value', value: null, before: r.basePrice }
    if (next <= 0) return { ...base, next: null, skipped: 'A price must be more than 0', value: null, before: r.basePrice }
    if (r.basePrice != null && round2(r.basePrice) === round2(next)) return { ...base, next: null, skipped: BULK_SAME(now), value: null, before: r.basePrice }
    return { ...base, next: money(next, currency), skipped: null, value: next, before: r.basePrice }
  })
}

const isoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')
const dayWord = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
export function saleText(sale: { value: number | null; start: string | null; end: string | null } | null | undefined, currency: string): string {
  if (!sale || sale.value == null) return 'No sale'
  const when = sale.start && sale.end ? ` · ${dayWord(sale.start)}–${dayWord(sale.end)}` : ''
  return `${money(sale.value, currency)}${when}`
}

export interface SaleLine extends BulkLine { coordinateKey: CoordinateKey; value: { value: number | null; start: string | null; end: string | null }; before: { value: number | null; start: string | null; end: string | null } }

/** Sale price: one line per row and market. The cell's own lock says why a line is skipped. */
export function saleLines(ctx: BulkContext, mode: BulkModeId, input: BulkInput, keys: readonly CoordinateKey[]): SaleLine[] {
  const chosen = ctx.coordinates.filter((c) => keys.includes(c.key))
  const out: SaleLine[] = []
  for (const r of ctx.rows) {
    if (r.isParent) continue
    for (const c of chosen) {
      const cells = ctx.cellsOf(r.id, c.key)
      if (!cells || (!cells.price && !cells.sale)) continue
      const before = { value: cells.sale?.value ?? null, start: cells.sale?.start ?? null, end: cells.sale?.end ?? null }
      const value = mode === 'sale-set' && input.sale ? { value: input.sale.value, start: input.sale.start, end: input.sale.end } : { value: null, start: null, end: null }
      const now = saleText(before, c.currency)
      const line = { id: `s|${r.id}|${c.key}`, rowId: r.id, sku: r.sku, where: c.label, now, note: null, coordinateKey: c.key, value, before }
      if (cells.writable.salePrice !== true) { out.push({ ...line, next: null, skipped: cells.writeBlockedReason.salePrice ?? 'The sale cannot be changed on this market' }); continue }
      if (mode === 'sale-set' && !input.sale) { out.push({ ...line, next: null, skipped: 'No sale entered' }); continue }
      if (mode === 'sale-remove' && before.value == null) { out.push({ ...line, next: null, skipped: 'No sale to remove' }); continue }
      const price = cells.price?.value ?? null
      if (mode === 'sale-set' && price != null && input.sale && input.sale.value >= price) { out.push({ ...line, next: null, skipped: `The sale price must be below the price (${money(price, c.currency)})` }); continue }
      if (before.value === value.value && isoDay(before.start) === isoDay(value.start) && isoDay(before.end) === isoDay(value.end)) { out.push({ ...line, next: null, skipped: BULK_SAME(now) }); continue }
      out.push({ ...line, next: saleText(value, c.currency), skipped: null })
    }
  }
  return out
}

export interface StatusLine extends BulkLine { coordinateKey: CoordinateKey; target: StatusTarget; before: StatusTarget | null }

/** What a Status cell holds for the bulk: its own new-listing choice, the waiting target, else its live state's target. */
export function statusNow(cell: PublishActionCell): { target: StatusTarget | null; word: string } {
  if (cell.create) return { target: cell.create.target, word: STATUS_WORD[cell.create.target] }
  if (cell.status.target) return { target: cell.status.target, word: `${STATUS_WORD[cell.status.target]} (waiting for Publish)` }
  const live = cell.state === 'active' ? 'active' : cell.state === 'paused' ? 'inactive' : cell.state === 'ended' ? 'ended' : null
  const word = live ? STATUS_WORD[live] : cell.state === 'draft' ? 'Draft' : cell.state === 'mixed' ? 'Mixed' : cell.state === 'not_listed' ? 'Not listed' : 'Unknown'
  return { target: live, word }
}

/** The markets' Status: one line per row and market with a Status cell. A choice the cell does not offer is skipped with its reason. */
export function statusLines(ctx: BulkContext, target: StatusTarget, keys: readonly CoordinateKey[]): StatusLine[] {
  const chosen = ctx.coordinates.filter((c) => keys.includes(c.key))
  const out: StatusLine[] = []
  for (const r of ctx.rows) for (const c of chosen) {
    const cell = ctx.statusCellOf(r.id, c)
    if (!cell) continue
    const now = statusNow(cell)
    const before = cell.create ? (cell.create.source === 'own' ? cell.status.target : null) : cell.status.target
    const line = { id: `t|${r.id}|${c.key}`, rowId: r.id, sku: r.sku, where: c.label, now: now.word, coordinateKey: c.key, target, before }
    const option = cell.statusOptions.find((o) => o.target === target)
    if (cell.create) { out.push({ ...line, next: null, note: null, skipped: BULK_STATUS_NEW_ROW }); continue }
    if (now.target === target) { out.push({ ...line, next: null, note: null, skipped: BULK_SAME(STATUS_WORD[target]) }); continue }
    if (!option || !option.offered) { out.push({ ...line, next: null, note: null, skipped: option?.reason ?? `${STATUS_WORD[target]} is not offered here` }); continue }
    if (target === 'ended' && !ctx.canDelete) { out.push({ ...line, next: null, note: null, skipped: 'Your role cannot end or delete listings' }); continue }
    out.push({ ...line, next: STATUS_WORD[target], note: option.warning ?? (cell.create ? option.sentence ?? 'Publish creates it' : 'Waits for Publish'), skipped: null })
  }
  return out
}

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
    stockSource: ['listing', 'listings'],
  }
  return `${n} ${one[field][n === 1 ? 0 : 1]}`
}
