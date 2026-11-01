import { isApiError } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import { moneyText, pctText } from '../costing/model'
import { SALES_ORDER_STATUSES, WATERFALL_REASONS, type CustomerGroup, type MarginsQuery, type OrderMargin, type OrderMarginRow, type StyleGroup, type WaterfallReason } from './api'

/**
 * Finance › Costing › Margins (SCR-155), the sales order's Margin tab and the orders list's Margin % column: the pure
 * rules — who may see what (the page with costing.view; the value with the price grain, costs with the cost grain,
 * margin % with the margin grain, a margin amount only with margin AND cost: Owner answer S2), the page's address
 * (`?from=&to=&party=&style=&q=&open=`), the tones, the bridge from price to margin, where the margin went (quoted → now)
 * as steps, the bars by customer and style, the CSV of a view, and the API's errors and live events in this page's words.
 * No fetching, no React: the tests hold them. No person is named.
 */

export const MARGINS_NAMESPACE = 'finance-margins'

export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

export interface MarginsCan {
  /** The page, the Margin tab and the Margin % column (GET /costing/margins…): costing.view. */
  readonly view: boolean
  readonly price: boolean
  readonly cost: boolean
  readonly margin: boolean
  /** An order opens its record (Sales › Orders). */
  readonly orders: boolean
  /** A work order's cost opens in Finance › Standard vs actual (costing.view). */
  readonly costing: boolean
}

export function marginsCanOf(permissions: readonly string[]): MarginsCan {
  const held = new Set(permissions)
  return { view: held.has('costing.view'), price: held.has('money.price'), cost: held.has('money.cost'), margin: held.has('money.margin'), orders: held.has('orders.view'), costing: held.has('costing.view') }
}

/** The Margin % column of the orders list and the Margin tab need the page's permission and the margin grain. */
export const showsMargin = (can: Pick<MarginsCan, 'view' | 'margin'>): boolean => can.view && can.margin

// ---- the address ----------------------------------------------------------------------------------------------------------

export interface MarginsAddress {
  /** The order date, Europe/Rome days, both included; null: no bound. */
  readonly from: string | null
  readonly to: string | null
  readonly party: string | null
  readonly style: string | null
  readonly q: string | null
  /** The order whose profitability is open (pop:order). */
  readonly open: string | null
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function addressOf(params: { get(name: string): string | null } | null): MarginsAddress {
  const day = (name: string) => {
    const value = params?.get(name) ?? null
    return value && DAY.test(value) ? value : null
  }
  const id = (name: string) => {
    const value = params?.get(name) ?? null
    return value && UUID.test(value) ? value : null
  }
  const q = params?.get('q')?.trim() ?? ''
  return { from: day('from'), to: day('to'), party: id('party'), style: id('style'), q: q.length > 0 ? q.slice(0, 100) : null, open: id('open') }
}

function queryString(address: MarginsAddress): string {
  const query = new URLSearchParams()
  for (const name of ['from', 'to', 'party', 'style', 'q', 'open'] as const) if (address[name]) query.set(name, address[name]!)
  const qs = query.toString()
  return qs ? `?${qs}` : ''
}

export const marginsHref = (prefix: string, address: MarginsAddress): string => `${prefix}/finance/margins${queryString(address)}`
export const orderHref = (prefix: string, orderId: string): string => `${prefix}/sales/orders/${encodeURIComponent(orderId)}`
export const orderMarginTabHref = (prefix: string, orderId: string): string => `${orderHref(prefix, orderId)}?tab=margin`
/** One order's profitability on Margins. */
export const orderProfitabilityHref = (prefix: string, orderId: string): string => `${prefix}/finance/margins?open=${encodeURIComponent(orderId)}`
/** A work order's cost in Finance › Standard vs actual (a step of where the margin went opens it). */
export const workOrderCostHref = (prefix: string, workOrderId: string | null): string => (workOrderId ? `${prefix}/finance/costing?open=${encodeURIComponent(workOrderId)}` : `${prefix}/finance/costing`)

/** The API's query for the address (every order but CANCELLED, the API's default). */
export const marginsQueryOf = (address: MarginsAddress, companyId: string | null, cursor: string | null = null): MarginsQuery => ({ companyId, partyId: address.party, styleId: address.style, from: address.from, to: address.to, q: address.q, cursor, limit: 50 })

// ---- words and tones --------------------------------------------------------------------------------------------------------

/** A margin % in tone: below zero danger, else neutral (the margin floor and its flag are W2b). */
export const pctTone = (pct: string | null | undefined): 'danger' | 'neutral' => (pct !== null && pct !== undefined && Number(pct) < 0 ? 'danger' : 'neutral')

/** The change since the quote in tone: lost → danger, gained → success. */
export const changeTone = (change: number | null | undefined): 'danger' | 'success' | 'neutral' => (typeof change !== 'number' || change === 0 ? 'neutral' : change < 0 ? 'danger' : 'success')

/** The stage the order's cost stands at, in words. */
export function stagePhrase(row: Pick<OrderMarginRow, 'final' | 'started'>): Phrase {
  if (row.final) return { key: 'stage.final' }
  return { key: row.started ? 'stage.started' : 'stage.notStarted' }
}

/** The difference between two margin percents (now − quoted), in points; null without both. */
export function pointsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null
  const a = Number(from)
  const b = Number(to)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) * 10) / 10 : null
}

