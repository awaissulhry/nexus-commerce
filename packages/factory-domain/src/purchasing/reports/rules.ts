import type { BusinessDate } from '../../core/time'
import { lastMonthOf, MATERIAL_TYPES, monthStart, periodOf, periodProblems, spanOf, type MaterialType, type Period } from '../../inventory/reports/rules'
import { countsInProductionSpend } from '../sample-orders/rules'
import { Dec } from '../../tax/decimal'

/**
 * Purchasing reports (B-W2b-350; design purchasing.reports SCR-255: sec spend, sec late, pop drill, tab print; SCM-165 spend
 * analysis, SCM-169 late lines and what they block), the rules of the spend, pure. The API reads the purchase order lines and
 * folds them here; the late lines are the expediting worklist's (purchasing/expediting/worklist.ts, B-W2b-305), read as they are.
 *
 *   spend        what the company committed to its suppliers in the period: the lines of its purchase orders PLACED in the
 *                period (the day the order was first sent: revision 1), at the value they hold now (a change sent again
 *                counts at its new value, in the month the order was first placed). An order still a draft or waiting for its
 *                yes, declined or cancelled is no spend; a cancelled line is none either; a line closed short counts what came
 *                (its value × received / ordered). An order in another currency counts in the company's at the rate of the
 *                order (its companyNetAmount, SCM-065), else in its own currency, apart (never summed across).
 *   samples      sample and development orders (kind SAMPLE, B-W2b-347) are counted APART, never in the production spend
 *                (`countsInProductionSpend`).
 *   by           supplier, category (the material's kind), material (the article), company, month of the placing.
 */

export { lastMonthOf, monthStart, periodOf, periodProblems, spanOf, type Period }

/** What the spend is grouped by (the design's "supplier, category, material, company and period"). */
export const SPEND_GROUPS = ['supplier', 'category', 'material', 'company', 'month'] as const
export type SpendGroup = (typeof SPEND_GROUPS)[number]
export const isSpendGroup = (value: unknown): value is SpendGroup => typeof value === 'string' && (SPEND_GROUPS as readonly string[]).includes(value)

/** The categories: the material types of the stock reports (the item's kind; finished garments last). */
export const SPEND_CATEGORIES = MATERIAL_TYPES
export type SpendCategory = MaterialType

/** The order states that are spend: placed with the supplier and not given up (a draft, a request for a yes, a decline or a cancel is none). */
export const SPEND_STATUSES = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const

/** Production spend or sample and development orders (apart). */
export const SPEND_KINDS = ['production', 'samples'] as const
export type SpendKind = (typeof SPEND_KINDS)[number]

/** The kind of an order's spend: production unless the order is a sample or development order. */
export const spendKindOf = (orderKind: string): SpendKind => (countsInProductionSpend(orderKind) ? 'production' : 'samples')

export const SPEND_LIMITS = Object.freeze({
  /** At most this many groups in the answer (the largest first; `more` counts the rest, the total counts them all). */
  groups: 50,
  /** At most this many lines behind one bar (`more` counts the rest). */
  drillLines: 500,
  /** At most this many lines read for one answer (`complete` says when there were more). */
  read: 20_000,
})

// ---- one line --------------------------------------------------------------------------------------------------------------

export interface LineSpendFacts {
  /** The line's value in minor units of its order's currency (quantity × unit price). */
  readonly netAmount: number
  readonly cancelled: boolean
  readonly closedShort: boolean
  /** The ordered quantity in the material's base unit, and what came of it (posted receipts). */
  readonly baseQuantity: string
  readonly receivedBase: string
}

/** A line's spend in its order's currency (minor units): none when cancelled; what came when closed short; else its value. */
export function lineSpendOf(line: LineSpendFacts): number {
  if (line.cancelled) return 0
  if (!line.closedShort) return line.netAmount
  const ordered = new Dec(line.baseQuantity)
  if (ordered.lte(0)) return 0
  const came = Dec.min(Dec.max(new Dec(line.receivedBase), 0), ordered)
  return Number.parseInt(new Dec(line.netAmount).times(came).div(ordered).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10)
}

export interface OrderCurrencyFacts {
  /** The order's currency and the company's. */
  readonly currency: string
  readonly companyCurrency: string
  /** The order's value in its currency and, for an order in another currency, in the company's at the rate of the order. */
  readonly netAmount: number
  readonly companyNetAmount: number | null
}

