import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import { changeProblem, MAX_CHANGE_NOTE } from '@nexus/factory-domain/purchasing/revisions/revisions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { revokeConfirmLinks } from '../confirm-links'
import { detailInCommand, onOrder } from '../orders'
import { lockOrderReceiving, receiptStopsCancel } from '../receiving'
import { officeContextOf, officeOrder, type OrderRow } from '../store'
import type { OrderDetail } from '../views'
import { keptForAudit, pricesOf, readState, stateOf } from './state'

/**
 * Change: the next revision of a sent purchase order (B-W2a-52; SCM-058; design purchasing.orders record › Lines "Sent:
 * read-only; 'Change' starts revision 2 with a banner 'Revision 2 draft — the supplier sees it after you send it'").
 * purchasing.send over the order's company, site and supplier (the supplier's order changes). ONE command on the order
 * (its version: a send, a cancel, a receipt or the supplier's answer that committed meanwhile makes it a 409):
 *
 *   1. SENT, DECLINED or CONFIRMED only (factory-domain changeProblem); under the receiving lock, refused while a receipt
 *      names the order (goods came: cancel a line or close it short instead);
 *   2. the order as it stands, with the supplier's answer, kept in the audit row (what the next revision is compared with);
 *   3. its live confirm links stop working (the supplier answers the new revision on a new link);
 *   4. the order DRAFT as its next revision: no send time, no confirm-by, a confirmed one without its confirmation (the
 *      …_supply_w2a_guards trigger allows exactly that), then each open line without the old revision's confirmation
 *      and proposal (allowed while the order is DRAFT);
 *   5. purchase_order.revision_started.
 *
 * The buyer then edits the draft (header and lines, W1's routes; a line an earlier revision sent may also be cancelled)
 * and sends it: the send writes the revision row and the supplier confirms again (../send.ts).
 *
 * A counter-proposal (CHANGES_PROPOSED, the supplier's proposal refused) goes the same way: ../confirm/counter.ts.
 */

export interface ChangeBody {
  readonly version: number
  /** Why, for the office (the change note to the supplier is given at the send). */
  readonly note?: string | null | undefined
}

/** Inside a command on the order: steps 2–4 for the order as it is now; returns what the audit and the event say. */
export async function startRevisionInCommand(
  tools: CommandTools,
  current: OrderRow,
  input: { readonly actorId: string; readonly counter: { readonly note: string | null } | null },
): Promise<{ revision: number; from: PurchaseOrderStatus; revokedLinkIds: string[]; kept: ReturnType<typeof keptForAudit> }> {
  const { tx, now } = tools
  const from = current.status as PurchaseOrderStatus
  const { order, lines } = await readState(tx, current.id)
  const kept = keptForAudit(stateOf(order, lines), pricesOf(order, lines))
  const revokedLinkIds = await revokeConfirmLinks(tools, current, input.actorId)
  const revision = current.revision + 1
  await tx.purchaseOrder.update({
    where: { id: current.id },
    data: {
      status: 'DRAFT',
      revision,
      sentAt: null,
      sentById: null,
      confirmBy: null,
      ...(from === 'CONFIRMED' ? { confirmedAt: null, confirmedVia: null, confirmLinkId: null, confirmedByName: null, supplierRef: null, confirmNote: null } : {}),
      ...(input.counter ? { proposalDecision: 'REFUSED' as const, proposalDecidedAt: now, proposalDecidedById: input.actorId, proposalDecisionNote: input.counter.note } : {}),
    },
    select: { id: true },
  })
  await tx.purchaseOrderLine.updateMany({
    where: { purchaseOrderId: current.id, cancelledAt: null, closedShortAt: null },
    data: { confirmedQuantity: null, confirmedDate: null, proposedQuantity: null, proposedDate: null, proposedSplitQuantity: null, proposedSplitDate: null, proposalReason: null, version: { increment: 1 } },
  })
  return { revision, from, revokedLinkIds, kept }
}

/** POST /purchasing/orders/:purchaseOrderId/change (purchasing.send): the next revision as a draft. */
export async function changeOrder(caller: CommandCaller, orderId: string, body: ChangeBody, idempotencyKey?: string): Promise<{ order: OrderDetail; revision: number; revokedLinkIds: string[] }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  const note = body.note?.trim() ? body.note.trim() : null
  if (note !== null && note.length > MAX_CHANGE_NOTE) throw new ValidationError('The note is too long.', [{ path: 'body/note', message: `At most ${MAX_CHANGE_NOTE} characters.` }])
  return onOrder(caller, order, { name: 'purchasing.change', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const problem = changeProblem(current.status as PurchaseOrderStatus)
    if (problem) throw new InvalidStateError(problem)
    // After the version bump: the lock a goods receipt takes (a floor receipt cannot move the order's state).
    await lockOrderReceiving(tools.tx, context.tenantId, current.id)
    if (await receiptStopsCancel(tools.tx, current.id)) throw new InvalidStateError('Goods were received against this order: it is not changed any more. Cancel a line, or close it short.')
    const started = await startRevisionInCommand(tools, current, { actorId: context.actorId, counter: null })
    tools.audit({
      action: 'purchasing.change',
      recordType: 'PurchaseOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      ...(note ? { reason: note } : {}),
      before: { status: started.from, revision: current.revision },
      after: { status: 'DRAFT', revision: started.revision, revokedLinkIds: started.revokedLinkIds, ...started.kept },
    })
    tools.emit({
      type: 'purchase_order.revision_started',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { purchaseOrderId: current.id, number: current.number, revision: started.revision, from: started.from, counterProposal: false, revokedLinkIds: started.revokedLinkIds },
    })
    return { ...(await detailInCommand(tools, current.id)), revision: started.revision, revokedLinkIds: started.revokedLinkIds }
  })
}
