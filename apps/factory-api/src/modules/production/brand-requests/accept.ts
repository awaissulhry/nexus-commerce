import { DomainError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { actorOf } from '../../../core/context'
import {
  CUSTOMER_PAUSE_REASON,
  isProductionAccept,
  pauseDoneWords,
  pausePlan,
  resumeReasonOf,
  SALES_ACCEPT_WORDS,
  type AcceptWorkOrder,
} from '@nexus/factory-domain/production-brand/accept'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { answerProblems, type OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
import type { Words } from '@nexus/factory-domain/portal/tasks/kinds'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { answerableIn } from '../../sales/change-requests/counter'
import type { OfficeRequestRow } from '../../sales/change-requests/store'
import { lockOrder } from '../../sales/orders/store'
import { GOODS_LINE_KINDS } from '../brand/facts'
import { liftWorkOrderHoldInCommand, placeWorkOrderHoldsInCommand } from '../holds/holds'
import { officeContextOf } from '../work-orders/access'
import { assertAnswers, viewAfter } from './answer'
import { brandRequestWhere, readableRequest } from './read'

/**
 * B-PR-27a — accepting a customer's production ask does the work (production plan §3 "Brand asks, we decide", "Who answers /
 * sets", "Legacy mixed work order: accept is held ('answer by hand')"; 08-backend §4.2 "Accept does"; lead pick L4; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."; rules factory-domain production-brand/accept):
 *
 *   POST /production/brand-requests/:requestId/accept {version, answer?}
 *     who     the request read through the brand wall (./read: orders.view or workorders.view over its company AND customer, else
 *             "Change request not found."), then the kind's permission over the order (HOLD, RESUME production.brand.manage),
 *             else 403 in words; a Sales kind (change, cancel, ship what is ready) → 409 `request/SALES_ASK`
 *     what    an OPEN request, or a COUNTERED one the customer said yes to (sales/change-requests/counter answerableIn: it is
 *             carried out with the counter), at the version read; ONE command — the request (FOR UPDATE), the order's row (FOR
 *             UPDATE), then the work orders by id (production/holds: each one's issue lock, gate lock, row) —
 *             HOLD    a BRAND hold (the customer's pause, its HOLD ask named; the reason CUSTOMER_PAUSE, never the office's
 *                     note) on each open work order of the order (placeWorkOrderHoldsInCommand); held in words, nothing written,
 *                     when the office answers it by hand (409 `request/<NO_WORK|MIXED|SHARED>`)
 *             RESUME  the order's ACTIVE BRAND holds lifted (liftWorkOrderHoldInCommand: a work order still held by another hold
 *                     stays held under it)
 *             then the request ACCEPTED with our words, audit rows on the request and the order, order_change_request.answered
 *             (ACCEPTED); production/holds emits work_order_hold.placed | lifted and workorder.status_changed
 *     wall    the work orders are those of the order's own goods lines only: a mixed one (another customer's pieces too) is never
 *             held, and nothing here reads or writes another customer's row; the answer names the order's own work orders only
 */

/** One work order of the order, as the accept writes it back. */
export interface AcceptedWorkOrder {
  readonly id: string
  readonly number: string
  readonly status: WorkOrderStatus
  /** HOLD: it went ON_HOLD now (false: on hold already, the pause stands beside the other hold). RESUME: it left ON_HOLD now. */
  readonly changed: boolean
}

export interface AcceptDone {
  readonly kind: OrderRequestKind
  /** HOLD: the work orders paused now. */
  readonly paused: readonly AcceptedWorkOrder[]
  /** RESUME: the work orders whose pause was lifted now. */
  readonly resumed: readonly AcceptedWorkOrder[]
  /** What was done, in the office's words. */
  readonly words: Words
}

export interface AcceptBody {
  readonly version: number
  /** Our words to the customer (optional on an accept). */
  readonly answer?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** The order's work orders (cells of its goods lines; never a repair), in id order, with what the accept needs of each. */
async function orderWorkOrders(tools: CommandTools, orderId: string): Promise<AcceptWorkOrder[]> {
  const { tx } = tools
  const lines = await tx.salesOrderLine.findMany({ where: { orderId }, select: { id: true, kind: true } })
  const own = new Set(lines.filter((line) => (GOODS_LINE_KINDS as readonly string[]).includes(line.kind)).map((line) => line.id))
  if (own.size === 0) return []
  const cells = await tx.workOrderSize.findMany({ where: { salesOrderLineId: { in: [...own] }, workOrder: { kind: { not: 'REPAIR' } } }, select: { workOrderId: true } })
  const ids = [...new Set(cells.map((cell) => cell.workOrderId))].sort()
  if (ids.length === 0) return []
  const rows = await tx.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, status: true, partyId: true } })
  // Every cell of those work orders: one of another order's line (or of no order) makes the work order shared.
  const all = await tx.workOrderSize.findMany({ where: { workOrderId: { in: ids } }, select: { workOrderId: true, salesOrderLineId: true } })
  const shared = new Set(all.filter((cell) => cell.salesOrderLineId === null || !own.has(cell.salesOrderLineId)).map((cell) => cell.workOrderId))
  const paused = new Set((await tx.workOrderHold.findMany({ where: { workOrderId: { in: ids }, kind: 'BRAND', status: 'ACTIVE' }, select: { workOrderId: true } })).map((hold) => hold.workOrderId))
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    return row ? [{ id, number: row.number, status: row.status as WorkOrderStatus, partyId: row.partyId, otherOrders: shared.has(id), paused: paused.has(id) }] : []
  })
}

