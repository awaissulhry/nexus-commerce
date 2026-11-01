import { localInstant } from '../../calendars/dates'
import type { FloorLook } from '../../auth/floor/literacy'
import { businessDate, type BusinessDate } from '../../core/time'
import { hourIn } from '../calls/rules'
import { laneKey, lastOperationOf, rootOf, standingScans, type DailyOperation, type DailyScan, type LaneRef } from '../reports/daily'

/**
 * Hour by hour (B-W2b-50; MES-161, ANA-007; design production.floor "Hour by hour": pieces per hour per line against the
 * line's target, with the lead's reason for each missed hour; floor.display "Output today": two huge numbers, done and
 * target, and hour bars with the hourly target as a line), pure.
 *
 *   done      the garments that passed the LINE's last operation in that hour: the daily report's "good" (factory-domain
 *             production/reports/daily: the standing REPORT and CORRECTION scans, whole-garment bundles only, a
 *             correction on the hour of the report it stands for), by the local hour the report reached the server.
 *   hours     every hour of the line's day that has a target, an output, or working time in the line's calendar.
 *   short     an hour that is over and ended below its target (an hour without a target is never short).
 *   so far    the targets of the hours that are over, and of the running hour the share of its minutes gone by.
 *   pace      ON_PACE when the line has done at least PACE_SHARE of its target so far, BEHIND below that, NO_TARGET when
 *             no target counts yet.
 *
 * Team totals only (Statuto dei Lavoratori art. 4; Owner answer F2): a scan's worker is never an input, a station only
 * says which line the work was on.
 */

export const HOUR_STATES = ['OVER', 'RUNNING', 'LATER'] as const
export type HourState = (typeof HOUR_STATES)[number]

export const PACES = ['ON_PACE', 'BEHIND', 'NO_TARGET'] as const
export type Pace = (typeof PACES)[number]

/** At least this share of the target so far is "on pace". */
export const PACE_SHARE = 0.9

export const PACE_LOOK: Readonly<Record<Pace, FloorLook>> = Object.freeze({
  ON_PACE: { icon: 'trending-up', tone: 'success' },
  BEHIND: { icon: 'trending-down', tone: 'warning' },
  NO_TARGET: { icon: 'minus', tone: 'neutral' },
})

export interface HourScanFacts {
  readonly day: BusinessDate
  readonly timeZone: string
  /** The day's scans with the later rows that void them and the older reports their corrections stand for. */
  readonly scans: readonly DailyScan[]
  readonly bundles: ReadonlyMap<string, { readonly part: string | null; readonly status: string }>
  readonly operations: ReadonlyMap<string, DailyOperation>
  readonly stationLanes: ReadonlyMap<string, LaneRef>
  /** The work centres of each lane, by laneKey. */
  readonly laneCentres: ReadonlyMap<string, ReadonlySet<string>>
}

/** The garments out of each LINE per local hour of the day: line id → hour → pieces. */
export function goodByLineHour(facts: HourScanFacts): Map<string, Map<number, number>> {
  const byId = new Map(facts.scans.map((scan) => [scan.id, scan]))
  const opsOfWorkOrder = new Map<string, (DailyOperation & { id: string })[]>()
  for (const [id, operation] of facts.operations) opsOfWorkOrder.set(operation.workOrderId, [...(opsOfWorkOrder.get(operation.workOrderId) ?? []), { ...operation, id }])
  const last = new Map<string, string | null>()
  const out = new Map<string, Map<number, number>>()
  for (const scan of standingScans(facts.scans)) {
    if (scan.stationId === null || scan.good <= 0) continue
    const lane = facts.stationLanes.get(scan.stationId)
    const bundle = facts.bundles.get(scan.bundleId)
    if (!lane || lane.kind !== 'LINE' || !bundle || bundle.part !== null || bundle.status !== 'ACTIVE' || !facts.operations.has(scan.operationId)) continue
    const at = rootOf(scan, byId).at
    if (businessDate(at, facts.timeZone) !== facts.day) continue
    const key = `${lane.id}|${scan.workOrderId}`
    if (!last.has(key)) last.set(key, lastOperationOf(opsOfWorkOrder.get(scan.workOrderId) ?? [], facts.laneCentres.get(laneKey(lane))))
    if (last.get(key) !== scan.operationId) continue
    const hours = out.get(lane.id) ?? new Map<number, number>()
    const hour = hourIn(at, facts.timeZone)
    hours.set(hour, (hours.get(hour) ?? 0) + scan.good)
    out.set(lane.id, hours)
  }
  return out
}

/** The real instants an hour of a day spans in a zone. */
export function hourSpan(day: BusinessDate, hour: number, timeZone: string): { readonly start: Date; readonly end: Date } {
  return { start: localInstant(day, hour * 60, timeZone), end: localInstant(day, (hour + 1) * 60, timeZone) }
}

