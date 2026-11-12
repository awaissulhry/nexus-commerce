import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { inverseOf, isUndoable, resultHolds, undoHoldOf, undoHoldWords, undoPermissionOf, type ChangeKind, type ChangePlace, type UndoableKind } from '@nexus/factory-domain/planning/schedule-log/changes'
import { refusalIssue, ScheduleRefusal } from '@nexus/factory-domain/planning/schedule/refusals'
import { laneColumns, SLOT_LIMITS, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { dayWords } from '@nexus/factory-domain/planning/schedule/time'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayAt, officeContextOf } from '../access'
import { SITE_COLUMNS, type SiteRow } from '../store'
import { assertNoGateHold } from '../schedule/gates'
import { storedSlotView } from '../schedule/publish'
import { capacityWith, overDays, scheduleWorld, type OverDay, type PlannedSlot, type ScheduleWorld } from '../schedule/service'
import { assertFits, slotMinutes } from '../schedule/slots'
import { laneFacts, lockedWorkingPlan, SLOT_COLUMNS, userNamesOf, type SlotRow } from '../schedule/store'
import { logChanges, type LoggedPlace } from '../schedule-depth/log'
import { pinnedRefusal } from '../schedule-depth/pins'
import type { UndoBody } from './contract'
import { byWords, CHANGE_COLUMNS, entriesOf, factsOf, laterWords, latestOfSlots, slotsNowOf, whatOf, type ChangeRow } from './feed'

/**
 * Undo one change of the board's log (B-W2b-329; PLN-149; design planning.board "Undo one move", "⌘Z … undo while the bar
 * is still where we put it"): POST /planning/schedule/changes/:changeId/undo {overloadReason?}. Undone once, while still ours
 * (factory-domain planning/schedule-log/changes: the change is its slot's latest in the log and the slot is where it left
 * it), by the same rules as the move it is: a PLACE is taken off the board, a MOVE goes back to where it was (the lane must
 * still do the operation and be active, the work order open, its order's gate passed, the lane not overbooked without a
 * reason), a REMOVE of a bar comes back with the same slot id (its operation with work left and no other bar), a PIN is
 * unpinned and an UNPIN pinned again. A pinned slot is not taken off or moved back (unpin it first).
 *
 * ONE command under the site's schedule lock (the working plan's version bump): the slot written, an UNDO row naming the
 * change and what it put back (the database keeps one undo per change: `ScheduleChange_one_undo`), an audit row
 * (planning.schedule.undo, recordType ScheduleChange) and planning.schedule_changed UNDONE. planning.schedule.manage for a
 * place, move or removal; planning.schedule.pin for a pin or unpin (checked here: the manifest asks planning.view).
 */

const asLogged = (place: ChangePlace | null): LoggedPlace | null => (place ? { lane: place.lane, startAt: new Date(place.startAt), endAt: new Date(place.endAt) } : null)

function overWords(laneName: string, over: readonly OverDay[]): string {
  const first = over[0]!
  const more = over.length > 1 ? ` and ${over.length - 1} more ${over.length === 2 ? 'day' : 'days'}` : ''
  return `${laneName} would be at ${first.loadPct ?? '—'}% on ${dayWords(first.date)} (+${first.overMinutes} min over)${more}. Undo it with a reason to keep it there.`
}

class OverloadedError extends DomainError {
  override name = 'OverloadedError'
  constructor(laneName: string, over: readonly OverDay[]) {
    super('conflict', overWords(laneName, over), [
      { path: 'body/overloadReason', message: 'Say why it goes back onto the overbooked lane.' },
      ...over.map((day) => ({ path: `over/${day.date}`, message: `${day.bookedMinutes} of ${day.availableMinutes} min (${day.loadPct ?? '—'}%), +${day.overMinutes} over.` })),
      refusalIssue('OVERLOAD'),
    ])
  }
}

const reasonOf = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim().slice(0, SLOT_LIMITS.reason))

async function changeTarget(caller: CommandCaller, changeId: string): Promise<{ id: string; kind: string; site: SiteRow }> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => (isUuid(changeId) ? db.scheduleChange.findUnique({ where: { id: changeId }, select: { id: true, kind: true, plan: { select: { site: { select: SITE_COLUMNS } } } } }) : Promise.resolve(null)))
  const site = row?.plan.site ?? null
  assertMayAt(context, PLANNING_VIEW, site ? { companyId: site.companyId, siteId: site.id } : null, 'Change')
  if (isUndoable(row!.kind as ChangeKind)) assertMayAt(context, undoPermissionOf(row!.kind as UndoableKind), { companyId: site!.companyId, siteId: site!.id }, 'Change')
  return { id: row!.id, kind: row!.kind, site: site! }
}

/** The work order open on the world (else 409 in words). */
function openOn(world: ScheduleWorld, row: ChangeRow) {
  const workOrder = world.workOrders.find((candidate) => candidate.id === row.workOrderId)
  if (!workOrder) throw new ScheduleRefusal('NOT_OPEN', `${row.workOrder?.number ?? 'The work order'} is not open any more (completed, closed or cancelled): its bar is not put back on the board.`)
  return workOrder
}

