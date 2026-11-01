import { dayOf, type WorkingShift } from '@nexus/factory-domain/calendars/working-time'
import { businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { lineQuality, MACHINE_DOWN_STATUSES, STATION_BOARD_LOOKS, stationBoardState } from '@nexus/factory-domain/production/boards/board'
import type { WaitingBundle } from '@nexus/factory-domain/production/boards/heatmap'
import { dayTotals, goodByLineHour, hourRows, PACE_LOOK, shiftAt, workingMinutesByHour, type DayTotals, type HourRow, type HourTarget } from '@nexus/factory-domain/production/boards/hourly'
import { hourLabel } from '@nexus/factory-domain/production/boards/targets'
import { hourIn, OPEN_CALL_STATUSES, stationCallState, type CallStatus } from '@nexus/factory-domain/production/calls/rules'
import { laneKey } from '@nexus/factory-domain/production/reports/daily'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { BUNDLE_COLUMNS } from '../bundles/store'
import { MAX_TRACKED } from '../bundles/tracked'
import { stationsOf, stuckLimitsOf, trackBundles } from '../bundles/track'
import { readDaily, type ReportSite } from '../reports/daily'
import { downtimeReasons, reasonWordsOf, targetsOf, type LineRow, type Reader, type ReasonRow, type TargetRow } from './store'

/**
 * The facts of the line boards (B-W2b-50), read for a site and a day at once (one read per table, never one per hour or
 * per bundle), as the reader given (the office as itself; the floor and the display through the tenant's system view:
 * the working calendars and the planning settings are no floor read):
 *
 *   lineDays     each line's hours: the garments out of its last operation per hour (the daily report's standing scans,
 *                platform reads of production/reports/daily), its targets, the working minutes of its calendar, the help
 *                calls sent from its stations; the totals so far, the shift now, and its DHU of the day.
 *   waiting      the ACTIVE bundles of the site's open work orders that wait at an operation (production/bundles track:
 *                place, next operation, stuck), each on its line (the last scan's station's line, else the work order's
 *                allocated line, else none).
 *   stations     a line's stations with their call state (open help calls) and whether a machine at it is down.
 * Never a worker: scans are read without their worker, help calls without their caller, notes without their author.
 */

const OPEN_WORK_ORDERS = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** A target as the hours carry it, with its reason. */
export interface BoardTarget extends HourTarget {
  readonly row: TargetRow
}

export interface LineDay {
  readonly line: LineRow
  readonly rows: readonly HourRow<BoardTarget>[]
  readonly totals: DayTotals
  readonly shift: WorkingShift | null
  readonly shifts: readonly WorkingShift[]
  readonly quality: ReturnType<typeof lineQuality>
}

export interface LineDays {
  readonly days: readonly LineDay[]
  readonly reasons: ReadonlyMap<string, ReasonRow>
}

/** The hours of these lines of one site on one day (see the module comment). */
export async function lineDays(db: Reader, site: ReportSite, lines: readonly LineRow[], day: BusinessDate, now: Date): Promise<LineDays> {
  const reasons = await downtimeReasons(db)
  if (lines.length === 0) return { days: [], reasons }
  const lineIds = lines.map((line) => line.id)
  const daily = await readDaily(db, site, day)
  const bundleIds = unique(daily.scans.map((scan) => scan.bundleId))
  const workOrderIds = unique(daily.scans.map((scan) => scan.workOrderId))
  const bundles = bundleIds.length ? await db.bundle.findMany({ where: { id: { in: bundleIds } }, select: { id: true, part: true, status: true } }) : []
  const operations = workOrderIds.length
    ? await db.workOrderOperation.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, seq: true, scanRequired: true, workCentreId: true, standardMinutes: true } })
    : []
  const stations = await db.station.findMany({ where: { siteId: site.id }, select: { id: true, lineId: true, workCentreId: true } })
  const laneCentres = new Map<string, Set<string>>()
  for (const station of stations) {
    if (!station.lineId) continue
    const key = laneKey({ kind: 'LINE', id: station.lineId })
    laneCentres.set(key, (laneCentres.get(key) ?? new Set()).add(station.workCentreId))
  }
  const good = goodByLineHour({
    day,
    timeZone: site.timezone,
    scans: daily.scans,
    bundles: new Map(bundles.map((bundle) => [bundle.id, { part: bundle.part, status: bundle.status }])),
    operations: new Map(operations.map((operation) => [operation.id, { workOrderId: operation.workOrderId, seq: operation.seq, scanRequired: operation.scanRequired, workCentreId: operation.workCentreId, standardMinutes: operation.standardMinutes.toString() }])),
    stationLanes: daily.stationLanes,
    laneCentres,
  })
  const targets = await targetsOf(db, lineIds, day)
  const calendars = await workingCalendarsFor(db, lineIds.map((id) => ({ scope: 'LINE' as const, id })), { from: day, to: day })
  const range = businessDayRange(day, site.timezone)
  const calls = await db.helpCall.findMany({ where: { lineId: { in: lineIds }, sentAt: { gte: range.start, lt: range.end } }, select: { lineId: true, sentAt: true } })

  const days = lines.map((line) => {
    const calendar = calendars.get(ownerKey({ scope: 'LINE', id: line.id }))?.calendar
    const shifts = calendar ? dayOf(calendar, day).shifts : []
    const callsByHour = new Map<number, number>()
    for (const call of calls) if (call.lineId === line.id) callsByHour.set(hourIn(call.sentAt, site.timezone), (callsByHour.get(hourIn(call.sentAt, site.timezone)) ?? 0) + 1)
    const rows = hourRows<BoardTarget>({
      day,
      timeZone: site.timezone,
      now,
      targets: targets.filter((target) => target.lineId === line.id).map((row) => ({ id: row.id, hour: row.hour, targetPieces: row.targetPieces, version: row.version, row })),
      done: good.get(line.id) ?? new Map(),
      workingMinutes: workingMinutesByHour(day, site.timezone, shifts.flatMap((shift) => shift.working)),
      calls: callsByHour,
    })
    const lane = daily.report.lanes.find((entry) => entry.lane.kind === 'LINE' && entry.lane.id === line.id)
    return { line, rows, totals: dayTotals(rows, now), shift: shiftAt(shifts, now), shifts, quality: lineQuality({ good: lane?.good ?? 0, scrap: lane?.scrap ?? 0, rework: lane?.rework ?? 0 }) }
  })
  return { days, reasons }
}

