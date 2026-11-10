import type { SectionSpec } from '@nexus/ui/patterns'
import { formatNumber } from '../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { csvText } from '../../quality/ncr/model'
import type { Cr6, ExpiryItem, Expiries, GapRow, GapType, Gate, Kpis, KpiKey, Ref, Register, RegisterKind } from './api'

/**
 * The pure rules of Compliance › Reports (B-W2b-272, SCR-261 and the annual review SCR-307): what this person may open (from the
 * session's permissions; the API checks each figure again), the address, the words of the figures, where each number leads
 * (a list's page only once built and in the role, else the number says why), the panels and the files. Nothing here names a
 * person.
 */

export { csvText }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface ReportsCan {
  /** compliance.reports.view: the page. */
  view: boolean
  /** The lists each number opens (their own view permission). */
  certificates: boolean
  register: boolean
  lots: boolean
  shipments: boolean
  /** parties.view: the supplier record. */
  suppliers: boolean
}

export function reportsCan(permissions: readonly string[]): ReportsCan {
  const held = new Set(permissions)
  return {
    view: held.has('compliance.reports.view'),
    certificates: held.has('compliance.certificates.view'),
    register: held.has('compliance.register.view'),
    lots: held.has('quality.lots.view'),
    shipments: held.has('shipping.view'),
    suppliers: held.has('parties.view'),
  }
}

// ---- the address -------------------------------------------------------------------------------------------------------------

export interface ReportsAddress {
  from: string | null
  to: string | null
  /** One brand's styles (a party id); null: every brand. */
  brandId: string | null
}

