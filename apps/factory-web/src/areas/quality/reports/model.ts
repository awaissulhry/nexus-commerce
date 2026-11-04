import type { SectionSpec, SectionWidth } from '@nexus/ui/patterns'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { csvText } from '../ncr/model'
import { DIMENSIONS, type Change, type CompareRow, type Dimension, type Incoming, type Kpis, type KpiKey, type Rate, type SupplierRow, type TrendWeek } from './api'

/**
 * The pure rules of Quality › Reports (B-W2b-138, SCR-147): what this person may open (from the session's permissions; the API
 * checks each figure again), the address, the words of the figures, where each number leads, the chart's rows and the files.
 * Groups only, never a person: no person key exists here, and the address, the print and the files carry none (Statuto dei
 * Lavoratori art. 4; Owner answers W1, F2; ANA-075).
 */

export { csvText }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** quality.reports.view: the page. */
  view: boolean
  /** The source lists each number opens (their own view permission). */
  inspections: boolean
  ncr: boolean
  holds: boolean
  capa: boolean
  /** parties.view: the supplier record. */
  suppliers: boolean
  /** product.styles.view / product.routing.view: the style and operation records. */
  styles: boolean
  operations: boolean
  /** workorders.view: Floor now on a line. */
  floor: boolean
}

export function reportsCan(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return {
    view: held.has('quality.reports.view'),
    inspections: held.has('quality.inspections.view'),
    ncr: held.has('quality.ncr.view'),
    holds: held.has('quality.holds.view'),
    capa: held.has('quality.capa.view'),
    suppliers: held.has('parties.view'),
    styles: held.has('product.styles.view'),
    operations: held.has('product.routing.view'),
    floor: held.has('workorders.view'),
  }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export interface ReportsAddress {
  from: string | null
  to: string | null
  /** Compare to the previous period (on unless `compare=0`). */
  compare: boolean
  /** The comparison table's dimension. */
  by: Dimension
  /** The trend's line (null: every line). */
  lineId: string | null
}

const dayOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function reportsAddressOf(params: { get(name: string): string | null } | null | undefined): ReportsAddress {
  const by = params?.get('by') ?? ''
  const line = params?.get('line') ?? ''
  return {
    from: dayOr(params?.get('from')),
    to: dayOr(params?.get('to')),
    compare: params?.get('compare') !== '0',
    by: (DIMENSIONS as readonly string[]).includes(by) ? (by as Dimension) : 'line',
    lineId: UUID.test(line) ? line : null,
  }
}

export function reportsAddressText(address: ReportsAddress): string {
  const terms = new URLSearchParams()
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  if (!address.compare) terms.set('compare', '0')
  if (address.by !== 'line') terms.set('by', address.by)
  if (address.lineId) terms.set('line', address.lineId)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** A business day as the date picker's local day, and back. */
export const dateOfDay = (day: string): Date => new Date(`${day}T12:00:00`)
export const dayOfDate = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** The default period: the 30 days up to today (the API's own default). */
export function defaultRange(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now)
  start.setDate(start.getDate() - 29)
  return { from: dayOfDate(start), to: dayOfDate(now) }
}

/** The period on show: the address's, else what the API answered, else the 30 days up to today. */
export function rangeShown(address: Pick<ReportsAddress, 'from' | 'to'>, answer: { from: string; to: string } | null, now: Date = new Date()): { from: string; to: string } {
  const fallback = defaultRange(now)
  return { from: address.from ?? answer?.from ?? fallback.from, to: address.to ?? answer?.to ?? fallback.to }
}

/** Days of a period, both ends included. */
export const daysIn = (range: { from: string; to: string }): number => Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1

/** The band's "Export report (PDF)": the print tab with the same scope (the browser saves it as a PDF). */
export const printAddress = (prefix: string, address: ReportsAddress): string => `${prefix}/quality/reports/print${reportsAddressText(address)}`

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

/** The design's W2b sections (qr-kpi, qr-trend, qr-table, qr-supplier); the Pareto and the heat map are W3. */
export const REPORT_SECTIONS = ['kpi', 'trend', 'table', 'supplier'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]
export const LAYOUT_KEY = 'quality.reports.layout'
export const WIDTHS: readonly SectionWidth[] = ['full', 'two-thirds', 'half']

/** Every panel full width at first (no dead space on the right); Arrange changes the order, what shows and the widths. */
export const sectionSpecs = (label: (id: string) => string): SectionSpec[] => REPORT_SECTIONS.map((id) => ({ id, label: label(id), defaultWidth: 'full' as const }))

// ---- figures in words --------------------------------------------------------------------------------------------------------

const asNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** "96,4 %" in Italian, "96.4 %" in English; "—" for nothing (never 0). */
export const pctText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  return number === null ? '—' : `${formatNumber(number, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}

/** A DHU or a number of days, one decimal; "—" for nothing. */
export const oneText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  return number === null ? '—' : formatNumber(number, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** A count; "—" for nothing. */
export const countText = (value: number | null | undefined, locale: Locale): string => (value === null || value === undefined ? '—' : formatNumber(value, locale, { maximumFractionDigits: 0 }))

/** A KPI's figure as the tile shows it. */
export function kpiValueText(kpi: KpiKey, kpis: Kpis['kpis'], locale: Locale): string {
  if (kpi === 'ncrOpen' || kpi === 'holdsOld') return countText(kpis[kpi]?.value, locale)
  const rate = kpis[kpi]
  if (!rate || rate.tooFew) return '—'
  return kpi === 'dhu' ? oneText(rate.value, locale) : pctText(rate.value, locale)
}

/** The unit a change is said in: points for a percent, the figure's own unit otherwise. */
export const changeUnit = (kpi: KpiKey): 'points' | 'dhu' | 'count' => (kpi === 'dhu' ? 'dhu' : kpi === 'ncrOpen' || kpi === 'holdsOld' ? 'count' : 'points')

/** The trend arrow in words ("up 1.2 points vs previous 30 days"): the key, its params and the tone. */
export function changeWords(kpi: KpiKey, change: Change | null | undefined, days: number, locale: Locale): { key: string; params: Record<string, string | number>; tone: 'positive' | 'negative' | 'neutral'; arrow: string } | null {
  if (!change) return null
  const unit = changeUnit(kpi)
  const by = unit === 'count' ? formatNumber(Number(change.by), locale, { maximumFractionDigits: 0 }) : formatNumber(Number(change.by), locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const tone = change.better === null ? 'neutral' : change.better ? 'positive' : 'negative'
  const arrow = change.direction === 'UP' ? '↑' : change.direction === 'DOWN' ? '↓' : '→'
  return { key: `change.${change.direction.toLowerCase()}.${unit}`, params: { by, days, count: Number(change.by) }, tone, arrow }
}

/** A tile's sparkline values, oldest week first (a hidden or empty week keeps its place). */
export const sparkValues = (rate: Pick<Rate, 'weeks'> | null | undefined): (number | null)[] => (rate?.weeks ?? []).map((week) => (week.tooFew ? null : asNumber(week.value)))

// ---- where each number leads ---------------------------------------------------------------------------------------------------

/**
 * Each tile's source list, filtered as close to the tile as the list's address allows, once its page is built and the person
 * may open it; null otherwise (the tile says why). FPY and DHU have no list of their own yet (in-process checks: B-W2b-127):
 * they open the comparison by line on this page.
 */
export function tileHref(kpi: KpiKey, prefix: string, can: ReportsCan, siteId: string | null, address: ReportsAddress, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  switch (kpi) {
    case 'fpy':
    case 'dhu':
      return `${prefix}/quality/reports${reportsAddressText({ ...address, by: 'line' })}#fw-qr-table`
    case 'aqlPass':
      return can.inspections && built.has('/quality/inspections') ? `${prefix}/quality/inspections?view=all` : null
    case 'ncrOpen':
      return can.ncr && built.has('/quality/ncr') ? `${prefix}/quality/ncr${siteId ? `?site=${encodeURIComponent(siteId)}` : ''}` : null
    case 'capaOnTime':
      return can.capa && built.has('/quality/capa') ? `${prefix}/quality/capa?view=closed` : null
    case 'holdsOld':
      return can.holds && built.has('/quality/holds') ? `${prefix}/quality/holds?view=open` : null
  }
}

