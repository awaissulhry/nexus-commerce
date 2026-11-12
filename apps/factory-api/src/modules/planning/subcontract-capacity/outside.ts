import { ConflictError, DomainError, ForbiddenError, isDomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { subcontractOrderKitTimed as timedEvent, workOrderOperationOutsourced as outsourcedEvent } from '@nexus/factory-domain/planning-subcontract/events'
import { PLANNING_SUBCONTRACT_OUTSOURCE } from '@nexus/factory-domain/planning/subcontract-capacity/permissions'
import { inHouseProblems, KIT_HOUR, MAX_PARTS, outsideProblems, outsideWorkOf, type Verdict } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import { PURCHASING_SUBCONTRACT_MANAGE } from '@nexus/factory-domain/purchasing/subcontracting/permissions'
import { WORK_ORDER_STATES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { cancelOrder, createOrder, removeOperation } from '../../purchasing/subcontracting/orders'
import { mayAt, officeContextOf, siteFor } from '../access'
import { workingPlanOf } from '../schedule/store'
import { dayOf, type Reader, type SiteRow } from '../store'
import { timingOf } from './kit-timing'
import { readWorkOrderOperations, type WorkOrderOperations } from './store'
import { plannedWorkOrder, verdictNow } from './workshops'

/**
 * An operation in-house or outside (B-W2b-321; PLN-165; design planning.allocation "Card operations chip: switch one
 * operation in-house / outside", header "Create subcontract orders (n)"):
 *
 *   POST /planning/work-orders/:workOrderId/operations/:operationId/outside {version, partyId, order?, pieces?, start?,
 *        expectedBackDate?, locationId?}   one operation to an offered workshop (PLN-162: a held one is refused with its
 *        reasons): with the caller's purchasing.subcontract.manage and a released or running work order, W2a's DRAFT
 *        subcontract order for it (its kit planned, its due-back date and kit time from the kit timing, PLN-164), then the
 *        operation outsourced naming it; else (or `order: false`) the operation outsourced before its order is made
 *   POST /planning/work-orders/:workOrderId/operations/:operationId/in-house {version, reason}   back in: its subcontract
 *        order cancelled (it carries only this operation) or the operation taken off it (a draft with others), never once
 *        the kit or pieces went out; then the operation in-house
 *   POST /planning/allocation/subcontract-orders {siteId, parts[{slotId}], preview?}   "Create subcontract orders (n)": per
 *        workshop part of the allocation board without its order, the outside work's DRAFT order (as above); each part its
 *        own answer
 *
 * planning.subcontract.outsource over the work order's site. Each W2a step is its own command (its own Idempotency-Key:
 * `<key>:order`, `<key>:cancel` …), then one command of this step on the operation: a retry with the same key goes on
 * where it stopped. The verdict and the work order's state are checked before the first write.
 */

type Operation = WorkOrderOperations['operations'][number]

const refusalOf = (verdict: Verdict, workshop: string, what: string): DomainError =>
  new DomainError('conflict', `${workshop} is not offered for ${what}: ${verdict.held.map((reason) => reason.words).join(' ')}`, verdict.held.map((reason): Issue => ({ path: `refusal/${reason.code}`, message: reason.words })))

const sub = (key: string | undefined, part: string): string | undefined => (key ? `${key}:${part}` : undefined)

/** The kit's time on the new order: the timing's, kept between the order date and its due-back date. */
function kitTimeOn(site: SiteRow, planned: Date, orderDate: BusinessDate, backDate: BusinessDate | null): Date {
  let day = businessDate(planned, site.timezone)
  if (day < orderDate) day = orderDate
  if (backDate !== null && day > backDate) day = backDate
  return day === businessDate(planned, site.timezone) ? planned : new Date(businessDayStart(day, site.timezone).getTime() + KIT_HOUR * 60 * 60 * 1000)
}

/** Writes the operations outside (and the order's kit time) in one command; the answer the routes give. */
async function markOutside(tools: CommandTools, site: SiteRow, workOrder: WorkOrderOperations, operations: readonly Operation[], partyId: string, order: { id: string; kitDueAt: Date | null } | null) {
  for (const operation of operations) {
    await tools.tx.workOrderOperation.update({ where: { id: operation.id }, data: { outsourced: true, subcontractOrderId: order?.id ?? null, ...(tools.record?.type === 'WorkOrderOperation' && tools.record.id === operation.id ? {} : { version: { increment: 1 } }) }, select: { id: true } })
    tools.emit(eventFor(outsourcedEvent, { subject: operation.id, companyId: workOrder.companyId, siteId: site.id, payload: { workOrderId: workOrder.id, workOrderOperationId: operation.id, siteId: site.id, outsourced: true, partyId, subcontractOrderId: order?.id ?? null } }))
  }
  if (order?.kitDueAt) {
    const current = await tools.tx.subcontractOrder.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, kitDueAt: true } })
    if (current.status === 'DRAFT' && current.kitDueAt === null) {
      await tools.tx.subcontractOrder.update({ where: { id: order.id }, data: { kitDueAt: order.kitDueAt, ...(tools.record?.type === 'SubcontractOrder' ? {} : { version: { increment: 1 } }) }, select: { id: true } })
      tools.emit(eventFor(timedEvent, { subject: order.id, companyId: workOrder.companyId, siteId: site.id, payload: { subcontractOrderId: order.id, siteId: site.id, kitDueAt: toUtcIso(order.kitDueAt) } }))
    }
  }
  tools.audit({
    action: 'planning.subcontractOperations.outside',
    recordType: 'WorkOrder',
    recordId: workOrder.id,
    companyId: workOrder.companyId,
    siteId: site.id,
    before: { operations: operations.map((operation) => ({ id: operation.id, outsourced: operation.outsourced, subcontractOrderId: operation.subcontractOrderId })) },
    after: { partyId, subcontractOrderId: order?.id ?? null, kitDueAt: order?.kitDueAt ? toUtcIso(order.kitDueAt) : null, operations: operations.map((operation) => operation.id) },
  })
}

