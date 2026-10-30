import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { trayOrder } from '@nexus/factory-domain/planning/schedule/backward'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PLANNING_SCHEDULE_MANAGE } from '@nexus/factory-domain/planning/schedule/permissions'
import { laneColumns, laneKey, laneOfSlot, SLOT_LIMITS, slotInputProblems, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { dayWords, workingMinutesFor } from '@nexus/factory-domain/planning/schedule/time'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, officeContextOf, siteFor } from '../access'
import { SITE_COLUMNS, type SiteRow } from '../store'
import { scheduleViewOf } from './board'
import type { MoveSlotBody, PlaceByDueDateBody, PlaceSlotBody } from './contract'
import { storedSlotView } from './publish'
import { capacityWith, durationOn, endOf, overDays, scheduleWorld, standardOf, type BoardOperation, type BoardWorkOrder, type OverDay, type PlannedSlot, type ScheduleWorld } from './service'
import { laneFacts, lockedSlot, lockedWorkingPlan, SLOT_COLUMNS, userNamesOf, type SlotRow } from './store'

/**
 * Moves on the planning board (B-W2a-34; PLN-129, PLN-131, PLN-160; design planning.board "Schedule": "Each move
 * autosaves to the working plan (version check); a 409 shows 'Moved by Marco at 10:42 · Reload'", "Drop on an
 * overbooked lane: warning popover … Keep with a reason / Cancel", the tray's "Place all by due date"; Owner answer P3:
 * every move goes into the site's shared WORKING plan, the floor sees none of it until a publish).
 *
 * Every write is ONE command under the site's schedule lock (store.ts: the advisory lock, then the working plan's version
 * bump, made by the first move when the site has none), checked again on the world read inside it:
 *   place      a bar (an operation with work left and no bar yet) on a line that does its work centre, on its own work
 *              centre, or at a workshop; or a whole-order slot (part of an order) on a line or at a workshop. The end,
 *              unless given, is the start plus what the work takes on the lane: standard minutes ÷ (people × efficiency)
 *              in the lane's working time (a workshop: the routing step's transit days, else one day).
 *   move       the slot at the version the board read (409 names who moved it and when); a new start or lane computes a
 *              new end the same way; the minutes are counted again (the scans may have moved on).
 *   overload   a place or move whose lane goes over its available minutes on a day it covers (released work only books
 *              capacity) is refused with the numbers in words unless it carries `overloadReason` ("Keep with a reason");
 *              a slot that no longer goes over loses its reason.
 *   remove     back to the tray.
 *   by due date  the tray's operations without a bar, at their latest starts (backward from the due date), or from now
 *              when the latest safe start has passed; a preview first, then one command (a reason when one overbooks).
 * Audited (recordType ScheduleSlot; the placement by due date: PlanVersion); event planning.schedule_changed.
 */

const instant = (value: string): Date => parseInstant(value)!

interface Target {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly site: SiteRow
}

async function workOrderFor(caller: CommandCaller, workOrderId: string, permission: Permission): Promise<Target> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => (isUuid(workOrderId) ? db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, site: { select: SITE_COLUMNS } } }) : Promise.resolve(null)))
  assertMayAt(context, permission, row ? { companyId: row.companyId, siteId: row.siteId } : null, 'Work order')
  return row!
}

async function slotFor(caller: CommandCaller, slotId: string, permission: Permission): Promise<Target & { slot: SlotRow }> {
  const context = officeContextOf(caller)
  const slot = await caller.withClient((db) => (isUuid(slotId) ? db.scheduleSlot.findUnique({ where: { id: slotId }, select: { ...SLOT_COLUMNS, workOrder: { select: { id: true, companyId: true, siteId: true, site: { select: SITE_COLUMNS } } } } }) : Promise.resolve(null)))
  assertMayAt(context, PLANNING_VIEW, slot ? { companyId: slot.workOrder.companyId, siteId: slot.siteId } : null, 'Slot')
  if (slot!.planKind !== 'WORKING') throw new NotFoundError('Slot not found on the working plan: a published version never changes.')
  assertMayAt(context, permission, { companyId: slot!.workOrder.companyId, siteId: slot!.siteId }, 'Slot')
  return { ...slot!.workOrder, slot: slot! }
}

