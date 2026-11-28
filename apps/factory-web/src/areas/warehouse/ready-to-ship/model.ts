import type { NewShipmentBody, ReadyOrder, ShipmentQuery, ShipmentRow } from '../shipments/api'
import { linesOf, MAX_ORDERS, piecesOf } from '../../sales/orders/record/shipments/ways/model'

/**
 * owb-ss3 step 3.4 (design plan § 5n "Shipping › Ready to ship"; ship.js `officeShip`) — Warehouse › Ready to ship, pure: every order with
 * garments released and on no shipment (`GET /shipping/ready`), BY CUSTOMER, with tick boxes; **One shipment for the n orders** (the
 * orders of ONE customer: two customers never travel in one shipment — the button says why); **Add to SH-…** (the customer's DRAFT that
 * the ticked orders may join); and every shipment with the chips Open · On the way · Arrived · All. Planning needs shipping.plan OR
 * shipping.manage; without it the page reads only. The words are `ready-to-ship`.
 */

export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface ReadyRow {
  readonly salesOrderId: string
  readonly number: string
  readonly customerRef: string | null
  /** Released garments on no shipment. */
  readonly pieces: number
}

export interface CustomerGroup {
  readonly partyId: string
  readonly code: string
  readonly name: string
  readonly orders: readonly ReadyRow[]
  readonly pieces: number
}

/** The orders with something to ship, by customer (the customers by name, each customer's orders by number). */
export function byCustomer(orders: readonly ReadyOrder[]): CustomerGroup[] {
  const groups = new Map<string, { partyId: string; code: string; name: string; orders: ReadyRow[] }>()
  for (const order of orders) {
    const pieces = piecesOf(order)
    if (pieces <= 0) continue
    const group = groups.get(order.partyId) ?? { partyId: order.partyId, code: order.party.code, name: order.party.legalName, orders: [] }
    group.orders.push({ salesOrderId: order.salesOrderId, number: order.number, customerRef: order.customerRef, pieces })
    groups.set(order.partyId, group)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, orders: [...group.orders].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true })), pieces: group.orders.reduce((sum, row) => sum + row.pieces, 0) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.code.localeCompare(b.code, 'en'))
}

/** The ticked orders and the customers they belong to. */
export function selectionOf(groups: readonly CustomerGroup[], ticked: ReadonlySet<string>): { readonly customers: readonly CustomerGroup[]; readonly orderIds: readonly string[]; readonly pieces: number } {
  const customers = groups.filter((group) => group.orders.some((row) => ticked.has(row.salesOrderId)))
  const rows = groups.flatMap((group) => group.orders.filter((row) => ticked.has(row.salesOrderId)))
  return { customers, orderIds: rows.map((row) => row.salesOrderId), pieces: rows.reduce((sum, row) => sum + row.pieces, 0) }
}

/** A tick on one order. */
export function toggled(ticked: ReadonlySet<string>, salesOrderId: string): Set<string> {
  const next = new Set(ticked)
  if (next.has(salesOrderId)) next.delete(salesOrderId)
  else next.add(salesOrderId)
  return next
}

/** The box beside a customer: all its orders ticked, or (all already) none of them. */
export function toggledCustomer(ticked: ReadonlySet<string>, group: CustomerGroup): Set<string> {
  const next = new Set(ticked)
  const all = group.orders.every((row) => next.has(row.salesOrderId))
  for (const row of group.orders) {
    if (all) next.delete(row.salesOrderId)
    else next.add(row.salesOrderId)
  }
  return next
}

/** Why "One shipment for the n orders" waits (null: it may go). The right first, then the ONE-customer rule. */
export function oneShipmentHeld(input: { readonly plan: boolean; readonly selection: ReturnType<typeof selectionOf>; readonly busy: boolean }): Said | null {
  if (!input.plan) return { key: 'held.noRight' }
  if (input.selection.orderIds.length === 0) return { key: 'held.pick' }
  if (input.selection.customers.length > 1) return { key: 'held.twoCustomers', params: { count: input.selection.customers.length } }
  if (input.selection.orderIds.length > MAX_ORDERS) return { key: 'held.tooMany', params: { max: MAX_ORDERS } }
  if (input.busy) return { key: 'held.busy' }
  return null
}

/** The button's words: "Make a shipment" for one order, "One shipment for the n orders" for several. */
export const oneShipmentWords = (count: number): Said => (count > 1 ? { key: 'act.oneShipment', params: { count } } : { key: 'act.makeShipment' })

/** The ticked orders of ONE customer in ONE DRAFT (today's create: the first order first, `salesOrderIds` when several). */
export function oneShipmentBody(orders: readonly ReadyOrder[], orderIds: readonly string[]): NewShipmentBody | null {
  const chosen = orderIds.flatMap((id) => orders.filter((order) => order.salesOrderId === id)).slice(0, MAX_ORDERS)
  const first = chosen[0]
  if (!first) return null
  return {
    salesOrderId: first.salesOrderId,
    ...(chosen.length > 1 ? { salesOrderIds: chosen.map((order) => order.salesOrderId) } : {}),
    destination: { kind: 'CUSTOMER' },
    lines: chosen.flatMap((order) => linesOf(order.cells)),
  }
}

/** The lines the ticked orders add to a DRAFT of their customer ("Add to SH-…"). */
export function addLinesOf(orders: readonly ReadyOrder[], orderIds: readonly string[]): { workOrderSizeId: string; quantity: number }[] {
  return orderIds.flatMap((id) => orders.filter((order) => order.salesOrderId === id)).flatMap((order) => linesOf(order.cells))
}

// ---- the shipments part ----------------------------------------------------------------------------------------------------------

export const SHIPMENT_CHIPS = ['open', 'onTheWay', 'arrived', 'all'] as const
export type ShipmentChip = (typeof SHIPMENT_CHIPS)[number]

/** The list's filter of each chip: Open = DRAFT + PACKED · On the way = SHIPPED · Arrived = DELIVERED · All. */
export function chipQuery(chip: ShipmentChip): ShipmentQuery {
  switch (chip) {
    case 'open':
      return { open: true }
    case 'onTheWay':
      return { status: 'SHIPPED' }
    case 'arrived':
      return { status: 'DELIVERED' }
    case 'all':
      return {}
  }
}

/** A chip from the address (`?shipments=`), else Open. */
export const chipOf = (value: string | null | undefined): ShipmentChip => (SHIPMENT_CHIPS as readonly string[]).includes(value ?? '') ? (value as ShipmentChip) : 'open'

/** A shipment row in a few words: where it stands, its garments and parcels, the orders it carries. */
export interface ShipmentLine {
  readonly id: string
  readonly number: string
  readonly status: ShipmentRow['status']
  readonly customer: string
  readonly orders: readonly string[]
  readonly garments: number
  readonly parcels: number
  readonly carrier: string | null
  /** The day it left (SHIPPED, DELIVERED) or was made. */
  readonly at: string
}

export function shipmentLinesOf(rows: readonly ShipmentRow[]): ShipmentLine[] {
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    customer: row.partyName,
    orders: (row.salesOrders ?? [{ id: row.salesOrderId, number: row.salesOrderNumber, customerRef: null }]).map((order) => order.number),
    garments: row.garments,
    parcels: row.parcels,
    carrier: row.carrierName ?? row.carrierCode,
    at: row.shippedAt ?? row.createdAt,
  }))
}
