import { isApiError, issuePath } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { CrViStatus, HideState, LedgerRow, LocationKind, MoveReason, PerUnit, QualityStatus, Uom } from './api'

/**
 * The warehouse stock screens' shared rules (Stock SCR-060, Movements SCR-064, Locations SCR-065, Hides SCR-200, Lots &
 * traceability SCR-201), pure: what this person may do (permissions and the cost grain), how a failed read or write is
 * said (keys of the `stock` catalogue, never the API's English), how quantities are written (with their unit, never
 * adding different units; leather in two numbers: hides and area, the area in m² and ft² both), and the tones of the
 * states. The words live in `messages/<locale>/stock.json`; each page adds its own catalogue beside it.
 */

export const STOCK_NAMESPACES = ['stock', 'lists'] as const
export const TIME_ZONE = 'Europe/Rome'

// ---- abilities -------------------------------------------------------------------------------------------------------------

export interface StockCan {
  stockView: boolean
  locationsView: boolean
  locationsManage: boolean
  adjust: boolean
  transfer: boolean
  scrap: boolean
  reverse: boolean
  receive: boolean
  openingImport: boolean
  /** Quality's own reads and decisions on a lot (the lot's checklist, documents, release: Compliance › Tests & substances). */
  lotsView: boolean
  lotsRelease: boolean
  /** Labels on the site's label printers. */
  printLabels: boolean
  printView: boolean
  workOrders: boolean
  receipts: boolean
  threads: boolean
  /** The cost grain: unit costs and values (a role without it never receives them; the columns are not drawn). */
  cost: boolean
}

/** What a person's permissions allow on the stock screens (the API checks every call again). */
export function stockCan(permissions: readonly string[]): StockCan {
  const held = new Set(permissions)
  return {
    stockView: held.has('inventory.stock.view'),
    locationsView: held.has('inventory.locations.view'),
    locationsManage: held.has('inventory.locations.manage'),
    adjust: held.has('inventory.adjust'),
    transfer: held.has('inventory.transfer'),
    scrap: held.has('inventory.scrap'),
    reverse: held.has('inventory.reverse'),
    receive: held.has('inventory.receive'),
    openingImport: held.has('inventory.opening.import') && held.has('imports.view'),
    lotsView: held.has('quality.lots.view'),
    lotsRelease: held.has('quality.lots.release'),
    printLabels: held.has('print.labels') && held.has('print.view'),
    printView: held.has('print.view'),
    workOrders: held.has('workorders.view'),
    receipts: held.has('inventory.stock.view'),
    threads: held.has('threads.read'),
    cost: held.has('money.cost'),
  }
}

// ---- problems --------------------------------------------------------------------------------------------------------------

/** Words with their values: a message key of `stock` and its parameters. */
export interface Phrase {
  key: string
  params?: Readonly<Record<string, string | number>>
}
export const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

/** A failed read in words (a key of `stock`): no right, no answer, gone, or another fault. A failed read is never "empty". */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  if (error.kind === 'not_found') return 'problem.gone'
  return 'problem.read'
}

/**
 * A refused write in words: the screen's own words for a path or code it knows (`own`), else by the kind — stock is not
 * there any more (409 below zero), changed by someone else, no right, gone, a bad request, no answer.
 */
export function writeProblem(error: unknown, own?: (paths: readonly string[], error: { kind: string; code: string; message: string }) => Phrase | null): Phrase {
  if (!isApiError(error)) return phrase('problem.write')
  const mine = own?.(error.issues.map(issuePath), error)
  if (mine) return mine
  switch (error.kind) {
    case 'conflict':
      // 409: below zero (the stock is not there any more: the issues name the stock), a state that does not allow it, or
      // a newer version.
      if (error.code === 'invalid_state') return phrase('problem.notNow')
      return error.issues.length > 0 ? phrase('problem.notEnough') : phrase('problem.changed')
    case 'forbidden':
    case 'step_up':
      return phrase('problem.forbidden')
    case 'not_found':
      return phrase('problem.gone')
    case 'invalid':
      return phrase('problem.invalid')
    case 'rate_limited':
      return phrase('problem.slowDown')
    case 'unavailable':
      return phrase('problem.offline')
    default:
      return phrase('problem.write')
  }
}

// ---- numbers and units -----------------------------------------------------------------------------------------------------