/** The open work order on the world read inside the command (else 409 in words). */
function openWorkOrder(world: ScheduleWorld, workOrderId: string): BoardWorkOrder {
  const workOrder = world.workOrders.find((candidate) => candidate.id === workOrderId)
  if (!workOrder) throw new ConflictError('The work order is not open any more (completed, closed or cancelled): it is not placed on the board.')
  return workOrder
}

const centreName = (world: ScheduleWorld, id: string): string => world.lanes.get(laneKey({ kind: 'WORK_CENTRE', id }))?.name ?? 'its work centre'

/** A bar fits a lane when the lane does its operation; a whole-order slot goes to a line or a workshop. */
function assertFits(world: ScheduleWorld, operation: BoardOperation | null, lane: LaneRef, laneName: string): void {
  if (operation === null) {
    if (lane.kind === 'WORK_CENTRE') throw new ConflictError('A part of an order goes to a line or a workshop; an operation goes to a work centre.')
    return
  }
  if (lane.kind === 'LINE') {
    const info = world.lanes.get(laneKey(lane))
    if (info && info.does !== null && !info.does.includes(operation.workCentreId)) {
      const does = info.does.map((id) => centreName(world, id)).join(', ')
      throw new ConflictError(`${laneName} does ${does}; Op ${operation.seq} ${operation.name} is done at ${centreName(world, operation.workCentreId)}.`)
    }
  }
  if (lane.kind === 'WORK_CENTRE' && lane.id !== operation.workCentreId) {
    throw new ConflictError(`Op ${operation.seq} ${operation.name} is done at ${centreName(world, operation.workCentreId)}: change its work centre on the work order to move it to ${laneName}.`)
  }
}

/**
 * Standard minutes a slot books: a bar, the operation's garments still to do; a part, its garments × the operations its
 * lane does (a workshop, or no lane: every operation).
 */
export function slotMinutes(world: ScheduleWorld, workOrder: BoardWorkOrder, operation: BoardOperation | null, lane: LaneRef | null, garments: number): Decimal {
  if (operation) return standardOf(operation, operation.remaining)
  const info = lane ? world.lanes.get(laneKey(lane)) : undefined
  return workOrder.operations
    .filter((candidate) => candidate.remaining > 0)
    .filter((candidate) => lane === null || lane.kind === 'WORKSHOP' || info?.does == null || info.does.includes(candidate.workCentreId))
    .reduce((sum, candidate) => sum.plus(standardOf(candidate, Math.min(garments, candidate.remaining))), new Dec(0))
}

/** Where a slot placed at `start` on a lane ends (see above). */
function endFor(world: ScheduleWorld, workOrder: BoardWorkOrder, operation: BoardOperation | null, lane: LaneRef, start: Date, minutes: Decimal): Date {
  let duration
  if (operation) duration = durationOn(world, lane, operation, operation.remaining)
  else if (lane.kind === 'WORKSHOP') duration = { kind: 'CLOCK' as const, minutes: 24 * 60 }
  else {
    const info = world.lanes.get(laneKey(lane))
    duration = { kind: 'WORKING' as const, minutes: workingMinutesFor(minutes, info?.rate ?? { people: 1, efficiencyPct: '100' }), spans: info?.spans ?? world.siteSpans }
  }
  const times = endOf(duration, start.getTime())
  if (!times) throw new ConflictError(`${workOrder.number} does not fit in the working time loaded from ${toUtcIso(start)}: give an end.`)
  return new Date(times.end)
}

function overWords(laneName: string, over: readonly OverDay[]): string {
  const first = over[0]!
  const more = over.length > 1 ? ` and ${over.length - 1} more ${over.length === 2 ? 'day' : 'days'}` : ''
  return `${laneName} would be at ${first.loadPct ?? '—'}% on ${dayWords(first.date)} (+${first.overMinutes} min over)${more}. Keep it there with a reason, or choose another place.`
}

