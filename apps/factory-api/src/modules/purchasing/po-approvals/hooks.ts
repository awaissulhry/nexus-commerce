import { PO_APPROVAL_WORDS } from '@nexus/factory-domain/purchasing/po-approvals/approvals'
import type { CommandTools } from '../../../core/command'
import type { Reader, TaskRef } from '../../../platform/approvals/kinds/kind'

/**
 * What a purchase order does with the decision on its request (B-W2b-305; SCM-078, SCM-080), called by the PURCHASE_ORDER
 * kind (platform/approvals/kinds/purchase-order.ts) inside the decision's command — the approver's, or the module's own
 * withdrawal — and only for the order that waits for THIS request (PENDING_APPROVAL naming it; a draft asked from the
 * generic route stays as it is):
 *
 *   the yes       nothing on the order changes here (it stays frozen while it waits): purchase_order.approved, and the
 *                 worker sends it right after as the person who asked (./approved-send.ts), with the words of its send
 *   a no, taken back, or changed (STALE)
 *                 the order is a draft again (PENDING_APPROVAL → DRAFT, its revision unchanged; approvalTaskId stays until
 *                 the next ask replaces it): it can be changed, and its next Send asks again
 *
 * The order's version moves with it, so a write that read the waiting order is refused as stale (unless the command is
 * the order's own: its version guard moved it already).
 */

/** The value (minor units) of the revision sent before this one, from its revision row; null when there is none. */
export async function previousSentValue(db: Reader, orderId: string, revision: number): Promise<number | null> {
  const row = await db.purchaseOrderRevision.findFirst({ where: { purchaseOrderId: orderId, revision: revision - 1 }, select: { afterPrices: true } })
  const net = (row?.afterPrices as { netAmount?: unknown } | null | undefined)?.netAmount
  return typeof net === 'number' && Number.isSafeInteger(net) ? net : null
}

async function waitingOrder(tools: CommandTools, task: TaskRef) {
  const order = await tools.tx.purchaseOrder.findUnique({ where: { id: task.recordId }, select: { id: true, number: true, status: true, approvalTaskId: true, companyId: true, siteId: true } })
  return order && order.status === 'PENDING_APPROVAL' && order.approvalTaskId === task.id ? order : null
}

/** The yes: the order goes to its supplier right after (purchase_order.approved → the worker's send). */
export async function afterApproved(tools: CommandTools, task: TaskRef): Promise<void> {
  const order = await waitingOrder(tools, task)
  if (!order) return
  tools.audit({ action: 'purchasing.approved', recordType: 'PurchaseOrder', recordId: order.id, companyId: order.companyId, siteId: order.siteId, after: { status: 'PENDING_APPROVAL', approvalTaskId: task.id, approvedById: task.decidedById, next: 'SEND' } })
  tools.emit({ type: 'purchase_order.approved', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, taskId: task.id } })
}

/** A no, a withdrawal or a change: the order is a draft again. */
export async function backToDraft(tools: CommandTools, task: TaskRef, outcome: 'REJECTED' | 'WITHDRAWN' | 'STALE'): Promise<void> {
  const order = await waitingOrder(tools, task)
  if (!order) return
  const guarded = tools.record?.type === 'PurchaseOrder' && tools.record.id === order.id
  await tools.tx.purchaseOrder.update({ where: { id: order.id }, data: { status: 'DRAFT', ...(guarded ? {} : { version: { increment: 1 } }) }, select: { id: true } })
  tools.audit({
    action: 'purchasing.approvalEnded',
    recordType: 'PurchaseOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { status: 'PENDING_APPROVAL', approvalTaskId: task.id },
    after: { status: 'DRAFT', approvalTaskId: task.id, outcome, words: PO_APPROVAL_WORDS.backToDraft[outcome] },
  })
  tools.emit({ type: 'purchase_order.approval_ended', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, taskId: task.id, outcome } })
}
