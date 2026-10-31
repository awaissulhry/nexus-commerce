import { isApiError } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { BridgeReason, CostedStatus, CostingMethod, LedgerEntry, MethodView, WorkOrderCost, WorkOrderCostRow, WorkOrderCostsQuery } from './api'

/**
 * Finance › Costing › Standard vs actual (SCR-154) and the work order's Labour & cost tab: the pure rules — who may see
 * what (the page with costing.view, every amount only with the cost grain, a reversal with costing.ledger.manage), the
 * page's address (`?site=&rows=&q=&month=&open=`), the period's days, the method in words (the accountant's choice:
 * "not decided yet" while UNDECIDED — the screen names what the data has and never picks one), the variance's tone, the
 * figures in the person's language, why a reversal is held, the CSV of a view and the API's errors and live events in
 * this page's words. No fetching, no React: the tests hold them. Never a person: labour is per work order and operation.
 */

/** The catalogue of these screens (messages/<locale>/finance-costing.json). */
export const COSTING_NAMESPACE = 'finance-costing'

/** A message key and its values, translated by the view. */
export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

export interface CostingCan {
  /** The page and the work order's Labour & cost (GET /costing/*): costing.view. */
  readonly view: boolean
  /** Every amount, unit cost and value: the cost grain (money.cost). */
  readonly cost: boolean
  /** Reverse a ledger entry: costing.ledger.manage. */
  readonly reverse: boolean
  /** A work order opens its record (Production › Work orders). */
  readonly workOrders: boolean
  /** The cost sheets (Products › Styles). */
  readonly styles: boolean
  /** A material line opens its stock movements (Warehouse › Movements). */
  readonly moves: boolean
  /** The site choice reads the company's sites (GET /inventory/locations: inventory.locations.view). */
  readonly sites: boolean
}

export function costingCanOf(permissions: readonly string[]): CostingCan {
  const held = new Set(permissions)
  return {
    view: held.has('costing.view'),
    cost: held.has('money.cost'),
    reverse: held.has('costing.ledger.manage'),
    workOrders: held.has('workorders.view'),
    styles: held.has('product.styles.view'),
    moves: held.has('inventory.stock.view'),
    sites: held.has('inventory.locations.view'),
  }
}

// ---- the address ----------------------------------------------------------------------------------------------------------

/** Rows ▾ (design "Over standard · Closed this month"): every costed work order, those over standard, those done in the period. */
export const ROW_VIEWS = ['all', 'over', 'closed'] as const
export type RowView = (typeof ROW_VIEWS)[number]

export interface CostingAddress {
  readonly site: string | null
  readonly rows: RowView
  readonly q: string | null
  /** The period (YYYY-MM); null: this month. */
  readonly month: string | null
  /** The work order whose cost is open (pop:wo-cost). */
  readonly open: string | null
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function addressOf(params: { get(name: string): string | null } | null): CostingAddress {
  const site = params?.get('site') ?? null
  const rows = params?.get('rows') ?? null
  const q = params?.get('q')?.trim() ?? ''
  const month = params?.get('month') ?? null
  const open = params?.get('open') ?? null
  return {
    site: site && UUID.test(site) ? site : null,
    rows: (ROW_VIEWS as readonly string[]).includes(rows ?? '') ? (rows as RowView) : 'all',
    q: q.length > 0 ? q.slice(0, 100) : null,
    month: month && MONTH.test(month) ? month : null,
    open: open && UUID.test(open) ? open : null,
  }
}

function queryString(address: CostingAddress): string {
  const query = new URLSearchParams()
  if (address.site) query.set('site', address.site)
  if (address.rows !== 'all') query.set('rows', address.rows)
  if (address.q) query.set('q', address.q)
  if (address.month) query.set('month', address.month)
  if (address.open) query.set('open', address.open)
  const qs = query.toString()
  return qs ? `?${qs}` : ''
}

export const costingHref = (prefix: string, address: CostingAddress): string => `${prefix}/finance/costing${queryString(address)}`
/** The variance report for paper (design tab:print), in a new tab, with the same scope. */
export const printHref = (prefix: string, address: CostingAddress): string => `${prefix}/finance/costing/print${queryString({ ...address, open: null })}`
export const workOrderHref = (prefix: string, workOrderId: string): string => `${prefix}/production/work-orders/${encodeURIComponent(workOrderId)}`
/** The work order's Labour & cost tab. */
export const labourHref = (prefix: string, workOrderId: string): string => `${workOrderHref(prefix, workOrderId)}?tab=labour`
/** The style's cost sheet (Products › Style › Cost). */
export const costSheetHref = (prefix: string, styleId: string): string => `${prefix}/products/styles/${encodeURIComponent(styleId)}?tab=cost`
export const stylesHref = (prefix: string): string => `${prefix}/products/styles`
/** One work order's cost on this page (Finance › Margins links its work orders here). */
export const workOrderCostHref = (prefix: string, workOrderId: string): string => `${prefix}/finance/costing?open=${encodeURIComponent(workOrderId)}`
/** A material line's stock movements (Warehouse › Movements, the issues and returns of that material at the site). */
export function movesHref(prefix: string, siteId: string, itemId: string, lotId?: string | null): string {
  const query = new URLSearchParams({ site: siteId, item: itemId, reasons: 'ISSUE,RETURN' })
  if (lotId) query.set('lot', lotId)
  return `${prefix}/warehouse/moves?${query.toString()}`
}

/** Today in Rome (the sites' default zone), YYYY-MM-DD. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The month a day is in (YYYY-MM). */
export const monthOf = (day: string): string => day.slice(0, 7)

/** The period's first and last day; this month ends today (nothing is dated after it). */
export function periodOf(month: string | null, today: string): { month: string; from: string; to: string } {
  const chosen = month ?? monthOf(today)
  const [year, number] = chosen.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  const end = `${chosen}-${String(last).padStart(2, '0')}`
  return { month: chosen, from: `${chosen}-01`, to: end > today ? today : end }
}

/** The twelve months up to this one, newest first (the period choice). */
export function recentMonths(today: string, count = 12): string[] {
  const [year, month] = monthOf(today).split('-').map(Number) as [number, number]
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 - index, 1))
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

