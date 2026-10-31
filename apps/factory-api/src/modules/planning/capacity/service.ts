import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { DEFAULT_PATTERN } from '@nexus/factory-domain/calendars/patterns'
import { OutsideWindowError, workingMinutesBetween, workingTimeOf, type WorkingCalendar } from '@nexus/factory-domain/calendars/working-time'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { capacityCells, minutesText, type CapacityCell, type CapacityDay } from '@nexus/factory-domain/planning/capacity/available'
import { LOADING_STATUSES, loadOf, loadParts, spreadPart, type LaneKind, type LoadPart, type LoadSlot, type LoadWorkOrder, type TimedBucket } from '@nexus/factory-domain/planning/capacity/load'
import { planBuckets, uniformBuckets, weekStart, type Bucket } from '@nexus/factory-domain/planning/settings/buckets'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { wipForMany } from './wip'
import { dayOf, type Reader, type SiteRow } from '../store'
import { effectiveOf, readLanes, type LaneFacts } from '../settings/lanes'
import { readSettings, settingsValuesOf, type SettingsRow } from '../settings/store'
import { CAPACITY_MAX_DAYS, type CalendarState, type CapacityLaneView } from './contract'

/**
 * Capacity against load (B-W2a-16; PLN-115, PLN-116): THE place the capacity screen, and later the planning board and
 * the MRP (B-W2a-22, B-W2a-34), get a site's lanes' available and booked minutes from. Pass your own client (a command's
 * `tx` or `caller.withClient`); no permission is checked here (the route checks its own). One query after another.
 *
 *   lanes      every ACTIVE line and work centre of the site, with its capacity row (settings/lanes.ts)
 *   available  factory-domain planning/capacity/available over THE calendars service's working days (a line's
 *              chain line → site → company, a work centre's work centre → site → company); never a day counted here
 *   booked     factory-domain planning/capacity/load over the RELEASED and IN_PROGRESS work orders of the site: their
 *              frozen operations' standard minutes × the garments still to do (production/scans wip for the ones in
 *              progress), placed by the site's WORKING plan slots (the board) or on their due date
 */

export interface CapacityPeriod {
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly buckets: readonly Bucket[]
}

/** The period and buckets a capacity question covers (default: four weeks from today, by week). */
export function periodOf(settings: SettingsRow | null, today: BusinessDate, query: { from?: string | undefined; to?: string | undefined; bucket?: string | undefined }): CapacityPeriod & { bucket: 'DAY' | 'WEEK' | 'MONTH' | 'PLAN' } {
  const bucket = (query.bucket ?? 'WEEK') as 'DAY' | 'WEEK' | 'MONTH' | 'PLAN'
  const from = query.from ?? today
  if (bucket === 'PLAN') {
    const plan = planBuckets(settingsValuesOf(settings), from)
    return { bucket, from: plan.from, to: plan.to, buckets: plan.buckets }
  }
  const to = query.to ?? plusDays(from, 27)
  if (to < from) throw new ValidationError('The period ends before it starts.', [{ path: 'querystring/to', message: 'Give a last day on or after the first.' }])
  if (daysFrom(from, to) + 1 > CAPACITY_MAX_DAYS) throw new ValidationError(`A capacity question covers at most ${CAPACITY_MAX_DAYS} days.`, [{ path: 'querystring/to', message: `At most ${CAPACITY_MAX_DAYS} days from the first.` }])
  return { bucket, from, to, buckets: uniformBuckets(from, to, bucket) }
}

export interface OpenWorkOrder extends LoadWorkOrder {
  readonly number: string
  readonly status: string
  readonly style: { readonly id: string; readonly code: string; readonly name: string }
  readonly operationsById: ReadonlyMap<string, { readonly id: string; readonly seq: number; readonly code: string; readonly name: string; readonly standardMinutes: string; readonly workCentreId: string }>
}

