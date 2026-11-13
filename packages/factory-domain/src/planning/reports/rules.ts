import { daysFrom, plusDays } from '../../calendars/dates'
import { businessDate, isBusinessDate, type BusinessDate } from '../../core/time'
import type { Issue } from '../../core/errors'
import { lastMonthOf, periodOf, REPORT_LIMITS, type Period } from '../../inventory/reports/rules'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'
import { Dec, type Decimal } from '../../tax/decimal'
import { LATER, PAST } from '../demand/rules'
import type { ItemProfile } from '../item-profile/profile'
import { uniformBuckets, weekStart, type Bucket } from '../settings/buckets'

/**
 * Planning reports (B-W2b-349; design planning.reports SCR-254; PLN-202, PLN-204, PLN-207), pure: the period and its weeks,
 * schedule adherence (planned against actual start and finish of each finished work order), the utilisation trend (earned
 * against available minutes per lane and week, and the plan's load ahead) and the material cover (days of cover and the
 * projected stock-out day of each material). No money (minutes, days, quantities) and no person: work is counted per line,
 * work centre, plant and workshop only (Owner answers W1, F2); a scan's worker is never read.
 */

export { lastMonthOf, periodOf, type Period }

export const PLANNING_REPORT_LIMITS = Object.freeze({
  /** The longest period one read covers (both ends included), and the first day a report reads. */
  maxDays: REPORT_LIMITS.maxDays,
  firstDay: REPORT_LIMITS.firstDay,
  /** Finished work orders read for adherence (more: `complete` false). */
  workOrders: 5000,
  /** Rows of a drill ("Work orders behind this bar"). */
  drillRows: 500,
  /** Materials of the cover grid. */
  coverRows: 500,
  /** Weeks of load ahead of the utilisation trend (from this week). */
  ahead: { min: 0, max: 12, default: 4 },
  /** Weeks of the cover horizon (the item profile's horizon). */
  coverWeeks: { min: 1, max: 52, default: 13 },
})

/** A period the report reads, in the site's days: real days, the end on or after the start, not after today, at most 366 days, from 2020. */
export function periodProblems(period: Period, today: BusinessDate): Issue[] {
  if (!isBusinessDate(period.from)) return [{ path: 'querystring/from', message: 'Give the first day as YYYY-MM-DD.' }]
  if (!isBusinessDate(period.to)) return [{ path: 'querystring/to', message: 'Give the last day as YYYY-MM-DD.' }]
  if (period.to < period.from) return [{ path: 'querystring/to', message: 'The period ends before it starts.' }]
  if (period.to > today) return [{ path: 'querystring/to', message: 'A report reads what happened: the period cannot end after today.' }]
  if (period.from < PLANNING_REPORT_LIMITS.firstDay) return [{ path: 'querystring/from', message: `A report starts on ${PLANNING_REPORT_LIMITS.firstDay} or later.` }]
  if (daysFrom(period.from, period.to) + 1 > PLANNING_REPORT_LIMITS.maxDays) return [{ path: 'querystring/from', message: `A report covers at most ${PLANNING_REPORT_LIMITS.maxDays} days.` }]
  return []
}

/** A percent with one decimal ("87.5"); null when the whole is not above 0. */
export function pctOf(part: Decimal, whole: Decimal): string | null {
  if (!whole.gt(0)) return null
  return part.div(whole).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

/** Minutes with one decimal. */
export const minutesOf = (value: Decimal): string => value.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)

// ---- the weeks ---------------------------------------------------------------------------------------------------------------

export interface ReportWeek {
  /** The ISO week (2026-W46). */
  readonly key: string
  /** Its days on show: the period's part (clipped) and/or the whole week ahead. */
  readonly from: BusinessDate
  readonly to: BusinessDate
  /** The week has days of the period (what happened: earned, finished). */
  readonly actual: boolean
  /** The week is this week or later (the plan's load). */
  readonly ahead: boolean
  /** The period's days of it (null: none). */
  readonly actualDays: { readonly from: BusinessDate; readonly to: BusinessDate } | null
}

/**
 * The utilisation trend's weeks: the period's weeks (the first and last clipped to it) for what happened, then this week and
 * the `ahead` - 1 weeks after it, whole, for the plan's load. A week in both (this week, when the period reaches today) is one
 * week with both parts; the days between the two runs are not shown.
 */
