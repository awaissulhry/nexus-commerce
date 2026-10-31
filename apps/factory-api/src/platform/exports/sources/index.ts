import type { AnyExportSource } from '../source'
import { purchaseOrders } from './purchase-orders'
import { salesOrders } from './sales-orders'
import { workOrders } from './work-orders'
// B-W2b-11: every W1 and W2a list (one file per list; a page's second frame is `<key>.2`).
import { materials } from './materials'
import { operations } from './operations'
import { sizes } from './sizes'
import { styles } from './styles'
import { quotes } from './quotes'
import { customers, suppliers } from './parties'
import { mrp } from './mrp'
import { capacityLoad } from './capacity'
import { invoicesShipped } from './invoices-shipped'
import { invoices } from './invoices'
import { payments } from './payments'
import { inspections } from './inspections'
import { ncrs } from './ncrs'
import { complaints } from './complaints'
import { certificates } from './certificates'
import { labels } from './labels'
import { register } from './register'
import { claims } from './claims'
import { counts } from './counts'
import { hides } from './hides'
import { locations } from './locations'
import { lots } from './lots'
import { moves } from './moves'
import { receipts } from './receipts'
import { shipments } from './shipments'
import { stock } from './stock'

/**
 * Every list with an export (B-W2a-23; PLT-179), one file per list beside this one. A step that gives its list an export
 * adds its file and one line here (a merge point: keep both sides). Reports are not listed: each report of the pack is
 * a dynamic source (./reports.ts, found by the registry).
 */
export const EXPORT_SOURCES: readonly AnyExportSource[] = Object.freeze([
  salesOrders,
  purchaseOrders,
  workOrders,
  // B-W2b-11: products and parties.
  materials,
  operations,
  sizes,
  styles,
  quotes,
  customers,
  suppliers,
  // B-W2b-11: planning and money.
  mrp,
  capacityLoad,
  invoicesShipped,
  invoices,
  payments,
  // B-W2b-11: quality, compliance and claims.
  inspections,
  ncrs,
  complaints,
  certificates,
  labels,
  register,
  claims,
  // B-W2b-11: the warehouse.
  counts,
  hides,
  locations,
  lots,
  moves,
  receipts,
  shipments,
  stock,
])