/** The site's open work orders that book capacity (RELEASED, IN_PROGRESS), and the held ones. */
async function readWorkOrders(db: Reader, site: SiteRow): Promise<{ loading: OpenWorkOrder[]; held: { id: string; lineId: string | null; workCentreIds: string[] }[] }> {
  const rows = await db.workOrder.findMany({
    where: { siteId: site.id, status: { in: [...LOADING_STATUSES, 'ON_HOLD'] } },
    select: {
      id: true,
      number: true,
      status: true,
      dueDate: true,
      lineId: true,
      heldFromStatus: true,
      style: { select: { id: true, code: true, name: true } },
      sizes: { select: { quantity: true } },
      operations: { select: { id: true, seq: true, code: true, name: true, standardMinutes: true, workCentreId: true }, orderBy: { seq: 'asc' } },
    },
    orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
  })
  const loading: OpenWorkOrder[] = []
  const held: { id: string; lineId: string | null; workCentreIds: string[] }[] = []
  // B-W2b-20: the WIP of every work order in progress in one read (./wip), not ~6 queries each.
  const wips = await wipForMany(db, rows.filter((row) => row.status === 'IN_PROGRESS').map((row) => row.id))
  for (const row of rows) {
    if (row.status === 'ON_HOLD') {
      if (row.heldFromStatus === 'RELEASED' || row.heldFromStatus === 'IN_PROGRESS') held.push({ id: row.id, lineId: row.lineId, workCentreIds: [...new Set(row.operations.map((operation) => operation.workCentreId))] })
      continue
    }
    // Whole garments done at each operation (good + scrapped), from the standing scans; none before the first work.
    const done = new Map<string, number>()
    if (row.status === 'IN_PROGRESS') {
      for (const operation of wips.get(row.id)?.operations ?? []) done.set(operation.operationId, operation.good + operation.scrap)
    }
    const operations = row.operations.map((operation) => ({ ...operation, standardMinutes: operation.standardMinutes.toString(), done: done.get(operation.id) ?? 0 }))
    loading.push({
      id: row.id,
      number: row.number,
      status: row.status,
      dueDate: row.dueDate ? dayOf(row.dueDate) : null,
      lineId: row.lineId,
      pieces: row.sizes.reduce((sum, size) => sum + size.quantity, 0),
      style: row.style,
      operations,
      operationsById: new Map(operations.map((operation) => [operation.id, operation])),
    })
  }
  return { loading, held }
}

/** The slots of the site's WORKING plan (the board) that book the open work orders. */
async function readSlots(db: Reader, site: SiteRow, workOrderIds: readonly string[]): Promise<LoadSlot[]> {
  if (workOrderIds.length === 0) return []
  const plan = await db.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true } })
  if (!plan) return []
  const rows = await db.scheduleSlot.findMany({
    where: { planVersionId: plan.id, workOrderId: { in: [...workOrderIds] } },
    select: { id: true, workOrderId: true, workOrderOperationId: true, lineId: true, workCentreId: true, startAt: true, endAt: true, minutes: true, pieces: true },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
  })
  // B-W2a-34: a whole-order slot's garments (part of an order on a lane) split the work order's load by garments.
  return rows.map((row) => ({ id: row.id, workOrderId: row.workOrderId, operationId: row.workOrderOperationId, lineId: row.lineId, workCentreId: row.workCentreId, startAt: row.startAt, endAt: row.endAt, minutes: row.minutes.toString(), pieces: row.pieces }))
}

const timed = (buckets: readonly Bucket[], timeZone: string): TimedBucket[] =>
  buckets.map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to, start: businessDayStart(bucket.from, timeZone), end: businessDayStart(plusDays(bucket.to, 1), timeZone) }))

/** One lane's world: its facts, setup, calendar and days over the loaded window. */
export interface LaneState {
  readonly lane: LaneFacts
  readonly people: number
  readonly peopleSource: 'CAPACITY' | 'STATIONS'
  readonly efficiencyPct: string
  readonly efficiencySource: 'LANE' | 'SITE' | 'DEFAULT'
  readonly calendar: WorkingCalendar | null
  readonly days: readonly CapacityDay[]
  /** The lane's working minutes between two instants; null outside the loaded window. */
  readonly working: (from: Date, to: Date) => number | null
}

