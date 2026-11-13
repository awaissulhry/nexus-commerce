import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { eventFor } from '@nexus/factory-domain/events/define'
import { workOrderOperationOutsourced as outsourcedEvent } from '@nexus/factory-domain/planning-subcontract/events'
import type { CommandCaller } from '../../../core/command'
import { SITE_COLUMNS } from '../../planning/store'
import { readWorkOrderOperations } from '../../planning/subcontract-capacity/store'
import { verdictNow } from '../../planning/subcontract-capacity/workshops'
import { createOrder, type CreateHook, type CreateInput } from '../subcontracting/orders'

/**
 * A subcontract order made by hand (B-W2b-365; follow-up of B-W2b-321 and B-W2b-338; design purchasing.subcontracting "New
 * subcontract order": "Workshop (qualified only), work order, operations, return date"): POST
 * /purchasing/subcontracting/orders is W2a's create (../subcontracting/orders `createOrder`, every check of B-W2a-25) with:
 *
 *   qualified   the workshop must be approved for the work sent, as planning offers it (B-W2b-321's verdict,
 *               planning/subcontract-capacity `verdictNow`): a qualification of the company covering each operation's kind
 *               of work or library operation (B-W2b-315), and a valid DURC when its supplier kinds name it a subcontractor.
 *               Held otherwise: 409 with each reason (`refusal/NOT_QUALIFIED`, `refusal/NO_VALID_DURC`). The verdict's other
 *               holds (no subcontractor role, not active, no location) are W2a's own checks, answered first in its words;
 *               its warnings (conditions, capacity) do not hold the order.
 *   outsourced  in the create's command, each operation sent goes outside naming the new order (WorkOrderOperation
 *               outsourced, subcontractOrderId; `work_order_operation.outsourced`), as planning's switch does (B-W2b-321):
 *               in-house capacity stops counting it and the board works it at the workshop. An operation outside already on
 *               another live order keeps that order (its pieces are split across them).
 *
 * The plan's own paths (planning/subcontract-capacity outside.ts, planned-orders/convert.ts) call W2a's create directly.
 */

const QUALIFICATION_HOLDS = ['NOT_QUALIFIED', 'NO_VALID_DURC'] as const
const LIVE_ORDER = (status: string) => status !== 'CANCELLED' && status !== 'CLOSED'

const handMade: CreateHook = {
  async check(db, { workOrder, partyId, operationIds }) {
    const facts = (await readWorkOrderOperations(db, [workOrder.id])).get(workOrder.id)
    const operations = (facts?.operations ?? []).filter((operation) => operationIds.includes(operation.id))
    if (!facts || operations.length === 0) return
    const site = await db.site.findUniqueOrThrow({ where: { id: workOrder.siteId }, select: SITE_COLUMNS })
    const { workshop, verdict } = await verdictNow(db, site, facts, operations, partyId, facts.garments)
    const held = verdict.held.filter((reason) => (QUALIFICATION_HOLDS as readonly string[]).includes(reason.code))
    if (held.length === 0) return
    const what = operations.map((operation) => `Op ${operation.seq} ${operation.name}`).join(', ')
    throw new DomainError('conflict', `${workshop.name} is not approved for ${what}: ${held.map((reason) => reason.words).join(' ')}`, held.map((reason): Issue => ({ path: `refusal/${reason.code}`, message: reason.words })))
  },
  async inCommand(tools, { orderId, workOrder, partyId, operationIds }) {
    const rows = await tools.tx.workOrderOperation.findMany({ where: { id: { in: [...operationIds] }, workOrderId: workOrder.id }, select: { id: true, outsourced: true, subcontractOrderId: true, subcontractOrder: { select: { status: true } } } })
    const moved = rows.filter((row) => !(row.outsourced && row.subcontractOrder && LIVE_ORDER(row.subcontractOrder.status)))
    for (const row of moved) {
      await tools.tx.workOrderOperation.update({ where: { id: row.id }, data: { outsourced: true, subcontractOrderId: orderId, version: { increment: 1 } }, select: { id: true } })
      tools.emit(eventFor(outsourcedEvent, { subject: row.id, companyId: workOrder.companyId, siteId: workOrder.siteId, payload: { workOrderId: workOrder.id, workOrderOperationId: row.id, siteId: workOrder.siteId, outsourced: true, partyId, subcontractOrderId: orderId } }))
    }
    if (moved.length === 0) return
    tools.audit({
      action: 'purchasing.subcontract.outsource',
      recordType: 'WorkOrder',
      recordId: workOrder.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      before: { operations: moved.map((row) => ({ id: row.id, outsourced: row.outsourced, subcontractOrderId: row.subcontractOrderId })) },
      after: { partyId, subcontractOrderId: orderId, operations: moved.map((row) => row.id) },
    })
  },
}

/** POST /purchasing/subcontracting/orders: W2a's create, for a qualified workshop, its operations outsourced. */
export function createOutsourcedOrder(caller: CommandCaller, input: CreateInput, idempotencyKey?: string) {
  return createOrder(caller, input, idempotencyKey, handMade)
}
