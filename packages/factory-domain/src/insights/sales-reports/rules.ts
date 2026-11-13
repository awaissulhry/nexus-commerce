import { plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { lastMonthOf, periodOf, periodProblems, spanOf, type Period } from '../../inventory/reports/rules'
import { isoWeekKey, uniformBuckets, weekStart } from '../../planning/settings/buckets'
import { Dec } from '../../tax/decimal'

/**
 * Sales reports (B-W2b-348; design sales.reports SCR-250: sec strip, sec intake, sec backlog, sec returns, pop arrange, tab
 * print; Sales › Quotes sec quotes.speed; SAL-105 order intake, SAL-106 backlog, SAL-458 return reason analysis), the rules,
 * pure. The API reads the orders, lines, returns and quotes the caller reaches and folds them here.
 *
 *   intake    the orders BOOKED in the period: confirmed (an order waiting for a yes, PENDING_APPROVAL, is not intake until it
 *             is confirmed; it then counts on its order date), never cancelled, never a return's replacement order (no new
 *             sale); at their value now (net, before VAT: an amended order counts as it stands). An order split off another
 *             (B-W2b-303) is booked on the day its first order was. Pieces are the garment lines' (a fee line has value,
 *             no pieces). By week (ISO, Monday first) or month of the booking; split by customer, style or season.
 *   backlog   what is confirmed and not shipped (SAL-106): the open orders (CONFIRMED, IN_PRODUCTION, READY, PARTLY_SHIPPED),
 *             each garment line's sizes less what shipped and less a line closed short, each size at its promise NOW
 *             (B-W2b-301's currentPromiseOf; never re-dated here), by the ISO week of that promise; late = a promise before
 *             today. Value = the open pieces' share of the line's net value.
 *   returns   the lines of the returns asked for in the period (requestedAt), not rejected or cancelled: pieces asked back,
 *             by reason (the RETURN reason list's code), style, size, colour and customer; the return rate = those pieces ÷
 *             the pieces shipped in the period. Reason groups do not exist yet (ReasonCode has no group: a schema need).
 *   quotes    "new to sent": from the inquiry's arrival (B-W2b-295, when the quote came from one) else the quote's making,
 *             to its first send, in working minutes on the company's calendar, for the quotes first sent in the period;
 *             "sent to decision": from the decided version's send to the customer's answer, in hours; win rate = accepted ÷
 *             decided (accepted + declined; an expired quote is counted apart, never decided); value won = the accepted
 *             versions' net value (price grain).
 *
 * Amounts are minor units of their currency, never summed across currencies (`byCurrency` lists each). No person anywhere.
 */

export { lastMonthOf, periodOf, periodProblems, spanOf, type Period }

export const INTAKE_BUCKETS = ['week', 'month'] as const
export type IntakeBucket = (typeof INTAKE_BUCKETS)[number]

export const INTAKE_SPLITS = ['none', 'customer', 'style', 'season'] as const
export type IntakeSplit = (typeof INTAKE_SPLITS)[number]

export const BACKLOG_GROUPS = ['customer', 'style'] as const
export type BacklogGroup = (typeof BACKLOG_GROUPS)[number]

export const RETURN_GROUPS = ['reason', 'style', 'size', 'colour', 'customer'] as const
export type ReturnGroup = (typeof RETURN_GROUPS)[number]

/** The order states that are intake: booked and not given up (waiting for a yes or cancelled is none). */
export const INTAKE_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'CLOSED'] as const

/** The order states of the backlog: confirmed, not shipped (B-W2b-317's demand states). */
export const BACKLOG_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

/** The return states that count: asked for and not turned down or cancelled. */
export const RETURN_STATUSES = ['REQUESTED', 'AUTHORISED', 'RECEIVED', 'INSPECTED', 'CLOSED'] as const

/** The backlog's horizons in the table by customer and style. */
export const BACKLOG_HORIZONS = ['late', 'thisWeek', 'next4', 'later', 'none'] as const
export type BacklogHorizon = (typeof BACKLOG_HORIZONS)[number]

