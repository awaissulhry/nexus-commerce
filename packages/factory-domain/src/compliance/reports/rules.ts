import type { Issue } from '../../core/errors'
import { businessDayRange, isBusinessDate, type BusinessDate } from '../../core/time'
import { daysFrom, plusDays } from '../../calendars/dates'
import type { LineState } from '../gates/gate'
import type { RequirementKind } from '../requirements/rules'
import { REGISTER_KINDS, type RegisterKind } from '../register/rules'

/**
 * Compliance reports (B-W2b-272; ANA-025; design compliance.reports SCR-261: cr-kpi, cr-gaps, cr-expiry, cr-cr6, cr-register,
 * tab:cr-pdf), the rules of the figures, pure. The API reads what the earlier compliance steps record — the status board's
 * style × market matrix (B-W2b-254: every cell's requirement lines, computed by THE gate's checks), the gate refusals
 * (GateEvent), the certificates (W1, B-W2b-255), the supplier declarations (B-W2b-256), the lots and their chromium VI results
 * (W1), the PPE register with its recalls and authority requests (W1, B-W2b-260) — and counts them here. Nothing is copied from
 * those modules' rules: a cell's certificate state IS the gate line's.
 *
 *   ANA-025 certificate coverage   style × market cells whose certificate requirement is met (the gate's certificate line
 *                                  OK or EXPIRING) over the cells where a certificate requirement applies (OK, EXPIRING or
 *                                  MISSING; a cell without one — a style that is not PPE, a market switched off — is not
 *                                  counted), one decimal. The KPI library of W2b-6 registers this same formula.
 *   shipped covered                the style × market pairs shipped in the period (shipment lines' styles × the ship-to
 *                                  country's market) whose cell needs a certificate: covered when the certificate line is
 *                                  OK or EXPIRING and no DoC language is missing, today (the design's "measured on what was
 *                                  actually shipped"). A destination no market profile names, or a style the board does not
 *                                  read, is counted apart as unknown.
 *   open gaps by type              every MISSING line of the matrix by its requirement's kind (certificate, DoC and user
 *                                  information languages, label, economic operator; anything else "other"), plus the lots
 *                                  that need a chromium VI result and have none that passes (quarantined or blocked).
 *   lots used with Cr VI evidence  lots that need a Cr VI test and were issued to production in the period, with a PASS.
 *   Cr VI per supplier             the current (not superseded) Cr VI results tested in the period, per the lot's supplier:
 *                                  lots tested, median and highest measured value, fails, results below detection.
 *   register summary               per kind: opened and closed in the period, open at its end, the median days to close.
 */

export const REPORT_LIMITS = Object.freeze({
  /** The longest period one read covers, in days (both ends included). */
  maxDays: 366,
  /** The period when none is asked: the 365 days up to today. */
  defaultDays: 365,
  /** The expiry calendar's months from today. */
  expiryMonths: 12,
  /** The first year the annual review takes. */
  firstYear: 2020,
})

/** The ANA-025 KPI (ANA-025 moved here from W2b-6: compliance.reports is its only screen). */
export const ANA_025 = Object.freeze({ key: 'ANA-025', name: 'Certificate coverage', better: 'UP' as const })

/** The headline numbers (design cr-kpi), in the design's order. */
export const KPI_KEYS = ['coverage', 'shipped', 'gaps', 'refusals', 'registerOpen', 'crViLots'] as const
export type KpiKey = (typeof KPI_KEYS)[number]

/** The records a figure is counted from, each behind its own view permission. */
export const SIGHTS = ['certificates', 'register', 'lots', 'shipments'] as const
export type Sight = (typeof SIGHTS)[number]

/** What each headline number needs to be seen. */
export const KPI_SIGHTS: Readonly<Record<KpiKey, readonly Sight[]>> = Object.freeze({
  coverage: ['certificates'],
  shipped: ['certificates', 'shipments'],
  gaps: ['certificates'],
  refusals: ['certificates'],
  registerOpen: ['register'],
  crViLots: ['lots'],
})

/** The gap types (design cr-gaps "certificate, DoC language, label, Cr VI evidence, operator role"), in that order. */
export const GAP_TYPES = ['certificate', 'docLanguage', 'label', 'crVi', 'operator', 'other'] as const
export type GapType = (typeof GAP_TYPES)[number]