export function reportWeeksOf(period: Period, today: BusinessDate, ahead: number): ReportWeek[] {
  const actual = uniformBuckets(period.from, period.to, 'WEEK')
  const monday = weekStart(today)
  const coming = ahead > 0 ? uniformBuckets(monday, plusDays(monday, ahead * 7 - 1), 'WEEK') : []
  const byKey = new Map<string, ReportWeek>()
  for (const bucket of actual) byKey.set(bucket.key, { key: bucket.key, from: bucket.from, to: bucket.to, actual: true, ahead: false, actualDays: { from: bucket.from, to: bucket.to } })
  for (const bucket of coming) {
    const seen = byKey.get(bucket.key)
    byKey.set(bucket.key, seen ? { ...seen, from: seen.from < bucket.from ? seen.from : bucket.from, to: bucket.to, ahead: true } : { key: bucket.key, from: bucket.from, to: bucket.to, actual: false, ahead: true, actualDays: null })
  }
  return [...byKey.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}

/** The week bucket a day falls in (null: none of them). */
export function weekOfDay(weeks: readonly Pick<Bucket, 'key' | 'from' | 'to'>[], day: BusinessDate): string | null {
  for (const week of weeks) if (day >= week.from && day <= week.to) return week.key
  return null
}

// ---- schedule adherence (PLN-202) --------------------------------------------------------------------------------------------

export const ADHERENCE_STATES = ['ON_TIME', 'LATE', 'NOT_PLANNED'] as const
export type AdherenceState = (typeof ADHERENCE_STATES)[number]
export const PLAN_SOURCES = ['PUBLISHED', 'WORKING'] as const
export type PlanSource = (typeof PLAN_SOURCES)[number]

/** One bar of a work order on a plan (a ScheduleSlot of a published version or of the working plan). */
export interface PlanBar {
  readonly versionId: string
  readonly kind: PlanSource
  readonly number: number | null
  readonly publishedAt: Date | null
  readonly startAt: Date
  readonly endAt: Date
}

/** The plan a finished work order is measured against: its first bar's start and its last bar's end on that plan. */
export interface PlannedSpan {
  readonly source: PlanSource
  readonly versionId: string
  readonly number: number | null
  readonly startAt: Date
  readonly endAt: Date
}

/**
 * The baseline of a work order: the plan the floor worked to when its work started — the latest PUBLISHED version published
 * on or before its first work that has bars of it; else (published only after it started) the first published version with
 * bars of it; else the working plan (never published); else none (it was never on the board: NOT_PLANNED, counted apart and
 * never on time or late). A later replan does not move the goalposts.
 */
export function baselineOf(bars: readonly PlanBar[], actualStart: Date | null): PlannedSpan | null {
  if (bars.length === 0) return null
  const byVersion = new Map<string, PlanBar[]>()
  for (const bar of bars) byVersion.set(bar.versionId, [...(byVersion.get(bar.versionId) ?? []), bar])
  const versions = [...byVersion.values()].map((list) => list[0]!)
  const published = versions.filter((bar) => bar.kind === 'PUBLISHED' && bar.publishedAt !== null).sort((a, b) => a.publishedAt!.getTime() - b.publishedAt!.getTime() || (a.number ?? 0) - (b.number ?? 0))
  const before = actualStart ? published.filter((bar) => bar.publishedAt!.getTime() <= actualStart.getTime()) : []
  const chosen = before.at(-1) ?? published[0] ?? versions.find((bar) => bar.kind === 'WORKING') ?? null
  if (!chosen) return null
  const list = byVersion.get(chosen.versionId)!
  const startAt = new Date(Math.min(...list.map((bar) => bar.startAt.getTime())))
  const endAt = new Date(Math.max(...list.map((bar) => bar.endAt.getTime())))
  return { source: chosen.kind, versionId: chosen.versionId, number: chosen.number, startAt, endAt }
}

export interface Adherence {
  readonly state: AdherenceState
  /** Site days between the planned and the actual start (+ late, − early); null: no plan or no recorded start. */
  readonly startDays: number | null
  /** Site days between the planned and the actual finish (+ late, − early); null: no plan. */
  readonly finishDays: number | null
}

/**
 * A finished work order against its plan, in the site's days: on time when it finished on or before the day its last bar
 * ended (a day's granularity: a bar ending at 18:00 finished at 19:00 the same day is on time), late after it. The start says
 * how many days after (or before) its first bar the first work on it was recorded.
 */
export function adherenceOf(facts: { readonly planned: PlannedSpan | null; readonly actualStart: Date | null; readonly actualFinish: Date; readonly timeZone: string }): Adherence {
  if (!facts.planned) return { state: 'NOT_PLANNED', startDays: null, finishDays: null }
  const day = (at: Date) => businessDate(at, facts.timeZone)
  const finishDays = daysFrom(day(facts.planned.endAt), day(facts.actualFinish))
  const startDays = facts.actualStart ? daysFrom(day(facts.planned.startAt), day(facts.actualStart)) : null
  return { state: finishDays <= 0 ? 'ON_TIME' : 'LATE', startDays, finishDays }
}

export interface AdherenceFigures {
  /** Work orders finished. */
  readonly finished: number
  /** Of them on a plan (measured), on time, late, not on any plan. */
  readonly planned: number
  readonly onTime: number
  readonly late: number
  readonly notPlanned: number
  /** On time ÷ measured, one decimal (null: none measured). */
  readonly onTimePct: string | null
  /** Measured work orders started after their first bar's day. */
  readonly startedLate: number
  /** The mean finish and start deviation in days, one decimal (null: none measured). */
  readonly meanFinishDays: string | null
  readonly meanStartDays: string | null
}

const mean = (values: readonly number[]): string | null => (values.length === 0 ? null : new Dec(values.reduce((sum, value) => sum + value, 0)).div(values.length).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1))