/** The undo's refusals before any write, in words (the domain's order: kind, once, still ours). */
async function assertUndoable(tx: CommandTools['tx'], row: ChangeRow, site: SiteRow): Promise<SlotRow | null> {
  const fact = factsOf(row)
  const what = whatOf(row)
  const undone = row.undoneBy[0] ?? null
  const latest = row.slotId ? (await latestOfSlots(tx, [row.slotId])).get(row.slotId) : undefined
  const slotNow = row.slotId ? ((await slotsNowOf(tx, [row.slotId])).get(row.slotId) ?? null) : null
  // The permission was asked before the command (changeTarget): here the kind, once, and still ours.
  const code = undoHoldOf(fact, { undone: undone !== null, latestOfSlot: latest?.id ?? null, slot: slotNow, may: true })
  if (code && code !== 'NO_PERMISSION') {
    const names = await userNamesOf(tx, [undone?.changedById ?? null, latest?.changedById ?? null])
    const later = latest && latest.id !== row.id ? laterWords(latest, names, site.timezone) : null
    const undoneBy = undone ? byWords(undone, names, site.timezone) : null
    throw new ScheduleRefusal(code, undoHoldWords(code, { kind: fact.kind, operationId: row.workOrderOperationId, what, undoneBy, later, permission: 'planning.schedule.manage' }))
  }
  if (!resultHolds(fact, slotNow)) throw new ScheduleRefusal('CHANGED_SINCE', undoHoldWords('CHANGED_SINCE', { kind: fact.kind, operationId: row.workOrderOperationId, what, undoneBy: null, later: null, permission: '' }))
  return row.slotId ? await tx.scheduleSlot.findUnique({ where: { id: row.slotId }, select: SLOT_COLUMNS }) : null
}