/** The register's kinds, in the register's order (W1's three and B-W2b-260's two). */
export const REPORT_REGISTER_KINDS: readonly RegisterKind[] = REGISTER_KINDS

// ---- the period ---------------------------------------------------------------------------------------------------------------

export interface Period {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The period asked, else the 365 days up to today (a lone `from` runs to today, a lone `to` starts 364 days before it). */
export function periodOf(query: { readonly from?: string | undefined; readonly to?: string | undefined }, today: BusinessDate): Period {
  const to = query.to ?? today
  const from = query.from ?? plusDays(isBusinessDate(to) ? to : today, 1 - REPORT_LIMITS.defaultDays)
  return { from, to }
}

/** A period the report reads: real days, the end on or after the start, not after today, at most 366 days. */
export function periodProblems(period: Period, today: BusinessDate): Issue[] {
  if (!isBusinessDate(period.from)) return [{ path: 'querystring/from', message: 'Give the first day as YYYY-MM-DD.' }]
  if (!isBusinessDate(period.to)) return [{ path: 'querystring/to', message: 'Give the last day as YYYY-MM-DD.' }]
  if (period.to < period.from) return [{ path: 'querystring/to', message: 'The period ends before it starts.' }]
  if (period.to > today) return [{ path: 'querystring/to', message: 'A report reads what was recorded: the period cannot end after today.' }]
  if (daysFrom(period.from, period.to) + 1 > REPORT_LIMITS.maxDays) return [{ path: 'querystring/from', message: `A report covers at most ${REPORT_LIMITS.maxDays} days.` }]
  return []
}

/** The annual review's period: the calendar year, up to today while it runs. */
export function yearPeriod(year: number, today: BusinessDate): Period {
  const from = `${String(year).padStart(4, '0')}-01-01`
  const end = `${String(year).padStart(4, '0')}-12-31`
  return { from, to: end > today ? today : end }
}

/** A year the annual review takes: from 2020 to this year. */
export function yearProblems(year: number, today: BusinessDate): Issue[] {
  const now = Number(today.slice(0, 4))
  if (!Number.isInteger(year) || year < REPORT_LIMITS.firstYear || year > now) return [{ path: 'querystring/year', message: `Give a year from ${REPORT_LIMITS.firstYear} to ${now}.` }]
  return []
}

/** The instants of a period in Rome: from the start of its first day to the end of its last. */
export function spanOf(period: Period): { readonly start: Date; readonly end: Date } {
  return { start: businessDayRange(period.from).start, end: businessDayRange(period.to).end }
}

/** The months (YYYY-MM) a period touches, oldest first. */
export function monthsOf(period: Period): string[] {
  const out: string[] = []
  let [year, month] = period.from.split('-').map(Number) as [number, number]
  const last = period.to.slice(0, 7)
  for (let guard = 0; guard < 40; guard++) {
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
    out.push(key)
    if (key >= last) break
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

// ---- figures ------------------------------------------------------------------------------------------------------------------

/** part / whole as a percent with one decimal ("96.4"); null when there is nothing to count (never 0 for nothing). */
export function pct(part: number, whole: number): string | null {
  if (whole <= 0) return null
  return (Math.round((part / whole) * 1000) / 10).toFixed(1)
}

/** The median of numbers (null for none). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** A measured value as the answer writes it: up to 3 decimals, no trailing zeros ("1.2"); null stays null. */
export const decimalText = (value: number | null): string | null => (value === null ? null : String(Math.round(value * 1000) / 1000))

/** A value rounded to 3 decimals (a lab writes mg/kg to 3 decimals); null stays null. */
export const round3 = (value: number | null): number | null => (value === null ? null : Math.round(value * 1000) / 1000)

/** One decimal ("12.5"); null stays null. */
export const oneDecimal = (value: number | null): string | null => (value === null ? null : (Math.round(value * 10) / 10).toFixed(1))

// ---- ANA-025: certificate coverage -----------------------------------------------------------------------------------------

/** A line of the board, as much of it as the reports read (gates/gate.ts GateLine). */
export interface ReportLine {
  readonly check: string
  readonly state: LineState
  readonly blocks: boolean
  readonly requirement: { readonly code: string; readonly kind: RequirementKind; readonly blocks: readonly string[] }
}

/** One style × market cell as the coverage reads it. */
export interface CoverageCell {
  readonly styleId: string
  readonly marketCode: string
  /** The certificate line's state (the worst of them, MISSING first); null when no certificate requirement applies. */
  readonly certificate: LineState | null
  /** A DoC language is missing (the design's "covered by a valid certificate and DoC"). */
  readonly docMissing: boolean
}

const CERTIFICATE_RANK: Readonly<Record<LineState, number>> = { MISSING: 0, OVERRIDDEN: 1, EXPIRING: 2, OK: 3, MANUAL: 4, NOT_NEEDED: 5 }

/** A cell from the board's lines of one style × market. */
export function coverageCellOf(styleId: string, marketCode: string, lines: readonly ReportLine[]): CoverageCell {
  const certificate = lines
    .filter((line) => line.check === 'certificate.coverage')
    .map((line) => line.state)
    .sort((a, b) => CERTIFICATE_RANK[a] - CERTIFICATE_RANK[b])[0] ?? null
  return { styleId, marketCode, certificate, docMissing: lines.some((line) => line.check === 'doc.languages' && line.state === 'MISSING') }
}

/** The cell needs a certificate (its certificate requirement applies and is computed). */
export const needsCertificate = (cell: Pick<CoverageCell, 'certificate'>): boolean => cell.certificate === 'OK' || cell.certificate === 'EXPIRING' || cell.certificate === 'MISSING' || cell.certificate === 'OVERRIDDEN'
/** The cell's certificate requirement is met today (a valid certificate covers it; one that ends within 90 days still does). */
export const hasValidCertificate = (cell: Pick<CoverageCell, 'certificate'>): boolean => cell.certificate === 'OK' || cell.certificate === 'EXPIRING'

export interface Coverage {
  /** Cells covered by a valid certificate. */
  readonly covered: number
  /** Cells that need a certificate. */
  readonly needing: number
  /** Of the covered, those whose certificate ends within 90 days. */
  readonly expiring: number
  /** covered / needing, one decimal; null when no cell needs a certificate. */
  readonly pct: string | null
}

/** ANA-025: the share of style × market cells with a valid certificate, over the cells that need one. */
export function certificateCoverage(cells: readonly Pick<CoverageCell, 'certificate'>[]): Coverage {
  const needing = cells.filter(needsCertificate)
  const covered = needing.filter(hasValidCertificate)
  return { covered: covered.length, needing: needing.length, expiring: covered.filter((cell) => cell.certificate === 'EXPIRING').length, pct: pct(covered.length, needing.length) }
}

export interface ShippedPair {
  readonly styleId: string
  /** The market of the ship-to country (null: no market profile names it). */
  readonly marketCode: string | null
}

export interface ShippedCoverage {
  /** Distinct style × market pairs shipped in the period. */
  readonly pairs: number
  /** Of them, those whose cell needs a certificate (protective styles). */
  readonly needing: number
  /** Of those, covered today by a valid certificate and a DoC in every language the market needs. */
  readonly covered: number
  /** Pairs whose market or cell is not known (a destination no profile names, a market switched off, a style the board did not read). */
  readonly unknown: number
  readonly pct: string | null
}

const pairKey = (styleId: string, marketCode: string): string => `${styleId}|${marketCode}`

/** The design's first tile: shipped protective style × market pairs covered by a valid certificate and DoC (today). */
export function shippedCoverage(shipped: readonly ShippedPair[], cells: readonly CoverageCell[]): ShippedCoverage {
  const byKey = new Map(cells.map((cell) => [pairKey(cell.styleId, cell.marketCode), cell]))
  const seen = new Set<string>()
  let needing = 0
  let covered = 0
  let unknown = 0
  for (const pair of shipped) {
    const key = `${pair.styleId}|${pair.marketCode ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const cell = pair.marketCode ? byKey.get(pairKey(pair.styleId, pair.marketCode)) : undefined
    if (!cell) {
      unknown += 1
      continue
    }
    if (!needsCertificate(cell)) continue
    needing += 1
    if (hasValidCertificate(cell) && !cell.docMissing) covered += 1
  }
  return { pairs: seen.size, needing, covered, unknown, pct: pct(covered, needing) }
}

// ---- gaps by type ---------------------------------------------------------------------------------------------------------------

const KIND_GAP: Readonly<Record<RequirementKind, GapType>> = {
  CERTIFICATE: 'certificate',
  DOC_LANGUAGE: 'docLanguage',
  USER_INFO_LANGUAGE: 'docLanguage',
  LABEL: 'label',
  OPERATOR_ROLE: 'operator',
  TEST: 'other',
  DECLARATION: 'other',
  CLAIM_EVIDENCE: 'other',
}

/** A missing line's gap type: by its check where it names the operator's contact (GPSR), else by its requirement's kind. */
export function gapTypeOf(line: Pick<ReportLine, 'check' | 'requirement'>): GapType {
  if (line.check === 'gpsr.contact' || line.check === 'operator.role') return 'operator'
  if (line.check === 'doc.languages' || line.check === 'userInfo.languages') return 'docLanguage'
  return KIND_GAP[line.requirement.kind]
}

export interface MissingLine extends ReportLine {
  readonly styleId: string
  readonly marketCode: string
}

export interface GapRow {
  readonly type: GapType
  /** Missing requirement lines (a style × market × requirement each); for Cr VI, the lots. */
  readonly count: number
  /** Distinct styles with such a gap (null for Cr VI: lots are not styles). */
  readonly styles: number | null
  /** Distinct markets with such a gap (null for Cr VI). */
  readonly markets: number | null
  /** Of the count, those that block at least one gate (null for Cr VI: W1's lot release holds the lot itself). */
  readonly blocking: number | null
  /** The requirement codes behind the gaps, most frequent first (at most 5). */
  readonly requirements: readonly string[]
}

/** The open gaps by type (every MISSING line of the matrix, and the lots without Cr VI evidence), in GAP_TYPES order. */
export function gapsByType(lines: readonly MissingLine[], crViLots: number | null): GapRow[] {
  return GAP_TYPES.flatMap((type): GapRow[] => {
    if (type === 'crVi') return crViLots === null ? [] : [{ type, count: crViLots, styles: null, markets: null, blocking: null, requirements: [] }]
    const ofType = lines.filter((line) => line.state === 'MISSING' && gapTypeOf(line) === type)
    const codes = new Map<string, number>()
    for (const line of ofType) codes.set(line.requirement.code, (codes.get(line.requirement.code) ?? 0) + 1)
    return [
      {
        type,
        count: ofType.length,
        styles: new Set(ofType.map((line) => line.styleId)).size,
        markets: new Set(ofType.map((line) => line.marketCode)).size,
        blocking: ofType.filter((line) => line.requirement.blocks.length > 0).length,
        requirements: [...codes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([code]) => code),
      },
    ]
  })
}

/** The open gaps in all (the KPI tile): the sum of the types shown. */
export const openGaps = (rows: readonly Pick<GapRow, 'count'>[]): number => rows.reduce((sum, row) => sum + row.count, 0)

// ---- chromium VI per supplier --------------------------------------------------------------------------------------------------

export interface CrViResult {
  readonly lotId: string
  readonly supplierId: string | null
  /** mg/kg; null when below detection. */
  readonly value: number | null
  readonly belowDetection: boolean
  readonly limit: number
  readonly verdict: 'PASS' | 'FAIL'
  readonly evidence: 'LOT_REPORT' | 'SUPPLIER_REPORT'
}

export interface CrViSupplier {
  readonly supplierId: string | null
  readonly lots: number
  readonly results: number
  /** Results with a measured value (below detection has none). */
  readonly measured: number
  readonly belowDetection: number
  readonly median: number | null
  readonly highest: number | null
  readonly fails: number
  /** The limit the results were judged against (the most frequent; the lowest on a tie). */
  readonly limit: number | null
  readonly lotReports: number
  readonly supplierReports: number
}

/** The results per supplier, the one with fails first, then the highest value, then by most lots. */
export function crViBySupplier(results: readonly CrViResult[]): CrViSupplier[] {
  const groups = new Map<string, CrViResult[]>()
  for (const result of results) groups.set(result.supplierId ?? '', [...(groups.get(result.supplierId ?? '') ?? []), result])
  const rows = [...groups.entries()].map(([key, group]): CrViSupplier => {
    const values = group.flatMap((result) => (result.value === null || result.belowDetection ? [] : [result.value]))
    const limits = new Map<number, number>()
    for (const result of group) limits.set(result.limit, (limits.get(result.limit) ?? 0) + 1)
    const limit = [...limits.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null
    return {
      supplierId: key === '' ? null : key,
      lots: new Set(group.map((result) => result.lotId)).size,
      results: group.length,
      measured: values.length,
      belowDetection: group.filter((result) => result.belowDetection).length,
      median: round3(median(values)),
      highest: values.length > 0 ? Math.max(...values) : null,
      fails: group.filter((result) => result.verdict === 'FAIL').length,
      limit,
      lotReports: group.filter((result) => result.evidence === 'LOT_REPORT').length,
      supplierReports: group.filter((result) => result.evidence === 'SUPPLIER_REPORT').length,
    }
  })
  return rows.sort((a, b) => b.fails - a.fails || (b.highest ?? -1) - (a.highest ?? -1) || b.lots - a.lots || (a.supplierId ?? '~').localeCompare(b.supplierId ?? '~'))
}

// ---- the register ---------------------------------------------------------------------------------------------------------------

export interface RegisterFact {
  readonly kind: RegisterKind
  readonly reportedAt: Date
  readonly closedAt: Date | null
}

export interface RegisterRow {
  readonly kind: RegisterKind
  /** Reported in the period. */
  readonly opened: number
  /** Closed in the period. */
  readonly closed: number
  /** Open at the period's end (reported by then, not closed by then). */
  readonly openAtEnd: number
  /** The median days from report to close of the entries closed in the period, one decimal; null for none. */
  readonly medianDaysToClose: string | null
  /** Entries reported per month of the period (the trend), oldest first. */
  readonly months: readonly number[]
}

const DAY_MS = 86_400_000

/** Days from report to close, as a decimal. */
export const daysToClose = (fact: Pick<RegisterFact, 'reportedAt' | 'closedAt'>): number | null => (fact.closedAt === null ? null : Math.max(0, (fact.closedAt.getTime() - fact.reportedAt.getTime()) / DAY_MS))

/** The month (YYYY-MM) an instant falls in, in Rome. */
export const monthOf = (instant: Date, toDay: (instant: Date) => BusinessDate): string => toDay(instant).slice(0, 7)

/** The register summary per kind (every kind, in the register's order) and its total. */
export function registerSummary(facts: readonly RegisterFact[], span: { readonly start: Date; readonly end: Date }, months: readonly string[], toDay: (instant: Date) => BusinessDate): { readonly rows: RegisterRow[]; readonly total: Omit<RegisterRow, 'kind'> } {
  const inSpan = (at: Date | null) => at !== null && at.getTime() >= span.start.getTime() && at.getTime() < span.end.getTime()
  const rowOf = (group: readonly RegisterFact[]): Omit<RegisterRow, 'kind'> => {
    const closedIn = group.filter((fact) => inSpan(fact.closedAt))
    const days = closedIn.flatMap((fact) => {
      const value = daysToClose(fact)
      return value === null ? [] : [value]
    })
    return {
      opened: group.filter((fact) => inSpan(fact.reportedAt)).length,
      closed: closedIn.length,
      openAtEnd: group.filter((fact) => fact.reportedAt.getTime() < span.end.getTime() && (fact.closedAt === null || fact.closedAt.getTime() >= span.end.getTime())).length,
      medianDaysToClose: oneDecimal(median(days)),
      months: months.map((month) => group.filter((fact) => inSpan(fact.reportedAt) && monthOf(fact.reportedAt, toDay) === month).length),
    }
  }
  return { rows: REPORT_REGISTER_KINDS.map((kind) => ({ kind, ...rowOf(facts.filter((fact) => fact.kind === kind)) })), total: rowOf(facts) }
}

/** An authority request answered on time: by the end of its due day in Rome. */
export const answeredOnTime = (request: { readonly answeredAt: Date | null; readonly dueOn: BusinessDate }): boolean => request.answeredAt !== null && request.answeredAt.getTime() < businessDayRange(request.dueOn).end.getTime()