/** The figures of a set of finished work orders. */
export function adherenceFigures(rows: readonly Adherence[]): AdherenceFigures {
  const measured = rows.filter((row) => row.state !== 'NOT_PLANNED')
  const onTime = measured.filter((row) => row.state === 'ON_TIME').length
  const starts = measured.flatMap((row) => (row.startDays === null ? [] : [row.startDays]))
  return {
    finished: rows.length,
    planned: measured.length,
    onTime,
    late: measured.length - onTime,
    notPlanned: rows.length - measured.length,
    onTimePct: pctOf(new Dec(onTime), new Dec(measured.length)),
    startedLate: starts.filter((value) => value > 0).length,
    meanFinishDays: mean(measured.map((row) => row.finishDays!)),
    meanStartDays: mean(starts),
  }
}

/** The drill's order: the latest finish against plan first, then the work orders on no plan, then by number. */
export function adherenceOrder<T extends Adherence & { readonly number: string }>(a: T, b: T): number {
  const rank = (row: Adherence) => (row.state === 'NOT_PLANNED' ? Number.NEGATIVE_INFINITY : row.finishDays!)
  const byDays = rank(b) - rank(a)
  if (byDays !== 0 && Number.isFinite(byDays)) return byDays
  if (rank(a) !== rank(b)) return rank(a) === Number.NEGATIVE_INFINITY ? 1 : -1
  return a.number.localeCompare(b.number)
}

// ---- the utilisation trend (PLN-204) -------------------------------------------------------------------------------------------

export const LANE_KINDS = ['PLANT', 'LINE', 'WORK_CENTRE', 'WORKSHOP'] as const
export type ReportLaneKind = (typeof LANE_KINDS)[number]

export interface EarnedScan {
  readonly id: string
  readonly kind: 'REPORT' | 'UNDO' | 'CORRECTION'
  readonly correctsId: string | null
  readonly bundleId: string
  readonly operationId: string
  readonly good: number
  readonly stationId: string | null
  readonly at: Date
}

export interface EarnedEntry {
  /** `LINE:<id>` or `WORK_CENTRE:<id>`. */
  readonly lane: string
  readonly week: string
  readonly operationId: string
  readonly good: number
  readonly minutes: Decimal
}

/**
 * Earned standard minutes per lane, week and operation: the good garments of the standing scans (a REPORT or CORRECTION no
 * later UNDO or CORRECTION voids) of whole-garment bundles (no `part`) that are ACTIVE, × the operation's frozen standard
 * minutes, counted in the week (the site's day) the scan reached the server. A scan from a station on a line counts for the
 * line; from a station of no line, for the station's work centre (as the capacity books an operation on a line or on a work
 * centre, never both). As Planning settings' actual line efficiency (planning/capacity/actual): never per person or station.
 */
