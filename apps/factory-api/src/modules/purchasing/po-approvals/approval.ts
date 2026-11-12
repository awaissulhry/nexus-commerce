import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { orderApprovalOf, withdrawProblem } from '@nexus/factory-domain/purchasing/po-approvals/approvals'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { withdrawPending } from '../../../platform/approvals/engine'
import { peopleNames } from '../../../platform/approvals/store'
import { detailInCommand, onOrder } from '../orders'
import { officeContextOf, officeOrder, type Reader } from '../store'
import type { OrderDetail } from '../views'
import { approvedCurrent, approverOf, wouldAsk } from './gate'

/**
 * A purchase order's approval on its record (B-W2b-305; SCM-078, SCM-080): how it stands with its newest request, and
 * what its Send would do now; taking a waiting request back to change the order.
 *
 *   GET  /purchasing/orders/:purchaseOrderId/approval                    purchasing.view
 *   POST /purchasing/orders/:purchaseOrderId/approval/withdraw {version, note?}   purchasing.send
 *
 * The request's own page is Home › Approvals (its id); its history is GET /approvals/history/PurchaseOrder/:id.
 */

const PO = 'PURCHASE_ORDER'

/** The order's approval: its newest request (by whom, for whom, decided how), and what a Send would do now. */
export async function approvalOf(db: Reader, order: { readonly id: string; readonly number: string; readonly status: string; readonly version: number }, askerId: string, now: Date) {
  const own = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, select: { approvalTaskId: true } })
  const task = await db.approvalTask.findFirst({
    where: { kind: PO, recordType: 'PurchaseOrder', recordId: order.id },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, requestedAt: true, requestedById: true, approverRoleId: true, approverUserId: true, dueAt: true, decidedAt: true, decidedById: true, comment: true, rejectReasonCode: true, rejectReason: true, signatureMeaning: true },
  })
  const names = await peopleNames(db, [task?.requestedById, task?.decidedById])
  const person = (id: string | null | undefined) => (id ? { id, name: names.get(id) ?? '' } : null)
  const standing = orderApprovalOf({ status: order.status as PurchaseOrderStatus, approvalTaskId: own.approvalTaskId }, task)
  const ask = order.status === 'DRAFT' ? await wouldAsk(db, order.id, askerId, now) : null
  return {
    orderId: order.id,
    number: order.number,
    status: order.status as PurchaseOrderStatus,
    version: order.version,
    state: standing.state,
    words: standing.words,
    task: task
      ? {
          id: task.id,
          status: task.status,
          requestedAt: toUtcIso(task.requestedAt),
          requestedBy: person(task.requestedById),
          approver: await approverOf(db, task),
          dueAt: task.dueAt ? toUtcIso(task.dueAt) : null,
          decidedAt: task.decidedAt ? toUtcIso(task.decidedAt) : null,
          decidedBy: person(task.decidedById),
          comment: task.comment,
          rejectReasonCode: task.rejectReasonCode,
          rejectReason: task.rejectReason,
          signatureMeaning: task.signatureMeaning,
        }
      : null,
    /** A draft: an approved request covers it as it is now (Send sends it without asking again). */
    approvedAsItIs: order.status === 'DRAFT' ? (await approvedCurrent(db, order.id)) !== null : false,
    /** A draft: the rule its Send would ask now, and who would approve (namesYou: every rule that holds names the reader). */
    wouldAsk: ask,
  }
}

export type ApprovalView = Awaited<ReturnType<typeof approvalOf>>

/** GET /purchasing/orders/:purchaseOrderId/approval (purchasing.view). */
export async function getApproval(caller: CommandCaller, orderId: string): Promise<{ approval: ApprovalView }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (client) => ({ approval: await approvalOf(client, order, context.actorId, serverClock.now()) }))
}

/**
 * POST /purchasing/orders/:purchaseOrderId/approval/withdraw (purchasing.send over the order: whoever may send it may take
 * its request back to change it): a waiting request is withdrawn (the engine's; the order is a draft again by its kind's
 * hook); an approved order whose send was held is a draft again (its yes stays in the history: a Send without a change
 * still sends it). ONE command on the order (its version guards it).
 */
export async function withdrawApproval(caller: CommandCaller, orderId: string, body: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ order: OrderDetail }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  const note = body.note?.trim() ? body.note.trim() : null
  return onOrder(caller, order, { name: 'purchasing.withdrawApproval', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const problem = withdrawProblem(current.status as PurchaseOrderStatus)
    if (problem) throw new InvalidStateError(problem)
    const withdrawn = await withdrawPending(tools, { kind: PO, recordId: current.id, byId: context.actorId, words: note })
    if (withdrawn === 0) {
      await tools.tx.purchaseOrder.update({ where: { id: current.id }, data: { status: 'DRAFT' }, select: { id: true } })
      tools.audit({ action: 'purchasing.backToDraft', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: 'PENDING_APPROVAL' }, after: { status: 'DRAFT', note } })
      tools.emit({ type: 'purchase_order.updated', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, fields: ['status'] } })
    }
    return detailInCommand(tools, current.id)
  })
}
