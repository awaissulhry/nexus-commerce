import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { MAX_TEXT, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import { counterProblem } from '@nexus/factory-domain/purchasing/revisions/revisions'
import type { CommandCaller } from '../../../core/command'
import { detailInCommand, onOrder } from '../orders'
import { startRevisionInCommand } from '../revisions/change'
import { officeContextOf, officeOrder } from '../store'
import type { OrderDetail } from '../views'

/**
 * The buyer's counter-proposal (B-W2a-52, the W1 leftover "revision 2"; design purchasing.orders pop "review-changes":
 * "Accept all · accept per line · counter-propose (creates revision 2 to send)"; Owner answer P2: the buyer decides).
 * purchasing.send, ONE command on the order with the version the buyer read: the supplier's proposal is REFUSED (who,
 * when, the buyer's note for the office) and the order goes back to DRAFT as its next revision in the same move
 * (CHANGES_PROPOSED → DRAFT, allowed only with the decision REFUSED by the …_supply_w2a_guards trigger), the proposal
 * kept with the change (../revisions/change.ts startRevisionInCommand: the state with every line's proposal), the
 * links stopped, the lines' proposals cleared. The buyer then sets the quantities and dates the company can take (W1's
 * line routes) and sends the new revision: the supplier confirms it again.
 */

export interface CounterBody {
  readonly version: number
  /** Why the buyer refuses the proposal, for the office (the supplier reads the new revision's mail). */
  readonly note?: string | null | undefined
}

/** POST /purchasing/orders/:purchaseOrderId/proposal/counter (purchasing.send). */
export async function counterPropose(caller: CommandCaller, orderId: string, body: CounterBody, idempotencyKey?: string): Promise<{ order: OrderDetail; revision: number }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  const note = body.note?.trim() ? body.note.trim() : null
  if (note !== null && note.length > MAX_TEXT.reason) throw new ValidationError('The note is too long.', [{ path: 'body/note', message: `At most ${MAX_TEXT.reason} characters.` }])
  return onOrder(caller, order, { name: 'purchasing.counterPropose', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const problem = counterProblem(current.status as PurchaseOrderStatus)
    if (problem) throw new InvalidStateError(problem)
    const started = await startRevisionInCommand(tools, current, { actorId: context.actorId, counter: { note } })
    tools.audit({
      action: 'purchasing.counterPropose',
      recordType: 'PurchaseOrder',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      ...(note ? { reason: note } : {}),
      before: { status: 'CHANGES_PROPOSED', revision: current.revision },
      after: { status: 'DRAFT', decision: 'REFUSED', revision: started.revision, revokedLinkIds: started.revokedLinkIds, ...started.kept },
    })
    tools.emit({
      type: 'purchase_order.revision_started',
      subject: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      payload: { purchaseOrderId: current.id, number: current.number, revision: started.revision, from: 'CHANGES_PROPOSED', counterProposal: true, revokedLinkIds: started.revokedLinkIds },
    })
    return { ...(await detailInCommand(tools, current.id)), revision: started.revision }
  })
}