export function earnedEntries(facts: {
  readonly scans: readonly EarnedScan[]
  readonly bundles: ReadonlyMap<string, { readonly part: string | null; readonly status: string }>
  readonly standardMinutes: ReadonlyMap<string, string>
  readonly laneOfStation: ReadonlyMap<string, string | null>
  readonly weeks: readonly Pick<Bucket, 'key' | 'from' | 'to'>[]
  readonly timeZone: string
}): EarnedEntry[] {
  const voided = new Set(facts.scans.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
  const out = new Map<string, { lane: string; week: string; operationId: string; good: number; minutes: Decimal }>()
  for (const scan of facts.scans) {
    if (scan.kind === 'UNDO' || voided.has(scan.id) || scan.good <= 0 || scan.stationId === null) continue
    const bundle = facts.bundles.get(scan.bundleId)
    const lane = facts.laneOfStation.get(scan.stationId) ?? null
    if (!bundle || bundle.part !== null || bundle.status !== 'ACTIVE' || lane === null) continue
    const week = weekOfDay(facts.weeks, businessDate(scan.at, facts.timeZone))
    if (!week) continue
    const key = `${lane}|${week}|${scan.operationId}`
    const minutes = decimalOf(facts.standardMinutes.get(scan.operationId) ?? '0').times(scan.good)
    const seen = out.get(key)
    out.set(key, seen ? { ...seen, good: seen.good + scan.good, minutes: seen.minutes.plus(minutes) } : { lane, week, operationId: scan.operationId, good: scan.good, minutes })
  }
  return [...out.values()]
}

/** A lane key: `LINE:<id>`, `WORK_CENTRE:<id>`. */
export const laneKey = (kind: 'LINE' | 'WORK_CENTRE', id: string): string => `${kind}:${id}`

// ---- material cover (PLN-207) --------------------------------------------------------------------------------------------------

export const COVER_STATES = ['SHORT_NOW', 'STOCK_OUT', 'BELOW_SAFETY', 'COVERED'] as const
export type CoverState = (typeof COVER_STATES)[number]

export interface CoverMove {
  readonly day: BusinessDate
  readonly quantity: string
}

export interface Cover {
  /** What the orders still need within the horizon (late demand included), and the open purchase lines due within it. */
  readonly demand: string
  readonly receipts: string
  /** The projected stock at the horizon's end (on hand + receipts − demand, nothing more ordered). */
  readonly projectedEnd: string
  /** The first day the projected stock falls below 0 / below the safety stock (today when it already is); null: not in the horizon. */
  readonly stockOutOn: BusinessDate | null
  readonly belowSafetyOn: BusinessDate | null
  /** Days from today to the stock-out (0: short now); null: none in the horizon. */
  readonly daysOfCover: number | null
  readonly state: CoverState
}

const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)

/**
 * A material's cover from its item profile (planning/item-profile/profile, the "Projected stock" pop-up's numbers): the
 * stock-out is in the profile's first short week (`firstShort`), on the first day of that week the stock projected day by day
 * (receipts of a day before its demand) falls below 0 — so the report and the pop-up always agree on the week — and today
 * when the week is PAST or the day already gone. The same for the safety stock. A short week after the horizon (LATER) is no
 * stock-out in the horizon.
 */
export function coverOf(input: { readonly today: BusinessDate; readonly profile: ItemProfile; readonly demand: readonly CoverMove[]; readonly receipts: readonly CoverMove[] }): Cover {
  const { profile, today } = input
  const inside = profile.rows.filter((row) => row.key !== LATER)
  const sum = (values: readonly string[]) => values.reduce((total, value) => total.plus(decimalOf(value)), decimalOf('0'))
  const dayOf = (key: string | null, below: Decimal): BusinessDate | null => {
    if (key === null || key === LATER) return null
    if (key === PAST) return today
    const index = profile.rows.findIndex((row) => row.key === key)
    const row = profile.rows[index]
    if (!row || !row.from || !row.to) return null
    let projected = index > 0 ? decimalOf(profile.rows[index - 1]!.projected) : decimalOf(profile.onHand)
    for (let day = row.from; day <= row.to; day = plusDays(day, 1)) {
      projected = projected.plus(sum(input.receipts.filter((move) => move.day === day).map((move) => move.quantity))).minus(sum(input.demand.filter((move) => move.day === day).map((move) => move.quantity)))
      if (projected.lt(below)) return day < today ? today : day
    }
    return row.to < today ? today : row.to
  }
  const stockOutOn = dayOf(profile.firstShort, decimalOf('0'))
  const belowSafetyOn = profile.safetyStock === null ? null : dayOf(profile.firstBelowSafety, decimalOf(profile.safetyStock))
  const daysOfCover = stockOutOn === null ? null : Math.max(0, daysFrom(today, stockOutOn))
  const state: CoverState = stockOutOn !== null ? (daysOfCover === 0 ? 'SHORT_NOW' : 'STOCK_OUT') : belowSafetyOn !== null ? 'BELOW_SAFETY' : 'COVERED'
  return {
    demand: q(sum(inside.map((row) => row.demand))),
    receipts: q(sum(inside.map((row) => row.receipts))),
    projectedEnd: inside.length > 0 ? inside.at(-1)!.projected : profile.onHand,
    stockOutOn,
    belowSafetyOn,
    daysOfCover,
    state,
  }
}

/** The grid's order: short now, then the soonest stock-out, then the soonest below safety, then covered; ties by code. */
export function coverOrder<T extends Pick<Cover, 'state' | 'stockOutOn' | 'belowSafetyOn'> & { readonly label: string }>(a: T, b: T): number {
  const rank = (row: T) => COVER_STATES.indexOf(row.state)
  const dayOf = (row: T) => row.stockOutOn ?? row.belowSafetyOn ?? '9999-12-31'
  return rank(a) - rank(b) || (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : 0) || a.label.localeCompare(b.label)
}
