import { isApiError } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { VALUATION_CATEGORIES, type CompanyMethod, type LayerKey, type Valuation, type ValuationCategory, type ValuationRow } from './api'

/**
 * Finance › Reports › Stock valuation (SCR-239): the pure rules — who may see what (the stock with inventory.stock.view,
 * its values only with the cost grain), the page's address (`?asOf=&site=&category=&q=&group=`), the rows' order (by
 * category, then item, lot and site), where a row opens (its lot, its work order), the key "How this lot is valued"
 * reads, the method in words (the costing method is the accountant's and UNDECIDED until chosen), the CSV of a view,
 * and the API's errors and live events in this page's terms. No fetching, no React: the tests hold them.
 */

/** A message key and its values, translated by the view (`finance-reports` catalogue). */
export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

export interface ReportsCan {
  /** The report itself (GET /costing/valuation): inventory.stock.view, as the stock. */
  readonly view: boolean
  /** Values, unit costs, receipts' prices: the cost grain (money.cost). */
  readonly cost: boolean
  /** A row's lot opens its record (Warehouse › Lots & traceability). */
  readonly lots: boolean
  /** A WIP row's work order opens its record (Production › Work orders). */
  readonly workOrders: boolean
}

export function reportsCanOf(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return { view: held.has('inventory.stock.view'), cost: held.has('money.cost'), lots: held.has('inventory.stock.view'), workOrders: held.has('workorders.view') }
}

// ---- the address ----------------------------------------------------------------------------------------------------------

export interface ValuationAddress {
  /** The day valued at (YYYY-MM-DD); null: today, every move so far. */
  readonly asOf: string | null
  readonly site: string | null
  readonly category: ValuationCategory | null
  readonly q: string | null
  /** Rows grouped by category (the default) or one list by item. */
  readonly group: boolean
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function addressOf(params: { get(name: string): string | null } | null): ValuationAddress {
  const asOf = params?.get('asOf') ?? null
  const site = params?.get('site') ?? null
  const category = params?.get('category') ?? null
  const q = params?.get('q')?.trim() ?? ''
  return {
    asOf: asOf && DAY.test(asOf) ? asOf : null,
    site: site && UUID.test(site) ? site : null,
    category: (VALUATION_CATEGORIES as readonly string[]).includes(category ?? '') ? (category as ValuationCategory) : null,
    q: q.length > 0 ? q.slice(0, 100) : null,
    group: params?.get('group') !== '0',
  }
}

function queryString(address: ValuationAddress): string {
  const query = new URLSearchParams()
  if (address.asOf) query.set('asOf', address.asOf)
  if (address.site) query.set('site', address.site)
  if (address.category) query.set('category', address.category)
  if (address.q) query.set('q', address.q)
  if (!address.group) query.set('group', '0')
  const qs = query.toString()
  return qs ? `?${qs}` : ''
}

export const reportsHref = (prefix: string, address: ValuationAddress): string => `${prefix}/finance/reports${queryString(address)}`
/** The dated paper for the accountant (design tab:print), in a new tab, with the same view. */
export const printHref = (prefix: string, address: ValuationAddress): string => `${prefix}/finance/reports/print${queryString(address)}`

/** Today in Rome (the sites' default zone), YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

// ---- rows -----------------------------------------------------------------------------------------------------------------

/** A row's id in the list (a stock key, or a work order's WIP). */
export const rowId = (row: ValuationRow): string =>
  row.workOrder ? `wip|${row.site.id}|${row.workOrder.id}` : `stock|${row.site.id}|${row.item?.id ?? ''}|${row.colour?.id ?? ''}|${row.lot?.id ?? ''}`

const categoryIndex = (category: ValuationCategory) => VALUATION_CATEGORIES.indexOf(category)

/** The report's order: grouped, by category first (the design's raw leather, materials, trims, packaging, finished goods, WIP); then item, lot, site. */
export function orderedRows(rows: readonly ValuationRow[], grouped: boolean): ValuationRow[] {
  const name = (row: ValuationRow) => row.item?.code ?? row.workOrder?.number ?? ''
  return [...rows].sort(
    (a, b) =>
      (grouped ? categoryIndex(a.category) - categoryIndex(b.category) : 0) ||
      name(a).localeCompare(name(b)) ||
      (a.colour?.code ?? '').localeCompare(b.colour?.code ?? '') ||
      (a.lot?.code ?? '').localeCompare(b.lot?.code ?? '') ||
      a.site.code.localeCompare(b.site.code),
  )
}

/** The key "How this lot is valued" reads; null for a WIP row (its value is the work order's cost ledger) or without the cost grain. */
export function layerKeyOf(row: ValuationRow, asOfDay: string | null, can: Pick<ReportsCan, 'cost'>): LayerKey | null {
  if (!can.cost || !row.item || row.workOrder) return null
  return { siteId: row.site.id, itemId: row.item.id, itemColourId: row.colour?.id ?? null, lotId: row.lot?.id ?? null, asOf: asOfDay }
}

export const lotHref = (prefix: string, lotId: string): string => `${prefix}/warehouse/lots/${encodeURIComponent(lotId)}`
export const workOrderHref = (prefix: string, workOrderId: string): string => `${prefix}/production/work-orders/${encodeURIComponent(workOrderId)}`

// ---- words --------------------------------------------------------------------------------------------------------------

/** The company's costing method beside the figures (the accountant's choice; UNDECIDED until made). */
export function methodPhrase(methods: readonly CompanyMethod[]): Phrase {
  const kinds = [...new Set(methods.map((entry) => entry.method))]
  if (kinds.length === 0) return { key: 'method.none' }
  if (kinds.length > 1) return { key: 'method.several' }
  return { key: `method.company.${kinds[0]}` }
}

/** What a row's value rests on, in words: the stock ledger's bases, or why it has none. */
export function basisPhrase(row: Pick<ValuationRow, 'methods' | 'valued' | 'unvaluedMoves' | 'workOrder'>): Phrase {
  if (row.workOrder) return { key: row.workOrder.done ? 'basis.wipDone' : 'basis.wip' }
  if (row.valued === 'NONE') return { key: 'basis.none', params: { count: row.unvaluedMoves } }
  if (row.valued === 'PART') return { key: 'basis.part', params: { count: row.unvaluedMoves } }
  return { key: 'basis.full' }
}

/** A decimal the API writes as text ("12.5000") in the person's language, without trailing zeros. */
export function decimalText(value: string | null | undefined, locale: Locale, maximumFractionDigits = 4): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? formatNumber(number, locale, { maximumFractionDigits }) : value
}