export interface OutsideBody {
  readonly version: number
  readonly partyId: string
  readonly order?: boolean | undefined
  readonly pieces?: number | undefined
  readonly start?: BusinessDate | undefined
  readonly expectedBackDate?: BusinessDate | undefined
  readonly locationId?: string | undefined
}

/** Whether the caller can make the order now, and why not in words. */
function orderHeld(caller: CommandCaller, workOrder: WorkOrderOperations): string | null {
  const context = officeContextOf(caller)
  if (!mayAt(context, PURCHASING_SUBCONTRACT_MANAGE, { companyId: workOrder.companyId, siteId: workOrder.siteId })) return 'No subcontract order yet: drafting it needs purchasing.subcontract.manage (the buyer makes it from Purchasing › Subcontracting).'
  if (!(WORK_ORDER_STATES as readonly string[]).includes(workOrder.status)) return `No subcontract order yet: ${workOrder.number} is ${workOrder.status.toLowerCase()}; its order is made once it is released.`
  return null
}

/** Makes the DRAFT subcontract order for operations at a workshop (W2a's create, its kit planned) and its kit time. */
async function draftOrder(caller: CommandCaller, site: SiteRow, workOrder: WorkOrderOperations, operations: readonly Operation[], partyId: string, pieces: number, timing: { kitDueAt: Date; backOn: BusinessDate }, body: Pick<OutsideBody, 'expectedBackDate' | 'locationId'>, key: string | undefined) {
  const back = body.expectedBackDate ?? timing.backOn
  const { order } = await createOrder(caller, { workOrderId: workOrder.id, partyId, locationId: body.locationId, expectedBackDate: back, operations: operations.map((operation) => ({ workOrderOperationId: operation.id, pieces, expectedBackDate: back })), planKit: true }, sub(key, 'order'))
  const row = await caller.withClient((db) => db.subcontractOrder.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, number: true, status: true, version: true, orderDate: true, expectedBackDate: true } }))
  return { id: row.id, number: row.number, status: row.status, version: row.version, kitDueAt: kitTimeOn(site, timing.kitDueAt, dayOf(row.orderDate), row.expectedBackDate ? dayOf(row.expectedBackDate) : null) }
}

