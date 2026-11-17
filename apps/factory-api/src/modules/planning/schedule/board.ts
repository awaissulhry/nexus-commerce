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
// B-PR-07: the board's wall.
import { EVERY_PARTY_WORDS, reachesEveryParty } from '@nexus/factory-domain/core/permissions'
import { actorOf } from '../../../core/context'
import { reachesWorkOrder } from '../../production/work-orders/scope'
import { serverClock } from '../../../core/time'
import { assertMayAt, mayAt, officeContextOf, siteFor } from '../access'
import { calendarStateOf, capacityAnswer } from '../capacity/service'
import { CAPACITY_MAX_DAYS } from '../capacity/contract'
import { readinessFor } from '../readiness/service'
import { dayOf, SITE_COLUMNS, type Reader } from '../store'
import type { BoardQuery, WorkOrderView } from './contract'
import { holdViewOf, NO_PERMISSION_HOLD, publishDiff, publishHoldOf, rangeOf, siteViewOf, storedSlotView, versionHeaderOf, type PublishHold } from './publish'
import { durationOn, scheduleWorld, standardOf, type BoardWorkOrder, type ScheduleWorld } from './service'
import { diffSlotOf, publishedOf, slotsOf, userNamesOf, type SlotRow } from './store'
// B-W2b-312: the earliest start with material (PLN-134) and the problems list's three W2b kinds.
import { materialStartsOf, materialStartViewOf } from '../schedule-depth/material'
import { depthProblemsOf } from '../schedule-depth/problems'
// B-PR-22b: the customer's urgency chip of a board work order.
import { workOrderCustomerUrgency, type WorkOrderUrgency } from '../../production/brand/urgency-of'
// B-W2b-329 (PLN-133): each bar's state on the floor (not started, running, paused, done) and its progress.
import { floorStatusesOf } from '../schedule-log/floor'

/**
 * The planning board's reads (B-W2a-34; PLN-129, PLN-131, PLN-132; design planning.board "Board controls", "Load per
 * lane", "Schedule", "Not on the board", "Problems in this plan", the bar popover): planning.view over the site's
 * company and the site; every figure counted on every read (./service). The resource view is `lanes` + `slots`; the
 * order view is `workOrders` with their operations (each names its slots); the tray and the problems are derived from
 * them. A production manager sees it read-only (`plan.mayChange` false).
 */

const DEFAULT_DAYS = { DAY: 13, WEEK: 55, MONTH: 182 } as const
const NOT_READY = new Set(['NOT_ENOUGH', 'DELAYED'])

// ── B-PR-22b ──
/**
 * The board's chip of a work order whose customer marked its order Urgent ("Customer urgency: Urgent 2": its place in the customer's
 * OWN list, never a place in our plan; production plan §5, F-PR-18); Regular, none, or the customer's switch off: no chip. Read
 * only: the board's order and the floor never move by it (the planner Publishes; the backlog's brand-slot pass is the backlog's).
 */
function customerUrgencyView(urgency: WorkOrderUrgency | undefined): { readonly urgentRank: number | null; readonly words: { readonly it: string; readonly en: string } } | null {
  return urgency && urgency.urgency === 'URGENT' && urgency.chip ? { urgentRank: urgency.urgentRank, words: urgency.chip } : null
}
// ── end B-PR-22b ──

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
    rush: workOrder.rush,
    version: workOrder.version,
    dueDate: workOrder.dueDate,
    style: workOrder.style,
    // B-W2b-20: the style's family and the customer (one customer; null when none or several: `customers` says them).
    family: workOrder.family,
    customer: workOrder.customers.length === 1 ? workOrder.customers[0]! : null,
    customers: workOrder.customers.map((customer) => ({ ...customer })),
    garments: workOrder.garments,
    line: line ? { id: line.ref.id, code: line.code, name: line.name } : null,
    holdReason: workOrder.holdReason,
    booksCapacity: workOrder.booksCapacity,
    minutes: remaining.toFixed(1),
    schedule: scheduleViewOf(schedule),
    readiness: readiness ? readinessViewOf(readiness) : null,
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

/**
 * B-W2b-20 (design planning.board "material status per component with arrival dates"): the work order's readiness word
 * and, per material, its word, the day it is needed and what arrives for it (planning/readiness).
 */