/** Minor units with the currency (`1.234,50 €`); '—' when unknown. */
export function moneyText(minor: number | null | undefined, currency: string | null, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  if (!currency) return formatNumber(minor / 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A cost per unit as the API writes it ("4.200000") with 2 to 4 decimals. */
export function unitCostText(value: string | null | undefined, currency: string | null, locale: Locale): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return currency ? formatNumber(number, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }) : formatNumber(number, locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** Rows hidden by the API's limit, a value left by lot-cost rounding, moves without a value: the notes under the totals. */
export function reportNotes(valuation: Pick<Valuation, 'truncated' | 'unvaluedMoves' | 'residue' | 'value' | 'currency'>, can: Pick<ReportsCan, 'cost'>): Phrase[] {
  const notes: Phrase[] = []
  if (valuation.truncated) notes.push({ key: 'note.truncated' })
  if (valuation.unvaluedMoves > 0) notes.push({ key: 'note.unvalued', params: { count: valuation.unvaluedMoves } })
  if (can.cost && typeof valuation.residue === 'number' && valuation.residue !== 0) notes.push({ key: 'note.residue' })
  if (can.cost && valuation.value === null) notes.push({ key: 'note.currencies' })
  return notes
}

// ---- CSV (the view, or the rows chosen) -----------------------------------------------------------------------------------

export interface CsvWords {
  readonly header: (column: string) => string
  readonly category: (category: ValuationCategory) => string
  readonly basis: (row: ValuationRow) => string
}

/** Plain numbers in the file's language (`1234,56` in Italian), so a spreadsheet reads them as numbers. */
const plain = (value: number | null | undefined, places: number, locale: Locale): string => (value === null || value === undefined ? '' : value.toFixed(places).replace('.', locale === 'it' ? ',' : '.'))
const plainDecimal = (value: string | null | undefined, locale: Locale): string => (value === null || value === undefined || value === '' ? '' : locale === 'it' ? value.replace('.', ',') : value)

/**
 * The rows as CSV for the accountant's spreadsheet: `;` and the decimal comma in Italian, `,` and the dot in English;
 * the value columns only with the cost grain (never more than the screen shows).
 */
export function valuationCsv(rows: readonly ValuationRow[], can: Pick<ReportsCan, 'cost'>, words: CsvWords, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const cell = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value)
    return new RegExp(`["\\n${separator}]`).test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const columns = ['category', 'item', 'colour', 'lot', 'workOrder', 'site', 'quantity', 'uom', 'areaM2', 'hides', ...(can.cost ? ['value', 'unitCost', 'currency'] : []), 'basis']
  const lines = [columns.map((column) => cell(words.header(column))).join(separator)]
  for (const row of rows) {
    lines.push(
      [
        words.category(row.category),
        row.item ? `${row.item.code} · ${row.item.name}` : '',
        row.colour?.code ?? '',
        row.lot?.code ?? '',
        row.workOrder?.number ?? '',
        row.site.code,
        plainDecimal(row.quantity, locale),
        row.uom ?? '',
        plainDecimal(row.areaM2, locale),
        row.hides > 0 ? row.hides : '',
        ...(can.cost ? [plain(typeof row.value === 'number' ? row.value / 100 : null, 2, locale), plainDecimal(row.unitCost ?? null, locale), row.currency ?? ''] : []),
        words.basis(row),
      ]
        .map(cell)
        .join(separator),
    )
  }
  return `${lines.join('\n')}\n`
}

// ---- the API in this page's words ----------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid'].includes(error.kind)) return `problem.${error.kind}`
  return 'problem.internal'
}

/** A live event that may change a value or a quantity: a stock move, a work order's cost, a standard cost. */
export const liveTouches = (change: { type: string }): boolean =>
  change.type.startsWith('inventory.') || change.type.startsWith('work_order_cost.') || change.type === 'standard_cost.changed'
