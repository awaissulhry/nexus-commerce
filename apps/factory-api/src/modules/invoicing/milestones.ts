import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import type { CommandCaller } from '../../core/command'
import { createDepositDraft } from './drafts'
import { assertMay, officeContextOf, type InvoiceDetail } from './store'

/**
 * Invoicing a step of an order's payment schedule (B-W2a-54; FIN-058 "Partial invoicing per shipment or milestone";
 * B-W2a-30 SalesOrderMilestone): a step paid before the goods leave makes the sale happen for the amount paid (DPR
 * 633/1972 art. 6 c.4), so its invoice is an advance — a deposit invoice (TD02) — deducted on the goods' invoice later
 * (B-W1-51). The database ties a TD02 to the deposit request it invoices and deducts only TD02s, so a step is invoiced
 * here through its deposit request: the order's DEPOSIT step (drafts.ts createDepositDraft: what is paid and not yet
 * invoiced; its line names the step). The other steps are refused in words: BEFORE_SHIPPING has no deposit request (a
 * schema and payment-schedule need, named in the step's notes), ON_DELIVERY and ON_INVOICE fall due with the invoice of
 * the shipped goods, whose instalments follow the order's payment terms (terms.ts).
 */
export async function createFromMilestone(caller: CommandCaller, body: { milestoneId: string }, idempotencyKey?: string): Promise<{ invoice: InvoiceDetail }> {
  const context = officeContextOf(caller)
  const step = isUuid(body.milestoneId)
    ? await caller.withClient((client) =>
        client.salesOrderMilestone.findUnique({ where: { id: body.milestoneId }, select: { kind: true, status: true, companyId: true, partyId: true, depositRequestId: true, order: { select: { number: true } } } }),
      )
    : null
  assertMay(context, INVOICES_VIEW, INVOICES_MANAGE, step ? { companyId: step.companyId, partyId: step.partyId } : null, 'Payment schedule step')
  const order = step!.order.number
  if (step!.status === 'WAIVED' || step!.status === 'CANCELLED') throw new InvalidStateError(`This step of order ${order} is ${step!.status.toLowerCase()}: there is nothing to invoice.`)
  if (step!.kind === 'BEFORE_SHIPPING' || (step!.kind === 'DEPOSIT' && !step!.depositRequestId)) {
    throw new InvalidStateError(
      `A step paid before the goods leave is invoiced as an advance (a deposit invoice, TD02: DPR 633/1972 art. 6 c.4), and a deposit invoice names the deposit request it invoices: this step of order ${order} has none (only the order's deposit has one today). Its payment is placed on the goods' invoice.`,
    )
  }
  if (step!.kind !== 'DEPOSIT') {
    throw new InvalidStateError(`This step of order ${order} falls due with the invoice of the shipped goods: invoice them from their DDTs; the invoice's due dates follow the order's payment terms.`)
  }
  return createDepositDraft(caller, { depositRequestId: step!.depositRequestId! }, idempotencyKey)
}
