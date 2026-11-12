import type { OrderSpecificInput } from '@nexus/factory-domain/planning/explode'
import { plannedForAlone } from '@nexus/factory-domain/planning/actions/pegs'
import type { Prisma } from '@nexus/factory-db'
import type { Reader } from '../store'

/** The order lines of stored sources (only what the peg reads; no import of ../views: inputs reads this). */
const sourceLinesOf = (value: Prisma.JsonValue): { orderLineId: string; orderNumber: string; lineSeq: number }[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).orderLineId === 'string' ? [{ orderLineId: (entry as Record<string, string>).orderLineId!, orderNumber: '', lineSeq: 0 }] : []))
    : []

/**
 * What a run (and every live read of the plan) reads of the site's order-specific supply (B-W2b-306; PLN-072), in the
 * caller's client:
 *
 *   pegs          the hard pegs of the site's latest DONE run (its lines kept for one order line: orderSpecific with the
 *                 line), carried into the next plan as the firm lines are
 *   bought for    the purchase order lines bought from a line planned for one order line alone (ORDERED, orderSpecific,
 *                 every source that order line), of any run of the site: they serve only that order line's need
 */
export async function readOrderPegs(db: Reader, siteId: string, latestRunId: string | null): Promise<OrderSpecificInput> {
  const pegged = latestRunId === null ? [] : await db.materialRequirement.findMany({ where: { runId: latestRunId, orderSpecific: true, reservedForLineId: { not: null } }, select: { itemId: true, itemColourId: true, reservedForLineId: true }, orderBy: { seq: 'asc' } })
  const ordered = await db.materialRequirement.findMany({
    where: { siteId, orderSpecific: true, decision: 'ORDERED', purchaseOrderLineId: { not: null }, reservedForLineId: { not: null } },
    select: { purchaseOrderLineId: true, reservedForLineId: true, orderSpecific: true, sources: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const purchaseFor = new Map<string, string>()
  for (const row of ordered) {
    if (plannedForAlone({ orderSpecific: row.orderSpecific, reservedForLineId: row.reservedForLineId, sources: sourceLinesOf(row.sources) })) purchaseFor.set(row.purchaseOrderLineId!, row.reservedForLineId!)
  }
  return { pegs: pegged.map((row) => ({ itemId: row.itemId, itemColourId: row.itemColourId, orderLineId: row.reservedForLineId! })), purchaseFor }
}