/** Why a tile opens nothing (a message key), when it does not. */
export function tileHeld(kpi: KpiKey, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  if (kpi === 'capaOnTime' && !built.has('/quality/capa')) return 'tile.held.capaPage'
  if (kpi === 'aqlPass' && !can.inspections) return 'tile.held.noList'
  if (kpi === 'ncrOpen' && !can.ncr) return 'tile.held.noList'
  if (kpi === 'holdsOld' && !can.holds) return 'tile.held.noList'
  if (kpi === 'capaOnTime' && !can.capa) return 'tile.held.noList'
  return null
}

/** A comparison row's record: the line on Floor now, the library operation, the supplier, the style. */
export function rowHref(by: Dimension, row: Pick<CompareRow, 'ref'>, prefix: string, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  const id = row.ref?.id
  if (!id) return null
  const page = (path: string) => (built.has(path) ? path : null)
  switch (by) {
    case 'line':
      return can.floor && page('/production/floor') ? `${prefix}/production/floor?line=${encodeURIComponent(id)}` : null
    case 'operation':
      return can.operations && page('/products/operations/[id]') ? `${prefix}/products/operations/${encodeURIComponent(id)}` : null
    case 'supplier':
      return can.suppliers && page('/purchasing/suppliers/[partyId]') ? `${prefix}/purchasing/suppliers/${encodeURIComponent(id)}` : null
    case 'style':
      return can.styles && page('/products/styles/[id]') ? `${prefix}/products/styles/${encodeURIComponent(id)}` : null
  }
}

