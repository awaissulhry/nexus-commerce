import type { WorkOrderCostRow } from '../api'

/**
 * B-W2b-424 — Finance › Costing › Standard vs actual, the work order's status with the W2b close (design finance.costing
 * sec:wos "status (open · closed W2b)", page.live "finance.cost.closed (W2b) → Status"): open while work is reported, final
 * once completed (its actual no longer grows), closed once the work order is closed (B-W2b-411: its cost settled while the
 * company's figures for the accountant are on). The close's live event (and the work order's status change) reads the
 * list again so the status changes in place.
 */

export type CostState = 'open' | 'final' | 'closed'

export function costStateOf(row: Pick<WorkOrderCostRow, 'final'> & { readonly workOrder: Pick<WorkOrderCostRow['workOrder'], 'status'> }): CostState {
  if (row.workOrder.status === 'CLOSED') return 'closed'
  return row.final ? 'final' : 'open'
}

/** A close, an undo or a reopen (or any status change of a work order): the list's Status reads again. */
export const closedTouches = (change: { type: string }): boolean => change.type === 'work_order_close.changed' || change.type === 'workorder.status_changed'