/** Group keys that are not a record: no season, no colour or size known, the fee lines of an order. */
export const NO_KEY = 'none'
export const FEES_KEY = 'fees'

export const SALES_REPORT_LIMITS = Object.freeze({
  /** At most this many records read for one answer (`complete` says when there were more). */
  read: 5000,
  /** At most this many groups in an answer (`more` counts the rest; the totals count them all). */
  groups: 50,
  /** At most this many rows behind the bars (the drill; `complete` says when there were more). */
  rows: 2000,
  /** The backlog's weeks on show: this many back (late) and ahead; earlier and later are folded. */
  weeksBack: 8,
  weeksAhead: 12,
  /** The heatmap's styles (the most returned). */
  heatmapStyles: 12,
})

// ---- money -----------------------------------------------------------------------------------------------------------------

export interface CurrencyValue {
  readonly currency: string
  readonly value: number
}

export interface ValueFigures {
  /** Each currency's total (the company's first, then by code). */
  readonly byCurrency: CurrencyValue[]
  /** The total when every amount is in one currency; null when in several (then `byCurrency` says each) or none. */
  readonly value: number | null
  readonly currency: string | null
  readonly mixedCurrencies: boolean
}

/** Amounts summed per currency, never across. */
export function valueFiguresOf(entries: readonly CurrencyValue[], companyCurrency: string | null): ValueFigures {
  const sums = new Map<string, number>()
  for (const entry of entries) sums.set(entry.currency, (sums.get(entry.currency) ?? 0) + entry.value)
  const byCurrency = [...sums.entries()]
    .map(([currency, value]) => ({ currency, value }))
    .sort((a, b) => (a.currency === companyCurrency ? -1 : b.currency === companyCurrency ? 1 : a.currency.localeCompare(b.currency)))
  const one = byCurrency.length === 1 ? byCurrency[0]! : null
  return { byCurrency, value: one ? one.value : byCurrency.length === 0 ? 0 : null, currency: one ? one.currency : byCurrency.length === 0 ? companyCurrency : null, mixedCurrencies: byCurrency.length > 1 }
}

/** A share of a whole, one decimal ("12.5"); null without a whole. */
export function pctOf(part: number, whole: number): string | null {
  if (!(whole > 0)) return null
  return new Dec(part).div(whole).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

/** The median of some numbers (the mean of the two middle ones for an even count, rounded); null for none. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

/** The open share of a line's net value: its net value × open ÷ ordered, rounded half up (minor units). */
export function openValueOf(netAmount: number, ordered: number, open: number): number {
  if (!(ordered > 0) || !(open > 0)) return 0
  if (open >= ordered) return netAmount
  return Number.parseInt(new Dec(netAmount).times(open).div(ordered).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10)
}

// ---- periods ---------------------------------------------------------------------------------------------------------------

export interface ReportBucket {
  /** 2026-W46 (an ISO week) or 2026-11 (a month). */
  readonly key: string
  /** Its days inside the period (clipped). */
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The period's weeks or months, clipped to the period. */
export function intakeBucketsOf(period: Period, by: IntakeBucket): ReportBucket[] {
  return uniformBuckets(period.from, period.to, by === 'week' ? 'WEEK' : 'MONTH').map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to }))
}

/** The bucket a day falls in (null: none). */
export function bucketOfDay(buckets: readonly ReportBucket[], day: BusinessDate): string | null {
  for (const bucket of buckets) if (day >= bucket.from && day <= bucket.to) return bucket.key
  return null
}

// ---- intake (SAL-105) ------------------------------------------------------------------------------------------------------

/** One order line of an order booked in the period. */
export interface IntakeLine {
  readonly orderId: string
  /** The day it is booked on (its order date, or its first order's for an order split off another). */
  readonly bookedOn: BusinessDate
  readonly customer: string
  /** The style, or FEES_KEY for a fee line. */
  readonly style: string
  /** The order's season, or NO_KEY. */
  readonly season: string
  /** Garment pieces (0 for a fee line). */
  readonly pieces: number
  /** Net value in minor units of `currency`. */
  readonly value: number
  readonly currency: string
}