export interface BridgeRow {
  readonly id: string
  readonly kind: 'value' | 'cost' | 'freight' | 'margin'
  /** A message key (`bridge.price`, `part.MATERIAL`, `bridge.freight`, `bridge.margin`). */
  readonly label: string
  readonly amount: number | null
}

/**
 * The order's profitability as a bridge (design pop:order "price − material − labour − subcontract − freight = margin"):
 * the value now, each cost part as estimated now, freight (none recorded yet: left out, said in words), the margin.
 * Null without the cost grain (a margin amount gives the cost away).
 */
export function bridgeOf(detail: Pick<OrderMargin, 'estimate'>, can: Pick<MarginsCan, 'cost' | 'price'>): BridgeRow[] | null {
  const stage = detail.estimate
  if (!can.cost || !can.price || !stage.parts) return null
  const parts = stage.parts
  const amount = (value: number | undefined) => (typeof value === 'number' ? value : null)
  return [
    { id: 'price', kind: 'value', label: 'bridge.price', amount: amount(stage.value) },
    { id: 'MATERIAL', kind: 'cost', label: 'part.MATERIAL', amount: amount(parts.material) },
    { id: 'LABOUR', kind: 'cost', label: 'part.LABOUR', amount: amount(parts.labour) },
    { id: 'SUBCONTRACT', kind: 'cost', label: 'part.SUBCONTRACT', amount: amount(parts.subcontract) },
    { id: 'OVERHEAD', kind: 'cost', label: 'part.OVERHEAD', amount: amount(parts.overhead) },
    ...(typeof parts.adjustment === 'number' && parts.adjustment !== 0 ? [{ id: 'ADJUSTMENT', kind: 'cost' as const, label: 'part.ADJUSTMENT', amount: parts.adjustment }] : []),
    { id: 'freight', kind: 'freight', label: 'bridge.freight', amount: null },
    { id: 'margin', kind: 'margin', label: 'bridge.margin', amount: typeof stage.margin === 'number' ? stage.margin : null },
  ]
}

export interface WaterfallStep {
  readonly id: string
  readonly reason: WaterfallReason | 'QUOTED' | 'NOW'
  readonly amount: number
  /** Where the bar starts and ends (the running margin), for the chart. */
  readonly from: number
  readonly to: number
}

/**
 * Where the margin went (design order.margin.waterfall): the margin as quoted, each part's change (the value's change
 * as PRICE; a cost part that rose takes margin off), the margin now. The steps add up: quoted + Σ = now. Null without
 * the waterfall (no cost grain, or a cost that cannot be told).
 */
