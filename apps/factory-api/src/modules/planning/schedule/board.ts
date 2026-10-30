import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { WorkOrderReadiness } from '@nexus/factory-domain/planning/readiness/readiness'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { trayOrder, type WorkOrderSchedule } from '@nexus/factory-domain/planning/schedule/backward'
import { PLANNING_SCHEDULE_MANAGE, PLANNING_SCHEDULE_PUBLISH } from '@nexus/factory-domain/planning/schedule/permissions'
import { diffWords, laneKey, laneOfSlot, planDiff } from '@nexus/factory-domain/planning/schedule/slots'
import { dayWords } from '@nexus/factory-domain/planning/schedule/time'
import { uniformBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, mayAt, officeContextOf, siteFor } from '../access'
import { capacityAnswer } from '../capacity/service'
import { CAPACITY_MAX_DAYS } from '../capacity/contract'
import { readinessFor } from '../readiness/service'
import { dayOf, SITE_COLUMNS, type Reader } from '../store'
import type { BoardQuery, WorkOrderView } from './contract'
import { heldReasonOf, publishDiff, rangeOf, siteViewOf, storedSlotView, versionHeaderOf } from './publish'
import { durationOn, scheduleWorld, standardOf, type BoardWorkOrder, type ScheduleWorld } from './service'
import { diffSlotOf, publishedOf, slotsOf, userNamesOf, type SlotRow } from './store'

/**
 * The planning board's reads (B-W2a-34; PLN-129, PLN-131, PLN-132; design planning.board "Board controls", "Load per
 * lane", "Schedule", "Not on the board", "Problems in this plan", the bar popover): planning.view over the site's
 * company and the site; every figure counted on every read (./service). The resource view is `lanes` + `slots`; the
 * order view is `workOrders` with their operations (each names its slots); the tray and the problems are derived from
 * them. A production manager sees it read-only (`plan.mayChange` false).
 */

const DEFAULT_DAYS = { DAY: 13, WEEK: 55, MONTH: 182 } as const
const NOT_READY = new Set(['NOT_ENOUGH', 'DELAYED'])