/** The supplier's record (design: its "Quality & rating" tab, which comes with the supplier record's own step). */
export const supplierHref = (row: Pick<SupplierRow, 'party'>, prefix: string, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null =>
  row.party && can.suppliers && built.has('/purchasing/suppliers/[partyId]') ? `${prefix}/purchasing/suppliers/${encodeURIComponent(row.party.id)}` : null

export const refLabel = (ref: CompareRow['ref']): string | null => (ref ? `${ref.code} · ${ref.name}` : null)

// ---- the trend chart ---------------------------------------------------------------------------------------------------------

export interface TrendRow extends Record<string, number | string> {
  week: string
}

/** One chart row per week: FPY and DHU where the week shows them (a hidden or empty week has no point). */
export function trendRows(weeks: readonly TrendWeek[]): TrendRow[] {
  return weeks.map((week) => {
    const fpy = asNumber(week.fpy)
    const dhu = asNumber(week.dhu)
    return { week: weekLabel(week.week), ...(fpy === null ? {} : { fpy }), ...(dhu === null ? {} : { dhu }) }
  })
}

/** "W44" from "2026-W44". */
export const weekLabel = (key: string): string => key.replace(/^\d{4}-/, '')

/** Weeks whose end-of-line figures are hidden (too few people). */
export const hiddenWeeks = (weeks: readonly Pick<TrendWeek, 'tooFew'>[]): number => weeks.filter((week) => week.tooFew).length

/** The CAPAs closed in the period (the chart's markers, said under it). */
export const closuresOf = (weeks: readonly TrendWeek[]): { week: string; capas: { id: string; number: string }[]; more: number }[] =>
  weeks.flatMap((week) => (week.capaClosed && week.capaClosed.count > 0 ? [{ week: week.week, capas: week.capaClosed.capas, more: Math.max(0, week.capaClosed.count - week.capaClosed.capas.length) }] : []))

// ---- files (Export panel (CSV)) ------------------------------------------------------------------------------------------------

/** The words a file needs from the view (the container has no catalogue). */
export interface CsvWords {
  readonly header: readonly string[]
  readonly none: string
  readonly tooFew: string
  /** The headline numbers' names (the KPI file's first column). */
  readonly labels?: Readonly<Record<string, string>>
}

export function kpiCsvRows(kpis: Kpis, labels: Readonly<Record<KpiKey, string>>, locale: Locale): (string | number | null)[][] {
  const order: KpiKey[] = ['fpy', 'dhu', 'aqlPass', 'ncrOpen', 'capaOnTime', 'holdsOld']
  return order.filter((kpi) => kpis.kpis[kpi] !== null).map((kpi) => {
    const now = kpiValueText(kpi, kpis.kpis, locale)
    const entry = kpis.kpis[kpi]!
    const before = entry.previous ? ('tooFew' in entry.previous ? (entry.previous.tooFew ? '—' : kpi === 'dhu' ? oneText(entry.previous.value, locale) : pctText(entry.previous.value, locale)) : countText(entry.previous.value, locale)) : ''
    return [labels[kpi], now, before]
  })
}

export function trendCsvRows(weeks: readonly TrendWeek[], words: Pick<CsvWords, 'tooFew'>, locale: Locale): (string | number | null)[][] {
  return weeks.map((week) => [
    week.week,
    week.from,
    week.to,
    week.tooFew ? words.tooFew : pctText(week.fpy, locale),
    week.tooFew ? words.tooFew : oneText(week.dhu, locale),
    week.pieces,
    week.aql ? pctText(week.aql.pct, locale) : week.aqlTooFew ? words.tooFew : '—',
    week.capaClosed?.count ?? null,
  ])
}

export function compareCsvRows(rows: readonly CompareRow[], words: Pick<CsvWords, 'none' | 'tooFew'>, locale: Locale): (string | number | null)[][] {
  return rows.map((row) => [
    refLabel(row.ref) ?? words.none,
    row.tooFew ? words.tooFew : countText(row.inspected, locale),
    row.tooFew ? '' : countText(row.defects, locale),
    row.tooFew ? '' : oneText(row.dhu, locale),
    row.tooFew ? '' : row.aql ? pctText(row.aql.pct, locale) : '—',
    row.tooFew ? '' : countText(row.ncrs, locale),
  ])
}

export function incomingCsvRows(answer: Incoming, words: Pick<CsvWords, 'none'>, locale: Locale): (string | number | null)[][] {
  return answer.suppliers.map((row) => [
    row.party ? `${row.party.code} · ${row.party.name}` : words.none,
    countText(row.lotsReceived, locale),
    countText(row.rejected, locale),
    countText(row.crViFails, locale),
    oneText(row.averageQuarantineDays, locale),
    countText(row.inspections, locale),
    countText(row.inspectionsFailed, locale),
  ])
}

/** The file name of a panel's export. */
export const csvName = (panel: ReportSection, range: { from: string; to: string }): string => `quality-${panel}-${range.from}-${range.to}.csv`