export interface IntakeFigures extends ValueFigures {
  /** Distinct orders. */
  readonly orders: number
  readonly pieces: number
}

export interface IntakeGroup {
  readonly key: string
  readonly figures: IntakeFigures
  readonly buckets: { readonly key: string; readonly figures: IntakeFigures }[]
}

export interface IntakeFold {
  readonly all: IntakeFigures
  readonly buckets: { readonly key: string; readonly from: BusinessDate; readonly to: BusinessDate; readonly figures: IntakeFigures }[]
  /** Ranked: by value for a reader who may see amounts (one currency), else by pieces; then by key. Empty for `none`. */
  readonly groups: IntakeGroup[]
}

export function intakeFiguresOf(lines: readonly IntakeLine[], companyCurrency: string | null): IntakeFigures {
  return { orders: new Set(lines.map((line) => line.orderId)).size, pieces: lines.reduce((sum, line) => sum + line.pieces, 0), ...valueFiguresOf(lines, companyCurrency) }
}

const splitKeyOf = (line: IntakeLine, split: Exclude<IntakeSplit, 'none'>): string => (split === 'customer' ? line.customer : split === 'style' ? line.style : line.season)

/** Rank groups: by value when amounts may be seen and the groups share one currency, else by pieces; then orders, then key. */
function rankGroups<T extends { key: string; figures: { pieces: number; value: number | null; orders?: number } }>(groups: T[], byValue: boolean): T[] {
  return groups.sort((a, b) => {
    if (byValue && a.figures.value !== null && b.figures.value !== null && a.figures.value !== b.figures.value) return b.figures.value - a.figures.value
    if (a.figures.pieces !== b.figures.pieces) return b.figures.pieces - a.figures.pieces
    const orders = (b.figures.orders ?? 0) - (a.figures.orders ?? 0)
    return orders !== 0 ? orders : a.key.localeCompare(b.key)
  })
}

/** The intake of the period by bucket, and per group of the split (each per bucket too). */
export function intakeFold(lines: readonly IntakeLine[], buckets: readonly ReportBucket[], split: IntakeSplit, options: { readonly byValue: boolean; readonly companyCurrency: string | null }): IntakeFold {
  const inBucket = (key: string) => lines.filter((line) => bucketOfDay(buckets, line.bookedOn) === key)
  const all = intakeFiguresOf(lines, options.companyCurrency)
  const perBucket = buckets.map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to, figures: intakeFiguresOf(inBucket(bucket.key), options.companyCurrency) }))
  if (split === 'none') return { all, buckets: perBucket, groups: [] }
  const byKey = new Map<string, IntakeLine[]>()
  for (const line of lines) {
    const key = splitKeyOf(line, split)
    byKey.set(key, [...(byKey.get(key) ?? []), line])
  }
  const groups = [...byKey.entries()].map(([key, own]) => ({
    key,
    figures: intakeFiguresOf(own, options.companyCurrency),
    buckets: buckets.map((bucket) => ({ key: bucket.key, figures: intakeFiguresOf(own.filter((line) => bucketOfDay(buckets, line.bookedOn) === bucket.key), options.companyCurrency) })),
  }))
  return { all, buckets: perBucket, groups: rankGroups(groups, options.byValue && !all.mixedCurrencies) }
}

/**
 * The day an order is booked on: its order date, unless it was split off another order (B-W2b-303's split writes the new
 * order with today's date): then its first order's booking day, followed back through earlier splits (at most 20 steps).
 */
export function bookedOnOf(orderId: string, orders: ReadonlyMap<string, { readonly orderDate: BusinessDate; readonly splitFrom: string | null }>): BusinessDate | null {
  let current = orders.get(orderId)
  if (!current) return null
  for (let step = 0; step < 20 && current.splitFrom; step += 1) {
    const source = orders.get(current.splitFrom)
    if (!source) break
    current = source
  }
  return current.orderDate
}

// ---- backlog (SAL-106) -----------------------------------------------------------------------------------------------------

