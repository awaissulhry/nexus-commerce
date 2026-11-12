import type { SectionSpec } from '@nexus/ui/patterns'
import type { Locale } from '../../../lib/i18n/locales'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { csvOf, quantity } from '../../_shared/stock/model'
import { dateOfDay, dayOfDate, lastMonth, QUICK_PERIODS, quickRange, romeToday, thisMonth, type QuickPeriod } from '../../warehouse/reports/model'
import type { Adherence, AdherenceFigures, AdherenceRows, Cover, CoverRow, Utilisation, UtilisationLane, UtilisationRows } from './api'

/**
 * The pure rules of Planning › Reports (B-W2b-349, SCR-254 and its print view SCR-409): what this person may open (from the
 * session's permissions; the API checks every read again), the address (`?from=&to=&lane=&ahead=&weeks=`; the site is the top
 * bar's), the panels (Arrange), the words of the figures, the chart rows, the drill ("Work orders behind this bar") and its
 * neighbours, where a row leads, the CSV files and the live events. No money and no person on this page.
 */

export { csvOf, dateOfDay, dayOfDate, lastMonth, QUICK_PERIODS, quickRange, romeToday, thisMonth, type QuickPeriod }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** planning.reports.view: the page. */
  view: boolean
  /** planning.view: the site's plan behind every figure. */
  plans: boolean
  /** purchasing.manage: Draft PO from the plan (What to buy & make). */
  draft: boolean
}

export function reportsCan(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return { view: held.has('planning.reports.view'), plans: held.has('planning.view'), draft: held.has('purchasing.manage') }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export const AHEAD_CHOICES = [0, 4, 8, 12] as const
export const COVER_WEEKS = [4, 8, 13, 26] as const
export const DEFAULT_AHEAD = 4
export const DEFAULT_COVER_WEEKS = 13

export interface ReportsAddress {
  from: string | null
  to: string | null
  /** The utilisation chart's lane (laneKeyOf; default the plant). */
  lane: string | null
  /** Weeks of the plan's load ahead (0, 4, 8, 12). */
  ahead: number
  /** The cover's horizon in weeks. */
  weeks: number
}

const dayOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)
const oneOf = (value: string | null | undefined, choices: readonly number[], fallback: number): number => {
  const number = value === null || value === undefined ? Number.NaN : Number.parseInt(value, 10)
  return choices.includes(number) ? number : fallback
}

export function reportsAddressOf(params: { get(name: string): string | null } | null | undefined): ReportsAddress {
  const lane = params?.get('lane') ?? null
  return {
    from: dayOr(params?.get('from')),
    to: dayOr(params?.get('to')),
    lane: lane && /^(PLANT|LINE:[0-9a-f-]{36}|WORK_CENTRE:[0-9a-f-]{36}|WORKSHOP:[0-9a-f-]{36}:[A-Z_]*)$/.test(lane) ? lane : null,
    ahead: oneOf(params?.get('ahead'), AHEAD_CHOICES, DEFAULT_AHEAD),
    weeks: oneOf(params?.get('weeks'), COVER_WEEKS, DEFAULT_COVER_WEEKS),
  }
}