/** The list's API query for its rows view (the API's own filters; "closed" is narrowed to the period on the page). */
export function rowsQuery(address: CostingAddress, companyId: string | null, cursor: string | null = null): WorkOrderCostsQuery {
  const status: CostedStatus[] | null = address.rows === 'closed' ? ['COMPLETED', 'CLOSED'] : null
  return { companyId, siteId: address.site, status, over: address.rows === 'over' ? true : null, q: address.q, cursor, limit: 50 }
}

/** "Closed this month": a work order completed (or closed) in the period. */
export function closedIn(row: Pick<WorkOrderCostRow, 'workOrder'>, period: { from: string; to: string }): boolean {
  const day = row.workOrder.completedAt ? romeDay(row.workOrder.completedAt) : null
  return day !== null && day >= period.from && day <= period.to
}

export const romeDay = (instant: string): string => romeToday(new Date(instant))

// ---- words --------------------------------------------------------------------------------------------------------------

/** The company's costing method in words (the accountant's choice; "not decided yet" while UNDECIDED). */
export function methodPhrase(method: Pick<MethodView, 'method' | 'locked'> | null, fallback: CostingMethod | null = null): Phrase {
  const chosen = method?.method ?? fallback
  if (!chosen) return { key: 'method.unknown' }
  if (chosen === 'UNDECIDED') return { key: 'method.undecided' }
  return { key: method?.locked ? 'method.locked' : 'method.chosen', params: { method: chosen } }
}

/** What the variance is taken against, in words. */
export function basisPhrase(row: Pick<WorkOrderCostRow, 'basis' | 'estimateComplete'>): Phrase {
  if (row.basis === 'STANDARD') return { key: 'basis.STANDARD' }
  if (row.basis === 'ESTIMATE') return { key: row.estimateComplete ? 'basis.ESTIMATE' : 'basis.estimatePart' }
  return { key: 'basis.none' }
}

/** Over its basis by more than 5 %: danger; under it: success; else neutral. */
export function varianceTone(row: Pick<WorkOrderCostRow, 'over' | 'variance'>): 'danger' | 'success' | 'neutral' {
  if (row.over) return 'danger'
  if (typeof row.variance === 'number' && row.variance < 0) return 'success'
  return 'neutral'
}

/** The work order's state for cost: open (the actual grows as work is reported) or final. */
export const statePhrase = (row: Pick<WorkOrderCostRow, 'final'>): Phrase => ({ key: row.final ? 'state.final' : 'state.open' })

/** The bridge from the basis to the actual (design "Bridge"): the basis, each reason with an amount, the actual. */
export function bridgeSteps(detail: Pick<WorkOrderCost, 'bridge' | 'basis' | 'standardTotal' | 'estimateTotal' | 'actualTotal'>): Array<{ id: string; reason: BridgeReason | 'BASIS' | 'ACTUAL'; amount: number | null }> | null {
  if (!detail.bridge || !detail.basis) return null
  const basis = detail.basis === 'STANDARD' ? detail.standardTotal : detail.estimateTotal
  return [
    { id: 'basis', reason: 'BASIS', amount: typeof basis === 'number' ? basis : null },
    ...detail.bridge.filter((step) => step.amount !== 0).map((step) => ({ id: step.reason, reason: step.reason, amount: typeof step.amount === 'number' ? step.amount : null })),
    { id: 'actual', reason: 'ACTUAL', amount: typeof detail.actualTotal === 'number' ? detail.actualTotal : null },
  ]
}