/** The work order as the board's order view and the bar popover give it. */
export function workOrderViewOf(world: ScheduleWorld, workOrder: BoardWorkOrder, readiness: WorkOrderReadiness | null): WorkOrderView {
  const schedule = world.schedules.get(workOrder.id)!
  const times = new Map(schedule.operations.map((operation) => [operation.id, operation]))
  const line = workOrder.lineId ? world.lanes.get(laneKey({ kind: 'LINE', id: workOrder.lineId })) : null
  const centre = (id: string) => {
    const lane = world.lanes.get(laneKey({ kind: 'WORK_CENTRE', id }))
    return { id, code: lane?.code ?? '', name: lane?.name ?? '' }
  }
  const remaining = workOrder.operations.reduce((sum, operation) => sum.plus(standardOf(operation, operation.remaining)), new Dec(0))
  return {
    id: workOrder.id,
    number: workOrder.number,
    status: workOrder.status,
    kind: workOrder.kind,
    priority: workOrder.priority,
    rush: workOrder.priority > 0,
    version: workOrder.version,
    dueDate: workOrder.dueDate,
    style: workOrder.style,
    garments: workOrder.garments,
    line: line ? { id: line.ref.id, code: line.code, name: line.name } : null,
    holdReason: workOrder.holdReason,
    booksCapacity: workOrder.booksCapacity,
    minutes: remaining.toFixed(1),
    schedule: scheduleViewOf(schedule),
    readiness: readiness ? { word: readiness.word, label: readiness.label, date: readiness.date, reason: readiness.reason } : null,
    operations: workOrder.operations.map((operation) => {
      const lane = world.operationLanes.get(operation.id)!
      const time = times.get(operation.id)
      return {
        id: operation.id,
        seq: operation.seq,
        code: operation.code,
        name: operation.name,
        workCentre: centre(operation.workCentreId),
        standardMinutes: new Dec(operation.standardMinutes).toFixed(3),
        remainingPieces: operation.remaining,
        minutes: standardOf(operation, operation.remaining).toFixed(1),
        workingMinutes: operation.remaining > 0 ? durationOn(world, lane, operation, operation.remaining).minutes : 0,
        lane,
        outside: operation.outside,
        latestStart: iso2(time?.latestStart ?? null),
        latestFinish: iso2(time?.latestFinish ?? null),
        earliestStart: iso2(time?.earliestStart ?? null),
        earliestFinish: iso2(time?.earliestFinish ?? null),
        plannedStart: iso2(time?.plannedStart ?? null),
        plannedFinish: iso2(time?.plannedFinish ?? null),
        startsLate: time?.startsLate ?? false,
        slotIds: world.slots.filter((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === operation.id).map((slot) => slot.id),
      }
    }),
  }
}

export const scheduleViewOf = (schedule: WorkOrderSchedule) => ({
  status: schedule.status,
  latestSafeStart: iso2(schedule.latestSafeStart),
  latestFinish: iso2(schedule.latestFinish),
  earliestFinish: iso2(schedule.earliestFinish),
  plannedStart: iso2(schedule.plannedStart),
  plannedFinish: iso2(schedule.plannedFinish),
  placed: schedule.placed,
  words: schedule.words,
  reasons: schedule.reasons.map((reason) => ({ code: reason.code, words: reason.words })),
})

/** The domain's instants are epoch milliseconds. */
const iso2 = (value: number | null): string | null => (value === null ? null : toUtcIso(new Date(value)))

/** A slot of the working plan with what the board draws on it. */
export function slotViewOf(world: ScheduleWorld, slot: SlotRow, names: ReadonlyMap<string, string>) {
  const workOrder = world.workOrders.find((candidate) => candidate.id === slot.workOrderId)
  const time = slot.workOrderOperationId ? world.schedules.get(slot.workOrderId)?.operations.find((operation) => operation.id === slot.workOrderOperationId) : undefined
  return {
    ...storedSlotView(slot, names),
    booksCapacity: workOrder?.booksCapacity ?? false,
    latestStart: iso2(time?.latestStart ?? null),
    latestFinish: iso2(time?.latestFinish ?? null),
    startsLate: time !== undefined && time.latestStart !== null && slot.startAt.getTime() > time.latestStart,
  }
}

/** Every lane with its load over the period's buckets (a workshop: no capacity cells). */
function laneViewsOf(world: ScheduleWorld, period: { from: BusinessDate; to: BusinessDate; buckets: ReturnType<typeof uniformBuckets> }) {
  const answer = capacityAnswer(world.capacity, period)
  const lanes = answer.lanes.map((lane) => ({
    kind: lane.kind,
    id: lane.id,
    code: lane.code,
    name: lane.name,
    workCentreKind: lane.workCentreKind,
    people: lane.people,
    efficiencyPct: lane.efficiencyPct,
    does: lane.does ? lane.does.map((centre) => centre.id) : null,
    location: null,
    cells: lane.cells.map((cell) => ({
      key: cell.key,
      from: cell.from,
      to: cell.to,
      availableMinutes: cell.availableMinutes,
      bookedMinutes: cell.bookedMinutes,
      scheduledMinutes: cell.scheduledMinutes,
      loadPct: cell.loadPct,
      overMinutes: cell.overMinutes,
      closedDays: cell.closedDays,
      words: cell.words,
    })),
  }))
  const workshops = world.workshops.map((workshop) => ({ kind: 'WORKSHOP' as const, id: workshop.id, code: workshop.code, name: workshop.name, workCentreKind: null, people: null, efficiencyPct: null, does: null, location: workshop.location, cells: null }))
  return [...lanes, ...workshops]
}

function daysLateOf(world: ScheduleWorld, workOrder: BoardWorkOrder): number | null {
  const schedule = world.schedules.get(workOrder.id)!
  const finish = schedule.plannedFinish ?? schedule.earliestFinish
  if (!workOrder.dueDate || finish === null) return null
  return Math.max(0, daysFrom(workOrder.dueDate, businessDate(new Date(finish), world.site.timezone)))
}

/** GET /planning/schedule: the board. */
export async function board(caller: CommandCaller, query: BoardQuery) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  const bucket = query.bucket ?? 'DAY'
  const from = query.from ?? today
  const to = query.to ?? plusDays(from, DEFAULT_DAYS[bucket])
  if (to < from) throw new ValidationError('The period ends before it starts.', [{ path: 'querystring/to', message: 'Give a last day on or after the first.' }])
  if (daysFrom(from, to) + 1 > CAPACITY_MAX_DAYS) throw new ValidationError(`The board covers at most ${CAPACITY_MAX_DAYS} days.`, [{ path: 'querystring/to', message: `At most ${CAPACITY_MAX_DAYS} days from the first.` }])
  const buckets = uniformBuckets(from, to, bucket)
  return caller.withClient(async (db) => {
    const world = await scheduleWorld(db, site, { from, to }, now)
    const readiness = query.readiness === 'false' || world.workOrders.length === 0 ? [] : await readinessFor(db, site, world.workOrders.map((workOrder) => workOrder.id))
    const readinessOf = new Map(readiness.map((row) => [row.workOrderId, row]))
    const lanes = laneViewsOf(world, { from, to, buckets })
    const window = { start: businessDayStart(from, site.timezone), end: businessDayStart(plusDays(to, 1), site.timezone) }
    const shown = world.slots.filter((slot) => slot.startAt < window.end && slot.endAt > window.start)
    const names = await userNamesOf(db, shown.map((slot) => slot.updatedById))
    const workOrders = world.workOrders.map((workOrder) => workOrderViewOf(world, workOrder, readinessOf.get(workOrder.id) ?? null))
    const header = await planHeaderOf(db, world, context)
    const tray = world.workOrders
      .map((workOrder) => ({ workOrder, schedule: world.schedules.get(workOrder.id)! }))
      .filter(({ schedule }) => schedule.status !== 'DONE' && schedule.placed !== 'ALL')
      .sort((a, b) => trayOrder({ ...a.schedule, dueDate: a.workOrder.dueDate, number: a.workOrder.number }, { ...b.schedule, dueDate: b.workOrder.dueDate, number: b.workOrder.number }))
      .map(({ workOrder, schedule }) => {
        const unplaced = schedule.operations.filter((operation) => operation.plannedStart === null)
        const minutes = workOrder.operations.filter((operation) => unplaced.some((candidate) => candidate.id === operation.id)).reduce((sum, operation) => sum.plus(standardOf(operation, operation.remaining)), new Dec(0))
        const chips: ('PAST_LATEST_SAFE_START' | 'START_SOON' | 'MATERIAL_NOT_READY' | 'ON_HOLD' | 'DRAFT' | 'NO_DUE_DATE')[] = []
        if (schedule.latestSafeStart !== null && schedule.latestSafeStart < now.getTime()) chips.push('PAST_LATEST_SAFE_START')
        else if (schedule.reasons.some((reason) => reason.code === 'START_SOON')) chips.push('START_SOON')
        if (schedule.status === 'LATE' && !chips.includes('PAST_LATEST_SAFE_START')) chips.push('PAST_LATEST_SAFE_START')
        if (NOT_READY.has(readinessOf.get(workOrder.id)?.word ?? '')) chips.push('MATERIAL_NOT_READY')
        if (workOrder.status === 'ON_HOLD') chips.push('ON_HOLD')
        if (workOrder.status === 'DRAFT') chips.push('DRAFT')
        if (schedule.status === 'NO_DUE_DATE') chips.push('NO_DUE_DATE')
        return { workOrderId: workOrder.id, unplacedOperations: unplaced.length, minutes: minutes.toFixed(1), latestSafeStart: iso2(schedule.latestSafeStart), chips }
      })
    const problems = [
      ...lanes.flatMap((lane) =>
        (lane.cells ?? [])
          .filter((cell) => Number(cell.overMinutes) > 0)
          .map((cell) => ({
            kind: 'OVERBOOKED' as const,
            words: `${lane.code} is at ${cell.loadPct ?? '—'}% ${cell.from === cell.to ? `on ${dayWords(cell.from)}` : `from ${dayWords(cell.from)} to ${dayWords(cell.to)}`} (+${cell.overMinutes} min over).`,
            lane: { kind: lane.kind, id: lane.id },
            date: cell.from,
            bucketKey: cell.key,
            overMinutes: cell.overMinutes,
            loadPct: cell.loadPct,
            workOrderId: null,
            daysLate: null,
          })),
      ),
      ...world.workOrders
        .filter((workOrder) => world.schedules.get(workOrder.id)!.status === 'LATE')
        .map((workOrder) => ({ kind: 'FINISHES_LATE' as const, words: world.schedules.get(workOrder.id)!.words, lane: null, date: workOrder.dueDate, bucketKey: null, overMinutes: null, loadPct: null, workOrderId: workOrder.id, daysLate: daysLateOf(world, workOrder) })),
    ]
    return {
      site: siteViewOf(site),
      from,
      to,
      bucket,
      today,
      asOf: toUtcIso(now),
      plan: header,
      buckets: buckets.map((entry) => ({ key: entry.key, kind: entry.kind, from: entry.from, to: entry.to })),
      lanes,
      slots: shown.map((slot) => slotViewOf(world, slot, names)),
      workOrders,
      tray,
      problems,
    }
  })
}