/** A decimal string as the API writes it ("420.0000") → a number, for display only (never arithmetic on money). */
export function decimalValue(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text.trim() === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** A quantity in the person's language: trailing zeros dropped, at most `decimals` decimals ("420", "12,5"); unknown "—". */
export function quantity(text: string | number | null | undefined, locale: Locale, decimals = 2): string {
  const value = typeof text === 'number' ? text : decimalValue(text)
  if (value === null) return '—'
  return formatNumber(value, locale, { maximumFractionDigits: decimals })
}

/** A signed quantity ("+12,5", "−3"); 0 as "0". */
export function signed(text: string | null | undefined, locale: Locale, decimals = 2): string {
  const value = decimalValue(text)
  if (value === null) return '—'
  if (value === 0) return quantity(0, locale)
  return `${value > 0 ? '+' : '−'}${quantity(Math.abs(value), locale, decimals)}`
}

/** A money amount in minor units (cents) with its currency ("€ 1.234,50"). */
export function money(minor: number | null | undefined, currency: string | null | undefined, locale: Locale): string {
  if (minor === null || minor === undefined || !currency) return '—'
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A unit cost as the API writes it ("4.200000") with its currency, 2 to 4 decimals. */
export function unitCost(text: string | null | undefined, currency: string | null | undefined, locale: Locale): string {
  const value = decimalValue(text)
  if (value === null || !currency) return '—'
  return formatNumber(value, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

export const AREA_UOMS: readonly Uom[] = ['M2', 'DM2', 'FT2']
export const isArea = (uom: Uom): boolean => AREA_UOMS.includes(uom)

/** Square metres per unit (1 ft² = 0.09290304 m², exact). */
const M2_PER: Readonly<Partial<Record<Uom, number>>> = { M2: 1, DM2: 0.01, FT2: 0.09290304 }

/** An area in another area unit (for display: "48,2 ft² · 4,48 m²"); null when either is not an area. */
export function convertArea(value: number, from: Uom, to: Uom): number | null {
  const a = M2_PER[from]
  const b = M2_PER[to]
  return a === undefined || b === undefined ? null : (value * a) / b
}

/** The other area unit to show beside one (tanneries sell in ft², cutters think in m²): ft² ↔ m², dm² → m². */
export const otherAreaUnit = (uom: Uom): Uom | null => (uom === 'FT2' ? 'M2' : uom === 'M2' ? 'FT2' : uom === 'DM2' ? 'M2' : null)

/** Words for one quantity with its unit, given the unit's words ("12,5 m²"). */
export const withUnit = (text: string | number | null | undefined, unit: Uom, unitWord: (uom: Uom) => string, locale: Locale, decimals = 2): string =>
  `${quantity(text, locale, decimals)} ${unitWord(unit)}`.trim()

/**
 * Totals per unit, never across units (design UnitTotals): "412,5 m² · 120 m · 2.400 pz"; empty units dropped.
 * `entries` may repeat a unit: they are added up per unit.
 */
export function unitTotals(entries: readonly PerUnit[], unitWord: (uom: Uom) => string, locale: Locale): string {
  const sums = new Map<Uom, number>()
  for (const entry of entries) sums.set(entry.uom, (sums.get(entry.uom) ?? 0) + (decimalValue(entry.quantity) ?? 0))
  const parts = [...sums.entries()].filter(([, value]) => value !== 0).map(([uom, value]) => withUnit(value, uom, unitWord, locale))
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/** Sums rows' quantities per unit (the selection's footer). */
export function sumPerUnit<T>(rows: readonly T[], pick: (row: T) => { uom: Uom; quantity: string } | null): PerUnit[] {
  const sums = new Map<Uom, number>()
  for (const row of rows) {
    const one = pick(row)
    if (one) sums.set(one.uom, (sums.get(one.uom) ?? 0) + (decimalValue(one.quantity) ?? 0))
  }
  return [...sums.entries()].map(([uom, value]) => ({ uom, quantity: value.toFixed(4) }))
}

// ---- tones of the states -----------------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const QUALITY_TONE: Readonly<Record<QualityStatus, Tone>> = { QUARANTINE: 'warning', RELEASED: 'success', BLOCKED: 'danger', REJECTED: 'neutral' }
export const CR_VI_TONE: Readonly<Record<CrViStatus, Tone>> = { NOT_REQUIRED: 'neutral', PENDING: 'warning', PASS: 'success', FAIL: 'danger' }
export const HIDE_TONE: Readonly<Record<HideState, Tone>> = { FULL: 'success', PARTLY_CUT: 'info', REMNANT: 'info', CONSUMED: 'neutral', SCRAPPED: 'neutral', RETURNED: 'neutral' }
export const REASON_TONE: Readonly<Record<MoveReason, Tone>> = {
  OPENING: 'neutral',
  RECEIPT: 'success',
  ISSUE: 'info',
  RETURN: 'info',
  TRANSFER: 'neutral',
  ADJUSTMENT: 'warning',
  COUNT: 'warning',
  SCRAP: 'danger',
  // W2a wave 5: finished garments of a work order into finished-goods stock.
  PRODUCTION_RECEIPT: 'success',
  // W2b (B-W2b-01): goods back from a customer, goods back to a supplier, garments leaving with a shipment.
  CUSTOMER_RETURN: 'success',
  SUPPLIER_RETURN: 'warning',
  SHIPMENT: 'info',
}
export const LOCATION_KIND_ORDER: readonly LocationKind[] = ['WAREHOUSE', 'ZONE', 'BIN', 'RECEIVING', 'QUARANTINE', 'PRODUCTION', 'SHIPPING']

/** A lot that may not be issued: not RELEASED (the database refuses an issue from it). */
export const isHeld = (status: QualityStatus | null | undefined): boolean => !!status && status !== 'RELEASED'

/** Why a lot waits, as a key of `stock` (the row says why it is held, not a code). */
export function lotWaitKey(lot: { qualityStatus: QualityStatus; crVi: { required: boolean; status: CrViStatus } }): string | null {
  if (lot.qualityStatus === 'RELEASED') return null
  if (lot.qualityStatus === 'REJECTED') return 'wait.rejected'
  if (lot.qualityStatus === 'BLOCKED') return lot.crVi.status === 'FAIL' ? 'wait.crViFailed' : 'wait.blocked'
  if (lot.crVi.required && lot.crVi.status === 'PENDING') return 'wait.crVi'
  if (lot.crVi.status === 'FAIL') return 'wait.crViFailed'
  return 'wait.release'
}

// ---- the ledger --------------------------------------------------------------------------------------------------------------

/** Moves that cannot be reversed from the ledger (an issue or return: from its work order's pick list; a receipt: with its receipt). */
export function reverseHeldKey(move: Pick<LedgerRow, 'reason' | 'reversalOfId' | 'reversedById'>, can: Pick<StockCan, 'reverse'>): string | null {
  if (!can.reverse) return 'held.noReverse'
  if (move.reversalOfId) return 'held.isReversal'
  if (move.reversedById) return 'held.alreadyReversed'
  if (move.reason === 'ISSUE' || move.reason === 'RETURN') return 'held.fromPickList'
  if (move.reason === 'RECEIPT') return 'held.fromReceipt'
  if (move.reason === 'OPENING') return 'held.opening'
  return null
}

/** A page's address in the warehouse (company-free; the caller adds `/w/<company>`). */
export const WAREHOUSE_PAGES = {
  stock: '/warehouse/stock',
  hides: '/warehouse/hides',
  lots: '/warehouse/lots',
  moves: '/warehouse/moves',
  locations: '/warehouse/locations',
} as const

/** The Movements page filtered to one stock key (every quantity on Stock links here). */
export function movesHref(prefix: string, key: { siteId?: string | null; itemId?: string | null; itemColourId?: string | null; lotId?: string | null; hideId?: string | null; locationId?: string | null; why?: boolean }): string {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries({ site: key.siteId, item: key.itemId, colour: key.itemColourId, lot: key.lotId, hide: key.hideId, location: key.locationId })) if (value) query.set(name, value)
  if (key.why) query.set('why', '1')
  const qs = query.toString()
  return `${prefix}${WAREHOUSE_PAGES.moves}${qs ? `?${qs}` : ''}`
}

/** Days since a moment (the age of stock), whole days; null when unknown. */
export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null
  const then = Date.parse(iso)
  return Number.isFinite(then) ? Math.max(0, Math.floor((now.getTime() - then) / 86_400_000)) : null
}

/** CSV with a header (Excel-safe: quotes doubled, a cell that starts like a formula prefixed). */
export function csvOf(header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? '' : String(value)
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
    return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [header, ...rows].map((row) => row.map(cell).join(';')).join('\n')
}
