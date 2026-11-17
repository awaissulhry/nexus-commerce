import type { AnyBulkTarget } from '../target'
import { workOrders } from './work-orders'
import { workOrderRelease } from './work-order-release'
// B-W2b-247: Products › Libraries › Colours & artwork.
import { colours } from './colours'
// B-TH-060: Sales › Orders, the sheet's cells.
import { salesOrders } from './sales-orders'

/**
 * The lists edited in bulk and cell by cell (B-W2b-13): one file per list beside this one, one line here (a merge
 * point: keep both sides). The key is the list's page id, as its export source's.
 */
export const BULK_TARGETS: readonly AnyBulkTarget[] = [
  // B-W2b-13: Production › Work orders (due date, priority).
  workOrders,
  // B-W2b-51: Production › Work orders, "Release N work orders" (per-row blockers).
  workOrderRelease,
  // B-W2b-247: Products › Colours & artwork (name, system, reference, family, hex).
  colours,
  // B-TH-060: Sales › Orders (the office note and the custom values this person sees; never the lines).
  salesOrders,
]