/** Why "Reverse entry" is held for this entry; null when it may be reversed. */
export function reverseHeld(entry: Pick<LedgerEntry, 'reversalOfId' | 'reversedBy'>, can: Pick<CostingCan, 'reverse'>, busy = false): Phrase | null {
  if (!can.reverse) return { key: 'held.noReverse', params: { permission: 'costing.ledger.manage' } }
  if (entry.reversalOfId) return { key: 'held.isReversal' }
  if (entry.reversedBy) return { key: 'held.reversed' }
  if (busy) return { key: 'held.busy' }
  return null
}

/** The reason a reversal needs (the API takes 3 to 500 characters). */
export const reasonHeld = (reason: string): Phrase | null => (reason.trim().length < 3 ? { key: 'reverse.reasonShort' } : reason.trim().length > 500 ? { key: 'reverse.reasonLong' } : null)

/** Minor units with the currency (`1.234,50 €`); '—' when unknown. */
export function moneyText(minor: number | null | undefined, currency: string | null, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  if (!currency) return formatNumber(minor / 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A signed amount (`+120,00 €`, `−40,00 €`): a variance or a bridge step. */
export function signedMoney(minor: number | null | undefined, currency: string | null, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  const text = moneyText(Math.abs(minor), currency, locale)
  return minor > 0 ? `+${text}` : minor < 0 ? `−${text}` : text
}

/** A percent the API writes as text ("4.5000") with one decimal and its sign. */
export function pctText(value: string | null | undefined, locale: Locale, signed = false): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const text = `${formatNumber(Math.abs(number), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
  if (!signed) return number < 0 ? `−${text}` : text
  return number > 0 ? `+${text}` : number < 0 ? `−${text}` : text
}

/** A decimal the API writes as text ("12.5000") in the person's language, without trailing zeros. */
export function decimalText(value: string | null | undefined, locale: Locale, maximumFractionDigits = 2): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? formatNumber(number, locale, { maximumFractionDigits }) : value
}

/** A cost per unit as the API writes it ("4.200000") with 2 to 4 decimals. */
export function unitCostText(value: string | null | undefined, currency: string | null, locale: Locale): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return currency ? formatNumber(number, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }) : formatNumber(number, locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

const UNIT_WORDS: Readonly<Record<string, string>> = { FT2: 'ft²', M2: 'm²', DM2: 'dm²', PCS: 'pz', M: 'm', CM: 'cm', MM: 'mm', KG: 'kg', G: 'g' }
/** A quantity with its unit ("186,5 ft²"). */
export const quantityText = (value: string | null | undefined, uom: string, locale: Locale): string => (value === null || value === undefined ? '—' : `${decimalText(value, locale, 4)} ${UNIT_WORDS[uom] ?? uom}`)

// ---- CSV (the view, or the rows chosen) -----------------------------------------------------------------------------------

export interface CsvWords {
  readonly header: (column: string) => string
  readonly basis: (row: WorkOrderCostRow) => string
  readonly reason: (reason: BridgeReason | null) => string
  readonly state: (row: WorkOrderCostRow) => string
}

const plainMinor = (value: number | null | undefined, locale: Locale): string => (value === null || value === undefined ? '' : (value / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))
const plainDecimal = (value: string | null | undefined, locale: Locale): string => (value === null || value === undefined || value === '' ? '' : locale === 'it' ? value.replace('.', ',') : value)

/**
 * The work orders as CSV for a spreadsheet: `;` and the decimal comma in Italian, `,` and the dot in English; the amount
 * columns only with the cost grain (never more than the screen shows).
 */
export function workOrdersCsv(rows: readonly WorkOrderCostRow[], can: Pick<CostingCan, 'cost'>, words: CsvWords, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const cell = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value)
    return new RegExp(`["\\n${separator}]`).test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const columns = ['workOrder', 'style', 'pieces', 'basis', ...(can.cost ? ['standard', 'estimate', 'actual', 'variance', 'variancePct', 'currency'] : []), 'reason', 'state']
  const lines = [columns.map((column) => cell(words.header(column))).join(separator)]
  for (const row of rows) {
    lines.push(
      [
        row.workOrder.number,
        `${row.workOrder.style.code} · ${row.workOrder.style.name}`,
        row.workOrder.pieces,
        words.basis(row),
        ...(can.cost ? [plainMinor(row.standardTotal, locale), plainMinor(row.estimateTotal, locale), plainMinor(row.actualTotal, locale), plainMinor(row.variance, locale), plainDecimal(row.variancePct, locale), row.currency] : []),
        words.reason(row.biggestReason),
        words.state(row),
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
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'conflict', 'step_up'].includes(error.kind)) return `problem.${error.kind}`
  return 'problem.internal'
}

/** A live event that may change a cost: a cost entry posted or reversed, a standard, the method, a stock move or a scan. */
export const liveTouches = (change: { type: string }): boolean =>
  change.type.startsWith('work_order_cost.') || change.type === 'standard_cost.changed' || change.type === 'costing_method.changed' || change.type.startsWith('inventory.') || change.type.startsWith('production.scan') || change.type.startsWith('work_order.')
