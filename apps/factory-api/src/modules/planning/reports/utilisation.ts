import { OutsideWindowError, workingTimeOf } from '@nexus/factory-domain/calendars/working-time'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { heatBand } from '@nexus/factory-domain/planning/heatmap/bands'
import { earnedEntries, laneKey, minutesOf, pctOf, PLANNING_REPORT_LIMITS, reportWeeksOf, type EarnedEntry, type ReportWeek } from '@nexus/factory-domain/planning/reports/rules'
import { weekStart, type Bucket } from '@nexus/factory-domain/planning/settings/buckets'
import { amountText } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { countKindOf, SCAN_KINDS } from '@nexus/factory-domain/production/scans/rules'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { capacityAnswer, capacityWorld, cellAnswer, type CapacityWorld, type LaneState } from '../capacity/service'
import { subcontractorWorld } from '../capacity/subcontractors'
import type { Reader } from '../store'
import { headOf, placeOf, type Place } from './access'
import type { UtilisationQuery, UtilisationWorkOrdersQuery } from './contract'

/**
 * The utilisation trend (B-W2b-349; PLN-204; design planning.reports sec utilisation "Load and utilisation per line, plant and
 * workshop over time", "Lines over weeks"): per week, for every ACTIVE line and work centre of the site, the plant (all of them
 * together) and each workshop capacity line:
 *
 *   what happened   the period's weeks (clipped): earned standard minutes (factory-domain planning/reports `earnedEntries`:
 *                   standing scans of whole garments, per line or work centre, never per person or station) ÷ the minutes
 *                   its people were there (people × the lane's working time, at 100 %: Planning settings' actual efficiency
 *                   counted the same way, with the lane's planned efficiency beside it as the yardstick)
 *   the load ahead  this week and the next weeks: B-W2a-16's capacity (booked ÷ capacity, the same numbers as Capacity & load
 *                   and the heatmap) and B-W2b-321's workshop lines (booked ÷ capacity in the line's unit)
 *
 * A workshop's past load is not kept (its jobs are what is left from today): its past weeks say nothing. No money, no person.
 */

const ZERO = new Dec(0)
const sum = (values: readonly Decimal[]): Decimal => values.reduce((total, value) => total.plus(value), ZERO)

export interface UtilisationRead {
  readonly place: Place
  readonly weeks: readonly ReportWeek[]
  readonly world: CapacityWorld | null
  readonly entries: readonly EarnedEntry[]
  readonly operations: ReadonlyMap<string, { readonly id: string; readonly seq: number; readonly code: string; readonly name: string; readonly workOrderId: string }>
}

const aheadBuckets = (weeks: readonly ReportWeek[]): Bucket[] => weeks.filter((week) => week.ahead).map((week) => ({ key: week.key, kind: 'WEEK' as const, from: weekStart(week.to), to: week.to }))
const actualBuckets = (weeks: readonly ReportWeek[]) => weeks.flatMap((week) => (week.actualDays ? [{ key: week.key, from: week.actualDays.from, to: week.actualDays.to }] : []))

