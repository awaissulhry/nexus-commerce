import type { AnyExportSource } from '../source'
import { purchaseOrders } from './purchase-orders'
import { salesOrders } from './sales-orders'
import { workOrders } from './work-orders'

/**
 * Every list with an export (B-W2a-23; PLT-179), one file per list beside this one. A step that gives its list an export
 * adds its file and one line here (a merge point: keep both sides).
 */
export const EXPORT_SOURCES: readonly AnyExportSource[] = Object.freeze([
  salesOrders,
  purchaseOrders,
  workOrders,
])
