import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { addWorkingDays, daysOf } from '@nexus/factory-domain/calendars/working-time'
import { businessDate, businessDayStart, type BusinessDate } from '@nexus/factory-domain/core/time'
import { capacityCells } from '@nexus/factory-domain/planning/capacity/available'
import { loadParts, type LoadSlot, type TimedBucket } from '@nexus/factory-domain/planning/capacity/load'
import { scheduleWorkOrder, type Duration, type WorkOrderSchedule } from '@nexus/factory-domain/planning/schedule/backward'
import { laneKey, laneOfSlot, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { after, MINUTE_MS, spansOf, startFrom, workingMinutesFor, type LaneRate, type Span } from '@nexus/factory-domain/planning/schedule/time'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { wipForMany } from '../capacity/wip'
import { bookedOf, capacityWorld, type CapacityWorld, type LaneState } from '../capacity/service'
import { dayOf, type Reader, type SiteRow } from '../store'
import { outsideWorkOf, slotsOf, workingPlanOf, workshopsOf, type PlanRow, type SlotRow, type WorkshopRow } from './store'

/**
 * The planning board's world (B-W2a-34; PLN-129, PLN-131, PLN-132, PLN-160): THE place the board, the allocation
 * board, the publish dialog and the commands read a site's plan from, on one client (a command's `tx` or
 * `caller.withClient`), one query after another; no permission is checked here (the routes check their own).
 *
 *   capacity     B-W2a-16's capacity world (planning/capacity/service.ts): lanes with their people, efficiency and
 *                calendars, the RELEASED and IN_PROGRESS work orders with their frozen operations and what the scans
 *                report done, the WORKING plan's slots that book them, and the load parts.
 *   work orders  every open work order of the site (DRAFT, RELEASED, IN_PROGRESS, ON_HOLD), its operations with work
 *                left (a draft: every garment; a held one: as it stood), its routing steps' outside work.
 *   the plan     the site's WORKING plan and all its slots (of any open work order: a draft's bar is drawn too, but only
 *                released work books capacity, B-W2a-16's rule).
 *   lanes        each line and work centre with its rate (people × efficiency) and working stretches; the workshops.
 *   schedules    per work order, backward scheduling from its due date (factory-domain planning/schedule/backward): an
 *                operation is worked on the lane of its own bar, else the work order's line when that line does it,
 *                else the routing step's workshop when the step is outside work, else its work centre.
 */

export const OPEN_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const BOOKING = new Set(['RELEASED', 'IN_PROGRESS'])

export interface BoardOperation {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly workCentreId: string
  readonly standardMinutes: string
  /** Garments still to do there (good and scrapped garments done by the standing scans taken off). */
  readonly remaining: number
  /** The routing step is outside work: its workshop and transit days. */
  readonly outside: { readonly partyId: string; readonly transitDays: number | null } | null
}

export interface BoardWorkOrder {
  readonly id: string
  readonly companyId: string
  readonly number: string
  readonly status: string
  readonly kind: string
  readonly priority: number
  readonly version: number
  readonly dueDate: BusinessDate | null
  readonly lineId: string | null
  readonly holdReason: string | null
  readonly style: { readonly id: string; readonly code: string; readonly name: string }
  /** B-W2b-20: the style's family on the allocation cards and the board (its product type: JACKET, TROUSERS, …). */
  readonly family: string
  /** B-W2b-20: the customers whose order lines it makes (its cells' parties), by code; usually one. */
  readonly customers: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  readonly garments: number
  /** Every operation, with its garments still to do. */
  readonly operations: readonly BoardOperation[]
  /** RELEASED or IN_PROGRESS: it books capacity (a draft or a held one does not). */
  readonly booksCapacity: boolean
}

export interface LaneInfo {
  readonly ref: LaneRef
  readonly code: string
  readonly name: string
  /** A line or work centre: how it works; null for a workshop. */
  readonly rate: LaneRate | null
  readonly spans: readonly Span[]
  /** A line: the work centres it does (null: every operation). */
  readonly does: readonly string[] | null
  readonly state: LaneState | null
  readonly workshop: WorkshopRow | null
}

export interface ScheduleWorld {
  readonly site: SiteRow
  readonly today: BusinessDate
  readonly now: Date
  readonly capacity: CapacityWorld
  readonly plan: PlanRow | null
  readonly slots: readonly SlotRow[]
  readonly workOrders: readonly BoardWorkOrder[]
  readonly lanes: ReadonlyMap<string, LaneInfo>
  readonly workshops: readonly WorkshopRow[]
  /** The site's own working stretches (the default lane, the publish dialog's days). */
  readonly siteSpans: readonly Span[]
  readonly siteDays: ReturnType<typeof daysOf>
  /** The end of the site's next working day (a latest safe start before it is soon). */
  readonly soon: number
  readonly schedules: ReadonlyMap<string, WorkOrderSchedule>
  /** The lane each operation (by id) is scheduled on. */
  readonly operationLanes: ReadonlyMap<string, LaneRef>
}

const WORK_ORDER_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  status: true,
  kind: true,
  priority: true,
  version: true,
  dueDate: true,
  lineId: true,
  holdReason: true,
  heldFromStatus: true,
  style: { select: { id: true, code: true, name: true, productType: true } },
  sizes: { select: { quantity: true, partyId: true } },
  operations: { select: { id: true, seq: true, code: true, name: true, workCentreId: true, standardMinutes: true, styleRevisionId: true, routingSeq: true }, orderBy: { seq: 'asc' as const } },
} as const