/** HOLD: a BRAND hold on each open work order of the order (or the reason it is answered by hand, nothing written). */
async function pauseInCommand(tools: CommandTools, row: OfficeRequestRow): Promise<AcceptDone> {
  const plan = pausePlan(await orderWorkOrders(tools, row.orderId))
  if (!plan.ok) throw new DomainError('invalid_state', plan.words.en, [{ path: `request/${plan.code}`, message: plan.words.en }])
  const placed = plan.hold.length === 0 ? [] : await placeWorkOrderHoldsInCommand(tools, { workOrderIds: plan.hold, kind: 'BRAND', reasonCode: CUSTOMER_PAUSE_REASON.code, requestId: row.id })
  const paused = placed.map((entry) => ({ id: entry.workOrder.id, number: entry.workOrder.number, status: entry.workOrder.status, changed: entry.held }))
  return { kind: 'HOLD', paused, resumed: [], words: pauseDoneWords('HOLD', paused.map((entry) => entry.number)) }
}

/** RESUME: every ACTIVE BRAND hold of the order's HOLD asks lifted, work order by work order in id order. */
async function resumeInCommand(tools: CommandTools, row: OfficeRequestRow): Promise<AcceptDone> {
  const { tx } = tools
  const pauses = await tx.orderChangeRequest.findMany({ where: { orderId: row.orderId, kind: 'HOLD' }, select: { id: true } })
  const holds = pauses.length === 0 ? [] : await tx.workOrderHold.findMany({ where: { requestId: { in: pauses.map((pause) => pause.id) }, kind: 'BRAND', status: 'ACTIVE' }, select: { id: true, workOrderId: true } })
  const order = await tx.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true } })
  const reason = resumeReasonOf(order?.number ?? '')
  const resumed: AcceptedWorkOrder[] = []
  for (const hold of [...holds].sort((a, b) => (a.workOrderId < b.workOrderId ? -1 : a.workOrderId > b.workOrderId ? 1 : a.id < b.id ? -1 : 1))) {
    const lifted = await liftWorkOrderHoldInCommand(tools, { workOrderId: hold.workOrderId, holdId: hold.id, reason })
    const workOrder = (await tx.workOrder.findUnique({ where: { id: hold.workOrderId }, select: { number: true, status: true } }))!
    resumed.push({ id: hold.workOrderId, number: workOrder.number, status: workOrder.status as WorkOrderStatus, changed: lifted.lifted })
  }
  return { kind: 'RESUME', paused: [], resumed, words: pauseDoneWords('RESUME', resumed.map((entry) => entry.number)) }
}

/** POST /production/brand-requests/:requestId/accept — accepting a production ask carries it out (ONE command). */
export async function acceptBrandRequest(caller: CommandCaller, requestId: string, body: AcceptBody, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!brandRequestWhere(actor)) throw new ForbiddenError()
  const found = await caller.withClient((client) => readableRequest(client, actor, requestId))
  const kind = found.kind as OrderRequestKind
  if (!isProductionAccept(kind)) throw new DomainError('invalid_state', SALES_ACCEPT_WORDS.en, [{ path: 'request/SALES_ASK', message: SALES_ACCEPT_WORDS.en }])
  assertAnswers(actor, found)
  const problems = answerProblems('ACCEPTED', body.answer)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const answer = blank(body.answer)
  const { result } = await runCommand(
    caller,
    { name: 'production.acceptCustomerRequest', idempotencyKey, input: { requestId, ...body } },
    async (tools) => {
      const { tx, now } = tools
      // The request first (FOR UPDATE: the customer's withdrawal and another answer wait), then the order's row, then its work.
      const { row } = await answerableIn(tools, requestId, body.version, 'ACCEPTED')
      await lockOrder(tx, row.orderId)
      let done: AcceptDone
      switch (kind) {
        case 'HOLD':
          done = await pauseInCommand(tools, row)
          break
        case 'RESUME':
          done = await resumeInCommand(tools, row)
          break
        default:
          throw new DomainError('invalid_state', SALES_ACCEPT_WORDS.en, [{ path: 'request/SALES_ASK', message: SALES_ACCEPT_WORDS.en }])
      }
      await tx.orderChangeRequest.update({ where: { id: requestId }, data: { status: 'ACCEPTED', answer, answeredAt: now, answeredById: context.actorId, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      const workOrders = { paused: done.paused.map((entry) => entry.id), resumed: done.resumed.map((entry) => entry.id) }
      tools.audit({ action: 'production.acceptCustomerRequest', recordType: 'OrderChangeRequest', recordId: requestId, companyId: row.companyId, before: { status: row.status }, after: { status: 'ACCEPTED', answer, kind, ...workOrders, ...(row.status === 'COUNTERED' ? { withCounter: row.counterApprovalId } : {}) } })
      tools.audit({ action: 'orders.changeRequestAccepted', recordType: 'SalesOrder', recordId: row.orderId, companyId: row.companyId, after: { requestId, kind, amendmentId: null, orderCancelled: false, ...workOrders } })
      tools.emit({ type: 'order_change_request.answered', subject: requestId, companyId: row.companyId, payload: { requestId, orderId: row.orderId, partyId: row.partyId, kind, answer: 'ACCEPTED', amendmentId: null, orderCancelled: false } })
      return done
    },
    { ...COMMAND_SETTINGS, clock },
  )
  return { request: await viewAfter(caller, requestId), done: result }
}
