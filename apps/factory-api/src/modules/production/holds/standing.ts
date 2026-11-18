import type { StandingHold } from '@nexus/factory-domain/production/holds/rules'
import { plainHoldWordsOf } from '@nexus/factory-domain/production-brand/accept' // B-PR-27a
import { workOrderHoldReason } from '@nexus/factory-domain/quality/holds/rules'
import type { CommandTx } from '../../../core/command'
import { reasonWords } from '../../../platform/reasons/service'

/**
 * B-PR-21: every hold still standing on a work order — its ACTIVE quality holds (subject the work order itself) and its ACTIVE
 * plain holds (WorkOrderHold, PRODUCTION or BRAND) — with the words the work order shows while held under each
 * (WorkOrder.holdReason, which the floor reads): a quality hold its reason and its note (as quality places it), a plain hold
 * its reason only (the office's note is never the floor's, the customer's words never the floor's either). Read by quality's
 * release and close (modules/quality/holds liftWorkOrders) and the production lift (./holds.ts), each after the work order's
 * row lock (`lockWorkOrderRow`), so a hold placed or lifted at the same time finishes first and is seen.
 */
export async function standingHoldsOf(tx: CommandTx, workOrderId: string): Promise<StandingHold[]> {
  const quality = await tx.qualityHold.findMany({
    where: { status: 'ACTIVE', subjectType: 'WorkOrder', subjectIds: { has: workOrderId } },
    select: { id: true, reasonCode: true, reasonNote: true, placedAt: true },
    orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
  })
  const plain = await tx.workOrderHold.findMany({
    where: { workOrderId, status: 'ACTIVE' },
    select: { id: true, kind: true /* B-PR-27a */, reasonCode: true, placedAt: true },
    orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
  })
  const qualityWords = quality.length > 0 ? await reasonWords(tx, 'HOLD') : new Map()
  const plainWords = plain.length > 0 ? await reasonWords(tx, 'PRODUCTION_HOLD') : new Map()
  return [
    ...quality.map((hold) => ({ recordType: 'QualityHold' as const, id: hold.id, reason: workOrderHoldReason(qualityWords.get(hold.reasonCode)?.labelEn ?? hold.reasonCode, hold.reasonNote), placedAt: hold.placedAt })),
    // B-PR-27a: a customer's pause in its own words (plainHoldWordsOf).
    ...plain.map((hold) => ({ recordType: 'WorkOrderHold' as const, id: hold.id, reason: plainHoldReason(plainHoldWordsOf(hold, plainWords.get(hold.reasonCode)?.labelEn)), placedAt: hold.placedAt })),
  ]
}

/** The words a work order shows while held under a plain hold: the reason's words only (never the office's note). */
export const plainHoldReason = (reasonWords: string): string => workOrderHoldReason(reasonWords, null)

/** The work order's row, locked FOR UPDATE inside the command (its holds' changes queue behind each other here). */
export async function lockWorkOrderRow(tx: CommandTx, workOrderId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "WorkOrder" WHERE "id" = ${workOrderId}::uuid FOR UPDATE`
}