/** The site's open work orders, as the board needs them (`ids`: only those). */
async function readBoardWorkOrders(db: Reader, site: SiteRow, capacity: CapacityWorld | null, ids?: readonly string[]) {
  const rows = await db.workOrder.findMany({
    where: { siteId: site.id, status: { in: [...OPEN_STATUSES] }, ...(ids ? { id: { in: [...ids] } } : {}) },
    select: WORK_ORDER_COLUMNS,
    orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
  })
  const outside = await outsideWorkOf(db, rows.flatMap((row) => row.operations))
  const done = new Map<string, number>()
  for (const workOrder of capacity?.workOrders ?? []) for (const operation of workOrder.operations) done.set(operation.id, operation.done)
  // A held work order that was in progress: what its scans report (the capacity world reads only booking ones); one read.
  const wips = await wipForMany(db, rows.filter((row) => row.status === 'ON_HOLD' && row.heldFromStatus === 'IN_PROGRESS').map((row) => row.id))
  for (const wip of wips.values()) for (const operation of wip.operations) done.set(operation.operationId, operation.good + operation.scrap)
  // B-W2b-20: the customers of the work orders' cells, by code.
  const partyIds = [...new Set(rows.flatMap((row) => row.sizes.map((size) => size.partyId)))]
  const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((party) => [party.id, { id: party.id, code: party.code, name: party.tradeName ?? party.legalName }]))
  const out: BoardWorkOrder[] = []
  for (const row of rows) {
    const garments = row.sizes.reduce((sum, size) => sum + size.quantity, 0)
    out.push({
      id: row.id,
      companyId: row.companyId,
      number: row.number,
      status: row.status,
      kind: row.kind,
      priority: row.priority,
      version: row.version,
      dueDate: row.dueDate ? dayOf(row.dueDate) : null,
      lineId: row.lineId,
      holdReason: row.holdReason,
      style: { id: row.style.id, code: row.style.code, name: row.style.name },
      family: row.style.productType,
      customers: [...new Set(row.sizes.map((size) => size.partyId))]
        .map((id) => parties.get(id))
        .filter((party): party is { id: string; code: string; name: string } => party !== undefined)
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
      garments,
      booksCapacity: BOOKING.has(row.status),
      operations: row.operations.map((operation) => ({
        id: operation.id,
        seq: operation.seq,
        code: operation.code,
        name: operation.name,
        workCentreId: operation.workCentreId,
        standardMinutes: operation.standardMinutes.toString(),
        remaining: Math.max(0, garments - (done.get(operation.id) ?? 0)),
        outside: outside.get(operation.id) ?? null,
      })),
    })
  }
  return out
}

/** Standard minutes × garments (a decimal). */
export const standardOf = (operation: Pick<BoardOperation, 'standardMinutes'>, garments: number): Decimal => new Dec(operation.standardMinutes).times(Math.max(0, garments))