/**
 * A spend of an order in the company's currency (the rate of the order: companyNetAmount / netAmount), or in the order's own
 * currency when the order has no rate (counted apart, never summed with the company's).
 */
export function inCompanyCurrency(spend: number, order: OrderCurrencyFacts): { readonly currency: string; readonly spend: number } {
  if (order.currency === order.companyCurrency) return { currency: order.currency, spend }
  if (order.companyNetAmount === null || order.netAmount <= 0) return { currency: order.currency, spend }
  return { currency: order.companyCurrency, spend: Number.parseInt(new Dec(spend).times(order.companyNetAmount).div(order.netAmount).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10) }
}

// ---- the fold --------------------------------------------------------------------------------------------------------------

/** One line as the fold reads it: its order, its kind, its keys, its month and its spend. */
export interface SpendRow {
  readonly lineId: string
  readonly orderId: string
  readonly kind: SpendKind
  readonly keys: Readonly<Record<SpendGroup, string>>
  /** YYYY-MM of the order's placing. */
  readonly month: string
  readonly currency: string
  readonly spend: number
}

export interface CurrencySpend {
  readonly currency: string
  readonly production: number
  readonly samples: number
}

export interface SpendFigures {
  /** Per currency (one in nearly every company), the company's first. */
  readonly byCurrency: readonly CurrencySpend[]
  /** In `currency` when there is one; null when the group is in several. */
  readonly production: number | null
  readonly samples: number | null
  readonly currency: string | null
  readonly mixedCurrencies: boolean
  /** Distinct production orders and their lines; distinct sample orders and their lines. */
  readonly orders: number
  readonly lines: number
  readonly sampleOrders: number
  readonly sampleLines: number
}

/** The figures of some lines. */
export function figuresOf(rows: readonly SpendRow[], companyCurrency: string | null = null): SpendFigures {
  const currencies = new Map<string, { production: number; samples: number }>()
  const orders = new Set<string>()
  const sampleOrders = new Set<string>()
  let lines = 0
  let sampleLines = 0
  for (const row of rows) {
    const entry = currencies.get(row.currency) ?? { production: 0, samples: 0 }
    if (row.kind === 'production') {
      entry.production += row.spend
      orders.add(row.orderId)
      lines += 1
    } else {
      entry.samples += row.spend
      sampleOrders.add(row.orderId)
      sampleLines += 1
    }
    currencies.set(row.currency, entry)
  }
  const byCurrency = [...currencies.entries()]
    .map(([currency, entry]) => ({ currency, production: entry.production, samples: entry.samples }))
    .sort((a, b) => (a.currency === companyCurrency ? -1 : b.currency === companyCurrency ? 1 : a.currency.localeCompare(b.currency)))
  const one = byCurrency.length === 1 ? byCurrency[0]! : null
  return {
    byCurrency,
    production: one ? one.production : byCurrency.length === 0 ? 0 : null,
    samples: one ? one.samples : byCurrency.length === 0 ? 0 : null,
    currency: one ? one.currency : byCurrency.length === 0 ? companyCurrency : null,
    mixedCurrencies: byCurrency.length > 1,
    orders: orders.size,
    lines,
    sampleOrders: sampleOrders.size,
    sampleLines,
  }
}

export interface SpendGroupFigures {
  readonly key: string
  readonly figures: SpendFigures
  /** The group's figures per month of the period (the pivot's columns), in the period's order. */
  readonly months: readonly { readonly month: string; readonly figures: SpendFigures }[]
}

/**
 * The groups of some lines by one key, the largest production spend first when amounts may be seen (`byValue`), else the most
 * orders first (the order of the bars says nothing of an amount the reader may not see); then the key.
 */
