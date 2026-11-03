import type { Issue } from '../../core/errors'
import { businessDayRange, isBusinessDate, type BusinessDate } from '../../core/time'
import { daysFrom, plusDays } from '../../calendars/dates'
import { groupShown, TOO_FEW_WORDS } from '../../people/privacy/groups'
import { isoWeekKey, weekStart } from '../../planning/settings/buckets'
import { inspectedOf } from '../final/plan'
import { dhuOf } from '../inprocess/rules'

/**
 * Quality reports (B-W2b-138; QHS-147; design quality.reports SCR-147): the rules of the figures, pure. The API reads the
 * records the earlier quality steps sign (B-W2b-97 final inspections, B-W2b-98/-111 incoming, B-W2b-99 in-process checks,
 * B-W2a-47 NCRs, B-W2b-108 CAPA, B-W2b-114 holds) and counts them here.
 *
 *   first-pass yield   pieces that passed the end-of-line check with no defect, over the pieces checked (B-W2b-99's
 *                      decided END_OF_LINE checks: pieces − defective pieces over pieces), one decimal
 *   DHU                defects per hundred pieces at end of line (B-W2b-99 `dhuOf`); per operation: the defects charged to
 *                      it (end of line, roving, scan lines: `chargesByOperation`) per hundred pieces reported there
 *   AQL pass (final)   final inspections PASSED over those PASSED or FAILED, signed in the period (cancelled and open ones
 *                      are not decided)
 *   NCRs open          at the period's end: found by then, neither closed nor cancelled by then; their average age in days
 *   CAPA on time       actions done in the period whose done moment is before the end of their due day (B-W2b-108's note)
 *   old holds          holds standing at the period's end that were placed more than 7 days before it
 *
 * Signed records only, as they were signed: an amendment (B-W2b-123) is an overlay that never changes a verdict, a class, a
 * quantity or a count, so every figure here reads the signed values; the page says how many corrections were signed.
 *
 * Never per worker (Statuto dei Lavoratori art. 4; Owner answers W1, F2; ANA-075): a figure stands on a group of people (a
 * site, a line, an operation, a style), and a group with fewer people than the company's minimum shows no figure at all
 * (`peopleShown`): an unknown headcount counts as too few. A comparison by operation is by the operation, never by who did it.
 */

export const REPORT_LIMITS = Object.freeze({
  /** The longest period one read covers, in days (both ends included). */
  maxDays: 366,
  /** The period when none is asked: the 30 days up to today. */
  defaultDays: 30,
  /** A hold standing longer than this many days counts as old. */
  oldHoldDays: 7,
  /** The CAPA closures a week names at most (the rest are counted). */
  closuresPerWeek: 10,
})

/** The comparison table's dimensions (design qr-table "By line, operation, supplier and style"). */
export const DIMENSIONS = ['line', 'operation', 'supplier', 'style'] as const
export type Dimension = (typeof DIMENSIONS)[number]

/** The records a figure is counted from, each behind its own view permission (QHS-147 "reports per role"). */
export const SIGHTS = ['inprocess', 'inspections', 'ncr', 'capa', 'holds', 'incoming', 'lots'] as const
export type Sight = (typeof SIGHTS)[number]

/** The headline numbers (design qr-kpi), in the design's order. */
export const KPI_KEYS = ['fpy', 'dhu', 'aqlPass', 'ncrOpen', 'capaOnTime', 'holdsOld'] as const
export type KpiKey = (typeof KPI_KEYS)[number]

/** Which way is better for each headline number (the trend arrow's tone; the words are the screen's). */
export const BETTER_WHEN: Readonly<Record<KpiKey, 'UP' | 'DOWN'>> = Object.freeze({ fpy: 'UP', dhu: 'DOWN', aqlPass: 'UP', ncrOpen: 'DOWN', capaOnTime: 'UP', holdsOld: 'DOWN' })

/** What a site's group may never show: the same words as every People read. */
export const TOO_FEW = TOO_FEW_WORDS

// ---- the period -----------------------------------------------------------------------------------------------------------------

