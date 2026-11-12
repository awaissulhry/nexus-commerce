import { newestOf, workHeldByEstimate, type EstimateStatus } from '@nexus/factory-domain/sales/repairs-depth/rules'
import type { Reader, RepairRow } from '../repairs/store'

/**
 * The stage rule for W2a's POST /sales/repairs/:id/stage (B-W2b-291's gap: the database does not refuse it): approved and
 * in repair wait for the customer's answer to the newest estimate, and a declined one refuses them. Read inside the
 * stage command, after the repair's row lock (the estimate's writes take the same lock when they move the stage).
 */
export async function estimateHoldInCommand(tx: Reader, repair: Pick<RepairRow, 'id' | 'number'>, to: string): Promise<string | null> {
  if (to !== 'APPROVED' && to !== 'IN_REPAIR') return null
  const rows = await tx.repairEstimate.findMany({ where: { repairId: repair.id }, select: { revision: true, status: true } })
  const newest = newestOf(rows.map((row) => ({ revision: row.revision, status: row.status as EstimateStatus })))
  return workHeldByEstimate(repair.number, to, newest)
}