/** POST /planning/schedule/changes/:changeId/undo. */
export async function undoChange(caller: CommandCaller, changeId: string, body: UndoBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await changeTarget(caller, changeId)
  const site = target.site
  const { result, replayed } = await command(caller, { name: 'planning.schedule.undo', idempotencyKey, input: { changeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, site, context.tenantId, { actorId: context.actorId, now, bump: true })
    const row = await tx.scheduleChange.findUnique({ where: { id: target.id }, select: CHANGE_COLUMNS })
    if (!row) throw new NotFoundError('Change not found.')
    const current = await assertUndoable(tx, row, site)
    const fact = factsOf(row) as ReturnType<typeof factsOf> & { kind: UndoableKind }
    const inverse = inverseOf(fact)
    const reason = reasonOf(body.overloadReason)
    let over: OverDay[] = []
    let keptReason: string | null = null
    const bump = (slot: SlotRow) => ({ version: slot.version + 1, updatedAt: now, updatedById: context.actorId })
    const write = async (slot: SlotRow, data: Prisma.ScheduleSlotUncheckedUpdateManyInput) => {
      const { count } = await tx.scheduleSlot.updateMany({ where: { id: slot.id, version: slot.version, planKind: 'WORKING' }, data })
      if (count !== 1) throw new ScheduleRefusal('SLOT_MOVED', 'The slot moved meanwhile: reload the board.')
    }
    /** The place a bar goes back to, checked as a move there: open work order, gate, lane, overload. */
    const placeBack = async (place: ChangePlace, others: (slots: readonly PlannedSlot[]) => PlannedSlot[]) => {
      const start = new Date(place.startAt)
      const end = new Date(place.endAt)
      const world = await scheduleWorld(tx, site, { from: businessDate(start, site.timezone), to: businessDate(end, site.timezone) }, now)
      const workOrder = openOn(world, row)
      await assertNoGateHold(tx, workOrder)
      const operation = row.workOrderOperationId ? (workOrder.operations.find((candidate) => candidate.id === row.workOrderOperationId) ?? null) : null
      if (row.workOrderOperationId && !operation) throw new NotFoundError('Operation not found on this work order.')
      const lane = await laneFacts(tx, site, place.lane)
      assertFits(world, operation, lane.ref, lane.name)
      const minutes = slotMinutes(world, workOrder, operation, lane.ref, operation ? 0 : (current?.pieces ?? workOrder.garments))
      const placed: PlannedSlot = { id: row.slotId!, workOrderId: workOrder.id, workOrderOperationId: row.workOrderOperationId, ...laneColumns(lane.ref), startAt: start, endAt: end, pieces: operation ? null : (current?.pieces ?? null), minutes }
      over = workOrder.booksCapacity ? overDays(world, capacityWith(world, [...others(world.slots), placed]), lane.ref, start, end) : []
      if (over.length > 0 && reason === null) throw new OverloadedError(lane.name, over)
      keptReason = over.length > 0 ? reason : null
      return { world, workOrder, operation, lane: lane.ref as LaneRef, start, end, minutes }
    }
    switch (inverse.action) {
      case 'TAKE_OFF': {
        if (current!.pinned) throw await pinnedRefusal(tx, current!, 'remove', site.timezone)
        const { count } = await tx.scheduleSlot.deleteMany({ where: { id: current!.id, version: current!.version, planKind: 'WORKING' } })
        if (count !== 1) throw new ScheduleRefusal('SLOT_MOVED', 'The slot moved meanwhile: reload the board.')
        break
      }
      case 'MOVE_BACK': {
        if (current!.pinned) throw await pinnedRefusal(tx, current!, 'move', site.timezone)
        const back = await placeBack(inverse.to!, (slots) => slots.filter((slot) => slot.id !== current!.id))
        await write(current!, { ...laneColumns(back.lane), startAt: back.start, endAt: back.end, minutes: back.minutes.toFixed(3), overloadReason: keptReason, ...bump(current!) })
        break
      }
      case 'PUT_BACK': {
        const back = await placeBack(inverse.to!, (slots) => [...slots])
        const operation = back.operation!
        if (operation.remaining === 0) throw new ScheduleRefusal('OPERATION_DONE', `Op ${operation.seq} ${operation.name} of ${back.workOrder.number} is done: nothing to put back.`)
        if (back.world.slots.some((slot) => slot.workOrderId === back.workOrder.id && slot.workOrderOperationId === operation.id)) throw new ScheduleRefusal('ALREADY_ON_BOARD', `Op ${operation.seq} ${operation.name} of ${back.workOrder.number} has another bar on the board now: move that one.`)
        await tx.scheduleSlot.create({
          data: {
            id: row.slotId!,
            siteId: site.id,
            planVersionId: plan.id,
            planKind: 'WORKING',
            workOrderId: back.workOrder.id,
            workOrderOperationId: operation.id,
            ...laneColumns(back.lane),
            startAt: back.start,
            endAt: back.end,
            pieces: null,
            minutes: back.minutes.toFixed(3),
            overloadReason: keptReason,
            note: null,
            createdAt: now,
            updatedAt: now,
            createdById: context.actorId,
            updatedById: context.actorId,
          },
          select: { id: true },
        })
        break
      }
      case 'UNPIN':
        await write(current!, { pinned: false, pinnedAt: null, pinnedById: null, ...bump(current!) })
        break
      case 'PIN':
        await write(current!, { pinned: true, pinnedAt: now, pinnedById: context.actorId, ...bump(current!) })
        break
    }
    const undoId = newId()
    try {
      await logChanges(tx, site, plan.id, [{ id: undoId, kind: 'UNDO', slotId: row.slotId, workOrderId: row.workOrderId, operationId: row.workOrderOperationId, from: asLogged(inverse.from), to: asLogged(inverse.to), undoesChangeId: row.id, reason: keptReason }], context.actorId, now)
    } catch (error) {
      // One undo per change (the partial unique index): another undo got there first.
      if ((error as { code?: string }).code === 'P2002') throw new ScheduleRefusal('ALREADY_UNDONE', 'This change is already undone.')
      throw error
    }
    tools.audit({
      action: 'planning.schedule.undo',
      recordType: 'ScheduleChange',
      recordId: row.id,
      companyId: site.companyId,
      siteId: site.id,
      before: { kind: row.kind, slotId: row.slotId, place: inverse.from ? { lane: inverse.from.lane, startAt: toUtcIso(new Date(inverse.from.startAt)), endAt: toUtcIso(new Date(inverse.from.endAt)) } : null, pinned: current?.pinned ?? null },
      after: { undoId, action: inverse.action, place: inverse.to ? { lane: inverse.to.lane, startAt: toUtcIso(new Date(inverse.to.startAt)), endAt: toUtcIso(new Date(inverse.to.endAt)) } : null, overloadReason: keptReason },
    })
    tools.emit({
      type: 'planning.schedule_changed',
      subject: plan.id,
      companyId: site.companyId,
      siteId: site.id,
      payload: { siteId: site.id, planVersionId: plan.id, planVersion: plan.version, change: 'UNDONE', slots: 1, slotIds: row.slotId ? [row.slotId] : [], workOrderIds: [row.workOrderId!] },
    })
    return { planVersion: plan.version, undoId, slotId: row.slotId, over }
  })
  return caller.withClient(async (db) => {
    const rows = await db.scheduleChange.findMany({ where: { id: { in: [result.undoId, target.id] } }, select: CHANGE_COLUMNS })
    const [undo, undone] = await entriesOf(db, caller, site, [rows.find((entry) => entry.id === result.undoId)!, rows.find((entry) => entry.id === target.id)!])
    const slot = result.slotId ? await db.scheduleSlot.findUnique({ where: { id: result.slotId }, select: SLOT_COLUMNS }) : null
    const names = slot ? await userNamesOf(db, [slot.updatedById, slot.pinnedById]) : new Map<string, string>()
    return { undo: undo!, undone: undone!, slot: slot && slot.planKind === 'WORKING' ? storedSlotView(slot, names) : null, planVersion: result.planVersion, over: result.over.map((day) => ({ ...day })), replayed }
  })
}