/** The working minutes in each hour of the day, from the working stretches of the line's shifts (whole minutes). */
export function workingMinutesByHour(day: BusinessDate, timeZone: string, stretches: readonly { readonly start: Date; readonly end: Date }[]): Map<number, number> {
  const out = new Map<number, number>()
  for (let hour = 0; hour < 24; hour += 1) {
    const span = hourSpan(day, hour, timeZone)
    let minutes = 0
    for (const stretch of stretches) {
      const from = Math.max(span.start.getTime(), stretch.start.getTime())
      const to = Math.min(span.end.getTime(), stretch.end.getTime())
      if (to > from) minutes += (to - from) / 60_000
    }
    if (minutes > 0) out.set(hour, Math.round(minutes))
  }
  return out
}

export interface HourTarget {
  readonly id: string
  readonly hour: number
  readonly targetPieces: number
  readonly version: number
}

export interface HourFacts<Target extends HourTarget = HourTarget> {
  readonly day: BusinessDate
  readonly timeZone: string
  readonly now: Date
  readonly targets: readonly Target[]
  /** Pieces out of the line per hour. */
  readonly done: ReadonlyMap<number, number>
  /** Working minutes per hour (the line's calendar). */
  readonly workingMinutes: ReadonlyMap<number, number>
  /** Help calls sent from the line's stations per hour (a count, never who). */
  readonly calls?: ReadonlyMap<number, number> | undefined
}

export interface HourRow<Target extends HourTarget = HourTarget> {
  readonly hour: number
  readonly start: Date
  readonly end: Date
  readonly state: HourState
  readonly workingMinutes: number
  readonly done: number
  readonly target: Target | null
  readonly short: boolean
  readonly calls: number
}

export function hourStateOf(span: { readonly start: Date; readonly end: Date }, now: Date): HourState {
  if (now.getTime() >= span.end.getTime()) return 'OVER'
  if (now.getTime() >= span.start.getTime()) return 'RUNNING'
  return 'LATER'
}

/** An hour is short when it is over and ended below its target. */
export const isShort = (state: HourState, done: number, target: { readonly targetPieces: number } | null): boolean => state === 'OVER' && target !== null && done < target.targetPieces

/** The hours of a line's day (see the module comment), earliest first. */
export function hourRows<Target extends HourTarget>(facts: HourFacts<Target>): HourRow<Target>[] {
  const targets = new Map(facts.targets.map((target) => [target.hour, target]))
  const hours = new Set<number>([...targets.keys(), ...[...facts.done.entries()].filter(([, pieces]) => pieces > 0).map(([hour]) => hour), ...facts.workingMinutes.keys()])
  return [...hours]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour < 24)
    .sort((a, b) => a - b)
    .map((hour) => {
      const span = hourSpan(facts.day, hour, facts.timeZone)
      const state = hourStateOf(span, facts.now)
      const done = facts.done.get(hour) ?? 0
      const target = targets.get(hour) ?? null
      return { hour, start: span.start, end: span.end, state, workingMinutes: facts.workingMinutes.get(hour) ?? 0, done, target, short: isShort(state, done, target), calls: facts.calls?.get(hour) ?? 0 }
    })
}

export interface DayTotals {
  readonly done: number
  /** The day's targets together; null when the day has none. */
  readonly target: number | null
  /** The targets of the hours over and the running hour's share; null when the day has none. */
  readonly targetSoFar: number | null
  readonly pace: Pace
  readonly shortHours: number
}

export function dayTotals(rows: readonly HourRow[], now: Date): DayTotals {
  const done = rows.reduce((sum, row) => sum + row.done, 0)
  const withTarget = rows.filter((row) => row.target !== null)
  if (withTarget.length === 0) return { done, target: null, targetSoFar: null, pace: 'NO_TARGET', shortHours: 0 }
  const target = withTarget.reduce((sum, row) => sum + row.target!.targetPieces, 0)
  let soFar = 0
  for (const row of withTarget) {
    if (row.state === 'OVER') soFar += row.target!.targetPieces
    else if (row.state === 'RUNNING') {
      const gone = Math.min(1, Math.max(0, (now.getTime() - row.start.getTime()) / (row.end.getTime() - row.start.getTime())))
      soFar += Math.floor(row.target!.targetPieces * gone)
    }
  }
  return { done, target, targetSoFar: soFar, pace: paceOf(done, soFar), shortHours: rows.filter((row) => row.short).length }
}

export function paceOf(done: number, targetSoFar: number | null): Pace {
  if (targetSoFar === null || targetSoFar <= 0) return 'NO_TARGET'
  return done >= targetSoFar * PACE_SHARE ? 'ON_PACE' : 'BEHIND'
}

/** The shift running at `now` among the day's shifts (label, start, end), else null. */
export function shiftAt<Shift extends { readonly start: Date; readonly end: Date }>(shifts: readonly Shift[], now: Date): Shift | null {
  return shifts.find((shift) => shift.start.getTime() <= now.getTime() && now.getTime() < shift.end.getTime()) ?? null
}
