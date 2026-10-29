import type { AnswerPlan } from '@nexus/factory-domain/purchasing/confirm/answer'
import { proposalColumnsOf } from '@nexus/factory-domain/purchasing/confirm/proposal'
import type { CommandTools } from '../../../core/command'
import type { LinkUse } from '../../../platform/links/use'
import { dayValue } from '../store'

/**
 * A supplier's answer with changes (other quantities or dates, a split, a line it cannot deliver) is a PROPOSAL: the buyer
 * decides (Owner question P2, answer A; B-W1-31). THE one place it is written, inside the link's answer command, in the
 * link's own scope (the …_supply_guards and …_supply_proposal_guards triggers hold it for a partner session):
 *
 *   1. every line's proposal (factory-domain purchasing/confirm/proposal proposalColumnsOf), written while the order is
 *      still SENT; NOT its confirmation: a late date or a short quantity reaches the plan and the receipts only when the
 *      buyer accepts it (the plan keeps the need date, the receipt the ordered quantity until then);
 *   2. the order SENT → CHANGES_PROPOSED with the proposal's time, the link, the typed name, the supplier's reference and
 *      note (the trigger clears the buyer's last decision);
 *   3. the audit row of the whole answer, and purchase_order.changes_proposed (the worker tells the buyer).
 */
export interface ProposalInput {
  readonly order: { readonly id: string; readonly number: string; readonly partyId: string; readonly companyId: string; readonly siteId: string }
  readonly plan: AnswerPlan
  readonly use: LinkUse
  readonly linkId: string
}

const dateOrNull = (value: string | null): Date | null => (value === null ? null : dayValue(value))

export async function recordProposal(tools: CommandTools, input: ProposalInput): Promise<void> {
  const { tx, now } = tools
  const { order, plan, use, linkId } = input
  for (const line of plan.lines) {
    const columns = proposalColumnsOf(line)
    await tx.purchaseOrderLine.updateMany({
      where: { id: line.lineId, purchaseOrderId: order.id },
      data: {
        proposedQuantity: columns.proposedQuantity,
        proposedDate: dateOrNull(columns.proposedDate),
        proposedSplitQuantity: columns.proposedSplitQuantity,
        proposedSplitDate: dateOrNull(columns.proposedSplitDate),
        proposalReason: columns.proposalReason,
        version: { increment: 1 },
      },
    })
  }
  await tx.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'CHANGES_PROPOSED', proposedAt: now, proposalLinkId: linkId, proposedByName: use.typedName, proposalSupplierRef: plan.supplierRef, proposalNote: plan.note },
    select: { id: true },
  })
  const changed = plan.lines.filter((line) => line.kind !== 'AS_ASKED').length
  tools.audit({
    action: 'purchasing.proposeByLink',
    recordType: 'PurchaseOrder',
    recordId: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    before: { status: 'SENT' },
    after: {
      status: 'CHANGES_PROPOSED',
      linkId,
      evidenceId: use.evidenceId,
      typedName: use.typedName,
      supplierRef: plan.supplierRef,
      note: plan.note,
      summary: plan.summary,
      lines: plan.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, kind: line.kind, quantity: line.quantity, date: line.date, deliveries: line.deliveries.map((part) => ({ ...part })), reason: line.reason, changes: [...line.changes] })),
    },
  })
  tools.emit({
    type: 'purchase_order.changes_proposed',
    subject: order.id,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: { purchaseOrderId: order.id, number: order.number, partyId: order.partyId, linkId, lines: plan.lines.length, changed },
  })
}