export const readinessViewOf = (readiness: WorkOrderReadiness) => ({
  word: readiness.word,
  label: readiness.label,
  date: readiness.date,
  reason: readiness.reason,
  materials: readiness.materials.map((material) => ({
    itemId: material.itemId,
    itemColourId: material.itemColourId,
    label: material.label,
    uom: material.uom,
    word: material.word,
    date: material.date,
    neededOn: material.neededOn,
    needed: material.needed,
    short: material.short,
    reason: material.reason,
    arrivals: material.arrivals.map((arrival) => ({ ...arrival })),
  })),
})

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
    // B-W2b-20: a lane without a calendar (the planning default) told apart from a day without working time.
    calendar: { state: lane.calendarState, calendars: lane.calendars },
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
  const workshops = world.workshops.map((workshop) => ({ kind: 'WORKSHOP' as const, id: workshop.id, code: workshop.code, name: workshop.name, workCentreKind: null, people: null, efficiencyPct: null, does: null, location: workshop.location, calendar: null, cells: null }))
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
    // B-PR-07 (production plan §2): a person limited to some customers sees the bars, work orders, tray and problems of the
    // work orders of those customers only, and no line load or capacity total (they count every customer's work).
    const wall = boardWallOf(context, world)
    const visible = world.workOrders.filter((workOrder) => wall.reaches(workOrder.id))
    const readiness = query.readiness === 'false' || visible.length === 0 ? [] : await readinessFor(db, site, visible.map((workOrder) => workOrder.id))
    const readinessOf = new Map(readiness.map((row) => [row.workOrderId, row]))
    const lanes = laneViewsOf(world, { from, to, buckets }).map((lane) => (wall.every ? lane : { ...lane, cells: null }))
    const window = { start: businessDayStart(from, site.timezone), end: businessDayStart(plusDays(to, 1), site.timezone) }
    const shown = world.slots.filter((slot) => slot.startAt < window.end && slot.endAt > window.start && wall.reaches(slot.workOrderId))
    const names = await userNamesOf(db, shown.flatMap((slot) => [slot.updatedById, slot.pinnedById])) // B-W2b-312: who pinned it too
    // B-W2b-312: per work order its earliest start with material, from the readiness read above.
    const starts = query.readiness === 'false' || visible.length === 0 ? null : await materialStartsOf(db, world, visible.map((workOrder) => workOrder.id), readiness)
    // B-PR-22b: each visible work order's customer urgency that counts (the chip "Customer urgency: Urgent 2"; walled like the rows).
    const urgency = await workOrderCustomerUrgency(db, visible.map((workOrder) => workOrder.id))
    const workOrders = visible.map((workOrder) => ({
      ...workOrderViewOf(world, workOrder, readinessOf.get(workOrder.id) ?? null),
      materialStart: starts ? materialStartViewOf(world, workOrder, starts.get(workOrder.id)!) : null,
      customerUrgency: customerUrgencyView(urgency.get(workOrder.id)), // B-PR-22b
    }))
    const header = await planHeaderOf(db, world, context, wall.every)
    const tray = visible
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
      // B-PR-07: a lane's overbooking counts every customer's work: none for a person limited to some customers (cells null).
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
      ...visible
        .filter((workOrder) => world.schedules.get(workOrder.id)!.status === 'LATE')
        .map((workOrder) => ({ kind: 'FINISHES_LATE' as const, words: world.schedules.get(workOrder.id)!.words, lane: null, date: workOrder.dueDate, bucketKey: null, overMinutes: null, loadPct: null, workOrderId: workOrder.id, daysLate: daysLateOf(world, workOrder) })),
    ]
    // B-W2b-312: operations in the past, material not in time, gate not passed (their own list).
    const moreProblems = (await depthProblemsOf(db, world, starts)).filter((problem) => wall.reaches(problem.workOrderId)) // B-PR-07
    const floor = await floorStatusesOf(db, world, shown) // B-W2b-329
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
      slots: shown.map((slot) => ({ ...slotViewOf(world, slot, names), floor: floor.get(slot.id) ?? null })), // B-W2b-329: floor
      workOrders,
      tray,
      problems,
      moreProblems,
      // B-PR-07: why the lanes carry no load (null: they do).
      loadWithheld: wall.every ? null : EVERY_PARTY_WORDS.en,
    }
  })
}

// ── B-PR-07 ──
/**
 * What of the board a person sees (production plan §2, the brand wall): with every customer at the site, all of it; limited to
 * some customers, the work orders of those customers (a work order of no customer, or a mixed one made before the rule, only
 * with every customer) and their bars. The schedules stay counted on the whole site (capacity is shared).
 */
function boardWallOf(context: ReturnType<typeof officeContextOf>, world: ScheduleWorld): { readonly every: boolean; readonly reaches: (workOrderId: string) => boolean } {
  const actor = actorOf(context)
  const place = { companyId: world.site.companyId, siteId: world.site.id }
  if (reachesEveryParty(actor, PLANNING_VIEW, place)) return { every: true, reaches: () => true }
  const reached = new Set(world.workOrders.filter((workOrder) => reachesWorkOrder(actor, PLANNING_VIEW, { ...place, partyId: workOrder.partyId })).map((workOrder) => workOrder.id))
  return { every: false, reaches: (workOrderId) => reached.has(workOrderId) }
}
// ── end B-PR-07 ──