/** The lane an operation is worked on (see above); `slots`: the working plan's. */
export function laneForOperation(world: Pick<ScheduleWorld, 'lanes'>, workOrder: BoardWorkOrder, operation: BoardOperation, slots: readonly SlotRow[]): LaneRef {
  const own = slots.find((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === operation.id)
  if (own) return laneOfSlot(own)
  if (workOrder.lineId) {
    const line = world.lanes.get(laneKey({ kind: 'LINE', id: workOrder.lineId }))
    if (line && (line.does === null || line.does.includes(operation.workCentreId))) return line.ref
  }
  if (operation.outside) {
    const workshop = world.lanes.get(laneKey({ kind: 'WORKSHOP', id: operation.outside.partyId }))
    if (workshop) return workshop.ref
  }
  return { kind: 'WORK_CENTRE', id: operation.workCentreId }
}

/** How long an operation takes on a lane (working minutes on a line or work centre; transit days at a workshop). */
export function durationOn(world: Pick<ScheduleWorld, 'lanes' | 'siteSpans'>, lane: LaneRef, operation: BoardOperation, garments: number): Duration {
  const info = world.lanes.get(laneKey(lane))
  if (lane.kind === 'WORKSHOP') {
    const days = operation.outside?.partyId === lane.id && operation.outside.transitDays !== null ? operation.outside.transitDays : 1
    return { kind: 'CLOCK', minutes: Math.max(1, days) * 24 * 60 }
  }
  const rate = info?.rate ?? { people: 1, efficiencyPct: '100' }
  return { kind: 'WORKING', minutes: workingMinutesFor(standardOf(operation, garments), rate), spans: info?.spans ?? world.siteSpans }
}

/** The end of a slot placed at `start` on a lane for so many working (or clock) minutes; null beyond the calendar. */
export function endOf(duration: Duration, start: number): { start: number; end: number } | null {
  if (duration.kind === 'CLOCK') return { start, end: start + Math.max(1, duration.minutes) * MINUTE_MS }
  const from = startFrom(duration.spans, start) ?? start
  const end = after(duration.spans, from, Math.max(1, duration.minutes))
  return end === null ? null : { start, end: Math.max(end, start + MINUTE_MS) }
}

/** The world, read once. `span`: the days the answer shows (the calendars are loaded wider, for the due dates). */
export async function scheduleWorld(db: Reader, site: SiteRow, span: { readonly from: BusinessDate; readonly to: BusinessDate }, now: Date): Promise<ScheduleWorld> {
  const today = businessDate(now, site.timezone)
  const plan = await workingPlanOf(db, site.id)
  const slots = plan ? await slotsOf(db, plan.id) : []
  const due = await db.workOrder.findFirst({ where: { siteId: site.id, status: { in: [...OPEN_STATUSES] }, dueDate: { not: null } }, select: { dueDate: true }, orderBy: { dueDate: 'desc' } })
  const lastSlot = slots.reduce<Date | null>((last, slot) => (last === null || slot.endAt > last ? slot.endAt : last), null)
  const ends = [span.to, plusDays(today, 35), ...(due?.dueDate ? [plusDays(dayOf(due.dueDate), 2)] : []), ...(lastSlot ? [plusDays(businessDate(lastSlot, site.timezone), 1)] : [])]
  const from = [span.from, plusDays(today, -31)].reduce((a, b) => (a < b ? a : b))
  const to = ends.reduce((a, b) => (a > b ? a : b))
  const capacity = await capacityWorld(db, site, { from, to }, today)
  const workOrders = await readBoardWorkOrders(db, site, capacity)
  const workshops = await workshopsOf(db, site, slots.filter((slot) => slot.partyId !== null).map((slot) => slot.partyId!))
  const window = capacity.window
  const lanes = new Map<string, LaneInfo>()
  for (const state of capacity.lanes) {
    const ref: LaneRef = { kind: state.lane.kind, id: state.lane.id }
    const days = state.calendar ? daysOf(state.calendar, window.from, window.to) : []
    lanes.set(laneKey(ref), {
      ref,
      code: state.lane.code,
      name: state.lane.name,
      rate: { people: state.people, efficiencyPct: state.efficiencyPct },
      spans: spansOf(days),
      does: state.lane.kind === 'LINE' ? (state.lane.workCentreIds.length > 0 ? state.lane.workCentreIds : null) : null,
      state,
      workshop: null,
    })
  }
  for (const workshop of workshops) {
    const ref: LaneRef = { kind: 'WORKSHOP', id: workshop.id }
    lanes.set(laneKey(ref), { ref, code: workshop.code, name: workshop.name, rate: null, spans: [], does: null, state: null, workshop })
  }
  const siteCalendar = (await workingCalendarsFor(db, [{ scope: 'SITE', id: site.id }], window)).get(ownerKey({ scope: 'SITE', id: site.id }))?.calendar ?? null
  const siteDays = siteCalendar ? daysOf(siteCalendar, window.from, window.to) : []
  const siteSpans = spansOf(siteDays)
  const next = siteCalendar ? addWorkingDays(siteCalendar, today, 1).date ?? plusDays(today, 1) : plusDays(today, 1)
  const soon = businessDayStart(plusDays(next, 1), site.timezone).getTime()
  const base = { lanes, siteSpans }
  const operationLanes = new Map<string, LaneRef>()
  const schedules = new Map<string, WorkOrderSchedule>()
  for (const workOrder of workOrders) {
    const own = slots.filter((slot) => slot.workOrderId === workOrder.id)
    const whole = own.filter((slot) => slot.workOrderOperationId === null)
    const left = workOrder.operations.filter((operation) => operation.remaining > 0)
    for (const operation of workOrder.operations) operationLanes.set(operation.id, laneForOperation(base, workOrder, operation, slots))
    schedules.set(
      workOrder.id,
      scheduleWorkOrder(
        {
          number: workOrder.number,
          dueDate: workOrder.dueDate,
          dueBy: workOrder.dueDate ? businessDayStart(plusDays(workOrder.dueDate, 1), site.timezone).getTime() : null,
          operations: left.map((operation) => {
            const bars = own.filter((slot) => slot.workOrderOperationId === operation.id)
            const planned = (bars.length > 0 ? bars : whole).map((slot) => ({ start: slot.startAt.getTime(), end: slot.endAt.getTime() }))
            return { id: operation.id, seq: operation.seq, name: `Op ${operation.seq} ${operation.name}`, duration: durationOn(base, operationLanes.get(operation.id)!, operation, operation.remaining), planned }
          }),
        },
        { now: now.getTime(), soon, timeZone: site.timezone },
      ),
    )
  }
  return { site, today, now, capacity, plan, slots, workOrders, lanes, workshops, siteSpans, siteDays, soon, schedules, operationLanes }
}

/** A slot as the load needs it: a stored one, or one a command is about to write. */
export type PlannedSlot = Pick<SlotRow, 'id' | 'workOrderId' | 'workOrderOperationId' | 'lineId' | 'workCentreId' | 'startAt' | 'endAt' | 'pieces'> & { readonly minutes: { toString(): string } }

/** The working plan's slots after a change, as the capacity reads them (only booking work orders' slots load lanes). */
export function loadSlotsOf(world: ScheduleWorld, slots: readonly PlannedSlot[]): LoadSlot[] {
  const booking = new Set(world.capacity.workOrders.map((workOrder) => workOrder.id))
  return slots
    .filter((slot) => booking.has(slot.workOrderId))
    .map((slot) => ({ id: slot.id, workOrderId: slot.workOrderId, operationId: slot.workOrderOperationId, lineId: slot.lineId, workCentreId: slot.workCentreId, startAt: slot.startAt, endAt: slot.endAt, minutes: slot.minutes.toString(), pieces: slot.pieces }))
}

/** The capacity world with the working plan's slots replaced (the load after a drop). */
export function capacityWith(world: ScheduleWorld, slots: readonly PlannedSlot[]): CapacityWorld {
  const load = loadSlotsOf(world, slots)
  const scopes = world.capacity.lanes.filter((state) => state.lane.kind === 'LINE').map((state) => ({ lineId: state.lane.id, workCentreIds: state.lane.workCentreIds.length > 0 ? state.lane.workCentreIds : null }))
  return { ...world.capacity, slots: load, parts: loadParts(world.capacity.workOrders, load, scopes) }
}

export interface OverDay {
  readonly lane: LaneRef
  readonly date: BusinessDate
  readonly availableMinutes: string
  readonly bookedMinutes: string
  readonly overMinutes: string
  readonly loadPct: string | null
}

/** The days of a line or work centre from `start` to `end` whose booked minutes go over the available ones. */
export function overDays(world: ScheduleWorld, capacity: CapacityWorld, lane: LaneRef, start: Date, end: Date): OverDay[] {
  if (lane.kind === 'WORKSHOP') return []
  const state = capacity.lanes.find((candidate) => candidate.lane.kind === lane.kind && candidate.lane.id === lane.id)
  if (!state) return []
  const tz = world.site.timezone
  const first = businessDate(start, tz)
  const last = businessDate(new Date(end.getTime() - 1), tz)
  const buckets: TimedBucket[] = []
  for (let date = first; date <= last; date = plusDays(date, 1)) buckets.push({ key: date, from: date, to: date, start: businessDayStart(date, tz), end: businessDayStart(plusDays(date, 1), tz) })
  const booked = bookedOf(capacity, state, buckets)
  const cells = capacityCells({ people: state.people, unit: state.lane.kind === 'LINE' ? 'people' : 'stations', efficiencyPct: state.efficiencyPct }, state.days, buckets.map((bucket) => ({ key: bucket.key, kind: 'DAY' as const, from: bucket.from, to: bucket.to })))
  const out: OverDay[] = []
  for (const bucket of buckets) {
    const available = new Dec(cells.find((cell) => cell.key === bucket.key)?.availableMinutes ?? '0')
    const value = booked.get(bucket.key)!.booked
    if (value.gt(available) && value.minus(available).gt('0.05')) {
      out.push({
        lane,
        date: bucket.key,
        availableMinutes: available.toFixed(1),
        bookedMinutes: value.toFixed(1),
        overMinutes: value.minus(available).toFixed(1),
        loadPct: available.gt(0) ? value.div(available).times(100).toFixed(1) : null,
      })
    }
  }
  return out
}