/** The board's band: the working plan, the last published version, what changed since, whether Publish is held. */
async function planHeaderOf(db: Reader, world: ScheduleWorld, context: ReturnType<typeof officeContextOf>) {
  const site = { companyId: world.site.companyId, siteId: world.site.id }
  const mayChange = mayAt(context, PLANNING_SCHEDULE_MANAGE, site)
  const mayPublish = mayAt(context, PLANNING_SCHEDULE_PUBLISH, site)
  const [published] = await publishedOf(db, world.site.id, 1)
  let changes = null
  if (published) {
    const tz = world.site.timezone
    const range = { start: businessDayStart(dayOf(published.coversFrom!), tz), end: businessDayStart(plusDays(dayOf(published.coversTo!), 1), tz) }
    const slots = await slotsOf(db, published.id)
    const set = world.slots.filter((slot) => slot.startAt < range.end && slot.endAt > range.start)
    const diff = planDiff(set.map(diffSlotOf), slots.map(diffSlotOf))
    changes = { moved: diff.moved, added: diff.added, removed: diff.removed, words: diffWords(diff) }
  }
  let held: string | null = null
  try {
    const range = rangeOf(world, {})
    const { previous, set, diff } = await publishDiff(db, world, range)
    held = heldReasonOf(previous, set, diff, range)
  } catch (error) {
    held = error instanceof Error ? error.message : 'The default days cannot be published.'
  }
  if (!mayPublish) held = 'Publishing needs planning.schedule.publish at this site.'
  return {
    id: world.plan?.id ?? null,
    version: world.plan?.version ?? null,
    updatedAt: world.plan ? toUtcIso(world.plan.updatedAt) : null,
    published: published ? await versionHeaderOf(db, published) : null,
    changesSincePublished: changes,
    mayChange,
    mayPublish,
    publishHeld: held,
  }
}