/** One open size of a backlog line. */
export interface BacklogPiece {
  readonly orderId: string
  readonly lineId: string
  readonly customer: string
  readonly style: string
  /** Open pieces (ordered less shipped). */
  readonly open: number
  /** Their share of the line's net value (minor units of `currency`). */
  readonly value: number
  readonly currency: string
  /** The size's promise now (null: none). */
  readonly promise: BusinessDate | null
}

export interface BacklogFigures extends ValueFigures {
  readonly orders: number
  readonly lines: number
  readonly pieces: number
  /** Pieces whose promise is before today. */
  readonly late: number
}

export const BACKLOG_WEEK_KINDS = ['EARLIER', 'WEEK', 'LATER', 'NONE'] as const
export type BacklogWeekKind = (typeof BACKLOG_WEEK_KINDS)[number]

export interface BacklogWeek {
  /** An ISO week (2026-W46), or EARLIER / LATER (folded weeks) / NONE (no promise). */
  readonly key: string
  readonly kind: BacklogWeekKind
  /** Its days (null for NONE; EARLIER: up to the day before the first week; LATER: from the day after the last). */
  readonly from: BusinessDate | null
  readonly to: BusinessDate | null
  /** Every day of it is before today (late). */
  readonly past: boolean
  /** It holds today. */
  readonly current: boolean
}

export function backlogFiguresOf(pieces: readonly BacklogPiece[], today: BusinessDate, companyCurrency: string | null): BacklogFigures {
  return {
    orders: new Set(pieces.map((piece) => piece.orderId)).size,
    lines: new Set(pieces.map((piece) => piece.lineId)).size,
    pieces: pieces.reduce((sum, piece) => sum + piece.open, 0),
    late: pieces.reduce((sum, piece) => sum + (piece.promise !== null && piece.promise < today ? piece.open : 0), 0),
    ...valueFiguresOf(pieces, companyCurrency),
  }
}

/**
 * The weeks on show: from the earliest promise's week (at most `weeksBack` before this week) to the latest's (at least this
 * week, at most `weeksAhead` after it); promises before or after are folded into EARLIER / LATER, no promise into NONE.
 */
export function backlogWeeksOf(pieces: readonly Pick<BacklogPiece, 'promise'>[], today: BusinessDate, limits: { readonly weeksBack: number; readonly weeksAhead: number } = SALES_REPORT_LIMITS): BacklogWeek[] {
  const monday = weekStart(today)
  const dates = pieces.map((piece) => piece.promise).filter((date): date is BusinessDate => date !== null)
  const earliest = dates.length > 0 ? weekStart(dates.reduce((a, b) => (a < b ? a : b))) : monday
  const latest = dates.length > 0 ? weekStart(dates.reduce((a, b) => (a > b ? a : b))) : monday
  const floor = plusDays(monday, -7 * limits.weeksBack)
  const ceiling = plusDays(monday, 7 * limits.weeksAhead)
  const first = earliest < floor ? floor : earliest > monday ? monday : earliest
  const last = latest > ceiling ? ceiling : latest < monday ? monday : latest
  const weeks: BacklogWeek[] = []
  if (dates.some((date) => date < first)) weeks.push({ key: 'EARLIER', kind: 'EARLIER', from: null, to: plusDays(first, -1), past: true, current: false })
  for (let cursor = first; cursor <= last; cursor = plusDays(cursor, 7)) {
    const sunday = plusDays(cursor, 6)
    weeks.push({ key: isoWeekKey(cursor), kind: 'WEEK', from: cursor, to: sunday, past: sunday < today, current: cursor <= today && today <= sunday })
  }
  const end = plusDays(last, 6)
  if (dates.some((date) => date > end)) weeks.push({ key: 'LATER', kind: 'LATER', from: plusDays(end, 1), to: null, past: false, current: false })
  if (pieces.some((piece) => piece.promise === null)) weeks.push({ key: 'NONE', kind: 'NONE', from: null, to: null, past: false, current: false })
  return weeks
}

/** The week a promise falls in (NONE for no promise). */
export function backlogWeekOf(weeks: readonly BacklogWeek[], promise: BusinessDate | null): string {
  if (promise === null) return 'NONE'
  for (const week of weeks) {
    if (week.kind === 'WEEK' && week.from! <= promise && promise <= week.to!) return week.key
    if (week.kind === 'EARLIER' && promise <= week.to!) return week.key
    if (week.kind === 'LATER' && promise >= week.from!) return week.key
  }
  return 'NONE'
}

