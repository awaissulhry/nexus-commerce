import type { KpiFile } from '../catalogue'
import deliveryOrderToShipDays from './delivery.order_to_ship_days'
import deliveryOtif from './delivery.otif'
import deliveryOtifCurrent from './delivery.otif_current'
import deliveryShippedOnTime from './delivery.shipped_on_time'
import productionLeatherYield from './production.leather_yield'
import productionOrderToStartDays from './production.order_to_start_days'
import productionOutput from './production.output'
import productionScrapRate from './production.scrap_rate'
import productionWipAgeDays from './production.wip_age_days'
import productionWipPieces from './production.wip_pieces'
import productionWipValue from './production.wip_value'
import purchasingReceiptLines from './purchasing.receipt_lines'
import purchasingSupplierOnTime from './purchasing.supplier_on_time'
import salesMarginActual from './sales.margin_actual'
import salesMarginQuoted from './sales.margin_quoted'
import salesOrderLinesIn from './sales.order_lines_in'
import salesOrderMargin from './sales.order_margin'
import salesOrdersIn from './sales.orders_in'
import salesQuoteToOrderDays from './sales.quote_to_order_days'

/**
 * The KPI files (B-W2b-428), one per KPI, named by its key. A step that adds KPIs adds its files here (merge point: keep
 * both sides, in key order). B-W2b-429 added the ready KPIs (on-time in full, lead times, work in progress, leather yield,
 * margin quoted and actual, supplier on-time). The catalogue test holds the file names equal to the keys and every file sound.
 */
export const KPI_FILES: readonly KpiFile[] = Object.freeze([
  deliveryOrderToShipDays,
  deliveryOtif,
  deliveryOtifCurrent,
  deliveryShippedOnTime,
  productionLeatherYield,
  productionOrderToStartDays,
  productionOutput,
  productionScrapRate,
  productionWipAgeDays,
  productionWipPieces,
  productionWipValue,
  purchasingReceiptLines,
  purchasingSupplierOnTime,
  salesMarginActual,
  salesMarginQuoted,
  salesOrderLinesIn,
  salesOrderMargin,
  salesOrdersIn,
  salesQuoteToOrderDays,
])