class OverloadedError extends DomainError {
  override name = 'OverloadedError'
  constructor(laneName: string, over: readonly OverDay[]) {
    super('conflict', overWords(laneName, over), [
      { path: 'body/overloadReason', message: 'Say why it stays on the overbooked lane.' },
      ...over.map((day) => ({ path: `over/${day.date}`, message: `${day.bookedMinutes} of ${day.availableMinutes} min (${day.loadPct ?? '—'}%), +${day.overMinutes} over.` })),
    ])
  }
}

const reasonOf = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const noteOf = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value)

function invalid(problems: Issue[]): never {
  throw new ValidationError(problems[0]!.message, problems)
}

async function answerAfter(caller: CommandCaller, site: SiteRow, slotId: string, workOrderId: string) {
  return caller.withClient(async (db) => {
    const slot = await db.scheduleSlot.findUniqueOrThrow({ where: { id: slotId }, select: SLOT_COLUMNS })
    const names = await userNamesOf(db, [slot.updatedById])
    const now = serverClock.now()
    const today = businessDate(now, site.timezone)
    const world = await scheduleWorld(db, site, { from: today, to: today }, now)
    const schedule = world.schedules.get(workOrderId)
    return { slot: storedSlotView(slot, names), schedule: schedule ? scheduleViewOf(schedule) : null }
  })
}

const emitChange = (tools: CommandTools, site: SiteRow, plan: { id: string; version: number }, change: 'PLACED' | 'MOVED' | 'REMOVED' | 'PLACED_BY_DUE_DATE', slotIds: string[], workOrderIds: string[]) =>
  tools.emit({
    type: 'planning.schedule_changed',
    subject: plan.id,
    companyId: site.companyId,
    siteId: site.id,
    payload: { siteId: site.id, planVersionId: plan.id, planVersion: plan.version, change, slots: slotIds.length, slotIds: slotIds.slice(0, SLOT_LIMITS.perBatch), workOrderIds: [...new Set(workOrderIds)].slice(0, SLOT_LIMITS.perBatch) },
  })

const slotAudit = (slot: Pick<SlotRow, 'lineId' | 'workCentreId' | 'partyId' | 'startAt' | 'endAt' | 'pieces' | 'overloadReason' | 'note'> & { minutes: { toString(): string } }) => ({
  lane: laneOfSlot(slot),
  startAt: toUtcIso(slot.startAt),
  endAt: toUtcIso(slot.endAt),
  pieces: slot.pieces,
  minutes: new Dec(slot.minutes.toString()).toFixed(1),
  overloadReason: slot.overloadReason,
  note: slot.note,
})

