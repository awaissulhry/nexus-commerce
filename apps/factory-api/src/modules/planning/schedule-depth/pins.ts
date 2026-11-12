import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PLANNING_SCHEDULE_PIN } from '@nexus/factory-domain/planning/schedule-depth/permissions'
import { ScheduleRefusal } from '@nexus/factory-domain/planning/schedule/refusals'
import { laneOfSlot } from '@nexus/factory-domain/planning/schedule/slots'
import { whenWords } from '@nexus/factory-domain/planning/schedule/time'
import { command, type CommandCaller } from '../../../core/command'
import { assertMayAt, officeContextOf } from '../access'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import { storedSlotView } from '../schedule/publish'
import { lockedSlot, lockedWorkingPlan, SLOT_COLUMNS, userNamesOf, type SlotRow } from '../schedule/store'
import type { PinSlotBody, PinWorkOrderBody } from './contract'
import { emitDepthChange, logChanges } from './log'

/**
 * Pinned operations (B-W2b-312; PLN-139 "lock an order or operation in place so automatic scheduling never moves it";
 * design planning.board "Right-click / ⋯ on a bar: Pin (W2b)", "P pins", the Legend's pins). A pinned slot keeps its lane
 * and times until it is unpinned: a move or a removal of it is refused in words (B-W2a-34's routes ask `pinnedRefusal`), the
 * allocation board leaves it where it is, and forward scheduling and the backlog reschedule go around it. The database
 * holds the same rule for every login (…_planning_depth_w2b_guards `ScheduleSlot_w2b5_pin`).
 *
 *   one slot      POST /planning/schedule/slots/:slotId/pin {version, pinned}: at the version the board read ("Moved by …")
 *   a work order  POST /planning/schedule/work-orders/:workOrderId/pin {pinned}: every slot of it on the working plan (an
 *                 order pinned in place), the ones already so left as they are
 *
 * ONE command each under the site's schedule lock (B-W2a-34's store: the advisory lock, the working plan's version bump):
 * the slots' version +1, `pinned`, `pinnedAt`, `pinnedById`; a ScheduleChange PIN or UNPIN per slot (B-W2b-286's log); an
 * audit row; planning.schedule_changed PINNED or UNPINNED. planning.schedule.pin (the planner and the production manager).
 */

async function slotTarget(caller: CommandCaller, slotId: string) {
  const context = officeContextOf(caller)
  const slot = await caller.withClient((db) => (isUuid(slotId) ? db.scheduleSlot.findUnique({ where: { id: slotId }, select: { id: true, siteId: true, planKind: true, workOrder: { select: { id: true, number: true, companyId: true, site: { select: SITE_COLUMNS } } } } }) : Promise.resolve(null)))
  assertMayAt(context, PLANNING_VIEW, slot ? { companyId: slot.workOrder.companyId, siteId: slot.siteId } : null, 'Slot')
  assertMayAt(context, PLANNING_SCHEDULE_PIN, { companyId: slot!.workOrder.companyId, siteId: slot!.siteId }, 'Slot')
  return { slotId: slot!.id, workOrder: slot!.workOrder, site: slot!.workOrder.site, companyId: slot!.workOrder.companyId }
}

/** "Op 30 Pack of SEED-WO-0001" / "SEED-WO-0001's part on L1". */
async function slotWords(db: Reader, slot: Pick<SlotRow, 'workOrderId' | 'workOrderOperationId' | 'lineId' | 'workCentreId' | 'partyId'>): Promise<string> {
  const workOrder = await db.workOrder.findUnique({ where: { id: slot.workOrderId }, select: { number: true } })
  if (slot.workOrderOperationId) {
    const operation = await db.workOrderOperation.findUnique({ where: { id: slot.workOrderOperationId }, select: { seq: true, name: true } })
    return `Op ${operation?.seq ?? '?'} ${operation?.name ?? ''} of ${workOrder?.number ?? 'the work order'}`
  }
  return `${workOrder?.number ?? 'The work order'}'s part of the order`
}