// ---- views ----------------------------------------------------------------------------------------------------------------

export const shiftView = (shift: WorkingShift | null) => (shift ? { label: shift.label, start: toUtcIso(shift.start), end: toUtcIso(shift.end) } : null)

export function hourView(row: HourRow<BoardTarget>, reasons: ReadonlyMap<string, ReasonRow>) {
  const target = row.target
  const given = target && target.row.shortReasonAt && (target.row.shortReasonCode || target.row.shortNote)
  return {
    hour: row.hour,
    label: hourLabel(row.hour),
    start: toUtcIso(row.start),
    end: toUtcIso(row.end),
    state: row.state,
    workingMinutes: row.workingMinutes,
    done: row.done,
    target: target ? { id: target.id, targetPieces: target.targetPieces, version: target.version } : null,
    short: row.short,
    calls: row.calls,
    reason: given ? { ...reasonWordsOf(reasons, target.row.shortReasonCode ?? ''), note: target.row.shortNote, at: toUtcIso(target.row.shortReasonAt!) } : null,
  }
}

export const totalsView = (totals: DayTotals) => ({ ...totals, paceLook: PACE_LOOK[totals.pace] })

// ---- the bundles waiting (the heat map, the TV's WIP) ---------------------------------------------------------------------

export interface Waiting {
  readonly waiting: readonly WaitingBundle[]
  readonly capped: boolean
  readonly stuckLimitHours: number
}

/**
 * The bundles of the site's open work orders waiting at an operation, each on its line (see the module comment). With a
 * line (the TV's poll): only the bundles that can be on it are tracked — those with a scan at one of its stations, and
 * those of the work orders allocated to it — the same answer for that line, without tracking the whole site every time.
 */
export async function waitingOfSite(db: Reader, siteId: string, now: Date, lineId?: string): Promise<Waiting> {
  const stationIds = lineId ? (await db.station.findMany({ where: { siteId, lineId }, select: { id: true } })).map((station) => station.id) : []
  const onLine = lineId ? [{ OR: [{ workOrder: { is: { lineId } } }, ...(stationIds.length ? [{ scans: { some: { stationId: { in: stationIds } } } }] : [])] }] : []
  const rows = await db.bundle.findMany({
    where: { AND: [{ siteId, status: 'ACTIVE', workOrder: { is: { status: { in: [...OPEN_WORK_ORDERS] } } } }, ...onLine] },
    select: BUNDLE_COLUMNS,
    orderBy: { id: 'desc' },
    take: MAX_TRACKED + 1,
  })
  const tracked = await trackBundles(db, rows.slice(0, MAX_TRACKED), now)
  const stations = await stationsOf(db, tracked.map((row) => row.lastScan?.stationId ?? null))
  const allocated = new Map(
    (await db.workOrder.findMany({ where: { id: { in: unique(tracked.map((row) => row.workOrder.id)) } }, select: { id: true, lineId: true } })).map((row) => [row.id, row.lineId]),
  )
  const waiting: WaitingBundle[] = []
  for (const row of tracked) {
    const next = row.place.next
    if ((row.place.place !== 'LINE' && row.place.place !== 'CUTTING') || !next) continue
    const scannedOn = row.lastScan?.stationId ? (stations.get(row.lastScan.stationId)?.lineId ?? null) : null
    waiting.push({ lineId: scannedOn ?? allocated.get(row.workOrder.id) ?? null, operation: { code: next.code, name: next.name, seq: next.seq }, pieces: row.bundle.quantity, stuck: row.stuck.stuck })
  }
  const limit = (await stuckLimitsOf(db, [siteId])).get(siteId)!
  return { waiting, capped: rows.length > MAX_TRACKED, stuckLimitHours: limit }
}

// ---- a line's stations ----------------------------------------------------------------------------------------------------

/** The line's ACTIVE stations by code, each with its call state and whether a machine at it is down (never who). */
export async function stationStates(db: Reader, lineId: string) {
  const stations = await db.station.findMany({ where: { lineId, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const stationIds = stations.map((station) => station.id)
  const open = stationIds.length
    ? await db.helpCall.findMany({ where: { stationId: { in: stationIds }, status: { in: [...OPEN_CALL_STATUSES] as CallStatus[] } }, select: { stationId: true, status: true, type: { select: { kind: true } } } })
    : []
  const down = stationIds.length ? await db.machine.findMany({ where: { stationId: { in: stationIds }, status: { in: [...MACHINE_DOWN_STATUSES] } }, select: { stationId: true } }) : []
  const downAt = new Set(down.map((machine) => machine.stationId))
  return stations.map((station) => {
    const calls = open.filter((call) => call.stationId === station.id)
    const call = stationCallState(calls)
    const machineDown = downAt.has(station.id)
    const state = stationBoardState({ call, machineDown })
    return { id: station.id, code: station.code, name: station.name, call, material: calls.some((entry) => entry.type.kind === 'MATERIAL'), machineDown, state, look: STATION_BOARD_LOOKS[state] }
  })
}
