import { MEASURE_SOURCES, type MeasureSource } from '@nexus/factory-domain/insights/kpis/measures'
import type { Source } from '../rows'
import { ordersSource } from './orders'
import { productionSource } from './production'
import { receiptsSource } from './receipts'
import { shipmentsSource } from './shipments'
import { wipSource } from './wip'

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
})

/** The events that change what a source counts. */
export const SOURCE_EVENTS: Readonly<Record<MeasureSource, readonly string[]>> = Object.freeze({
  ORDERS: ['sales_order.created', 'sales_order.status_changed', 'sales_order.amended', 'sales_order.lines_closed'],
  SHIPMENTS: ['shipment.status_changed', 'sales_order.promise_changed'],
  PRODUCTION: ['production.scan_recorded'],
  WIP: ['work_order_cost.posted', 'work_order_cost.reversed'],
  RECEIPTS: ['inventory.receipt_posted', 'inventory.receipt_reversed'],
})

export const sourcesOfEvent = (type: string): MeasureSource[] => MEASURE_SOURCES.filter((source) => SOURCE_EVENTS[source].includes(type))