export function waterfallOf(detail: Pick<OrderMargin, 'waterfall' | 'quotedMargin' | 'estimateMargin'>): WaterfallStep[] | null {
  if (!detail.waterfall || typeof detail.quotedMargin !== 'number' || typeof detail.estimateMargin !== 'number') return null
  const steps: WaterfallStep[] = [{ id: 'quoted', reason: 'QUOTED', amount: detail.quotedMargin, from: 0, to: detail.quotedMargin }]
  let running = detail.quotedMargin
  for (const reason of WATERFALL_REASONS) {
    const step = detail.waterfall.find((entry) => entry.reason === reason)
    if (!step || typeof step.amount !== 'number' || step.amount === 0) continue
    steps.push({ id: reason, reason, amount: step.amount, from: running, to: running + step.amount })
    running += step.amount
  }
  steps.push({ id: 'now', reason: 'NOW', amount: detail.estimateMargin, from: 0, to: detail.estimateMargin })
  return steps
}

export interface Bar {
  readonly id: string
  readonly label: string
  readonly sub: string
  /** The margin % as the API writes it (null: the cost cannot be told). */
  readonly pct: string | null
  readonly orders: number
}

/** Profitability per customer or per style as bars (design "BarList with margin %"), the largest value first (the API's order). */
export function barsOf(groups: readonly (CustomerGroup | StyleGroup)[]): Bar[] {
  return groups.map((group) =>
    'party' in group
      ? { id: group.party.id, label: group.party.name, sub: '', pct: group.marginPct ?? null, orders: group.orders }
      : { id: group.style.id, label: group.style.code, sub: group.style.name, pct: group.marginPct ?? null, orders: group.orders },
  )
}

// ---- CSV ------------------------------------------------------------------------------------------------------------------

export interface CsvWords {
  readonly header: (column: string) => string
  readonly status: (row: OrderMarginRow) => string
  readonly stage: (row: OrderMarginRow) => string
}

const plainMinor = (value: number | null | undefined, locale: Locale): string => (value === null || value === undefined ? '' : (value / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))
const plainDecimal = (value: string | null | undefined, locale: Locale): string => (value === null || value === undefined || value === '' ? '' : locale === 'it' ? value.replace('.', ',') : value)

/** The orders as CSV: each grain's columns only for a person who holds it (never more than the screen shows). */
export function marginsCsv(rows: readonly OrderMarginRow[], can: Pick<MarginsCan, 'price' | 'cost' | 'margin'>, words: CsvWords, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const cell = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value)
    return new RegExp(`["\\n${separator}]`).test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const amounts = can.margin && can.cost
  const columns = [
    'order',
    'customer',
    'orderDate',
    'status',
    ...(can.price ? ['value'] : []),
    ...(can.cost ? ['quotedCost', 'estimateCost', 'actualCost'] : []),
    ...(can.margin ? ['quotedMarginPct', 'estimateMarginPct', 'actualMarginPct'] : []),
    ...(amounts ? ['marginChange'] : []),
    'currency',
    'stage',
  ]
  const lines = [columns.map((column) => cell(words.header(column))).join(separator)]
  for (const row of rows) {
    lines.push(
      [
        row.order.number,
        row.order.party.name,
        row.order.orderDate,
        words.status(row),
        ...(can.price ? [plainMinor(row.value, locale)] : []),
        ...(can.cost ? [plainMinor(row.quotedCost, locale), plainMinor(row.estimateCost, locale), plainMinor(row.actualCost, locale)] : []),
        ...(can.margin ? [plainDecimal(row.quotedMarginPct, locale), plainDecimal(row.estimateMarginPct, locale), plainDecimal(row.actualMarginPct, locale)] : []),
        ...(amounts ? [plainMinor(row.marginChange, locale)] : []),
        row.currency,
        words.stage(row),
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

/** A live event that may change a margin: a cost posted or reversed, a standard, an order changed, an invoice issued. */
export const liveTouches = (change: { type: string }): boolean =>
  change.type.startsWith('work_order_cost.') || change.type === 'standard_cost.changed' || change.type.startsWith('sales_order.') || change.type === 'invoice.issued'

/** Every status, for the orders list's Margin % column (the list shows cancelled orders too). */
export const EVERY_STATUS = SALES_ORDER_STATUSES

export { moneyText, pctText }