export function groupsOf(rows: readonly SpendRow[], by: SpendGroup, months: readonly string[], options: { readonly byValue: boolean; readonly companyCurrency?: string | null }): SpendGroupFigures[] {
  const grouped = new Map<string, SpendRow[]>()
  for (const row of rows) grouped.set(row.keys[by], [...(grouped.get(row.keys[by]) ?? []), row])
  const currency = options.companyCurrency ?? null
  const groups = [...grouped.entries()].map(([key, members]) => ({
    key,
    figures: figuresOf(members, currency),
    months: months.map((month) => ({ month, figures: figuresOf(members.filter((row) => row.month === month), currency) })),
  }))
  const amount = (group: SpendGroupFigures) => group.figures.production ?? -1
  return groups.sort((a, b) => {
    if (by === 'month') return a.key.localeCompare(b.key)
    const first = options.byValue ? amount(b) - amount(a) || (b.figures.samples ?? 0) - (a.figures.samples ?? 0) : 0
    return first || b.figures.orders - a.figures.orders || b.figures.sampleOrders - a.figures.sampleOrders || a.key.localeCompare(b.key)
  })
}

/** part / whole as a percent with one decimal ("42.5"); null when the whole is nothing or not one currency. */
export function shareOf(part: number | null, whole: number | null): string | null {
  if (part === null || whole === null || whole <= 0) return null
  return new Dec(part).times(100).div(whole).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

/** The months (YYYY-MM) a period touches, in order. */
export function monthsOf(period: Period): string[] {
  const months: string[] = []
  let year = Number.parseInt(period.from.slice(0, 4), 10)
  let month = Number.parseInt(period.from.slice(5, 7), 10)
  const last = period.to.slice(0, 7)
  for (let guard = 0; guard < 24; guard += 1) {
    const text = `${year}-${String(month).padStart(2, '0')}`
    months.push(text)
    if (text >= last) break
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}

/** The month (YYYY-MM) of a business day. */
export const monthOf = (day: BusinessDate): string => day.slice(0, 7)

// ---- the supply alerts (SCM-174; factory-domain alerts/kinds PO_CONFIRMED_LATE, SUPPLIER_STATUS_CHANGED) ---------------------

/**
 * The supplier statuses a SUPPLIER_STATUS_CHANGED alert tells the buyer of: those that limit or stop buying (B-W2b-311's
 * newOrderProblem: on hold, blocked and inactive take no new order; approved with conditions buys under its conditions). Back to
 * approved (or prospect) is no alert: the open one clears.
 */
export const SUPPLY_ALERT_STATUSES = ['CONDITIONAL', 'ON_HOLD', 'BLOCKED', 'INACTIVE'] as const

/** The order states with goods still to come (the expediting worklist's), and those not sent yet. */
export const OPEN_ORDER_STATUSES = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED'] as const
export const UNSENT_ORDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL'] as const

export interface ConfirmedLateLine {
  readonly seq: number
  readonly needDate: BusinessDate
  readonly confirmedDate: BusinessDate | null
  /** The delivery the line waits for next (B-W2b-296's schedule), when it has one. */
  readonly nextDelivery: { readonly needDate: BusinessDate; readonly confirmedDate: BusinessDate | null } | null
  /** The most days the line (or one of its deliveries) is confirmed later than asked. */
  readonly confirmedLaterBy: number
}

const later = (needDate: BusinessDate, confirmedDate: BusinessDate | null): number =>
  confirmedDate === null || confirmedDate <= needDate ? 0 : Math.round((Date.parse(`${confirmedDate}T00:00:00Z`) - Date.parse(`${needDate}T00:00:00Z`)) / 86_400_000)

/**
 * The line an order's PO_CONFIRMED_LATE alert names: the one confirmed the most days later than needed (then the earliest day
 * needed, then the line number), with the dates that say it — its next delivery's when that is the later one, else its own.
 */
export function worstConfirmedLate(lines: readonly ConfirmedLateLine[]): { readonly line: ConfirmedLateLine; readonly needDate: BusinessDate; readonly confirmedDate: BusinessDate; readonly days: number } | null {
  const ranked = lines
    .map((line) => {
      const own = later(line.needDate, line.confirmedDate)
      const next = line.nextDelivery ? later(line.nextDelivery.needDate, line.nextDelivery.confirmedDate) : 0
      const dates = next > own && line.nextDelivery?.confirmedDate ? { needDate: line.nextDelivery.needDate, confirmedDate: line.nextDelivery.confirmedDate } : line.confirmedDate ? { needDate: line.needDate, confirmedDate: line.confirmedDate } : null
      return dates ? { line, ...dates, days: Math.max(own, next) } : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.days > 0)
    .sort((a, b) => b.days - a.days || a.needDate.localeCompare(b.needDate) || a.line.seq - b.line.seq)
  return ranked[0] ?? null
}