/** POST …/operations/:operationId/outside. */
export async function sendOutside(caller: CommandCaller, workOrderId: string, operationId: string, body: OutsideBody, idempotencyKey?: string) {
  const { workOrder, site } = await plannedWorkOrder(caller, workOrderId, PLANNING_SUBCONTRACT_OUTSOURCE)
  const operation = workOrder.operations.find((candidate) => candidate.id === operationId)
  if (!operation) throw new NotFoundError('Operation not found on this work order.')
  const problems = outsideProblems(workOrder, operation)
  if (problems.length > 0) throw new ConflictError(problems[0]!)
  const pieces = body.pieces ?? workOrder.garments
  if (!Number.isSafeInteger(pieces) || pieces < 1 || pieces > workOrder.garments) throw new ValidationError(`From 1 to ${workOrder.garments} garments go out.`, [{ path: 'body/pieces', message: `At most the work order's ${workOrder.garments}.` }])
  const facts = await caller.withClient(async (db) => {
    const { workshop, verdict } = await verdictNow(db, site, workOrder, [operation], body.partyId, pieces)
    const party = await db.party.findUniqueOrThrow({ where: { id: body.partyId }, select: { leadTimeDays: true } })
    const timing = await timingOf(db, site, workOrder, [operation], { id: workshop.id, name: workshop.name, leadTimeDays: party.leadTimeDays }, body.start ?? null, pieces)
    return { workshop, verdict, timing }
  })
  if (!facts.verdict.offered) throw refusalOf(facts.verdict, facts.workshop.name, `Op ${operation.seq} ${operation.name}`)
  const held = body.order === false ? 'No subcontract order yet: it was sent outside without one.' : orderHeld(caller, workOrder)
  if (held && body.order === true) throw (held.includes('purchasing.subcontract.manage') ? new ForbiddenError(held) : new ConflictError(held))
  const order = held ? null : await draftOrder(caller, site, workOrder, [operation], body.partyId, pieces, facts.timing, body, idempotencyKey)
  await command(caller, { name: 'planning.subcontractOperations.outside', idempotencyKey: sub(idempotencyKey, 'outside'), input: { workOrderId, operationId, ...body, orderId: order?.id ?? null }, record: { type: 'WorkOrderOperation', id: operation.id, expectedVersion: body.version } }, async (tools) => {
    await markOutside(tools, site, workOrder, [operation], body.partyId, order)
    return { operationId: operation.id }
  })
  const after = (await caller.withClient((db) => readWorkOrderOperations(db, [workOrder.id]))).get(workOrder.id)!
  const now = after.operations.find((candidate) => candidate.id === operation.id)!
  return {
    operation: { id: now.id, seq: now.seq, name: now.name, version: now.version, outsourced: now.outsourced, subcontractOrderId: now.subcontractOrderId },
    workshop: { id: facts.workshop.id, code: facts.workshop.code, name: facts.workshop.name },
    order: order ? { id: order.id, number: order.number, status: order.status, kitDueAt: toUtcIso(order.kitDueAt) } : null,
    orderWords: held,
    timing: { start: facts.timing.start, kitShipOn: facts.timing.shipOn, kitDueAt: toUtcIso(facts.timing.kitDueAt), late: facts.timing.late, words: facts.timing.words, backOn: facts.timing.backOn },
    warnings: [...facts.verdict.warnings],
  }
}

