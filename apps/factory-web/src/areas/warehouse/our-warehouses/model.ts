import type { AtWarehouseRow, OnTheWayRow, OurWarehouse } from '../../sales/orders/record/shipments/legs/api'
import type { ShipRights } from '../../sales/orders/record/shipments/legs/model'

/**
 * owb-ss3 step 3.4 (design plan § 7 "to our warehouse first"; office.js `officeWarehouse`) — Warehouse › Our warehouses, pure: one section
 * per warehouse of the company (`GET /shipping/our-warehouses`): **At our warehouse** (the customer, its orders, the pieces, since when,
 * the customer's label here or awaited; the oldest first) with **Send on to the customer**, and **On the way** (the customer, the pieces,
 * the day it left; the oldest first) with **It arrived at the warehouse**. The acts are pack and send (shipping.manage): the read carries no
 * row `may`, so the page offers them by the right and the leg's window reads the shipment's own leg first (its `may` and version) — the
 * server keeps the last word. The words are `our-warehouses`.
 */

export interface AtRow extends AtWarehouseRow {
  readonly label: boolean
}

export interface WarehouseSection {
  readonly siteId: string
  readonly code: string
  readonly name: string
  readonly place: string
  readonly at: readonly AtRow[]
  readonly onTheWay: readonly OnTheWayRow[]
  readonly pieces: { readonly at: number; readonly onTheWay: number }
}

const sum = (rows: readonly { readonly pieces: number }[]): number => rows.reduce((total, row) => total + row.pieces, 0)

/** The sections, by warehouse name; inside, the oldest first (the one that waits longest on top). */
export function sectionsOf(warehouses: readonly OurWarehouse[]): WarehouseSection[] {
  return [...warehouses]
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.code.localeCompare(b.code, 'en'))
    .map((warehouse) => {
      const at = [...warehouse.atWarehouse].sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt)).map((row) => ({ ...row, label: row.labelSentAt !== null }))
      const onTheWay = [...warehouse.onTheWay].sort((a, b) => a.shippedAt.localeCompare(b.shippedAt))
      return {
        siteId: warehouse.siteId,
        code: warehouse.code,
        name: warehouse.name,
        place: [warehouse.city, warehouse.country].filter((part): part is string => !!part).join(', '),
        at,
        onTheWay,
        pieces: { at: sum(at), onTheWay: sum(onTheWay) },
      }
    })
}

/** The acts the page offers: Send on and It arrived (pack and send); a planner or a reader sees none. */
export const actsOf = (rights: Pick<ShipRights, 'send'>): { readonly sendOn: boolean; readonly arrived: boolean } => ({ sendOn: rights.send, arrived: rights.send })

/** The section's answer: "2 at our warehouse · 1 on the way", or "Nothing here now". */
export function answerOf(section: Pick<WarehouseSection, 'at' | 'onTheWay'>): { readonly key: string; readonly params?: Readonly<Record<string, number>> } {
  if (section.at.length === 0 && section.onTheWay.length === 0) return { key: 'section.nothing' }
  return { key: 'section.answer', params: { at: section.at.length, onTheWay: section.onTheWay.length } }
}

/** How many days a shipment has waited at our warehouse (whole days, never below 0). */
export function daysWaiting(arrivedAt: string, now: Date = new Date()): number {
  const days = Math.floor((now.getTime() - Date.parse(arrivedAt)) / 86_400_000)
  return Number.isFinite(days) && days > 0 ? days : 0
}