/**
 * The refusal of a move or removal of a pinned slot (PLN-139), in words: who pinned it and when. B-W2a-34's move, removal
 * and allocation ask it before the database's own refusal would answer a 500.
 */
export async function pinnedRefusal(db: Reader, slot: SlotRow, doing: 'move' | 'remove', timeZone: string): Promise<ScheduleRefusal> {
  const names = await userNamesOf(db, [slot.pinnedById])
  const by = slot.pinnedById ? names.get(slot.pinnedById) : undefined
  const when = slot.pinnedAt ? ` at ${whenWords(slot.pinnedAt.getTime(), timeZone)}` : ''
  const what = await slotWords(db, slot)
  const action = doing === 'move' ? 'unpin it to move it' : 'unpin it to send it back to the tray'
  return new ScheduleRefusal('PINNED', `${what} is pinned${by ? ` by ${by}` : ''}${when}: it stays on its lane and times; ${action}.`, [
    { path: 'pinnedAt', message: slot.pinnedAt ? toUtcIso(slot.pinnedAt) : '' },
  ])
}

const pinData = (pinned: boolean, slot: Pick<SlotRow, 'version'>, actorId: string, now: Date) => ({
  pinned,
  pinnedAt: pinned ? now : null,
  pinnedById: pinned ? actorId : null,
  version: slot.version + 1,
  updatedAt: now,
  updatedById: actorId,
})

async function answerOf(db: Reader, slotIds: readonly string[]) {
  const slots = await db.scheduleSlot.findMany({ where: { id: { in: [...slotIds] } }, select: SLOT_COLUMNS, orderBy: [{ startAt: 'asc' }, { id: 'asc' }] })
  const names = await userNamesOf(db, slots.flatMap((slot) => [slot.updatedById, slot.pinnedById]))
  return slots.map((slot) => storedSlotView(slot, names))
}

/** POST /planning/schedule/slots/:slotId/pin: pin a slot where it is, or unpin it. */
export async function pinSlot(caller: CommandCaller, slotId: string, body: PinSlotBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await slotTarget(caller, slotId)
  const { result, replayed } = await command(caller, { name: body.pinned ? 'planning.schedule.pin' : 'planning.schedule.unpin', idempotencyKey, input: { slotId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, target.site, context.tenantId, { actorId: context.actorId, now, bump: true })
    const current = await lockedSlot(tx, slotId, body.version, target.site.timezone)
    if (current.pinned === body.pinned) {
      const what = await slotWords(tx, current)
      throw new ScheduleRefusal(body.pinned ? 'ALREADY_PINNED' : 'NOT_PINNED', body.pinned ? `${what} is already pinned.` : `${what} is not pinned.`)
    }
    const { count } = await tx.scheduleSlot.updateMany({ where: { id: current.id, version: current.version }, data: pinData(body.pinned, current, context.actorId, now) })
    if (count !== 1) throw new ScheduleRefusal('SLOT_MOVED', 'The slot moved meanwhile: reload the board.')
    await logChanges(tx, target.site, plan.id, [{ kind: body.pinned ? 'PIN' : 'UNPIN', slotId: current.id, workOrderId: current.workOrderId, operationId: current.workOrderOperationId }], context.actorId, now)
    tools.audit({
      action: body.pinned ? 'planning.schedule.pin' : 'planning.schedule.unpin',
      recordType: 'ScheduleSlot',
      recordId: current.id,
      companyId: target.companyId,
      siteId: target.site.id,
      before: { pinned: current.pinned, pinnedAt: current.pinnedAt ? toUtcIso(current.pinnedAt) : null },
      after: { pinned: body.pinned, pinnedAt: body.pinned ? toUtcIso(now) : null, lane: laneOfSlot(current), startAt: toUtcIso(current.startAt), endAt: toUtcIso(current.endAt) },
    })
    emitDepthChange(tools, target.site, plan, body.pinned ? 'PINNED' : 'UNPINNED', [current.id], [current.workOrderId])
    return { planVersion: plan.version }
  })
  const [slot] = await caller.withClient((db) => answerOf(db, [target.slotId]))
  return { slot: slot!, planVersion: result.planVersion, replayed }
}