export interface CapacityWorld {
  readonly site: SiteRow
  readonly settings: SettingsRow | null
  readonly today: BusinessDate
  readonly lanes: readonly LaneState[]
  readonly workOrders: readonly OpenWorkOrder[]
  readonly held: readonly { id: string; lineId: string | null; workCentreIds: string[] }[]
  readonly slots: readonly LoadSlot[]
  readonly parts: readonly LoadPart[]
  readonly window: { readonly from: BusinessDate; readonly to: BusinessDate }
}

/** Everything a capacity answer is made of, read once for the days from `from` to `to` (and this week and the next four). */
export async function capacityWorld(db: Reader, site: SiteRow, span: { readonly from: BusinessDate; readonly to: BusinessDate }, today: BusinessDate): Promise<CapacityWorld> {
  const settings = await readSettings(db, site.id)
  const { lines, workCentres } = await readLanes(db, site.id)
  const { loading, held } = await readWorkOrders(db, site)
  const slots = await readSlots(db, site, loading.map((workOrder) => workOrder.id))
  // The calendars: the period, this week and the next four weeks, and the slots' days (their shares need whole spans).
  const dates = [span.from, span.to, weekStart(today), plusDays(today, 27)]
  for (const slot of slots) dates.push(businessDate(slot.startAt, site.timezone), businessDate(slot.endAt, site.timezone))
  let from = plusDays(dates.reduce((a, b) => (a < b ? a : b)), -1)
  const to = plusDays(dates.reduce((a, b) => (a > b ? a : b)), 1)
  // A slot far in the past never widens the window beyond two years: its share is then counted by the clock.
  if (daysFrom(from, to) > 2 * CAPACITY_MAX_DAYS) from = plusDays(to, -2 * CAPACITY_MAX_DAYS)
  const window = { from, to }
  const all = [...lines, ...workCentres]
  const calendars = await workingCalendarsFor(db, all.map((lane) => ({ scope: lane.kind, id: lane.id })), window)
  const lanes: LaneState[] = all.map((lane) => {
    const calendar = calendars.get(ownerKey({ scope: lane.kind, id: lane.id }))?.calendar ?? null
    const effective = effectiveOf(lane, settings)
    const days = calendar ? workingTimeOf(calendar, window.from, window.to).days : []
    return {
      lane,
      ...effective,
      calendar,
      days,
      working: (start: Date, end: Date) => {
        if (!calendar) return null
        try {
          return workingMinutesBetween(calendar, start, end)
        } catch (error) {
          if (error instanceof OutsideWindowError) return null
          throw error
        }
      },
    }
  })
  const scopes = lines.map((line) => ({ lineId: line.id, workCentreIds: line.workCentreIds.length > 0 ? line.workCentreIds : null }))
  return { site, settings, today, lanes, workOrders: loading, held, slots, parts: loadParts(loading, slots, scopes), window }
}

const ZERO = new Dec(0)
const sumOf = (values: Iterable<Decimal>): Decimal => [...values].reduce((sum, value) => sum.plus(value), ZERO)

/** One lane's booked minutes per bucket, and the parts behind each bucket (with the minutes each puts there). */
export function bookedOf(world: CapacityWorld, state: LaneState, buckets: readonly TimedBucket[]): Map<string, { booked: Decimal; scheduled: Decimal; parts: { part: LoadPart; minutes: Decimal }[] }> {
  const out = new Map(buckets.map((bucket) => [bucket.key, { booked: ZERO, scheduled: ZERO, parts: [] as { part: LoadPart; minutes: Decimal }[] }]))
  for (const part of world.parts) {
    if (part.laneKind !== state.lane.kind || part.laneId !== state.lane.id) continue
    for (const [key, minutes] of spreadPart(part, buckets, state.working)) {
      const cell = out.get(key)!
      out.set(key, { booked: cell.booked.plus(minutes), scheduled: part.placement.placedBy === 'SLOT' ? cell.scheduled.plus(minutes) : cell.scheduled, parts: [...cell.parts, { part, minutes }] })
    }
  }
  return out
}

