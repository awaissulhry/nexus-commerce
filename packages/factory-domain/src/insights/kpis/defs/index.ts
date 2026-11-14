import type { KpiFile } from '../catalogue'
import deliveryShippedOnTime from './delivery.shipped_on_time'
import productionOutput from './production.output'
import productionScrapRate from './production.scrap_rate'
import productionWipValue from './production.wip_value'
import purchasingReceiptLines from './purchasing.receipt_lines'
import salesOrderLinesIn from './sales.order_lines_in'
import salesOrderMargin from './sales.order_margin'
import salesOrdersIn from './sales.orders_in'

/**
 * The KPI files (B-W2b-428), one per KPI, named by its key. A step that adds KPIs adds its files here (merge point: keep
 * both sides, in key order). The catalogue test holds the file names equal to the keys and every file sound.
 */
export const KPI_FILES: readonly KpiFile[] = Object.freeze([
  deliveryShippedOnTime,
  productionOutput,
  productionScrapRate,
  productionWipValue,
  purchasingReceiptLines,
  salesOrderLinesIn,
  salesOrderMargin,
  salesOrdersIn,
])