/** The table's horizon of a promise: late (before today), this week (today to Sunday), the next 4 weeks, later, none. */
export function horizonOf(promise: BusinessDate | null, today: BusinessDate): BacklogHorizon {
  if (promise === null) return 'none'
  if (promise < today) return 'late'
  const sunday = plusDays(weekStart(today), 6)
  if (promise <= sunday) return 'thisWeek'
  if (promise <= plusDays(sunday, 28)) return 'next4'
  return 'later'
}

export interface BacklogGroupFold {
  readonly key: string
  readonly figures: BacklogFigures
  /** Pieces per horizon (late, this week, next 4 weeks, later, no promise). */
  readonly horizons: Record<BacklogHorizon, number>
}

/** The backlog by customer or style: each group's figures and its pieces per horizon; ranked as the intake's groups. */
export function backlogGroupsOf(pieces: readonly BacklogPiece[], by: BacklogGroup, today: BusinessDate, options: { readonly byValue: boolean; readonly companyCurrency: string | null }): BacklogGroupFold[] {
  const byKey = new Map<string, BacklogPiece[]>()
  for (const piece of pieces) {
    const key = by === 'customer' ? piece.customer : piece.style
    byKey.set(key, [...(byKey.get(key) ?? []), piece])
  }
  const groups = [...byKey.entries()].map(([key, own]) => {
    const horizons = Object.fromEntries(BACKLOG_HORIZONS.map((horizon) => [horizon, 0])) as Record<BacklogHorizon, number>
    for (const piece of own) horizons[horizonOf(piece.promise, today)] += piece.open
    return { key, figures: backlogFiguresOf(own, today, options.companyCurrency), horizons }
  })
  const mixed = valueFiguresOf(pieces, options.companyCurrency).mixedCurrencies
  return rankGroups(groups, options.byValue && !mixed)
}

// ---- returns (SAL-458) -----------------------------------------------------------------------------------------------------

/** One line of a return asked for in the period. */
export interface ReturnEntry {
  readonly returnId: string
  readonly lineId: string
  readonly reason: string
  /** Style, colour and size when the line names its order line (else NO_KEY). */
  readonly style: string
  readonly colour: string
  readonly size: string
  readonly customer: string
  readonly pieces: number
  /** The credit decided (minor units) and its currency; null: not decided yet. */
  readonly credited: CurrencyValue | null
}

export interface ReturnFigures extends ValueFigures {
  readonly returns: number
  readonly lines: number
  readonly pieces: number
}

export function returnFiguresOf(entries: readonly ReturnEntry[], companyCurrency: string | null): ReturnFigures {
  return {
    returns: new Set(entries.map((entry) => entry.returnId)).size,
    lines: entries.length,
    pieces: entries.reduce((sum, entry) => sum + entry.pieces, 0),
    ...valueFiguresOf(
      entries.flatMap((entry) => (entry.credited ? [entry.credited] : [])),
      companyCurrency,
    ),
  }
}

/** The returns grouped one way, the most pieces first (then the most returns, then the key). */
export function returnGroupsOf(entries: readonly ReturnEntry[], by: ReturnGroup, companyCurrency: string | null): { key: string; figures: ReturnFigures }[] {
  const byKey = new Map<string, ReturnEntry[]>()
  for (const entry of entries) byKey.set(entry[by], [...(byKey.get(entry[by]) ?? []), entry])
  return [...byKey.entries()]
    .map(([key, own]) => ({ key, figures: returnFiguresOf(own, companyCurrency) }))
    .sort((a, b) => b.figures.pieces - a.figures.pieces || b.figures.returns - a.figures.returns || a.key.localeCompare(b.key))
}

const LETTER_SIZES = ['XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL']