/** Everything the trend is made of: the weeks, the capacity world over them, the earned scans of the period (to now). */
async function utilisationRead(db: Reader, place: Place, ahead: number): Promise<UtilisationRead> {
  const { site, period, today, span, now } = place
  const weeks = reportWeeksOf(period, today, ahead)
  const first = weeks[0]!.from
  const last = weeks.at(-1)!.to
  const world = await capacityWorld(db, site, { from: first, to: last }, today)
  const end = new Date(Math.min(span.end.getTime(), now.getTime()))
  // The count ledger only (the timing kinds carry no counts); never the worker: per line or work centre only.
  const scans = await db.operationScan.findMany({
    where: { siteId: site.id, kind: { in: [...SCAN_KINDS] }, serverTime: { gte: span.start, lt: end } },
    select: { id: true, kind: true, bundleId: true, workOrderOperationId: true, correctsId: true, goodQuantity: true, stationId: true, serverTime: true },
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
  const ids = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  const bundles = scans.length ? await db.bundle.findMany({ where: { id: { in: ids(scans.map((scan) => scan.bundleId)) } }, select: { id: true, part: true, status: true } }) : []
  const operations = scans.length ? await db.workOrderOperation.findMany({ where: { id: { in: ids(scans.map((scan) => scan.workOrderOperationId)) } }, select: { id: true, seq: true, code: true, name: true, standardMinutes: true, workOrderId: true } }) : []
  const stations = scans.length ? await db.station.findMany({ where: { id: { in: ids(scans.map((scan) => scan.stationId)) } }, select: { id: true, lineId: true, workCentreId: true } }) : []
  const entries = earnedEntries({
    scans: scans.map((scan) => ({ id: scan.id, kind: countKindOf(scan.kind), correctsId: scan.correctsId, bundleId: scan.bundleId, operationId: scan.workOrderOperationId, good: scan.goodQuantity, stationId: scan.stationId, at: scan.serverTime })),
    bundles: new Map(bundles.map((bundle) => [bundle.id, bundle])),
    standardMinutes: new Map(operations.map((operation) => [operation.id, operation.standardMinutes.toString()])),
    laneOfStation: new Map(stations.map((station) => [station.id, station.lineId ? laneKey('LINE', station.lineId) : laneKey('WORK_CENTRE', station.workCentreId)])),
    weeks: actualBuckets(weeks),
    timeZone: site.timezone,
  })
  return { place, weeks, world, entries, operations: new Map(operations.map((operation) => [operation.id, { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, workOrderId: operation.workOrderId }])) }
}

/** A lane's minutes its people were there on some days (people × working time); null: no calendar or outside it. */
function presentMinutes(state: LaneState, from: string, to: string): Decimal | null {
  if (!state.calendar) return null
  try {
    return new Dec(workingTimeOf(state.calendar, from, to).minutes ?? 0).times(state.people)
  } catch (error) {
    if (error instanceof OutsideWindowError) return null
    throw error
  }
}

interface CellFacts {
  earned: Decimal | null
  available: Decimal | null
  booked: Decimal | null
  capacity: Decimal | null
}

const cellView = (key: string, facts: CellFacts, text: (value: Decimal) => string = minutesOf) => {
  const loadPct = facts.booked !== null && facts.capacity !== null ? pctOf(facts.booked, facts.capacity) : null
  return {
    key,
    earnedMinutes: facts.earned === null ? null : minutesOf(facts.earned),
    availableMinutes: facts.available === null ? null : minutesOf(facts.available),
    utilisationPct: facts.earned !== null && facts.available !== null ? pctOf(facts.earned, facts.available) : null,
    booked: facts.booked === null ? null : text(facts.booked),
    capacity: facts.capacity === null ? null : text(facts.capacity),
    loadPct,
    band: heatBand(loadPct),
  }
}

/** GET /planning/reports/utilisation (sec utilisation): every lane, the plant and each workshop, week by week. */
export async function utilisationAnswer(caller: CommandCaller, query: UtilisationQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(caller, query, db)
    const ahead = query.ahead ?? PLANNING_REPORT_LIMITS.ahead.default
    const read = await utilisationRead(db, place, ahead)
    const world = read.world!
    const coming = aheadBuckets(read.weeks)
    const load = coming.length > 0 ? capacityAnswer(world, { from: coming[0]!.from, to: coming.at(-1)!.to, buckets: coming }) : null
    const loadOf = new Map((load?.lanes ?? []).map((lane) => [`${lane.kind}:${lane.id}`, new Map(lane.cells.map((cell) => [cell.key, cell]))]))
    const facts = new Map<string, Map<string, CellFacts>>()
    for (const state of world.lanes) {
      const key = laneKey(state.lane.kind, state.lane.id)
      const cells = new Map<string, CellFacts>()
      for (const week of read.weeks) {
        const earned = week.actualDays ? sum(read.entries.filter((entry) => entry.lane === key && entry.week === week.key).map((entry) => entry.minutes)) : null
        const available = week.actualDays ? presentMinutes(state, week.actualDays.from, week.actualDays.to) : null
        const cell = week.ahead ? loadOf.get(key)?.get(week.key) : undefined
        cells.set(week.key, { earned, available, booked: cell ? new Dec(cell.bookedMinutes) : null, capacity: cell ? new Dec(cell.availableMinutes) : null })
      }
      facts.set(key, cells)
    }
    // The plant: every line and work centre together.
    const plant = read.weeks.map((week) => {
      const all = [...facts.values()].map((cells) => cells.get(week.key)!)
      const total = (pick: (cell: CellFacts) => Decimal | null) => {
        const values = all.map(pick).filter((value): value is Decimal => value !== null)
        return values.length === 0 ? null : sum(values)
      }
      return cellView(week.key, { earned: total((cell) => cell.earned), available: total((cell) => cell.available), booked: total((cell) => cell.booked), capacity: total((cell) => cell.capacity) })
    })
    const workshops = coming.length > 0 ? await subcontractorWorld(db, place.site, coming, place.today) : null
    return {
      ...headOf(place),
      weeks: read.weeks.map((week) => ({ key: week.key, from: week.from, to: week.to, actual: week.actual, ahead: week.ahead, actualDays: week.actualDays })),
      lanes: [
        { kind: 'PLANT' as const, id: null, code: null, name: null, workCentreKind: null, unit: 'MINUTES', plannedEfficiencyPct: null, cells: plant },
        ...world.lanes.map((state) => ({
          kind: state.lane.kind,
          id: state.lane.id,
          code: state.lane.code,
          name: state.lane.name,
          workCentreKind: state.lane.workCentreKind,
          unit: 'MINUTES',
          plannedEfficiencyPct: state.efficiencyPct,
          cells: read.weeks.map((week) => cellView(week.key, facts.get(laneKey(state.lane.kind, state.lane.id))!.get(week.key)!)),
        })),
        ...(workshops?.lines ?? []).map((line) => {
          const byKey = new Map(line.cells.map((cell) => [cell.key, cell]))
          return {
            kind: 'WORKSHOP' as const,
            id: line.workshop.id,
            code: line.workshop.code,
            name: line.workshop.name,
            workCentreKind: line.key?.workCentreKind ?? null,
            unit: line.key?.unit ?? null,
            plannedEfficiencyPct: null,
            cells: read.weeks.map((week) => {
              const cell = week.ahead ? byKey.get(week.key) : undefined
              return cellView(week.key, { earned: null, available: null, booked: cell ? cell.booked : null, capacity: cell && cell.known ? cell.available : null }, amountText)
            }),
          }
        }),
      ],
    }
  })
}