/** GET /planning/schedule/work-orders/:workOrderId: the bar popover (sizes, operations, slots, material, risk). */
export async function workOrderSchedule(caller: CommandCaller, workOrderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const row = isUuid(workOrderId) ? await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, site: { select: SITE_COLUMNS }, sizes: { select: { size: true, quantity: true, colourway: { select: { code: true } } }, orderBy: [{ size: 'asc' }] } } }) : null
    assertMayAt(context, PLANNING_VIEW, row ? { companyId: row.companyId, siteId: row.siteId } : null, 'Work order')
    const now = serverClock.now()
    const today = businessDate(now, row!.site.timezone)
    const world = await scheduleWorld(db, row!.site, { from: today, to: today }, now)
    const workOrder = world.workOrders.find((candidate) => candidate.id === row!.id)
    if (!workOrder) throw new NotFoundError('The work order is not open: it is not on the board.')
    const [readiness] = await readinessFor(db, row!.site, [workOrder.id])
    const slots = world.slots.filter((slot) => slot.workOrderId === workOrder.id)
    const names = await userNamesOf(db, slots.map((slot) => slot.updatedById))
    const laneKeys = new Set([...slots.map((slot) => laneKey(laneOfSlot(slot))), ...workOrder.operations.map((operation) => laneKey(world.operationLanes.get(operation.id)!))])
    return {
      site: siteViewOf(row!.site),
      asOf: toUtcIso(now),
      workOrder: workOrderViewOf(world, workOrder, readiness ?? null),
      sizes: row!.sizes.map((size) => ({ colourway: size.colourway.code, size: size.size, quantity: size.quantity })),
      slots: slots.map((slot) => slotViewOf(world, slot, names)),
      lanes: [...world.lanes.values()]
        .filter((lane) => laneKeys.has(laneKey(lane.ref)))
        .map((lane) => ({ kind: lane.ref.kind, id: lane.ref.id, code: lane.code, name: lane.name, workCentreKind: lane.state?.lane.workCentreKind ?? null, people: lane.rate?.people ?? null, efficiencyPct: lane.rate?.efficiencyPct ?? null, does: lane.does ? [...lane.does] : null, location: lane.workshop?.location ?? null })),
    }
  })
}