/** Sizes in wearing order: letter sizes small to large, then numbers rising, then the rest by name; unknown last. */
export function sizeOrder(a: string, b: string): number {
  if (a === b) return 0
  if (a === NO_KEY) return 1
  if (b === NO_KEY) return -1
  const la = LETTER_SIZES.indexOf(a.toUpperCase())
  const lb = LETTER_SIZES.indexOf(b.toUpperCase())
  if (la >= 0 && lb >= 0) return la - lb
  if (la >= 0) return -1
  if (lb >= 0) return 1
  const na = Number(a.replace(',', '.'))
  const nb = Number(b.replace(',', '.'))
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  if (Number.isFinite(na)) return -1
  if (Number.isFinite(nb)) return 1
  return a.localeCompare(b)
}

export interface ReturnHeatmap {
  /** The most returned styles (at most `heatmapStyles`), the most first. */
  readonly styles: string[]
  /** Every size of their returns, in wearing order. */
  readonly sizes: string[]
  /** Pieces per style (row) and size (column); null where nothing came back. */
  readonly cells: (number | null)[][]
}

/** The heatmap model × size of the most returned styles. */
export function returnHeatmapOf(entries: readonly ReturnEntry[], limit: number = SALES_REPORT_LIMITS.heatmapStyles): ReturnHeatmap {
  const styles = returnGroupsOf(entries, 'style', null)
    .map((group) => group.key)
    .filter((key) => key !== NO_KEY)
    .slice(0, limit)
  const shown = entries.filter((entry) => styles.includes(entry.style))
  const sizes = [...new Set(shown.map((entry) => entry.size))].sort(sizeOrder)
  const cells = styles.map((style) =>
    sizes.map((size) => {
      const pieces = shown.filter((entry) => entry.style === style && entry.size === size).reduce((sum, entry) => sum + entry.pieces, 0)
      return pieces > 0 ? pieces : null
    }),
  )
  return { styles, sizes, cells }
}

// ---- quote speed ------------------------------------------------------------------------------------------------------------

export const QUOTE_OUTCOMES = ['ACCEPTED', 'DECLINED', 'EXPIRED'] as const
export type QuoteOutcome = (typeof QUOTE_OUTCOMES)[number]

export interface QuoteDecision {
  readonly outcome: QuoteOutcome
  /** Hours from the version's send to the answer (null: not known). */
  readonly hours: number | null
  /** The version's net value (minor units of `currency`). */
  readonly value: number
  readonly currency: string
}

export interface QuoteSpeedFigures {
  /** Quotes first sent in the period, and the median working minutes from new to sent (of those whose company has a calendar). */
  readonly answered: number
  readonly medianAnswerMinutes: number | null
  /** Of them, made from an inquiry (counted from its arrival). */
  readonly fromInquiries: number
  readonly accepted: number
  readonly declined: number
  readonly expired: number
  /** accepted ÷ (accepted + declined), one decimal; null when nothing was decided. */
  readonly winRatePct: string | null
  /** Median hours from sent to the customer's answer (accepted or declined). */
  readonly medianDecisionHours: number | null
  /** The accepted versions' value. */
  readonly won: ValueFigures
}

export function quoteSpeedOf(answers: readonly { readonly minutes: number | null; readonly fromInquiry: boolean }[], decisions: readonly QuoteDecision[], companyCurrency: string | null): QuoteSpeedFigures {
  const accepted = decisions.filter((decision) => decision.outcome === 'ACCEPTED')
  const declined = decisions.filter((decision) => decision.outcome === 'DECLINED').length
  const decidedHours = decisions.filter((decision) => decision.outcome !== 'EXPIRED' && decision.hours !== null).map((decision) => decision.hours!)
  return {
    answered: answers.length,
    medianAnswerMinutes: medianOf(answers.flatMap((answer) => (answer.minutes === null ? [] : [answer.minutes]))),
    fromInquiries: answers.filter((answer) => answer.fromInquiry).length,
    accepted: accepted.length,
    declined,
    expired: decisions.filter((decision) => decision.outcome === 'EXPIRED').length,
    winRatePct: pctOf(accepted.length, accepted.length + declined),
    medianDecisionHours: medianOf(decidedHours),
    won: valueFiguresOf(accepted, companyCurrency),
  }
}