async function workOrderTarget(caller: CommandCaller, workOrderId: string): Promise<{ id: string; number: string; companyId: string; site: SiteRow }> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => (isUuid(workOrderId) ? db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, site: { select: SITE_COLUMNS } } }) : Promise.resolve(null)))
  assertMayAt(context, PLANNING_VIEW, row ? { companyId: row.companyId, siteId: row.siteId } : null, 'Work order')
  assertMayAt(context, PLANNING_SCHEDULE_PIN, { companyId: row!.companyId, siteId: row!.siteId }, 'Work order')
  return row!
}

/** POST /planning/schedule/work-orders/:workOrderId/pin: every slot of the work order on the working plan pinned (or unpinned). */
export async function pinWorkOrder(caller: CommandCaller, workOrderId: string, body: PinWorkOrderBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await workOrderTarget(caller, workOrderId)
  const { result, replayed } = await command(caller, { name: body.pinned ? 'planning.schedule.pinWorkOrder' : 'planning.schedule.unpinWorkOrder', idempotencyKey, input: { workOrderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, target.site, context.tenantId, { actorId: context.actorId, now, expectedVersion: body.planVersion, bump: true })
    const slots = await tx.scheduleSlot.findMany({ where: { planVersionId: plan.id, workOrderId: target.id }, select: SLOT_COLUMNS, orderBy: [{ startAt: 'asc' }, { id: 'asc' }] })
    if (slots.length === 0) throw new ScheduleRefusal('NOTHING_TO_PIN', `${target.number} has nothing on the board to ${body.pinned ? 'pin' : 'unpin'}.`)
    const change = slots.filter((slot) => slot.pinned !== body.pinned)
    if (change.length === 0) throw new ScheduleRefusal('NOTHING_TO_PIN', body.pinned ? `Every slot of ${target.number} is already pinned.` : `No slot of ${target.number} is pinned.`)
    for (const slot of change) {
      const { count } = await tx.scheduleSlot.updateMany({ where: { id: slot.id, version: slot.version }, data: pinData(body.pinned, slot, context.actorId, now) })
      if (count !== 1) throw new ScheduleRefusal('SLOT_MOVED', 'A slot of the work order moved meanwhile: reload the board.')
    }
    await logChanges(tx, target.site, plan.id, change.map((slot) => ({ kind: body.pinned ? ('PIN' as const) : ('UNPIN' as const), slotId: slot.id, workOrderId: slot.workOrderId, operationId: slot.workOrderOperationId })), context.actorId, now)
    tools.audit({
      action: body.pinned ? 'planning.schedule.pinWorkOrder' : 'planning.schedule.unpinWorkOrder',
      recordType: 'WorkOrder',
      recordId: target.id,
      companyId: target.companyId,
      siteId: target.site.id,
      before: { pinned: change.map((slot) => ({ slotId: slot.id, pinned: slot.pinned })) },
      after: { pinned: body.pinned, slots: change.map((slot) => slot.id), kept: slots.length - change.length },
    })
    emitDepthChange(tools, target.site, plan, body.pinned ? 'PINNED' : 'UNPINNED', change.map((slot) => slot.id), [target.id])
    return { planVersion: plan.version, slotIds: slots.map((slot) => slot.id), changed: change.length }
  })
  const slots = await caller.withClient((db) => answerOf(db, result.slotIds))
  return { workOrderId: target.id, pinned: body.pinned, changed: result.changed, slots, planVersion: result.planVersion, replayed }
}