const dayOr = (value: string | null | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function reportsAddressOf(params: { get(name: string): string | null } | null | undefined): ReportsAddress {
  const brand = params?.get('brand') ?? ''
  return { from: dayOr(params?.get('from')), to: dayOr(params?.get('to')), brandId: UUID.test(brand) ? brand : null }
}

export function reportsAddressText(address: ReportsAddress): string {
  const terms = new URLSearchParams()
  if (address.from) terms.set('from', address.from)
  if (address.to) terms.set('to', address.to)
  if (address.brandId) terms.set('brand', address.brandId)
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** A business day as the date picker's local day, and back. */
export const dateOfDay = (day: string): Date => new Date(`${day}T12:00:00`)
export const dayOfDate = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** The default period: the 365 days up to today (the API's own default). */
export function defaultRange(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now)
  start.setDate(start.getDate() - 364)
  return { from: dayOfDate(start), to: dayOfDate(now) }
}

/** The period on show: the address's, else what the API answered, else the 365 days up to today. */
export function rangeShown(address: Pick<ReportsAddress, 'from' | 'to'>, answer: { from: string; to: string } | null, now: Date = new Date()): { from: string; to: string } {
  const fallback = defaultRange(now)
  return { from: address.from ?? answer?.from ?? fallback.from, to: address.to ?? answer?.to ?? fallback.to }
}

// ---- the annual review (tab:cr-pdf, SCR-307) -------------------------------------------------------------------------------

export interface ReviewAddress {
  year: number
  brandId: string | null
}

/** `?year=2026&brand=` (the year of today when none or a bad one). */
export function reviewAddressOf(params: { get(name: string): string | null } | null | undefined, today: string): ReviewAddress {
  const now = Number(today.slice(0, 4))
  const asked = Number(params?.get('year') ?? '')
  const brand = params?.get('brand') ?? ''
  return { year: Number.isInteger(asked) && asked >= 2020 && asked <= now ? asked : now, brandId: UUID.test(brand) ? brand : null }
}

/** The annual review's address (a new tab; the browser saves it as a PDF). */
export const reviewAddress = (prefix: string, year: number, brandId: string | null): string => `${prefix}/compliance/reports/print?year=${year}${brandId ? `&brand=${encodeURIComponent(brandId)}` : ''}`

/** The year's period: 1 January to 31 December, or to today while the year runs. */
export function yearRange(year: number, today: string): { from: string; to: string } {
  const end = `${year}-12-31`
  return { from: `${year}-01-01`, to: end > today ? today : end }
}

/** Today in Rome as YYYY-MM-DD (the API's "today": a period never ends after it). */
export const romeToday = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

/** Every year the review takes, newest first (from 2020, the API's first). */
export const reviewYearsAll = (today: string): number[] => {
  const now = Number(today.slice(0, 4))
  return Array.from({ length: Math.max(1, now - 2019) }, (_, index) => now - index)
}

/** The years the band offers a review of: this year and the one before. */
export const reviewYears = (today: string): number[] => {
  const now = Number(today.slice(0, 4))
  return [now, now - 1]
}

// ---- sections (Arrange) ------------------------------------------------------------------------------------------------------

/** The design's sections (cr-kpi, cr-gaps, cr-expiry, cr-cr6, cr-register), in its order. */
export const REPORT_SECTIONS = ['kpi', 'gaps', 'expiry', 'cr6', 'register'] as const
export type ReportSection = (typeof REPORT_SECTIONS)[number]
export const LAYOUT_KEY = 'compliance.reports.layout'

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

/** One decimal (days); "—" for nothing. */
export const oneText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  return number === null ? '—' : formatNumber(number, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** A count; "—" for nothing. */
export const countText = (value: number | null | undefined, locale: Locale): string => (value === null || value === undefined ? '—' : formatNumber(value, locale, { maximumFractionDigits: 0 }))

/** mg/kg as the lab writes it (up to 3 decimals); "—" for nothing. */
export const mgText = (value: string | null | undefined, locale: Locale): string => {
  const number = asNumber(value)
  return number === null ? '—' : formatNumber(number, locale, { maximumFractionDigits: 3 })
}

/** A number for the LimitMeter (null when not measured). */
export const mgNumber = (value: string | null | undefined): number | null => asNumber(value)

/** A headline number as the tile shows it ("—" when not counted or not seen). */
export function kpiValueText(kpi: KpiKey, kpis: Kpis['kpis'], locale: Locale): string {
  switch (kpi) {
    case 'coverage':
      return pctText(kpis.coverage?.pct, locale)
    case 'shipped':
      return pctText(kpis.shipped?.pct, locale)
    case 'crViLots':
      return pctText(kpis.crViLots?.pct, locale)
    case 'gaps':
      return countText(kpis.gaps?.count, locale)
    case 'refusals':
      return countText(kpis.refusals?.count, locale)
    case 'registerOpen':
      return countText(kpis.registerOpen?.count, locale)
  }
}

/** The sight a headline number needs (the tile says "Not in your role" otherwise). */
export const KPI_SIGHT: Readonly<Record<KpiKey, readonly ('certificates' | 'register' | 'lots' | 'shipments')[]>> = {
  coverage: ['certificates'],
  shipped: ['certificates', 'shipments'],
  gaps: ['certificates'],
  refusals: ['certificates'],
  registerOpen: ['register'],
  crViLots: ['lots'],
}

/** "Dec 2026" / "dic 2026" of a YYYY-MM key. */
export function monthLabel(month: string, locale: Locale): string {
  const [year, number] = month.split('-').map(Number) as [number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 1)))
}

/** The gates in their order, with a count each (the refusals tile's words). */
export const refusalsByGate = (byGate: readonly { gate: Gate; count: number }[]): { gate: Gate; count: number }[] => byGate.filter((entry) => entry.count > 0)

// ---- where each number leads ---------------------------------------------------------------------------------------------------

const STATUS_BOARD = '/compliance/status'

/** The status board (B-W2b-266) is built: coverage, gaps and refusals open it. */
export const boardBuilt = (built: ReadonlySet<string> = OFFICE_PAGES): boolean => built.has(STATUS_BOARD)

/**
 * Each tile's list, filtered as close to the tile as the list's address allows, once its page is built and the person may open
 * it; null otherwise (the tile says why). Coverage, gaps and refusals belong to the status board (B-W2b-266): until it is built,
 * coverage opens the certificate register and the gaps the panel on this page.
 */
export function tileHref(kpi: KpiKey, prefix: string, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  const board = built.has(STATUS_BOARD) && can.certificates
  switch (kpi) {
    case 'coverage':
      return board ? `${prefix}${STATUS_BOARD}` : can.certificates && built.has('/compliance/certificates') ? `${prefix}/compliance/certificates?view=valid` : null
    case 'shipped':
      return can.shipments && built.has('/warehouse/shipments') ? `${prefix}/warehouse/shipments` : null
    case 'gaps':
      return board ? `${prefix}${STATUS_BOARD}` : '#fw-cr-gaps'
    case 'refusals':
      return board ? `${prefix}${STATUS_BOARD}#cs-gates` : null
    case 'registerOpen':
      return can.register && built.has('/compliance/register') ? `${prefix}/compliance/register?view=open` : null
    case 'crViLots':
      return can.lots && built.has('/compliance/tests') ? `${prefix}/compliance/tests?view=released` : null
  }
}

/** Why a tile opens nothing (a message key), when it does not. */
export function tileHeld(kpi: KpiKey, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  if (kpi === 'refusals' && !built.has(STATUS_BOARD)) return 'tile.held.board'
  if (tileHref(kpi, '', can, built) !== null) return null
  return 'tile.held.noList'
}

/** Where a gap type is fixed: the status board filtered once it is built, else the page of its fix when built. */
export function gapHref(type: GapType, prefix: string, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  if (built.has(STATUS_BOARD) && can.certificates) return `${prefix}${STATUS_BOARD}?gap=${type}`
  const page: Partial<Record<GapType, { readonly path: string; readonly query: string; readonly may: boolean }>> = {
    certificate: { path: '/compliance/certificates', query: '', may: can.certificates },
    docLanguage: { path: '/compliance/declarations', query: '', may: can.certificates },
    label: { path: '/compliance/labels', query: '', may: can.certificates },
    crVi: { path: '/compliance/tests', query: '?view=waiting', may: can.lots },
    operator: { path: '/compliance/settings', query: '', may: can.certificates },
  }
  const target = page[type]
  return target && target.may && built.has(target.path) ? `${prefix}${target.path}${target.query}` : null
}

/** An expiring record's own page (or its panels while its page is not built). */
export const expiryHref = (item: Pick<ExpiryItem, 'recordType' | 'recordId' | 'label'>, prefix: string, built: ReadonlySet<string> = OFFICE_PAGES): string => `${prefix}${recordAddress({ type: item.recordType, id: item.recordId, label: item.label }, built)}`

/** A supplier's record. */
export const supplierHref = (party: Ref | null, prefix: string, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null =>
  party && can.suppliers && built.has('/purchasing/suppliers/[partyId]') ? `${prefix}/purchasing/suppliers/${encodeURIComponent(party.id)}` : null

/** The lots whose chromium VI test failed (the tests list cannot filter by supplier yet: the failed lots of every supplier). */
export const failedLotsHref = (prefix: string, can: ReportsCan, built: ReadonlySet<string> = OFFICE_PAGES): string | null => (can.lots && built.has('/compliance/tests') ? `${prefix}/compliance/tests?view=failed` : null)

/** The register's kinds its list filters by (`?kind=`): W1's three. */
const LISTED_KINDS: readonly RegisterKind[] = ['COMPLAINT', 'NON_CONFORMITY', 'RECALL']

/** A register kind's entries (the open ones when `open`); a kind the list does not filter by opens the view without it. */
export function registerHref(kind: RegisterKind | null, prefix: string, can: ReportsCan, open: boolean, built: ReadonlySet<string> = OFFICE_PAGES): string | null {
  if (!can.register || !built.has('/compliance/register')) return null
  const terms = new URLSearchParams()
  if (open) terms.set('view', 'open')
  if (kind && LISTED_KINDS.includes(kind)) terms.set('kind', kind)
  const text = terms.toString()
  return `${prefix}/compliance/register${text ? `?${text}` : ''}`
}

// ---- files (Export panel (CSV)) ------------------------------------------------------------------------------------------------

/** The words a file needs from the view (the container has no catalogue). */
export interface CsvWords {
  readonly header: readonly string[]
  readonly none: string
  /** The names of the rows (KPIs, gap types, kinds, months). */
  readonly labels?: Readonly<Record<string, string>>
}

export function kpiCsvRows(kpis: Kpis, labels: Readonly<Record<string, string>>, locale: Locale): (string | number | null)[][] {
  const rows: (string | number | null)[][] = []
  const k = kpis.kpis
  if (k.coverage) rows.push([labels.coverage ?? 'coverage', pctText(k.coverage.pct, locale), k.coverage.covered, k.coverage.needing])
  if (k.shipped) rows.push([labels.shipped ?? 'shipped', pctText(k.shipped.pct, locale), k.shipped.covered, k.shipped.needing])
  if (k.gaps) rows.push([labels.gaps ?? 'gaps', k.gaps.count, null, null])
  if (k.refusals) rows.push([labels.refusals ?? 'refusals', k.refusals.count, null, null])
  if (k.registerOpen) rows.push([labels.registerOpen ?? 'registerOpen', k.registerOpen.count, null, null])
  if (k.crViLots) rows.push([labels.crViLots ?? 'crViLots', pctText(k.crViLots.pct, locale), k.crViLots.withEvidence, k.crViLots.lots])
  return rows
}

export const gapCsvRows = (rows: readonly GapRow[], labels: Readonly<Record<string, string>>): (string | number | null)[][] =>
  rows.map((row) => [labels[row.type] ?? row.type, row.count, row.styles, row.markets, row.blocking, row.requirements.join(' ')])

export const expiryCsvRows = (answer: Expiries): (string | number | null)[][] =>
  answer.months.flatMap((month) => month.items.map((item) => [month.month, item.validTo, item.recordType, item.label, item.status, item.detail, item.party]))

export const cr6CsvRows = (answer: Cr6, words: Pick<CsvWords, 'none'>, locale: Locale): (string | number | null)[][] =>
  answer.suppliers.map((row) => [row.party ? `${row.party.code} · ${row.party.name}` : words.none, row.lots, mgText(row.median, locale), mgText(row.highest, locale), mgText(row.limit, locale), row.fails, row.belowDetection, row.lotReports, row.supplierReports])

export const registerCsvRows = (answer: Register, labels: Readonly<Record<string, string>>, locale: Locale): (string | number | null)[][] =>
  answer.kinds.map((row) => [labels[row.kind] ?? row.kind, row.opened, row.closed, row.openAtEnd, oneText(row.medianDaysToClose, locale), ...row.months])

/** The file name of a panel's export. */
export const csvName = (panel: ReportSection, range: { from: string; to: string }): string => `compliance-${panel}-${range.from}-${range.to}.csv`

/** "SEED-C1 · Seed Customer One S.r.l." */
export const refLabel = (ref: Ref | null): string | null => (ref ? `${ref.code} · ${ref.name}` : null)