/** The board's band: the working plan, the last published version, what changed since, whether Publish is held. */
async function planHeaderOf(db: Reader, world: ScheduleWorld, context: ReturnType<typeof officeContextOf>, everyParty: boolean) {
  const site = { companyId: world.site.companyId, siteId: world.site.id }
  const mayChange = mayAt(context, PLANNING_SCHEDULE_MANAGE, site)
  // B-PR-07: Publish sends every customer's bars; what changed since counts them: only with every customer.
  const mayPublish = everyParty && mayAt(context, PLANNING_SCHEDULE_PUBLISH, site)
  const [published] = await publishedOf(db, world.site.id, 1)
  let changes = null
  if (published && everyParty) {
    const tz = world.site.timezone
    const range = { start: businessDayStart(dayOf(published.coversFrom!), tz), end: businessDayStart(plusDays(dayOf(published.coversTo!), 1), tz) }
    const slots = await slotsOf(db, published.id)
    const set = world.slots.filter((slot) => slot.startAt < range.end && slot.endAt > range.start)
    const diff = planDiff(set.map(diffSlotOf), slots.map(diffSlotOf))
    changes = { moved: diff.moved, added: diff.added, removed: diff.removed, words: diffWords(diff) }
  }
  let hold: PublishHold | null = null
  if (everyParty) {
    try {
      const range = rangeOf(world, {})
      const { previous, set, diff } = await publishDiff(db, world, range)
      hold = publishHoldOf(previous, set, diff, range)
    } catch (error) {
      hold = { code: 'RANGE_NOT_VALID', words: error instanceof Error ? error.message : 'The default days cannot be published.', previousVersion: null, coversFrom: null, coversTo: null }
    }
  }
  if (!mayPublish) hold = NO_PERMISSION_HOLD
  return {
    id: world.plan?.id ?? null,
    version: world.plan?.version ?? null,
    updatedAt: world.plan ? toUtcIso(world.plan.updatedAt) : null,
    // B-PR-07: the version's note is the planners' own words over every customer: only with every customer.
    published: published ? { ...(await versionHeaderOf(db, published)), ...(everyParty ? {} : { note: null }) } : null,
    changesSincePublished: changes,
    mayChange,
    mayPublish,
    publishHeld: hold?.words ?? null,
    // B-W2b-20: why it is held as a stable code and its facts (B-W2a-45 read the sentence's shape).
    publishHold: holdViewOf(hold),
  }
}

/** GET /planning/schedule/work-orders/:workOrderId: the bar popover (sizes, operations, slots, material, risk). */
export async function workOrderSchedule(caller: CommandCaller, workOrderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const row = isUuid(workOrderId) ? await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, /* B-PR-07 */ partyId: true, site: { select: SITE_COLUMNS }, sizes: { select: { size: true, quantity: true, colourway: { select: { code: true } } }, orderBy: [{ size: 'asc' }] } } }) : null
    assertMayAt(context, PLANNING_VIEW, row && reachesWorkOrder(actorOf(context), PLANNING_VIEW, row) ? { companyId: row.companyId, siteId: row.siteId } : null, 'Work order') // B-PR-07: and its customer
    const now = serverClock.now()
    const today = businessDate(now, row!.site.timezone)
    const world = await scheduleWorld(db, row!.site, { from: today, to: today }, now)
    const workOrder = world.workOrders.find((candidate) => candidate.id === row!.id)
    if (!workOrder) throw new NotFoundError('The work order is not open: it is not on the board.')
    const [readiness] = await readinessFor(db, row!.site, [workOrder.id])
    const slots = world.slots.filter((slot) => slot.workOrderId === workOrder.id)
    const names = await userNamesOf(db, slots.flatMap((slot) => [slot.updatedById, slot.pinnedById])) // B-W2b-312: who pinned it too
    const laneKeys = new Set([...slots.map((slot) => laneKey(laneOfSlot(slot))), ...workOrder.operations.map((operation) => laneKey(world.operationLanes.get(operation.id)!))])
    const floor = await floorStatusesOf(db, world, slots) // B-W2b-329 (PLN-133)
    return {
      site: siteViewOf(row!.site),
      asOf: toUtcIso(now),
      // B-W2b-312: the earliest start with material (PLN-134).
      workOrder: {
        ...workOrderViewOf(world, workOrder, readiness ?? null),
        materialStart: materialStartViewOf(world, workOrder, (await materialStartsOf(db, world, [workOrder.id], readiness ? [readiness] : [])).get(workOrder.id)!),
        customerUrgency: customerUrgencyView((await workOrderCustomerUrgency(db, [workOrder.id])).get(workOrder.id)), // B-PR-22b
      },
      sizes: row!.sizes.map((size) => ({ colourway: size.colourway.code, size: size.size, quantity: size.quantity })),
      slots: slots.map((slot) => ({ ...slotViewOf(world, slot, names), floor: floor.get(slot.id) ?? null })), // B-W2b-329: floor
      lanes: [...world.lanes.values()]
        .filter((lane) => laneKeys.has(laneKey(lane.ref)))
        .map((lane) => ({
          kind: lane.ref.kind,
          id: lane.ref.id,
          code: lane.code,
          name: lane.name,
          workCentreKind: lane.state?.lane.workCentreKind ?? null,
          people: lane.rate?.people ?? null,
          efficiencyPct: lane.rate?.efficiencyPct ?? null,
          does: lane.does ? [...lane.does] : null,
          location: lane.workshop?.location ?? null,
          calendar: lane.state ? { state: calendarStateOf(lane.state), calendars: (lane.state.calendar?.layers ?? []).map((layer) => ({ id: layer.id, scope: layer.scope, name: layer.name })) } : null,
        })),
    }
  })
}
