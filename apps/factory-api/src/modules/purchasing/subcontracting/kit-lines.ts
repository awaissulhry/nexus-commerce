import { kitNote, kitPlan, type KitPlan } from '@nexus/factory-domain/product/bom-lines/rules'
import type { Reader } from '../store'

/**
 * The subcontracting BOM (B-W2b-228; PRD-108; "terzisti get kits from the BOM"): which of a work order's planned materials
 * a subcontract order's kit takes. The work order's revision marks the lines that go to a workshop (BomLine
 * `issueToSubcontract`, set by modules/product/bom-lines); a marked line tied to a routing step (`routingSeq`) goes only with
 * an order that sends that step; a revision that marks no line keeps W2a's kit (every planned material). The quantities stay
 * the work order's planned ones (WorkOrderMaterial, one level: a sub-assembly goes whole, as the component we make) for the
 * cells sent; leather tracked by the hide still goes cut, as bundles (./orders.ts `kitPlanOf`). Called by ./orders.ts
 * (create with `planKit`, and "Plan from the work order").
 */

export interface KitLines extends KitPlan {
  /** The note each planned kit line carries: where it came from. */
  readonly note: string
}

/** The kit's BOM lines for the work order's operations sent (by WorkOrderOperation id). */
export async function kitLinesOf(db: Reader, workOrderId: string, workOrderOperationIds: readonly string[]): Promise<KitLines> {
  const workOrder = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { styleRevisionId: true } })
  const lines = workOrder?.styleRevisionId ? await db.bomLine.findMany({ where: { revisionId: workOrder.styleRevisionId }, select: { id: true, seq: true, issueToSubcontract: true, routingSeq: true }, orderBy: { seq: 'asc' } }) : []
  const ids = [...new Set(workOrderOperationIds)]
  const operations = ids.length === 0 ? [] : await db.workOrderOperation.findMany({ where: { id: { in: ids }, workOrderId }, select: { routingSeq: true } })
  const plan = kitPlan(lines, new Set(operations.flatMap((operation) => (operation.routingSeq === null ? [] : [operation.routingSeq]))))
  return { ...plan, note: kitNote(plan.from) }
}