function patternOf(calendar: WorkingCalendar | null): CapacityLaneView['pattern'] {
  const layer = calendar?.layers.find((candidate) => candidate.shiftPatternId !== null)
  const pattern = layer ? calendar!.patterns.get(layer.shiftPatternId!) : undefined
  return pattern ? { id: pattern.id, code: pattern.code, name: pattern.name, source: 'CALENDAR' } : { id: DEFAULT_PATTERN.id, code: DEFAULT_PATTERN.code, name: DEFAULT_PATTERN.name, source: 'DEFAULT' }
}

/** B-W2b-20: a lane's own calendar, its site's or company's only, or none (the planning default). */
export function calendarStateOf(state: Pick<LaneState, 'lane' | 'calendar'>): CalendarState {
  const layers = state.calendar?.layers ?? []
  if (layers.length === 0) return 'NONE'
  return layers.some((layer) => layer.scope === state.lane.kind) ? 'OWN' : 'INHERITED'
}

const setupOf = (state: LaneState) => ({ people: state.people, unit: state.lane.kind === 'LINE' ? ('people' as const) : ('stations' as const), efficiencyPct: state.efficiencyPct })

/** Available and booked over one span of days (the tiles). */
function spanLoad(world: CapacityWorld, state: LaneState, from: BusinessDate, to: BusinessDate): { available: Decimal; booked: Decimal } {
  const bucket: Bucket = { key: 'span', kind: 'DAY', from, to }
  const [cell] = capacityCells(setupOf(state), state.days, [bucket])
  const booked = bookedOf(world, state, timed([bucket], world.site.timezone)).get('span')!.booked
  return { available: new Dec(cell!.availableMinutes), booked }
}

/** The capacity answer: every lane's cells over the period's buckets, its totals, what is not placed, and the tiles. */
export function capacityAnswer(world: CapacityWorld, period: CapacityPeriod) {
  const buckets = timed(period.buckets, world.site.timezone)
  const centreName = new Map(world.lanes.filter((state) => state.lane.kind === 'WORK_CENTRE').map((state) => [state.lane.id, { id: state.lane.id, code: state.lane.code, name: state.lane.name }]))
  const lanes: CapacityLaneView[] = world.lanes.map((state) => {
    const booked = bookedOf(world, state, buckets)
    const cells = capacityCells(setupOf(state), state.days, period.buckets).map((cell: CapacityCell) => {
      const load = booked.get(cell.key)!
      return { ...cell, bookedMinutes: minutesText(load.booked), scheduledMinutes: minutesText(load.scheduled), ...loadOf(load.booked, new Dec(cell.availableMinutes)) }
    })
    const available = sumOf(cells.map((cell) => new Dec(cell.availableMinutes)))
    const bookedTotal = sumOf([...booked.values()].map((cell) => cell.booked))
    const own = world.parts.filter((part) => part.laneKind === state.lane.kind && part.laneId === state.lane.id)
    const pastDue = sumOf(own.filter((part) => part.placement.placedBy === 'DUE_DATE' && part.placement.date < period.from).map((part) => part.minutes))
    const undated = sumOf(own.filter((part) => part.placement.placedBy === 'NO_DATE').map((part) => part.minutes))
    const heldWorkOrders = world.held.filter((held) => (state.lane.kind === 'LINE' ? held.lineId === state.lane.id : held.workCentreIds.includes(state.lane.id))).length
    return {
      kind: state.lane.kind,
      id: state.lane.id,
      code: state.lane.code,
      name: state.lane.name,
      workCentreKind: state.lane.workCentreKind,
      stations: state.lane.stations,
      efficiencyPct: state.efficiencyPct,
      efficiencySource: state.efficiencySource,
      people: state.people,
      peopleSource: state.peopleSource,
      pattern: patternOf(state.calendar),
      calendars: (state.calendar?.layers ?? []).map((layer) => ({ id: layer.id, scope: layer.scope, name: layer.name })),
      calendarState: calendarStateOf(state),
      does: state.lane.kind === 'LINE' && state.lane.workCentreIds.length > 0 ? state.lane.workCentreIds.map((id) => centreName.get(id) ?? { id, code: '', name: '' }) : null,
      cells,
      overall: { availableMinutes: minutesText(available), bookedMinutes: minutesText(bookedTotal), ...loadOf(bookedTotal, available) },
      unplaced: { pastDueMinutes: minutesText(pastDue), undatedMinutes: minutesText(undated) },
      heldWorkOrders,
    }
  })
  // The tiles: this week (Monday to Sunday) and the next four weeks from today.
  const monday = weekStart(world.today)
  let over = 0
  let most: { kind: LaneKind; id: string; code: string; pct: Decimal } | null = null
  const free = { LINE: ZERO, WORK_CENTRE: ZERO }
  for (const state of world.lanes) {
    const week = spanLoad(world, state, monday, plusDays(monday, 6))
    if (week.booked.gt(week.available)) over += 1
    if (week.available.gt(0)) {
      const pct = week.booked.div(week.available).times(100)
      if (pct.gt(0) && (!most || pct.gt(most.pct))) most = { kind: state.lane.kind, id: state.lane.id, code: state.lane.code, pct }
    }
    const next = spanLoad(world, state, world.today, plusDays(world.today, 27))
    if (next.available.gt(next.booked)) free[state.lane.kind] = free[state.lane.kind].plus(next.available.minus(next.booked))
  }
  const onLines = new Set(world.parts.filter((part) => part.laneKind === 'LINE').map((part) => part.workOrderId))
  return {
    site: { id: world.site.id, companyId: world.site.companyId, code: world.site.code, name: world.site.name, timeZone: world.site.timezone },
    from: period.from,
    to: period.to,
    today: world.today,
    buckets: period.buckets.map((bucket) => ({ key: bucket.key, kind: bucket.kind, from: bucket.from, to: bucket.to })),
    lanes,
    tiles: {
      lanesOverThisWeek: over,
      freeMinutesNext4Weeks: { lines: minutesText(free.LINE), workCentres: minutesText(free.WORK_CENTRE) },
      mostLoadedThisWeek: most ? { kind: most.kind, id: most.id, code: most.code, loadPct: most.pct.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) } : null,
    },
    workOrdersWithoutLine: world.workOrders.filter((workOrder) => !onLines.has(workOrder.id) && workOrder.operations.some((operation) => operation.done < workOrder.pieces)).length,
  }
}

