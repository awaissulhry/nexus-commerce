import { workOrderPlanOf, type PlanOrder, type PlanWorkOrder, type WorkOrderPlanRow } from '@nexus/factory-domain/order-apply/plan'
import { CHANGE_WORDS, extraOf, type PlannedChange, type WorkCell } from '@nexus/factory-domain/order-apply/rules'
import { actorOf, type OfficeContext } from '../../../core/context'
import { gapOf, raisesOf, storedGapLines, workCellsOf, type GapLine } from '../../production/work-order-changes/propose'
import { cellsOf, CHANGE_COLUMNS, WORK_ORDER_COLUMNS } from '../../production/work-order-changes/read'
import type { Reader } from './store'

/**
 * B-OP-013 (order page plan N2; 13-backend §1.3; review R-4): what an office change of the order will do to its work orders, read
 * BEFORE it is applied — the amendment's, the priced change's, the close of lines' and the cancel's previews, and a customer
 * request's apply plan. Two reads, both nothing written:
 *
 *   plannedChangesOf   the WorkOrderChanges the change would propose, read as the command reads them (production/work-order-changes
 *                      proposeGapsInCommand): the lines it touches as they will be, the order's waiting changes that name one of
 *                      them (they would go STALE: their lines are read again with them, their raises carried), against the work
 *                      orders' cells as they are (what is cut: the database's floor)
 *   workOrderPlanFor   those changes as plan rows for this reader (factory-domain order-apply workOrderPlanOf, the command's own
 *                      follow rule): cells from → to with what is cut, whether each follows in the same click or waits and why,
 *                      the reprint mark — a work order the reader does not reach with workorders.view named by nothing
 */

/** The lines of the waiting changes that name a touched line, grown until none is left (as proposeGapsInCommand reads them). */
async function replacedOf(db: Reader, orderId: string, lineIds: readonly string[]) {
  const waiting = await db.workOrderChange.findMany({ where: { salesOrderId: orderId, status: 'PROPOSED' }, select: CHANGE_COLUMNS })
  const touched = new Set(lineIds)
  const replaced: typeof waiting = []
  for (let grew = true; grew; ) {
    grew = false
    for (const row of waiting) {
      if (replaced.includes(row) || !cellsOf(row).some((cell) => touched.has(cell.salesOrderLineId))) continue
      replaced.push(row)
      for (const cell of cellsOf(row)) {
        if (touched.has(cell.salesOrderLineId)) continue
        touched.add(cell.salesOrderLineId)
        grew = true
      }
    }
  }
  return { touched, replaced }
}

/**
 * The changes a change of `lines` (as they will be after it) would propose to the order's work orders, and the cells read (their
 * cut); `before`: the touched lines' sizes before the change (a raise is what the change added; none: it raises nothing).
 */
export async function plannedChangesOf(
  db: Reader,
  tenantId: string,
  order: { readonly id: string; readonly status: string },
  lines: readonly GapLine[],
  before: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map(),
): Promise<{ changes: PlannedChange[]; cells: WorkCell[] }> {
  if (lines.length === 0) return { changes: [], cells: [] }
  const { touched, replaced } = await replacedOf(db, order.id, lines.map((line) => line.id))
  const own = new Set(lines.map((line) => line.id))
  const others = [...touched].filter((lineId) => !own.has(lineId))
  const all = [...lines, ...(others.length > 0 ? await storedGapLines(db, order, others) : [])]
  const cells = await workCellsOf(db, tenantId, [...touched])
  return { changes: gapOf(all, cells, raisesOf(before, all, replaced.map((row) => ({ kind: row.kind, cells: cellsOf(row) })))), cells }
}

/** The plan rows of `changes` for the reader: their work orders and every cell of each read once; `cells` give what is cut. */
export async function workOrderPlanFor(db: Reader, context: OfficeContext, order: PlanOrder, changes: readonly PlannedChange[], cells?: readonly WorkCell[]): Promise<WorkOrderPlanRow[]> {
  if (changes.length === 0) return []
  const ids = [...new Set(changes.flatMap((change) => (change.workOrderId ? [change.workOrderId] : [])))]
  const rows = ids.length > 0 ? await db.workOrder.findMany({ where: { id: { in: ids } }, select: WORK_ORDER_COLUMNS }) : []
  const every = ids.length > 0 ? await db.workOrderSize.findMany({ where: { workOrderId: { in: ids } }, select: { id: true, workOrderId: true } }) : []
  const workOrders = new Map<string, PlanWorkOrder>(rows.map((row) => [row.id, { ...row, cellIds: every.filter((cell) => cell.workOrderId === row.id).map((cell) => cell.id) }]))
  const read = cells ?? (await workCellsOf(db, context.tenantId, [...new Set(changes.flatMap((change) => change.cells.map((cell) => cell.salesOrderLineId)))]))
  return workOrderPlanOf(changes, workOrders, actorOf(context), order, new Map(read.map((cell) => [cell.cellId, cell.cut])))
}

/**
 * The work orders' part of a preview (the answer's `workOrders`): the extra pieces the changes leave with their words, whether the
 * change stays held until their outcome is chosen (`requireOutcome`: an amendment, a priced change; a close or a cancel leaves them
 * to production when none is chosen), and the plan rows.
 */
export async function workOrderPreviewOf(db: Reader, context: OfficeContext, order: PlanOrder, planned: { readonly changes: readonly PlannedChange[]; readonly cells: readonly WorkCell[] }, options: { readonly requireOutcome: boolean; readonly outcomeChosen: boolean }) {
  const extra = extraOf(planned.changes)
  const pieces = extra.reduce((sum, entry) => sum + entry.count, 0)
  return {
    extra: extra.map((entry) => ({ ...entry, words: CHANGE_WORDS.extra(entry.count, entry.size) })),
    needsOutcome: options.requireOutcome && pieces > 0 && !options.outcomeChosen,
    words: pieces > 0 ? CHANGE_WORDS.chooseExtra(pieces) : null,
    plan: await workOrderPlanFor(db, context, order, planned.changes, planned.cells),
  }
}