export function reportsAddressText(address: Partial<ReportsAddress>): string {
  const terms = new URLSearchParams()
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  if (address.lane && address.lane !== 'PLANT') terms.set('lane', address.lane)
  if (address.ahead !== undefined && address.ahead !== DEFAULT_AHEAD) terms.set('ahead', String(address.ahead))
  if (address.weeks !== undefined && address.weeks !== DEFAULT_COVER_WEEKS) terms.set('weeks', String(address.weeks))
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** The period on show: the address's, else what the API answered, else this month so far. */
export function rangeShown(address: Pick<ReportsAddress, 'from' | 'to'>, answer: { from: string; to: string } | null, today: string): { from: string; to: string } {
  const fallback = thisMonth(today)
  return { from: address.from ?? answer?.from ?? fallback.from, to: address.to ?? answer?.to ?? fallback.to }
}

/** The print view's address (a new tab; the browser prints it or saves the PDF), with what is on show. */
export const printAddress = (prefix: string, address: ReportsAddress, range: { from: string; to: string }): string => `${prefix}/planning/reports/print${reportsAddressText({ ...address, ...range })}`

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

/** The design's W2b sections (sec adherence, sec utilisation, sec cover), in its order (OTIF and lead time are W3). */
export const REPORT_SECTIONS = ['adherence', 'utilisation', 'cover'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]
export const LAYOUT_KEY = 'planning.reports.layout'

/** Every panel full width at first (no dead space on the right); Arrange changes the order, what shows and the widths. */
export const sectionSpecs = (label: (id: string) => string): SectionSpec[] => REPORT_SECTIONS.map((id) => ({ id, label: label(id), defaultWidth: 'full' as const }))

// ---- words ---------------------------------------------------------------------------------------------------------------------

const numberFormat = (locale: Locale, digits: number) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** A percent as "87,5 %"; unknown "—". */
export function pctText(value: string | null | undefined, locale: Locale): string {
  if (value === null || value === undefined) return '—'
  const number = Number(value)
  return Number.isFinite(number) ? `${numberFormat(locale, 1).format(number)} %` : '—'
}

/** Minutes as "1.234,5 min"; unknown "—". */
export function minutesText(value: string | null | undefined, locale: Locale): string {
  if (value === null || value === undefined) return '—'
  const number = Number(value)
  return Number.isFinite(number) ? `${numberFormat(locale, number % 1 === 0 ? 0 : 1).format(number)} min` : '—'
}

/** A signed day count with one decimal ("+1,5"; "0"; "−2"); unknown "—". */
export function signedDays(value: string | number | null | undefined, locale: Locale): string {
  if (value === null || value === undefined) return '—'
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return '—'
  if (number === 0) return '0'
  const text = numberFormat(locale, Number.isInteger(number) ? 0 : 1).format(Math.abs(number))
  return `${number > 0 ? '+' : '−'}${text}`
}

/** A quantity in its unit. */
export const quantityText = (value: string, unit: string, locale: Locale): string => `${quantity(value, locale)} ${unit}`

/** An ISO week as "W47" and its days ("16–22 nov"). */
export function weekLabel(week: { key: string; from: string; to: string }, locale: Locale): string {
  const number = week.key.slice(week.key.indexOf('W'))
  const format = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const from = format.format(new Date(`${week.from}T12:00:00Z`))
  const to = format.format(new Date(`${week.to}T12:00:00Z`))
  return `${number} · ${week.from === week.to ? from : `${from} – ${to}`}`
}

/** A week's short label for a chart axis ("W47"). */
export const weekShort = (key: string): string => key.slice(key.indexOf('W'))

// ---- schedule adherence ------------------------------------------------------------------------------------------------------------

/** The adherence figures of one line (null: every line) for one week. */
export function figuresOf(answer: Adherence, lineKey: string | null, week: string | null): AdherenceFigures | null {
  if (lineKey === null) return week === null ? answer.all : (answer.weeks.find((entry) => entry.key === week)?.figures ?? null)
  const line = answer.lines.find((entry) => (entry.line?.id ?? 'none') === lineKey)
  if (!line) return null
  return week === null ? line.figures : (line.weeks.find((entry) => entry.key === week)?.figures ?? null)
}

export interface AdherenceChartRow extends Record<string, number | string> {
  week: string
  finished: number
}

/** The chart: % on time per week (a line; a week with nothing measured has no point) and the work orders finished (bars). */
export function adherenceChartRows(answer: Adherence, lineKey: string | null): AdherenceChartRow[] {
  return answer.weeks.map((week) => {
    const figures = figuresOf(answer, lineKey, week.key)
    return { week: weekShort(week.key), finished: figures?.finished ?? 0, ...(figures?.onTimePct ? { onTime: Number(figures.onTimePct) } : {}) }
  })
}

/** "3 of 4 on time" words of a cell; "—" when nothing finished. */
export const cellWords = (figures: AdherenceFigures | null, words: { cell: (onTime: number, planned: number) => string; none: string; unplanned: (count: number) => string }): string => {
  if (!figures || figures.finished === 0) return words.none
  if (figures.planned === 0) return words.unplanned(figures.notPlanned)
  return words.cell(figures.onTime, figures.planned)
}

// ---- the utilisation trend ---------------------------------------------------------------------------------------------------------

/** A lane's key in the address and the chart picker. */
export const laneKeyOf = (lane: Pick<UtilisationLane, 'kind' | 'id' | 'workCentreKind'>): string => (lane.kind === 'PLANT' ? 'PLANT' : lane.kind === 'WORKSHOP' ? `WORKSHOP:${lane.id}:${lane.workCentreKind ?? ''}` : `${lane.kind}:${lane.id}`)

/** The lane the chart shows: the address's, else the plant. */
export const chosenLane = (answer: Utilisation, key: string | null): UtilisationLane | null => answer.lanes.find((lane) => laneKeyOf(lane) === key) ?? answer.lanes.find((lane) => lane.kind === 'PLANT') ?? answer.lanes[0] ?? null

export interface UtilisationChartRow extends Record<string, number | string> {
  week: string
}

/** The chart of one lane: utilisation (what happened, a line) and load (the plan ahead, bars); a missing value has no mark. */
export function utilisationChartRows(answer: Utilisation, lane: UtilisationLane): UtilisationChartRow[] {
  return answer.weeks.map((week) => {
    const cell = lane.cells.find((entry) => entry.key === week.key)
    const row: UtilisationChartRow = { week: weekShort(week.key) }
    if (cell?.utilisationPct) row.utilisation = Number(cell.utilisationPct)
    if (cell?.loadPct) row.load = Number(cell.loadPct)
    return row
  })
}

/** A lane in words: the plant, a line or work centre by code and name, a workshop with its kind. */
export function laneLabel(lane: Pick<UtilisationLane, 'kind' | 'code' | 'name' | 'workCentreKind'>, words: { plant: string; kind: (kind: string) => string }): string {
  if (lane.kind === 'PLANT') return words.plant
  const name = [lane.code, lane.name].filter(Boolean).join(' · ')
  return lane.kind === 'WORKSHOP' && lane.workCentreKind ? `${name} (${words.kind(lane.workCentreKind)})` : name
}

/** A point opens its work orders: a line, a work centre or the plant (a workshop's are on Capacity & load). */
export const pointOpens = (lane: Pick<UtilisationLane, 'kind'>): boolean => lane.kind !== 'WORKSHOP'

// ---- the drill ("Work orders behind this bar") -------------------------------------------------------------------------------------

export type DrillTarget = { readonly section: 'adherence'; readonly lineKey: string | null; readonly week: string | null } | { readonly section: 'utilisation'; readonly laneKey: string; readonly week: string }

export const drillKey = (target: DrillTarget): string => (target.section === 'adherence' ? `a|${target.lineKey ?? '*'}|${target.week ?? '*'}` : `u|${target.laneKey}|${target.week}`)

/** J / K: the same line or lane, the next or the previous week (null at the ends; a whole-period drill has none). */
export function neighbourOf(target: DrillTarget, weeks: readonly string[], step: 1 | -1): DrillTarget | null {
  if (target.week === null) return null
  const index = weeks.indexOf(target.week)
  const next = index < 0 ? undefined : weeks[index + step]
  return next ? { ...target, week: next } : null
}

/** The utilisation drill's lane in the API's terms. */
export function pointOf(laneKey: string): { laneKind: 'PLANT' | 'LINE' | 'WORK_CENTRE'; laneId: string | null } | null {
  if (laneKey === 'PLANT') return { laneKind: 'PLANT', laneId: null }
  const [kind, id] = laneKey.split(':')
  return kind === 'LINE' || kind === 'WORK_CENTRE' ? { laneKind: kind, laneId: id ?? null } : null
}

// ---- where a row leads -----------------------------------------------------------------------------------------------------------

export const workOrderHref = (prefix: string, id: string, number?: string): string => `${prefix}${recordAddress({ type: 'WorkOrder', id, ...(number ? { label: number } : {}) }, OFFICE_PAGES)}`
export const purchaseOrderHref = (prefix: string, id: string, number?: string): string => `${prefix}${recordAddress({ type: 'PurchaseOrder', id, ...(number ? { label: number } : {}) }, OFFICE_PAGES)}`
export const materialHref = (prefix: string, id: string, code?: string): string => `${prefix}${recordAddress({ type: 'Item', id, ...(code ? { label: code } : {}) }, OFFICE_PAGES)}`
/** Capacity & load for a workshop's weeks (its cells open there). */
export const capacityHref = (prefix: string, siteId: string): string => `${prefix}/planning/capacity?site=${encodeURIComponent(siteId)}`

/**
 * "Draft PO" (design sec cover interaction): the plan's own Draft PO on What to buy & make, the material's lines to buy found;
 * held with its reason without the right to manage purchase orders, for a material that is made, and for one with nothing left
 * to order.
 */
export function draftOf(prefix: string, siteId: string, row: Pick<CoverRow, 'action' | 'uncovered' | 'item'>, can: Pick<ReportsCan, 'draft'>): { href: string | null; held: 'draft.heldRight' | 'draft.heldMake' | 'draft.heldNothing' | null } {
  if (row.action === 'MAKE') return { href: null, held: 'draft.heldMake' }
  if (!(Number(row.uncovered) > 0)) return { href: null, held: 'draft.heldNothing' }
  if (!can.draft) return { href: null, held: 'draft.heldRight' }
  return { href: `${prefix}/planning/mrp?view=toBuy&q=${encodeURIComponent(row.item.code)}&site=${encodeURIComponent(siteId)}`, held: null }
}

// ---- files -------------------------------------------------------------------------------------------------------------------

/** The adherence panel's rows: one per line and week cell, then each line, then the total. */
export function adherenceCsvRows(answer: Adherence, words: { line: (line: Adherence['lines'][number]['line']) => string; all: string }): (string | number | null)[][] {
  const row = (name: string, week: string, figures: AdherenceFigures) => [name, week, figures.finished, figures.planned, figures.onTime, figures.late, figures.notPlanned, figures.onTimePct, figures.meanFinishDays, figures.meanStartDays]
  return [
    ...answer.lines.flatMap((line) => [...line.weeks.filter((week) => week.figures.finished > 0).map((week) => row(words.line(line.line), week.key, week.figures)), row(words.line(line.line), '', line.figures)]),
    row(words.all, '', answer.all),
  ]
}

/** The utilisation panel's rows: one per lane and week. */
export function utilisationCsvRows(answer: Utilisation, words: { lane: (lane: UtilisationLane) => string }): (string | number | null)[][] {
  return answer.lanes.flatMap((lane) => lane.cells.map((cell) => [words.lane(lane), cell.key, cell.earnedMinutes, cell.availableMinutes, cell.utilisationPct, cell.booked, cell.capacity, cell.loadPct, lane.unit]))
}

/** The cover grid's rows. */
export function coverCsvRows(rows: readonly CoverRow[], words: { state: (state: CoverRow['state']) => string }): (string | number | null)[][] {
  return rows.map((row) => [row.item.code, row.item.name, row.colour?.name ?? '', row.item.baseUom, row.onHand, row.safetyStock, row.demand, row.receipts, row.daysOfCover, row.stockOutOn, row.belowSafetyOn, words.state(row.state), row.openPurchases.orders, row.openPurchases.quantity, row.openPurchases.next?.day ?? ''])
}

/** The work orders behind a bar as a file. */
export function adherenceDrillCsvRows(answer: AdherenceRows, words: { state: (state: AdherenceRows['rows'][number]['state']) => string }): (string | number | null)[][] {
  return answer.rows.map((row) => [row.workOrder.number, row.workOrder.style.code, row.line?.code ?? '', row.planned?.startAt ?? '', row.planned?.endAt ?? '', row.actual.startAt ?? '', row.actual.finishAt, row.startDays, row.finishDays, words.state(row.state)])
}

export function utilisationDrillCsvRows(answer: UtilisationRows): (string | number | null)[][] {
  return [
    ...(answer.earned?.rows ?? []).map((row) => ['earned', row.workOrder.number, row.operation.code, row.lane.code, row.garments, row.minutes]),
    ...(answer.booked?.rows ?? []).map((row) => ['booked', row.workOrder.number, row.operation.code, row.lane.code, row.pieces, row.minutes]),
  ]
}

/** A file's name: the panel and the period. */
export const csvName = (panel: ReportSection | 'drill', range: { from: string; to: string }): string => `planning-${panel}-${range.from}-${range.to}.csv`

// ---- live --------------------------------------------------------------------------------------------------------------------

/** Design: "planning.run.finished, production.workorder.completed → panels refresh with their own AsOf" (at most once a minute). */
export const LIVE_TYPES = ['planning.run_finished', 'planning.schedule_', 'planning.capacity_changed', 'workorder.', 'production.scan_', 'purchase_order.', 'inventory.receipt_posted'] as const
export const LIVE_EVERY_MS = 60_000

export type { Cover }
