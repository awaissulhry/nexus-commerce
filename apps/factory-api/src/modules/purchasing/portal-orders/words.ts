import { proposedLineOf } from '@nexus/factory-domain/purchasing/confirm/proposal'
import { portalAnswerSummary, portalCountsOf, portalLineOfStored, portalLineText, type PortalAnsweredLine } from '@nexus/factory-domain/purchasing/portal-orders/answer'
import { dayOf, quantityText, type Reader } from '../store'

/**
 * A supplier's stored proposal in words, for the buyer (B-W2b-174; the worker's note on the order's thread, ../confirm/
 * handler.ts): the summary ("1 line as asked · 1 substitute") and every line that waits for the buyer's yes, a substitute
 * named by our item's code and name or the supplier's words. Read by an office or system caller (Item is not the partner's).
 * A proposal made through W1's link reads exactly as before (no substitute, no change in words).
 */
export async function proposalWordsOf(db: Reader, orderId: string): Promise<{ summary: string; lines: string[] }> {
  const rows = await db.purchaseOrderLine.findMany({
    where: { purchaseOrderId: orderId, cancelledAt: null, closedShortAt: null },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      quantity: true,
      uom: true,
      needDate: true,
      proposedQuantity: true,
      proposedDate: true,
      proposedSplitQuantity: true,
      proposedSplitDate: true,
      proposalReason: true,
      proposedSubstituteItemId: true,
      proposedSubstituteNote: true,
      proposalNeedsBuyer: true,
    },
  })
  const lines: PortalAnsweredLine[] = rows.flatMap((row) => {
    const read = proposedLineOf({
      id: row.id,
      seq: row.seq,
      quantity: quantityText(row.quantity),
      uom: row.uom,
      needDate: dayOf(row.needDate)!,
      proposedQuantity: row.proposedQuantity === null ? null : quantityText(row.proposedQuantity),
      proposedDate: dayOf(row.proposedDate),
      proposedSplitQuantity: row.proposedSplitQuantity === null ? null : quantityText(row.proposedSplitQuantity),
      proposedSplitDate: dayOf(row.proposedSplitDate),
      proposalReason: row.proposalReason,
    })
    return read ? [portalLineOfStored(read, row)] : []
  })
  const itemIds = [...new Set(lines.flatMap((line) => (line.substitute?.itemId ? [line.substitute.itemId] : [])))]
  const items = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true } })).map((item) => [item.id, `${item.code} ${item.name}`]))
  return {
    summary: portalAnswerSummary(portalCountsOf(lines)),
    lines: lines.filter((line) => line.needsBuyer).map((line) => portalLineText(line, line.substitute?.itemId ? (items.get(line.substitute.itemId) ?? null) : null)),
  }
}

/** The commands that answer in the portal (./answer.ts): the worker tells the buyer "in the portal" for their events. */
export const PORTAL_ANSWER_COMMANDS: readonly string[] = Object.freeze(['purchasing.portalConfirm', 'purchasing.portalDecline'])