export interface Period {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The period asked, else the 30 days up to today (a lone `from` runs to today, a lone `to` starts 29 days before it). */
export function periodOf(query: { readonly from?: string | undefined; readonly to?: string | undefined }, today: BusinessDate): Period {
  const to = query.to ?? today
  const from = query.from ?? (query.to ? plusDays(query.to, 1 - REPORT_LIMITS.defaultDays) : plusDays(today, 1 - REPORT_LIMITS.defaultDays))
  return { from, to }
}

/** A period the report reads: real days, the end on or after the start, not after today, at most 366 days. */
export function periodProblems(period: Period, today: BusinessDate): Issue[] {
  if (!isBusinessDate(period.from)) return [{ path: 'querystring/from', message: 'Give the first day as YYYY-MM-DD.' }]
  if (!isBusinessDate(period.to)) return [{ path: 'querystring/to', message: 'Give the last day as YYYY-MM-DD.' }]
  if (period.to < period.from) return [{ path: 'querystring/to', message: 'The period ends before it starts.' }]
  if (period.to > today) return [{ path: 'querystring/to', message: 'A report reads what was signed: the period cannot end after today.' }]
  if (daysFrom(period.from, period.to) + 1 > REPORT_LIMITS.maxDays) return [{ path: 'querystring/from', message: `A report covers at most ${REPORT_LIMITS.maxDays} days.` }]
  return []
}

/** The same number of days right before (the comparison of "compare to previous"). */
export function previousOf(period: Period): Period {
  const days = daysFrom(period.from, period.to) + 1
  return { from: plusDays(period.from, -days), to: plusDays(period.from, -1) }
}

/** The number of days of a period, both ends included. */
export const daysOf = (period: Period): number => daysFrom(period.from, period.to) + 1

/** The instants of a period at the site: from the start of its first day to the end of its last. */
export function spanOf(period: Period, timeZone: string): { readonly start: Date; readonly end: Date } {
  return { start: businessDayRange(period.from, timeZone).start, end: businessDayRange(period.to, timeZone).end }
}

export interface Week {
  /** The ISO week, `2026-W44`. */
  readonly key: string
  /** The days of the period it covers (the first and the last week may be clipped). */
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The ISO weeks (Monday to Sunday) a period touches, oldest first, each clipped to the period. */
export function weeksOf(period: Period): Week[] {
  const out: Week[] = []
  for (let monday = weekStart(period.from); monday <= period.to; monday = plusDays(monday, 7)) {
    const sunday = plusDays(monday, 6)
    out.push({ key: isoWeekKey(monday), from: monday < period.from ? period.from : monday, to: sunday > period.to ? period.to : sunday })
  }
  return out
}

/** The ISO week a day falls in. */
export const weekKeyOf = (day: BusinessDate): string => isoWeekKey(day)

// ---- figures --------------------------------------------------------------------------------------------------------------------

/** A share in percent with one decimal ("96.4"), or null when the whole is nothing (never a made-up 0). */
export function pct(part: number, whole: number): string | null {
  if (!(whole > 0)) return null
  return (Math.round((Math.max(0, Math.min(part, whole)) * 1000) / whole) / 10).toFixed(1)
}

/** First-pass yield: pieces with no defect at end of line, over the pieces checked. */
export const fpyOf = (pieces: number, defective: number): string | null => pct(pieces - Math.max(0, defective), pieces)

/** Defects per hundred units (B-W2b-99's rule). */
export { dhuOf }

/** The final AQL pass rate: passed over decided. */
export const passRateOf = (passed: number, decided: number): string | null => pct(passed, decided)

/**
 * The units a final inspection looked at: an inspection on a plan counts its pieces (B-W2b-97's AQL_SAMPLE entry, which may
 * stop short when the stop rule ends a rejected sample), a W1 inspection its sample.
 */
export function unitsInspectedOf(row: { readonly planVersionId: string | null; readonly sampleSize: number; readonly checklist: unknown }): number {
  if (!row.planVersionId) return row.sampleSize
  const counted = inspectedOf(row.checklist)
  return counted > 0 ? counted : row.sampleSize
}

/** A CAPA action done on time: done before its due day ended at the site (B-W2b-108: doneAt ≤ dueOn end of day). */
export function doneOnTime(doneAt: Date, dueOn: BusinessDate, timeZone: string): boolean {
  return doneAt.getTime() < businessDayRange(dueOn, timeZone).end.getTime()
}

/** An NCR open at a moment: found by then, neither closed nor cancelled by then. */
export function openAt(row: { readonly foundOn: Date; readonly closedAt: Date | null; readonly cancelledAt: Date | null }, at: Date): boolean {
  const t = at.getTime()
  return row.foundOn.getTime() <= t && !(row.closedAt && row.closedAt.getTime() <= t) && !(row.cancelledAt && row.cancelledAt.getTime() <= t)
}

/** A hold standing at a moment: placed by then, neither released nor closed by then. */
export function heldAt(row: { readonly placedAt: Date; readonly releasedAt: Date | null; readonly closedAt: Date | null }, at: Date): boolean {
  const t = at.getTime()
  return row.placedAt.getTime() <= t && !(row.releasedAt && row.releasedAt.getTime() <= t) && !(row.closedAt && row.closedAt.getTime() <= t)
}

const DAY_MS = 86_400_000

/** A hold standing at a moment that was placed more than `days` days before it. */
export function oldHoldAt(row: { readonly placedAt: Date; readonly releasedAt: Date | null; readonly closedAt: Date | null }, at: Date, days: number = REPORT_LIMITS.oldHoldDays): boolean {
  return heldAt(row, at) && at.getTime() - row.placedAt.getTime() > days * DAY_MS
}

/** Days from one moment to another (fractional; never below 0). */
export const daysBetween = (from: Date, to: Date): number => Math.max(0, (to.getTime() - from.getTime()) / DAY_MS)

/** The mean of some day counts with one decimal, or null when there are none. */
export function averageDays(values: readonly number[]): string | null {
  if (values.length === 0) return null
  return (Math.round((values.reduce((sum, value) => sum + value, 0) * 10) / values.length) / 10).toFixed(1)
}

/**
 * The days a lot spent in quarantine: from its receipt to the lab's decision (released or rejected), else up to `at` while it
 * waits (counted as "still in quarantine"); null for a lot with no receipt moment.
 */
export function quarantineDaysOf(lot: { readonly receivedAt: Date | null; readonly qualityDecidedAt: Date | null }, at: Date): number | null {
  if (!lot.receivedAt) return null
  return daysBetween(lot.receivedAt, lot.qualityDecidedAt ?? at)
}

// ---- the comparison with the previous period ------------------------------------------------------------------------------------

export type Direction = 'UP' | 'DOWN' | 'SAME'

export interface Change {
  readonly direction: Direction
  /** By how much (points for a percent, the unit for a count or DHU), one decimal, never signed. */
  readonly by: string
  /** Whether the change is good news (null when nothing changed). */
  readonly better: boolean | null
}

/** The change of a headline number against the previous period, or null when either side has no figure. */
export function changeOf(kpi: KpiKey, now: string | number | null | undefined, before: string | number | null | undefined): Change | null {
  if (now === null || now === undefined || before === null || before === undefined) return null
  const a = Number(now)
  const b = Number(before)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const diff = Math.round((a - b) * 10) / 10
  if (diff === 0) return { direction: 'SAME', by: '0.0', better: null }
  const direction: Direction = diff > 0 ? 'UP' : 'DOWN'
  return { direction, by: Math.abs(diff).toFixed(1), better: direction === BETTER_WHEN[kpi] }
}

// ---- people behind a figure (ANA-075) --------------------------------------------------------------------------------------------

/** A group's figures may show: at least the company's minimum of people stand behind them (an unknown headcount never). */
export const peopleShown = (people: number | null | undefined, minimum: number): boolean => groupShown(people, minimum)

/** A set of worker ids as a headcount (null ids are no one: a scan that names nobody adds nobody). */
export const headcountOf = (workers: Iterable<string | null | undefined>): number => new Set([...workers].filter((id): id is string => typeof id === 'string')).size

// ---- the comparison table -------------------------------------------------------------------------------------------------------

/** An operation of a work order as the report groups it: the library operation, else its code (B-W2b-99 groups by code). */
export const operationKeyOf = (operation: { readonly operationId: string | null; readonly code: string }): string => operation.operationId ?? `code:${operation.code.trim().toUpperCase()}`

/** What one row of the comparison counted. */
export interface Tally {
  inspected: number
  defects: number
  passed: number
  decided: number
  ncrs: number
}

export const emptyTally = (): Tally => ({ inspected: 0, defects: 0, passed: 0, decided: 0, ncrs: 0 })

/** Which columns a dimension fills (the others say "—": nothing of that kind is counted for it). */
export const COLUMNS_OF: Readonly<Record<Dimension, { readonly inspected: boolean; readonly aql: boolean; readonly ncrs: boolean }>> = Object.freeze({
  line: { inspected: true, aql: true, ncrs: true },
  operation: { inspected: true, aql: false, ncrs: false },
  supplier: { inspected: true, aql: true, ncrs: true },
  style: { inspected: true, aql: true, ncrs: true },
})

/** Dimensions whose rows stand on people (the supplier rows are companies: never masked). */
export const PEOPLE_DIMENSIONS: readonly Dimension[] = Object.freeze(['line', 'operation', 'style'])

export interface RowFigures {
  readonly inspected: number | null
  readonly defects: number | null
  readonly dhu: string | null
  readonly aql: { readonly passed: number; readonly decided: number; readonly pct: string | null } | null
  readonly ncrs: number | null
}

/** The figures of one row: its tally in the columns its dimension fills, all empty when the group is too small. */
export function rowFigures(dimension: Dimension, tally: Tally, tooFew: boolean, sight: { readonly counts: boolean; readonly aql: boolean; readonly ncrs: boolean }): RowFigures {
  const columns = COLUMNS_OF[dimension]
  if (tooFew) return { inspected: null, defects: null, dhu: null, aql: null, ncrs: null }
  const counts = columns.inspected && sight.counts
  return {
    inspected: counts ? tally.inspected : null,
    defects: counts ? tally.defects : null,
    dhu: counts ? dhuOf(tally.defects, tally.inspected) : null,
    aql: columns.aql && sight.aql ? { passed: tally.passed, decided: tally.decided, pct: passRateOf(tally.passed, tally.decided) } : null,
    ncrs: columns.ncrs && sight.ncrs ? tally.ncrs : null,
  }
}