/** The orders behind one lane's days (the cell's DetailModal). */
export function cellAnswer(world: CapacityWorld, state: LaneState, from: BusinessDate, to: BusinessDate) {
  const bucket: Bucket = { key: 'cell', kind: 'DAY', from, to }
  const [cell] = capacityCells(setupOf(state), state.days, [bucket])
  const booked = bookedOf(world, state, timed([bucket], world.site.timezone)).get('cell')!
  const total = booked.booked
  const workOrderOf = new Map(world.workOrders.map((workOrder) => [workOrder.id, workOrder]))
  const slotOf = new Map(world.slots.map((slot) => [slot.id, slot]))
  const orders = booked.parts
    .filter(({ minutes }) => minutes.gt(0))
    .sort((a, b) => b.minutes.comparedTo(a.minutes))
    .map(({ part, minutes }) => {
      const workOrder = workOrderOf.get(part.workOrderId)!
      const operation = workOrder.operationsById.get(part.operationId)!
      const slot = part.placement.placedBy === 'SLOT' ? slotOf.get(part.placement.slotId)! : null
      return {
        workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, dueDate: workOrder.dueDate, style: workOrder.style },
        operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, standardMinutes: new Dec(operation.standardMinutes).toFixed(3) },
        pieces: part.pieces,
        minutes: minutesText(minutes),
        sharePct: total.gt(0) ? minutes.div(total).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) : '0.0',
        placedBy: part.placement.placedBy as 'SLOT' | 'DUE_DATE',
        slot: slot ? { id: slot.id, startAt: toUtcIso(slot.startAt), endAt: toUtcIso(slot.endAt) } : null,
      }
    })
  const available = new Dec(cell!.availableMinutes)
  return {
    lane: { kind: state.lane.kind, id: state.lane.id, code: state.lane.code, name: state.lane.name },
    from,
    to,
    availableMinutes: cell!.availableMinutes,
    bookedMinutes: minutesText(total),
    loadPct: loadOf(total, available).loadPct,
    words: cell!.words,
    orders,
  }
}