/**
 * GET /planning/reports/utilisation/work-orders (pop drill "Work orders behind this point"): one week of a line, a work centre
 * or the plant — the work orders whose scans earned its minutes (the period's days of it: per operation, garments and minutes),
 * and, for this week and later, those booking its load (B-W2a-16's cell: per operation, garments still to do and minutes).
 */
export async function utilisationWorkOrdersAnswer(caller: CommandCaller, query: UtilisationWorkOrdersQuery) {
  return caller.withClient(async (db) => {
    const place = await placeOf(caller, query, db)
    const ahead = query.ahead ?? PLANNING_REPORT_LIMITS.ahead.default
    if (query.laneKind !== 'PLANT' && !query.laneId) throw new ValidationError('Name the line or work centre.', [{ path: 'querystring/laneId', message: 'A line or work centre’s id.' }])
    const read = await utilisationRead(db, place, ahead)
    const week = read.weeks.find((entry) => entry.key === query.week)
    if (!week) throw new ValidationError(`A week of the trend: ${read.weeks.map((entry) => entry.key).join(', ')}.`, [{ path: 'querystring/week', message: 'Choose a week of the trend.' }])
    const world = read.world!
    const states = query.laneKind === 'PLANT' ? world.lanes : world.lanes.filter((state) => state.lane.kind === query.laneKind && state.lane.id === query.laneId)
    if (states.length === 0 && query.laneKind !== 'PLANT') throw new NotFoundError('Line or work centre not found.')
    const laneOf = new Map(world.lanes.map((state) => [laneKey(state.lane.kind, state.lane.id), state.lane]))
    const keys = new Set(states.map((state) => laneKey(state.lane.kind, state.lane.id)))
    const workOrderIds = [...new Set(read.entries.filter((entry) => keys.has(entry.lane) && entry.week === week.key).map((entry) => read.operations.get(entry.operationId)?.workOrderId).filter((value): value is string => !!value))]
    const workOrders = workOrderIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, style: { select: { id: true, code: true, name: true } } } })
    const workOrderOf = new Map(workOrders.map((row) => [row.id, row]))
    const earnedRows = week.actualDays
      ? read.entries
          .filter((entry) => keys.has(entry.lane) && entry.week === week.key && entry.minutes.gt(0))
          .flatMap((entry) => {
            const operation = read.operations.get(entry.operationId)
            const workOrder = operation ? workOrderOf.get(operation.workOrderId) : undefined
            const lane = laneOf.get(entry.lane)
            if (!operation || !workOrder || !lane) return []
            return [{ workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, style: workOrder.style }, operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name }, lane: { kind: lane.kind, code: lane.code }, garments: entry.good, minutes: entry.minutes }]
          })
          .sort((a, b) => b.minutes.comparedTo(a.minutes) || a.workOrder.number.localeCompare(b.workOrder.number) || a.operation.seq - b.operation.seq)
      : null
    const bookedRows = week.ahead
      ? states
          .flatMap((state) => cellAnswer(world, state, weekStart(week.to), week.to).orders.map((order) => ({ workOrder: { id: order.workOrder.id, number: order.workOrder.number, status: order.workOrder.status as 'RELEASED' | 'IN_PROGRESS', style: order.workOrder.style }, operation: { id: order.operation.id, seq: order.operation.seq, code: order.operation.code, name: order.operation.name }, lane: { kind: state.lane.kind, code: state.lane.code }, pieces: order.pieces, minutes: new Dec(order.minutes), placedBy: order.placedBy })))
          .sort((a, b) => b.minutes.comparedTo(a.minutes) || a.workOrder.number.localeCompare(b.workOrder.number) || a.operation.seq - b.operation.seq)
      : null
    const limit = PLANNING_REPORT_LIMITS.drillRows
    const lane = query.laneKind === 'PLANT' ? { kind: 'PLANT' as const, id: null, code: null, name: null } : { kind: states[0]!.lane.kind, id: states[0]!.lane.id, code: states[0]!.lane.code, name: states[0]!.lane.name }
    return {
      ...headOf(place),
      lane,
      week: { key: week.key, from: week.from, to: week.to, actual: week.actual, ahead: week.ahead, actualDays: week.actualDays },
      earned: earnedRows ? { minutes: minutesOf(sum(earnedRows.map((row) => row.minutes))), rows: earnedRows.slice(0, limit).map((row) => ({ ...row, minutes: minutesOf(row.minutes) })), more: Math.max(0, earnedRows.length - limit) } : null,
      booked: bookedRows ? { minutes: minutesOf(sum(bookedRows.map((row) => row.minutes))), rows: bookedRows.slice(0, limit).map((row) => ({ ...row, minutes: minutesOf(row.minutes) })), more: Math.max(0, bookedRows.length - limit) } : null,
    }
  })
}
