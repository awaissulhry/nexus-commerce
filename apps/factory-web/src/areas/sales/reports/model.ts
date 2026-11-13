import type { SectionSpec } from '@nexus/ui/patterns'
import type { Locale } from '../../../lib/i18n/locales'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { csvOf, money } from '../../_shared/stock/model'
import { monthText } from '../../purchasing/reports/model'
import { pctText, weekLabel, weekShort } from '../../planning/reports/model'
import { dateOfDay, dayOfDate, lastMonth, QUICK_PERIODS, quickRange, romeToday, thisMonth, type QuickPeriod } from '../../warehouse/reports/model'
import {
  BACKLOG_GROUPS,
  BACKLOG_HORIZONS,
  FEES_KEY,
  INTAKE_BUCKETS,
  INTAKE_SPLITS,
  NO_KEY,
  RETURN_GROUPS,
  type Backlog,
  type BacklogGroup,
  type BacklogHorizon,
  type BacklogLine,
  type BacklogWeek,
  type Intake,
  type IntakeBucket,
  type IntakeOrder,
  type IntakeSplit,
  type ReturnGroup,
  type ReturnLineRow,
  type Returns,
  type ValueFigures,
} from './api'

/**
 * The pure rules of Sales › Reports (B-W2b-348, SCR-250 and its print view SCR-427): what this person may open (from the
 * session's permissions; the API checks every read again), the address (`?from=&to=&by=&split=&backlog=&also=`; the company is
 * the top bar's), the panels (Arrange), the words of the figures, the chart rows, the records behind a bar ("what this number
 * counts", filtered from the panel's own answer), where a row leads, the CSV files and the live events. Money only with the
 * price grain; no person anywhere.
 */

export { csvOf, dateOfDay, dayOfDate, lastMonth, monthText, pctText, QUICK_PERIODS, quickRange, romeToday, thisMonth, weekLabel, weekShort, type QuickPeriod }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** sales.reports.view: the page. */
  view: boolean
  /** orders.view, quotes.view, sales.returns.view: the records behind the figures. */
  orders: boolean
  quotes: boolean
  returns: boolean
  /** money.price: amounts. */
  price: boolean
}

export function reportsCan(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return { view: held.has('sales.reports.view'), orders: held.has('orders.view'), quotes: held.has('quotes.view'), returns: held.has('sales.returns.view'), price: held.has('money.price') }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

/** The returns panel's second view ("also by"): every grouping but the reasons (always shown). */
export const ALSO_BY = ['style', 'size', 'colour', 'customer'] as const
export type AlsoBy = (typeof ALSO_BY)[number]

export interface ReportsAddress {
  from: string | null
  to: string | null
  /** The intake's buckets (week, month) and its split (none, customer, style, season). */
  by: IntakeBucket
  split: IntakeSplit
  /** The backlog table's rows (customer, style). */
  backlog: BacklogGroup
  /** The returns panel's second bars. */
  also: AlsoBy
}

const dayOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)
const oneOf = <T extends string>(value: string | null | undefined, choices: readonly T[], fallback: T): T => (value && (choices as readonly string[]).includes(value) ? (value as T) : fallback)

export function reportsAddressOf(params: { get(name: string): string | null } | null | undefined): ReportsAddress {
  return {
    from: dayOr(params?.get('from')),
    to: dayOr(params?.get('to')),
    by: oneOf(params?.get('by'), INTAKE_BUCKETS, 'week'),
    split: oneOf(params?.get('split'), INTAKE_SPLITS, 'none'),
    backlog: oneOf(params?.get('backlog'), BACKLOG_GROUPS, 'customer'),
    also: oneOf(params?.get('also'), ALSO_BY, 'style'),
  }
}

