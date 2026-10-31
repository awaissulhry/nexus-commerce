import type { AnyBulkTarget } from '../target'
import { workOrders } from './work-orders'

/**
 * The lists edited in bulk and cell by cell (B-W2b-13): one file per list beside this one, one line here (a merge
 * point: keep both sides). The key is the list's page id, as its export source's.
 */
export const BULK_TARGETS: readonly AnyBulkTarget[] = [
  // B-W2b-13: Production › Work orders (due date, priority).
  workOrders,
]