/** POST /planning/schedule/slots: place a bar or a part of an order on a lane of the working plan. */
export async function placeSlot(caller: CommandCaller, body: PlaceSlotBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await workOrderFor(caller, body.workOrderId, PLANNING_SCHEDULE_MANAGE)
  const start = instant(body.startAt)
  const { result, replayed } = await command(caller, { name: 'planning.schedule.place', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, target.site, context.tenantId, { actorId: context.actorId, now, bump: true })
    const world = await scheduleWorld(tx, target.site, { from: businessDate(start, target.site.timezone), to: businessDate(body.endAt ? instant(body.endAt) : start, target.site.timezone) }, now)
    const workOrder = openWorkOrder(world, target.id)
    const operation = body.operationId ? workOrder.operations.find((candidate) => candidate.id === body.operationId) : null
    if (body.operationId && !operation) throw new NotFoundError('Operation not found on this work order.')
    const lane = await laneFacts(tx, target.site, body.lane)
    assertFits(world, operation ?? null, lane.ref, lane.name)
    if (operation) {
      if (operation.remaining === 0) throw new ConflictError(`Op ${operation.seq} ${operation.name} of ${workOrder.number} is done: nothing to place.`)
      if (world.slots.some((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === operation.id)) throw new ConflictError(`Op ${operation.seq} ${operation.name} of ${workOrder.number} already has a bar on the board: move that one.`)
    } else if (world.slots.some((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === null && laneKey(laneOfSlot(slot)) === laneKey(lane.ref))) {
      throw new ConflictError(`${workOrder.number} already has a part on ${lane.name}: change it on the allocation board.`)
    }
    const garments = operation ? operation.remaining : (body.pieces ?? workOrder.garments)
    const minutes = slotMinutes(world, workOrder, operation ?? null, lane.ref, garments)
    const end = body.endAt ? instant(body.endAt) : endFor(world, workOrder, operation ?? null, lane.ref, start, minutes)
    const problems = slotInputProblems({ startAt: start.getTime(), endAt: end.getTime(), pieces: body.pieces ?? null, overloadReason: body.overloadReason ?? null, note: body.note ?? null }, { whole: !operation, garments: workOrder.garments })
    if (problems.length > 0) invalid(problems)
    const id = newId()
    const row: PlannedSlot = { id, workOrderId: workOrder.id, workOrderOperationId: operation?.id ?? null, ...laneColumns(lane.ref), startAt: start, endAt: end, pieces: operation ? null : (body.pieces ?? null), minutes }
    const over = workOrder.booksCapacity ? overDays(world, capacityWith(world, [...world.slots, row]), lane.ref, start, end) : []
    const reason = reasonOf(body.overloadReason)
    if (over.length > 0 && reason === null) throw new OverloadedError(lane.name, over)
    const data = {
      id,
      siteId: target.siteId,
      planVersionId: plan.id,
      planKind: 'WORKING' as const,
      workOrderId: workOrder.id,
      workOrderOperationId: operation?.id ?? null,
      ...laneColumns(lane.ref),
      startAt: start,
      endAt: end,
      pieces: row.pieces,
      minutes: minutes.toFixed(3),
      overloadReason: over.length > 0 ? reason : null,
      note: noteOf(body.note),
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
      updatedById: context.actorId,
    }
    await tx.scheduleSlot.create({ data, select: { id: true } })
    tools.audit({ action: 'planning.schedule.place', recordType: 'ScheduleSlot', recordId: id, companyId: target.companyId, siteId: target.siteId, before: null, after: { workOrderId: workOrder.id, operationId: data.workOrderOperationId, ...slotAudit({ ...data, minutes }) } })
    emitChange(tools, target.site, plan, 'PLACED', [id], [workOrder.id])
    return { slotId: id, planVersion: plan.version, over }
  })
  const after = await answerAfter(caller, target.site, result.slotId, target.id)
  return { ...after, planVersion: result.planVersion, over: result.over, replayed }
}

/** PATCH /planning/schedule/slots/:slotId: move a slot (lane, time, garments, reason, note) at the version read. */
export async function moveSlot(caller: CommandCaller, slotId: string, body: MoveSlotBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await slotFor(caller, slotId, PLANNING_SCHEDULE_MANAGE)
  const { result, replayed } = await command(caller, { name: 'planning.schedule.move', idempotencyKey, input: { slotId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, target.site, context.tenantId, { actorId: context.actorId, now, bump: true })
    const current = await lockedSlot(tx, slotId, body.version, target.site.timezone)
    const start = body.startAt ? instant(body.startAt) : current.startAt
    const world = await scheduleWorld(tx, target.site, { from: businessDate(start, target.site.timezone), to: businessDate(body.endAt ? instant(body.endAt) : current.endAt, target.site.timezone) }, now)
    const workOrder = openWorkOrder(world, current.workOrderId)
    const operation = current.workOrderOperationId ? (workOrder.operations.find((candidate) => candidate.id === current.workOrderOperationId) ?? null) : null
    const lane = body.lane ? await laneFacts(tx, target.site, body.lane) : await laneFacts(tx, target.site, laneOfSlot(current))
    assertFits(world, operation, lane.ref, lane.name)
    if (body.lane && !operation && laneKey(body.lane) !== laneKey(laneOfSlot(current)) && world.slots.some((slot) => slot.id !== current.id && slot.workOrderId === workOrder.id && slot.workOrderOperationId === null && laneKey(laneOfSlot(slot)) === laneKey(lane.ref))) {
      throw new ConflictError(`${workOrder.number} already has a part on ${lane.name}: change it on the allocation board.`)
    }
    const pieces = operation ? null : body.pieces !== undefined ? body.pieces : current.pieces
    const minutes = slotMinutes(world, workOrder, operation, lane.ref, operation ? 0 : (pieces ?? workOrder.garments))
    const replaced = body.startAt !== undefined || body.lane !== undefined || (!operation && body.pieces !== undefined)
    const end = body.endAt ? instant(body.endAt) : replaced ? endFor(world, workOrder, operation, lane.ref, start, minutes) : current.endAt
    const problems = slotInputProblems({ startAt: start.getTime(), endAt: end.getTime(), pieces, overloadReason: body.overloadReason ?? null, note: body.note ?? null }, { whole: !operation, garments: workOrder.garments })
    if (problems.length > 0) invalid(problems)
    const moved: PlannedSlot = { id: current.id, workOrderId: current.workOrderId, workOrderOperationId: current.workOrderOperationId, ...laneColumns(lane.ref), startAt: start, endAt: end, pieces, minutes }
    const others = world.slots.filter((slot) => slot.id !== current.id)
    const over = workOrder.booksCapacity ? overDays(world, capacityWith(world, [...others, moved]), lane.ref, start, end) : []
    const reason = body.overloadReason !== undefined ? reasonOf(body.overloadReason) : current.overloadReason
    if (over.length > 0 && reason === null) throw new OverloadedError(lane.name, over)
    const data = {
      ...laneColumns(lane.ref),
      startAt: start,
      endAt: end,
      pieces,
      minutes: minutes.toFixed(3),
      overloadReason: over.length > 0 ? reason : null,
      note: body.note !== undefined ? noteOf(body.note) : current.note,
      version: current.version + 1,
      updatedAt: now,
      updatedById: context.actorId,
    }
    const { count } = await tx.scheduleSlot.updateMany({ where: { id: current.id, version: current.version }, data })
    if (count !== 1) throw new ConflictError('The slot moved meanwhile: reload the board.')
    tools.audit({ action: 'planning.schedule.move', recordType: 'ScheduleSlot', recordId: current.id, companyId: target.companyId, siteId: target.siteId, before: slotAudit(current), after: slotAudit({ ...data, minutes }) })
    emitChange(tools, target.site, plan, 'MOVED', [current.id], [current.workOrderId])
    return { planVersion: plan.version, over }
  })
  const after = await answerAfter(caller, target.site, slotId, target.slot.workOrderId)
  return { ...after, planVersion: result.planVersion, over: result.over, replayed }
}

/** POST /planning/schedule/slots/:slotId/remove: the slot goes back to the tray. */
export async function removeSlot(caller: CommandCaller, slotId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await slotFor(caller, slotId, PLANNING_SCHEDULE_MANAGE)
  const { result, replayed } = await command(caller, { name: 'planning.schedule.remove', idempotencyKey, input: { slotId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, target.site, context.tenantId, { actorId: context.actorId, now, bump: true })
    const current = await lockedSlot(tx, slotId, body.version, target.site.timezone)
    const { count } = await tx.scheduleSlot.deleteMany({ where: { id: current.id, version: current.version } })
    if (count !== 1) throw new ConflictError('The slot moved meanwhile: reload the board.')
    tools.audit({ action: 'planning.schedule.remove', recordType: 'ScheduleSlot', recordId: current.id, companyId: target.companyId, siteId: target.siteId, before: { workOrderId: current.workOrderId, operationId: current.workOrderOperationId, ...slotAudit(current) }, after: null })
    emitChange(tools, target.site, plan, 'REMOVED', [current.id], [current.workOrderId])
    return { planVersion: plan.version, workOrderId: current.workOrderId }
  })
  return { removed: slotId, workOrderId: result.workOrderId, planVersion: result.planVersion, replayed }
}

interface Proposal {
  readonly row: PlannedSlot
  readonly lane: LaneRef
  readonly laneName: string
  readonly placedBy: 'BACKWARD' | 'FORWARD'
  readonly over: OverDay[]
}

/** The tray's operations without a bar or part, placed by their due dates (see above), in the tray's order. */
function proposalsOf(world: ScheduleWorld, workOrderIds: readonly string[] | undefined) {
  const now = world.now.getTime()
  const skipped: { workOrderId: string; operationId: string | null; words: string }[] = []
  const wanted = workOrderIds ? new Set(workOrderIds) : null
  for (const id of wanted ?? []) if (!world.workOrders.some((workOrder) => workOrder.id === id)) skipped.push({ workOrderId: id, operationId: null, words: 'Not an open work order of this site.' })
  const targets = world.workOrders
    .filter((workOrder) => (wanted ? wanted.has(workOrder.id) : true))
    .map((workOrder) => ({ workOrder, schedule: world.schedules.get(workOrder.id)! }))
    .sort((a, b) => trayOrder({ ...a.schedule, dueDate: a.workOrder.dueDate, number: a.workOrder.number }, { ...b.schedule, dueDate: b.workOrder.dueDate, number: b.workOrder.number }))
  const proposals: Proposal[] = []
  let slots: PlannedSlot[] = [...world.slots]
  for (const { workOrder, schedule } of targets) {
    if (schedule.status === 'DONE') continue
    const unplaced = schedule.operations.filter((operation) => operation.plannedStart === null)
    if (unplaced.length === 0) continue
    if (workOrder.status === 'ON_HOLD') {
      skipped.push({ workOrderId: workOrder.id, operationId: null, words: `${workOrder.number} is on hold${workOrder.holdReason ? `: ${workOrder.holdReason}` : ''}; it waits until the hold is lifted.` })
      continue
    }
    if (schedule.status === 'NO_DUE_DATE') {
      skipped.push({ workOrderId: workOrder.id, operationId: null, words: schedule.words })
      continue
    }
    const backward = schedule.latestSafeStart !== null && schedule.latestSafeStart >= now
    for (const times of unplaced) {
      const operation = workOrder.operations.find((candidate) => candidate.id === times.id)!
      const lane = world.operationLanes.get(operation.id)!
      const info = world.lanes.get(laneKey(lane))
      const start = backward ? times.latestStart : times.earliestStart
      const end = backward ? times.latestFinish : times.earliestFinish
      if (!info) {
        skipped.push({ workOrderId: workOrder.id, operationId: operation.id, words: `Op ${operation.seq} ${operation.name}: its lane is not active on this site.` })
        continue
      }
      if (start === null || end === null || end <= start) {
        skipped.push({ workOrderId: workOrder.id, operationId: operation.id, words: `Op ${operation.seq} ${operation.name} does not fit in the working time loaded: place it by hand.` })
        continue
      }
      const row: PlannedSlot = { id: newId(), workOrderId: workOrder.id, workOrderOperationId: operation.id, ...laneColumns(lane), startAt: new Date(start), endAt: new Date(end), pieces: null, minutes: standardOf(operation, operation.remaining) }
      slots = [...slots, row]
      const over = workOrder.booksCapacity ? overDays(world, capacityWith(world, slots), lane, row.startAt, row.endAt) : []
      proposals.push({ row, lane, laneName: info.name, placedBy: backward ? 'BACKWARD' : 'FORWARD', over })
    }
  }
  return { proposals, skipped }
}

const proposalView = (proposal: Proposal) => ({
  workOrderId: proposal.row.workOrderId,
  operationId: proposal.row.workOrderOperationId!,
  lane: proposal.lane,
  startAt: toUtcIso(proposal.row.startAt),
  endAt: toUtcIso(proposal.row.endAt),
  minutes: new Dec(proposal.row.minutes.toString()).toFixed(1),
  placedBy: proposal.placedBy,
  over: proposal.over,
})

/** POST /planning/schedule/place-by-due-date: the tray by backward scheduling; a preview, or applied in one command. */
export async function placeByDueDate(caller: CommandCaller, body: PlaceByDueDateBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, body.apply ? PLANNING_SCHEDULE_MANAGE : PLANNING_VIEW)
  if (!body.apply) {
    const now = serverClock.now()
    return caller.withClient(async (db) => {
      const today = businessDate(now, site.timezone)
      const world = await scheduleWorld(db, site, { from: today, to: plusDays(today, 1) }, now)
      const { proposals, skipped } = proposalsOf(world, body.workOrderIds)
      return { planVersion: world.plan?.version ?? null, applied: false, slots: proposals.map(proposalView), skipped, overbooked: proposals.filter((proposal) => proposal.over.length > 0).length, replayed: false }
    })
  }
  const { result, replayed } = await command(caller, { name: 'planning.schedule.placeByDueDate', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, site, context.tenantId, { actorId: context.actorId, now, expectedVersion: body.version, bump: true })
    const today = businessDate(now, site.timezone)
    const world = await scheduleWorld(tx, site, { from: today, to: plusDays(today, 1) }, now)
    const { proposals, skipped } = proposalsOf(world, body.workOrderIds)
    if (proposals.length === 0) throw new ConflictError(skipped.length ? `Nothing to place: ${skipped[0]!.words}` : 'Nothing to place: every operation with work left is on the board.')
    const over = proposals.filter((proposal) => proposal.over.length > 0)
    const reason = reasonOf(body.overloadReason)
    if (over.length > 0 && reason === null) {
      throw new DomainError('conflict', `${over.length} of the ${proposals.length} placements would overbook their lanes (${overWords(over[0]!.laneName, over[0]!.over)}) Give a reason to keep them, or place them by hand.`, [
        { path: 'body/overloadReason', message: 'Say why they stay on the overbooked lanes.' },
      ])
    }
    if (reason !== null && reason.length < 3) invalid([{ path: 'body/overloadReason', message: 'Say in a few words why they stay on the overbooked lanes.' }])
    await tx.scheduleSlot.createMany({
      data: proposals.map((proposal) => ({
        id: proposal.row.id,
        siteId: site.id,
        planVersionId: plan.id,
        planKind: 'WORKING' as const,
        workOrderId: proposal.row.workOrderId,
        workOrderOperationId: proposal.row.workOrderOperationId,
        lineId: proposal.row.lineId,
        workCentreId: proposal.row.workCentreId,
        partyId: proposal.lane.kind === 'WORKSHOP' ? proposal.lane.id : null,
        startAt: proposal.row.startAt,
        endAt: proposal.row.endAt,
        pieces: null,
        minutes: new Dec(proposal.row.minutes.toString()).toFixed(3),
        overloadReason: proposal.over.length > 0 ? reason : null,
        note: null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
        updatedById: context.actorId,
      })),
    })
    tools.audit({
      action: 'planning.schedule.placeByDueDate',
      recordType: 'PlanVersion',
      recordId: plan.id,
      companyId: site.companyId,
      siteId: site.id,
      before: null,
      after: { placed: proposals.map((proposal) => ({ slotId: proposal.row.id, workOrderId: proposal.row.workOrderId, operationId: proposal.row.workOrderOperationId, placedBy: proposal.placedBy, ...slotAudit({ ...proposal.row, partyId: proposal.lane.kind === 'WORKSHOP' ? proposal.lane.id : null, overloadReason: proposal.over.length > 0 ? reason : null, note: null }) })), overbooked: over.length },
    })
    emitChange(tools, site, plan, 'PLACED_BY_DUE_DATE', proposals.map((proposal) => proposal.row.id), proposals.map((proposal) => proposal.row.workOrderId))
    return { planVersion: plan.version, slots: proposals.map(proposalView), skipped, overbooked: over.length }
  })
  return { ...result, applied: true, replayed }
}