export function reportsAddressText(address: Partial<ReportsAddress>): string {
  const terms = new URLSearchParams()
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  if (address.by && address.by !== 'week') terms.set('by', address.by)
  if (address.split && address.split !== 'none') terms.set('split', address.split)
  if (address.backlog && address.backlog !== 'customer') terms.set('backlog', address.backlog)
  if (address.also && address.also !== 'style') terms.set('also', address.also)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** The period on show: the address's, else what the API answered, else this month so far. */
export function rangeShown(address: Pick<ReportsAddress, 'from' | 'to'>, answer: { from: string; to: string } | null, today: string): { from: string; to: string } {
  const fallback = thisMonth(today)
  return { from: address.from ?? answer?.from ?? fallback.from, to: address.to ?? answer?.to ?? fallback.to }
}

/** The print view's address (a new tab; the browser prints it or saves the PDF), with what is on show. */
export const printAddress = (prefix: string, address: ReportsAddress, range: { from: string; to: string }): string => `${prefix}/sales/reports/print${reportsAddressText({ ...address, ...range })}`

/** Sales reports for a period (Quote speed's tiles open them filtered the same way). */
export const reportsHref = (prefix: string, range: { from: string; to: string }): string => `${prefix}/sales/reports${reportsAddressText(range)}`

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

/** The design's W2b sections (sec strip, intake, backlog, returns), in its order (conversion and claim cost are Later). */
export const REPORT_SECTIONS = ['strip', 'intake', 'backlog', 'returns'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]
export const LAYOUT_KEY = 'sales.reports.layout'

/** Every panel full width at first (no dead space on the right); Arrange changes the order, what shows and the widths. */
export const sectionSpecs = (label: (id: string) => string): SectionSpec[] => REPORT_SECTIONS.map((id) => ({ id, label: label(id), defaultWidth: 'full' as const }))

// ---- words -------------------------------------------------------------------------------------------------------------------

const numberFormat = (locale: Locale, digits = 0) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** A count ("1.234"). */
export const countText = (value: number, locale: Locale): string => numberFormat(locale).format(value)

/** The figures' amount: one currency as "€ 1.234,50", several each ("€ 1.000,00 · $ 200,00"); without the grain "—". */
export function valueText(figures: Pick<ValueFigures, 'byCurrency' | 'value' | 'currency' | 'mixedCurrencies'>, locale: Locale): string {
  if (figures.mixedCurrencies) {
    const parts = figures.byCurrency.flatMap((entry) => (typeof entry.value === 'number' ? [money(entry.value, entry.currency, locale)] : []))
    return parts.length > 0 ? parts.join(' · ') : '—'
  }
  return typeof figures.value === 'number' ? money(figures.value, figures.currency, locale) : '—'
}

/** The figures carry an amount (the price grain, one currency): a chart can draw it. */
export const hasValue = (figures: Pick<ValueFigures, 'value' | 'mixedCurrencies'>): boolean => !figures.mixedCurrencies && typeof figures.value === 'number'

/** Working minutes as "45 min", "3,5 h", or working days of 8 hours ("2,1 days" is said by the caller's words). */
export function workingTime(minutes: number | null, locale: Locale): { unit: 'minutes' | 'hours' | 'days'; value: string } | null {
  if (minutes === null) return null
  if (minutes < 60) return { unit: 'minutes', value: numberFormat(locale).format(minutes) }
  if (minutes < 8 * 60 * 2) return { unit: 'hours', value: numberFormat(locale, 1).format(minutes / 60) }
  return { unit: 'days', value: numberFormat(locale, 1).format(minutes / 480) }
}

/** Hours as days with one decimal once past two days ("6,5"), else hours. */
export function elapsed(hours: number | null, locale: Locale): { unit: 'hours' | 'days'; value: string } | null {
  if (hours === null) return null
  if (hours < 48) return { unit: 'hours', value: numberFormat(locale).format(hours) }
  return { unit: 'days', value: numberFormat(locale, 1).format(hours / 24) }
}

/** A bucket's label: a week "W46 · 9 – 15 nov", a month "novembre 2026". */
export const bucketLabel = (bucket: { key: string; from: string; to: string }, locale: Locale): string => (bucket.key.includes('W') ? weekLabel(bucket, locale) : monthText(bucket.key, locale))
/** A bucket's short label for a chart axis ("W46", "nov 2026"). */
export const bucketShort = (key: string, locale: Locale): string => (key.includes('W') ? weekShort(key) : new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}-15T12:00:00Z`)))

/** A backlog week's label: an ISO week with its days, or the folded ones and "no promise" (words from the caller). */
export function backlogWeekLabel(week: Pick<BacklogWeek, 'key' | 'kind' | 'from' | 'to'>, locale: Locale, words: { earlier: (to: string) => string; later: (from: string) => string; none: string }): string {
  if (week.kind === 'NONE') return words.none
  if (week.kind === 'EARLIER') return words.earlier(week.to ?? '')
  if (week.kind === 'LATER') return words.later(week.from ?? '')
  return weekLabel({ key: week.key, from: week.from!, to: week.to! }, locale)
}
export const backlogWeekShort = (week: Pick<BacklogWeek, 'key' | 'kind'>, words: { earlier: string; later: string; none: string }): string => (week.kind === 'WEEK' ? weekShort(week.key) : week.kind === 'EARLIER' ? words.earlier : week.kind === 'LATER' ? words.later : words.none)

/** A group's name: a record's code and name, or the words of a key that is none (no season, fee lines, unknown). */
export function groupName(group: { key: string; code: string | null; name: string | null }, words: { none: string; fees: string }): string {
  if (group.key === FEES_KEY) return words.fees
  if (group.key === NO_KEY || (!group.code && !group.name)) return words.none
  return [group.code, group.name].filter(Boolean).join(' · ')
}

/** A return reason in the reader's language (the list's words; a code no longer listed is shown as its code). */
export const reasonWords = (reason: { key: string; words: { it: string; en: string } | null }, locale: Locale): string => (reason.words ? reason.words[locale === 'it' ? 'it' : 'en'] : reason.key)

// ---- charts ------------------------------------------------------------------------------------------------------------------

/** The intake chart stacks its split's largest groups; the rest are "Others". */
export const STACK_GROUPS = 5
export const OTHERS = '__others'

export interface StackPart {
  readonly key: string
  readonly label: string
}

/** The stack's parts: the split's first groups (as ranked) and Others when more. */
export function stackParts(answer: Intake, label: (group: Intake['groups'][number]) => string, others: string): StackPart[] {
  if (answer.split === 'none') return []
  const first = answer.groups.slice(0, STACK_GROUPS).map((group) => ({ key: group.key, label: label(group) }))
  return answer.groups.length > STACK_GROUPS || answer.more > 0 ? [...first, { key: OTHERS, label: others }] : first
}

/** The measure the bars show: the value with the price grain in one currency, else pieces. */
export const intakeMeasure = (answer: Pick<Intake, 'all' | 'sight'>): 'value' | 'pieces' => (answer.sight.values && hasValue(answer.all) ? 'value' : 'pieces')

const measureOf = (figures: Intake['all'], measure: 'value' | 'pieces'): number => (measure === 'value' ? (figures.value ?? 0) / 100 : figures.pieces)

/** The chart rows: one per bucket — the bars (the measure, or one part per stacked group) and the orders booked (a line). */
export function intakeChartRows(answer: Intake, parts: readonly StackPart[], measure: 'value' | 'pieces', locale: Locale): Record<string, number | string>[] {
  return answer.buckets.map((bucket) => {
    const row: Record<string, number | string> = { bucket: bucketShort(bucket.key, locale), orders: bucket.figures.orders, total: measureOf(bucket.figures, measure) }
    if (parts.length > 0) {
      let shown = 0
      for (const part of parts) {
        if (part.key === OTHERS) continue
        const figures = answer.groups.find((group) => group.key === part.key)?.buckets.find((entry) => entry.key === bucket.key)?.figures
        const value = figures ? measureOf(figures, measure) : 0
        row[part.key] = value
        shown += value
      }
      if (parts.some((part) => part.key === OTHERS)) row[OTHERS] = Math.max(0, measureOf(bucket.figures, measure) - shown)
    }
    return row
  })
}

/** The backlog chart: per week the late and the due pieces (stacked bars) and the open value or the orders (a line). */
export function backlogChartRows(answer: Backlog, words: { earlier: string; later: string; none: string }): Record<string, number | string>[] {
  return answer.weeks.map((week) => ({
    week: backlogWeekShort(week, words),
    late: week.figures.late,
    due: week.figures.pieces - week.figures.late,
    orders: week.figures.orders,
    ...(hasValue(week.figures) ? { value: (week.figures.value ?? 0) / 100 } : {}),
  }))
}

// ---- what a number counts (the drill) -----------------------------------------------------------------------------------------

export type DrillTarget =
  | { readonly section: 'intake'; readonly bucket: string | null; readonly group: string | null }
  | { readonly section: 'backlog'; readonly week: string | null; readonly group: string | null; readonly horizon: BacklogHorizon | null }
  | { readonly section: 'returns'; readonly by: ReturnGroup | null; readonly key: string | null; readonly size?: string | null }

export const drillKey = (target: DrillTarget): string =>
  target.section === 'intake' ? `i|${target.bucket ?? '*'}|${target.group ?? '*'}` : target.section === 'backlog' ? `b|${target.week ?? '*'}|${target.group ?? '*'}|${target.horizon ?? '*'}` : `r|${target.by ?? '*'}|${target.key ?? '*'}|${target.size ?? '*'}`

/** The orders behind an intake bar, bucket or group (for a style or season: the orders with a line of it). */
export function intakeRowsOf(answer: Intake, target: Extract<DrillTarget, { section: 'intake' }>): IntakeOrder[] {
  return answer.orders.filter((order) => {
    if (target.bucket !== null && order.bucket !== target.bucket) return false
    if (target.group === null || answer.split === 'none') return true
    if (answer.split === 'customer') return order.customer.id === target.group
    if (answer.split === 'season') return (order.season?.id ?? NO_KEY) === target.group
    return order.styles.some((style) => style.key === target.group)
  })
}

/** The open sizes behind a backlog week, a group, a group's horizon. */
export function backlogRowsOf(answer: Backlog, target: Extract<DrillTarget, { section: 'backlog' }>): BacklogLine[] {
  return answer.lines.filter((line) => {
    if (target.week !== null && line.week !== target.week) return false
    if (target.horizon !== null && line.horizon !== target.horizon) return false
    if (target.group !== null && (answer.by === 'customer' ? line.customer.id : line.style.id) !== target.group) return false
    return true
  })
}

/** The return line's key in one grouping (the API's: a colour is its style and colourway). */
function returnKeyOf(line: ReturnLineRow, by: ReturnGroup, colours: ReadonlyMap<string, string>): string {
  if (by === 'reason') return line.reason
  if (by === 'style') return line.style?.id ?? NO_KEY
  if (by === 'size') return line.size ?? NO_KEY
  if (by === 'customer') return line.customer.id
  return line.colour && line.style ? (colours.get(`${line.style.id}|${line.colour.code}`) ?? NO_KEY) : NO_KEY
}

/** The return lines behind a reason, a style, size, colour or customer, a heatmap cell. */
export function returnRowsOf(answer: Returns, target: Extract<DrillTarget, { section: 'returns' }>): ReturnLineRow[] {
  const colours = new Map(answer.colours.map((group) => [`${group.key.split('|')[0]}|${group.code ?? ''}`, group.key]))
  return answer.lines.filter((line) => {
    if (target.by !== null && target.key !== null && returnKeyOf(line, target.by, colours) !== target.key) return false
    if (target.size !== undefined && target.size !== null && (line.size ?? NO_KEY) !== target.size) return false
    return true
  })
}

/** J / K: the next or previous bar of the same group (an intake bucket, a backlog week); none for the returns. */
export function neighbourOf(target: DrillTarget, keys: readonly string[], step: 1 | -1): DrillTarget | null {
  if (target.section === 'intake' && target.bucket !== null) {
    const next = keys[keys.indexOf(target.bucket) + step]
    return next ? { ...target, bucket: next } : null
  }
  if (target.section === 'backlog' && target.week !== null) {
    const next = keys[keys.indexOf(target.week) + step]
    return next ? { ...target, week: next } : null
  }
  return null
}

// ---- where a row leads ---------------------------------------------------------------------------------------------------------

export const orderHref = (prefix: string, id: string, number?: string): string => `${prefix}${recordAddress({ type: 'SalesOrder', id, ...(number ? { label: number } : {}) }, OFFICE_PAGES)}`
export const returnHref = (prefix: string, id: string, number?: string): string => `${prefix}${recordAddress({ type: 'ReturnAuthorisation', id, ...(number ? { label: number } : {}) }, OFFICE_PAGES)}`
export const customerHref = (prefix: string, id: string, code?: string): string => `${prefix}${recordAddress({ type: 'Party', id, ...(code ? { label: code } : {}) }, OFFICE_PAGES)}`
export const styleHref = (prefix: string, id: string, code?: string): string => `${prefix}${recordAddress({ type: 'Style', id, ...(code ? { label: code } : {}) }, OFFICE_PAGES)}`

/**
 * The list a drill opens ("Open the list", the closest the list's address can say): Orders (every order, or the open ones for
 * the backlog), Returns (the open returns), each searched by the customer's code when the bar is one customer's. The lists take
 * no period, style, season, week or reason in their address: the dialog says so.
 */
export function listHref(prefix: string, target: DrillTarget, customerCode: string | null): string {
  const q = customerCode ? `q=${encodeURIComponent(customerCode)}` : ''
  if (target.section === 'returns') return `${prefix}/sales/returns?view=all${q ? `&${q}` : ''}`
  if (target.section === 'backlog') return `${prefix}/sales/orders${q ? `?${q}` : ''}`
  return `${prefix}/sales/orders?rows=all${q ? `&${q}` : ''}`
}

/** Sales › Quotes for the headline's quote tiles (the accepted ones; the ones sent). */
export const quotesHref = (prefix: string, status: 'ACCEPTED' | 'SENT'): string => `${prefix}/sales/quotes?status=${status}`

// ---- files -------------------------------------------------------------------------------------------------------------------

/** The intake panel's rows: one per bucket, then (split) one per group. */
export function intakeCsvRows(answer: Intake, words: { bucket: (bucket: Intake['buckets'][number]) => string; group: (group: Intake['groups'][number]) => string; price: boolean; locale: Locale }): (string | number | null)[][] {
  const value = (figures: Intake['all']) => (words.price ? [valueText(figures, words.locale)] : [])
  return [...answer.buckets.map((bucket) => [words.bucket(bucket), '', bucket.figures.orders, bucket.figures.pieces, ...value(bucket.figures)]), ...answer.groups.map((group) => ['', words.group(group), group.figures.orders, group.figures.pieces, ...value(group.figures)])]
}

/** The backlog panel's rows: one per group with its horizons. */
export function backlogCsvRows(answer: Backlog, words: { group: (group: Backlog['groups'][number]) => string; price: boolean; locale: Locale }): (string | number | null)[][] {
  return answer.groups.map((group) => [words.group(group), ...BACKLOG_HORIZONS.map((horizon) => group.horizons[horizon]), group.figures.pieces, group.figures.orders, ...(words.price ? [valueText(group.figures, words.locale)] : [])])
}

/** The returns panel's rows: one per return line. */
export function returnsCsvRows(answer: Returns, words: { reason: (code: string) => string; price: boolean; locale: Locale }): (string | number | null)[][] {
  return answer.lines.map((line) => [line.number, line.seq, line.requestedOn, words.reason(line.reason), line.style?.code ?? '', line.colour?.name ?? '', line.size ?? '', `${line.customer.code} ${line.customer.name}`, line.pieces, ...(words.price ? [typeof line.credited === 'number' ? money(line.credited, line.currency, words.locale) : ''] : [])])
}

/** A file's name: the panel and the period. */
export const csvName = (panel: ReportSection | 'drill', range: { from: string; to: string }): string => `sales-${panel}-${range.from}-${range.to}.csv`

// ---- live --------------------------------------------------------------------------------------------------------------------

/** Design: "sales_order.created / shipped → panels refresh with AsOf" (at most once a minute); quotes, returns, shipments and promises too. */
export const LIVE_TYPES = ['sales_order.', 'quote.', 'return.', 'shipment.', 'order_promise.'] as const
export const LIVE_EVERY_MS = 60_000

export { RETURN_GROUPS }
