import { MEASURE_SOURCES, type MeasureSource } from '@nexus/factory-domain/insights/kpis/measures'
import type { Source } from '../rows'
import { deliverySource } from './delivery'
import { leadTimesSource } from './lead-times'
import { leatherSource } from './leather'
import { marginSource } from './margin'
import { ordersSource } from './orders'
import { productionSource } from './production'
import { receiptsSource } from './receipts'
import { shipmentsSource } from './shipments'
import { supplySource } from './supply'
import { wipSource } from './wip'
import { workOrdersSource } from './work-orders'

/**
 * The sources of the facts (B-W2b-428): one reader per factory-domain MeasureSource, each rebuilding all its measures for a
 * company and some days, and the events after which a source's day is rebuilt (the event stream; the hourly and nightly
 * rebuilds catch what no event says). A step that adds measures adds its source here (merge point).
 */
export const SOURCES: Readonly<Record<MeasureSource, Source>> = Object.freeze({
  ORDERS: ordersSource,
  SHIPMENTS: shipmentsSource,
  PRODUCTION: productionSource,
  WIP: wipSource,
  RECEIPTS: receiptsSource,
  // B-W2b-429 (the ready KPIs): own lines.
  DELIVERY: deliverySource,
  LEAD_TIMES: leadTimesSource,
  WORK_ORDERS: workOrdersSource,
  LEATHER: leatherSource,
  MARGIN: marginSource,
  SUPPLY: supplySource,
})

/** The events that change what a source counts. */
export const SOURCE_EVENTS: Readonly<Record<MeasureSource, readonly string[]>> = Object.freeze({
  ORDERS: ['sales_order.created', 'sales_order.status_changed', 'sales_order.amended', 'sales_order.lines_closed'],
  SHIPMENTS: ['shipment.status_changed', 'sales_order.promise_changed'],
  PRODUCTION: ['production.scan_recorded'],
  WIP: ['work_order_cost.posted', 'work_order_cost.reversed'],
  RECEIPTS: ['inventory.receipt_posted', 'inventory.receipt_reversed'],
  // B-W2b-429: own lines.
  DELIVERY: ['shipment.status_changed', 'sales_order.promise_changed', 'order_promise.recorded', 'sales_order.status_changed', 'sales_order.amended', 'sales_order.lines_closed'],
  LEAD_TIMES: ['sales_order.created', 'shipment.status_changed', 'workorder.status_changed'],
  WORK_ORDERS: ['workorder.released', 'workorder.status_changed'],
  LEATHER: ['production.cut_logged', 'production.cut_reversed'],
  MARGIN: ['cost_of_sales.posted'],
  SUPPLY: ['inventory.receipt_posted', 'inventory.receipt_reversed'],
})

export const sourcesOfEvent = (type: string): MeasureSource[] => MEASURE_SOURCES.filter((source) => SOURCE_EVENTS[source].includes(type))