/** POST …/operations/:operationId/in-house. */
export async function bringInHouse(caller: CommandCaller, workOrderId: string, operationId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { workOrder, site } = await plannedWorkOrder(caller, workOrderId, PLANNING_SUBCONTRACT_OUTSOURCE)
  const operation = workOrder.operations.find((candidate) => candidate.id === operationId)
  if (!operation) throw new NotFoundError('Operation not found on this work order.')
  const order = operation.subcontractOrderId
    ? await caller.withClient(async (db) => {
        const row = await db.subcontractOrder.findUniqueOrThrow({ where: { id: operation.subcontractOrderId! }, select: { id: true, number: true, status: true, version: true, partyId: true, operations: { select: { id: true, workOrderOperationId: true, piecesSent: true } }, kitLines: { where: { status: 'SENT' }, select: { id: true } } } })
        return { ...row, somethingOut: row.kitLines.length > 0 || row.operations.some((entry) => entry.piecesSent > 0) }
      })
    : null
  const problems = inHouseProblems(workOrder, operation, order)
  if (problems.length > 0) throw new ConflictError(problems[0]!)
  let orderChange: 'CANCELLED' | 'OPERATION_REMOVED' | null = null
  if (order && (order.status === 'DRAFT' || order.status === 'ISSUED')) {
    const context = officeContextOf(caller)
    if (!mayAt(context, PURCHASING_SUBCONTRACT_MANAGE, { companyId: workOrder.companyId, siteId: workOrder.siteId })) throw new ForbiddenError(`Bringing it back changes ${order.number}: that needs purchasing.subcontract.manage.`)
    const own = order.operations.filter((entry) => entry.workOrderOperationId === operation.id)
    if (own.length === order.operations.length) {
      await cancelOrder(caller, order.id, { version: order.version, reason: body.reason }, sub(idempotencyKey, 'cancel'))
      orderChange = 'CANCELLED'
    } else {
      if (order.status !== 'DRAFT') throw new ConflictError(`${order.number} is issued with other operations too: reopen it to take this one off.`)
      let version = order.version
      for (const entry of own) {
        const answer = await removeOperation(caller, order.id, entry.id, { version }, sub(idempotencyKey, `remove:${entry.id}`))
        version = (answer.order as unknown as { version: number }).version
      }
      orderChange = 'OPERATION_REMOVED'
    }
  }
  await command(caller, { name: 'planning.subcontractOperations.inHouse', idempotencyKey: sub(idempotencyKey, 'in-house'), input: { workOrderId, operationId, ...body }, record: { type: 'WorkOrderOperation', id: operation.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.workOrderOperation.update({ where: { id: operation.id }, data: { outsourced: false, subcontractOrderId: null }, select: { id: true } })
    tools.audit({ action: 'planning.subcontractOperations.inHouse', recordType: 'WorkOrderOperation', recordId: operation.id, companyId: workOrder.companyId, siteId: site.id, before: { outsourced: true, subcontractOrderId: operation.subcontractOrderId }, after: { outsourced: false, subcontractOrderId: null, orderChange, reason: body.reason } })
    tools.emit(eventFor(outsourcedEvent, { subject: operation.id, companyId: workOrder.companyId, siteId: site.id, payload: { workOrderId: workOrder.id, workOrderOperationId: operation.id, siteId: site.id, outsourced: false, partyId: order?.partyId ?? null, subcontractOrderId: order?.id ?? null } }))
    return { operationId: operation.id }
  })
  const after = (await caller.withClient((db) => readWorkOrderOperations(db, [workOrder.id]))).get(workOrder.id)!
  const now = after.operations.find((candidate) => candidate.id === operation.id)!
  return { operation: { id: now.id, seq: now.seq, name: now.name, version: now.version, outsourced: now.outsourced, subcontractOrderId: now.subcontractOrderId }, order: order ? { id: order.id, number: order.number, change: orderChange } : null }
}

// ---- Create subcontract orders (n) -------------------------------------------------------------------------------------------

interface PartFacts {
  readonly slotId: string
  readonly workOrder: WorkOrderOperations
  readonly partyId: string
  readonly operations: Operation[]
  readonly pieces: number
}

async function partFacts(db: Reader, site: SiteRow, slotIds: readonly string[]): Promise<Map<string, PartFacts | string>> {
  const out = new Map<string, PartFacts | string>()
  const plan = await workingPlanOf(db, site.id)
  const slots = plan ? await db.scheduleSlot.findMany({ where: { planVersionId: plan.id, id: { in: slotIds.filter(isUuid) } }, select: { id: true, workOrderId: true, workOrderOperationId: true, partyId: true, pieces: true } }) : []
  const workOrders = await readWorkOrderOperations(db, [...new Set(slots.map((slot) => slot.workOrderId))])
  for (const slotId of slotIds) {
    const slot = slots.find((candidate) => candidate.id === slotId)
    if (!slot || slot.partyId === null || slot.workOrderOperationId !== null) {
      out.set(slotId, 'Not a part of a work order at a workshop on this site’s board.')
      continue
    }
    const workOrder = workOrders.get(slot.workOrderId)!
    const ordered = await db.subcontractOperation.groupBy({ by: ['workOrderOperationId'], where: { workOrderId: workOrder.id, subcontractOrder: { status: { notIn: ['CANCELLED'] }, partyId: slot.partyId } }, _sum: { pieces: true } })
    const done = Math.max(0, ...ordered.map((row) => row._sum.pieces ?? 0))
    const pieces = Math.max(0, (slot.pieces ?? workOrder.garments) - done)
    const operations = outsideWorkOf(workOrder.operations).filter((operation) => !operation.outsourced || operation.subcontractOrderId === null)
    if (pieces === 0) out.set(slotId, `${workOrder.number}'s garments at this workshop are on a subcontract order already.`)
    else if (operations.length === 0) out.set(slotId, `${workOrder.number} has no work left to send out.`)
    else out.set(slotId, { slotId, workOrder, partyId: slot.partyId, operations, pieces })
  }
  return out
}

/** POST /planning/allocation/subcontract-orders. */
export async function createFromAllocation(caller: CommandCaller, body: { readonly siteId: string; readonly parts: readonly { readonly slotId: string }[]; readonly preview?: boolean | undefined }, idempotencyKey?: string) {
  const site = await siteFor(caller, body.siteId, PLANNING_SUBCONTRACT_OUTSOURCE)
  const preview = body.preview === true
  const slotIds = [...new Set(body.parts.map((part) => part.slotId))].slice(0, MAX_PARTS)
  const facts = await caller.withClient((db) => partFacts(db, site, slotIds))
  const results = []
  for (const slotId of slotIds) {
    const part = facts.get(slotId)!
    if (typeof part === 'string') {
      results.push({ slotId, ok: false, workOrder: null, workshop: null, operations: [], pieces: 0, order: null, kitShipOn: null, backOn: null, problems: [part], warnings: [] })
      continue
    }
    const base = { slotId, workOrder: { id: part.workOrder.id, number: part.workOrder.number }, operations: part.operations.map((operation) => ({ id: operation.id, seq: operation.seq, name: operation.name })), pieces: part.pieces }
    try {
      const checked = await caller.withClient(async (db) => {
        const { workshop, verdict } = await verdictNow(db, site, part.workOrder, part.operations, part.partyId, part.pieces)
        const party = await db.party.findUniqueOrThrow({ where: { id: part.partyId }, select: { leadTimeDays: true } })
        const timing = await timingOf(db, site, part.workOrder, part.operations, { id: workshop.id, name: workshop.name, leadTimeDays: party.leadTimeDays }, null, part.pieces)
        return { workshop, verdict, timing }
      })
      const workshop = { id: checked.workshop.id, code: checked.workshop.code, name: checked.workshop.name }
      const problems = checked.verdict.held.map((reason) => reason.words)
      const held = orderHeld(caller, part.workOrder)
      if (held) problems.push(held)
      if (preview || problems.length > 0) {
        results.push({ ...base, ok: problems.length === 0, workshop, order: null, kitShipOn: checked.timing.shipOn, backOn: checked.timing.backOn, problems, warnings: [...checked.verdict.warnings] })
        continue
      }
      const order = await draftOrder(caller, site, part.workOrder, part.operations, part.partyId, part.pieces, checked.timing, {}, sub(idempotencyKey, slotId))
      await command(caller, { name: 'planning.subcontractOperations.fromAllocation', idempotencyKey: sub(idempotencyKey, `${slotId}:outside`), input: { slotId, orderId: order.id }, record: { type: 'SubcontractOrder', id: order.id, expectedVersion: order.version } }, async (tools) => {
        await markOutside(tools, site, part.workOrder, part.operations, part.partyId, order)
        return { orderId: order.id }
      })
      results.push({ ...base, ok: true, workshop, order: { id: order.id, number: order.number, status: order.status, kitDueAt: toUtcIso(order.kitDueAt) }, kitShipOn: checked.timing.shipOn, backOn: checked.timing.backOn, problems: [], warnings: [...checked.verdict.warnings] })
    } catch (error) {
      if (!isDomainError(error)) throw error
      results.push({ ...base, ok: false, workshop: null, order: null, kitShipOn: null, backOn: null, problems: [error.message, ...(error.issues ?? []).map((issue) => issue.message).filter((message) => message !== error.message)], warnings: [] })
    }
  }
  return { preview, made: preview ? 0 : results.filter((result) => result.ok).length, held: results.filter((result) => !result.ok).length, asOf: toUtcIso(serverClock.now()), results }
}
