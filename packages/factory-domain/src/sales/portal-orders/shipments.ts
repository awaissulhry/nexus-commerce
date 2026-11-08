import type { BusinessDate } from '../../core/time'
import { trackingPageOf, type TrackingStatus } from '../../shipping/labels/tracking'
import type { ShipmentStatus } from '../../shipping/shipments'
import type { ProgressRow } from '../orders/orders'
import type { Words } from './status'

/**
 * Shipments, tracking and what is still to ship, in the customer's words (B-W2b-175; SAL-080 "Shipments and tracking",
 * SAL-081 "Open lines and backorders"; design portal.customer.orders › Shipments & tracking: "Per shipment: DDT number
 * and date · carrier · tracking number · parcels · MilestoneTracker small (Packed, Collected, In transit, Delivered)",
 * "Still to ship: style, colour, size, pieces open, expected date", the list's "On the way").
 *
 *   shown       a shipment the customer can expect: PACKED, SHIPPED, DELIVERED, RETURNED. A DRAFT is still being packed
 *               and a CANCELLED one never left: neither is shown.
 *   status      the shipment's state with its parcels' latest tracking: PACKED (waiting for the carrier), IN_TRANSIT,
 *               OUT_FOR_DELIVERY, DELAYED (the carrier reported a problem), DELIVERED, RETURNED
 *   milestones  Packed (packedAt), Collected (it left: shippedAt), In transit (the carrier's first scan on the way), Delivered
 *   still to ship  per line and size, the pieces ordered and not shipped yet (a line closed short: nothing), expected on
 *               the line's own promise date, else the order's
 * The carrier's own words of an event (its description and place) are passed on as the carrier wrote them.
 *
 *   ETA         B-W2b-F14: the carrier's expected delivery while the goods are packed or on the way (none once delivered
 *               or returned: the day it happened is shown instead)
 *   track       B-W2b-F14: "Track on the carrier's site", a parcel's tracking page when it is an https address (anything
 *               else is never shown)
 */

export const SHOWN_SHIPMENT_STATUSES: readonly ShipmentStatus[] = Object.freeze(['PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED'])

export const CUSTOMER_SHIPMENT_STATUSES = ['PACKED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELAYED', 'DELIVERED', 'RETURNED'] as const
export type CustomerShipmentStatus = (typeof CUSTOMER_SHIPMENT_STATUSES)[number]

export const SHIPMENT_STATUS_WORDS: Readonly<Record<CustomerShipmentStatus, Words>> = Object.freeze({
  PACKED: { it: 'Imballato, in attesa del corriere', en: 'Packed, waiting for the carrier' },
  IN_TRANSIT: { it: 'In viaggio', en: 'On the way' },
  OUT_FOR_DELIVERY: { it: 'In consegna oggi', en: 'Out for delivery' },
  DELAYED: { it: 'In ritardo o fermo presso il corriere', en: 'Delayed or held by the carrier' },
  DELIVERED: { it: 'Consegnato', en: 'Delivered' },
  RETURNED: { it: 'Tornato a noi', en: 'Returned to us' },
})

export const TRACKING_WORDS: Readonly<Record<TrackingStatus, Words>> = Object.freeze({
  LABEL_CREATED: { it: 'Etichetta pronta', en: 'Label ready' },
  IN_TRANSIT: { it: 'In viaggio', en: 'On the way' },
  OUT_FOR_DELIVERY: { it: 'In consegna oggi', en: 'Out for delivery' },
  DELIVERED: { it: 'Consegnato', en: 'Delivered' },
  EXCEPTION: { it: 'In ritardo o fermo presso il corriere', en: 'Delayed or held by the carrier' },
  RETURNED: { it: 'In ritorno al mittente', en: 'Going back to us' },
})

/** The customer's status of a shown shipment from its own state and its parcels' latest tracking statuses. */
export function customerShipmentStatusOf(status: ShipmentStatus, latest: readonly TrackingStatus[]): CustomerShipmentStatus {
  if (status === 'DELIVERED') return 'DELIVERED'
  if (status === 'RETURNED') return 'RETURNED'
  if (status !== 'SHIPPED') return 'PACKED'
  if (latest.includes('EXCEPTION') || latest.includes('RETURNED')) return 'DELAYED'
  if (latest.length > 0 && latest.every((entry) => entry === 'OUT_FOR_DELIVERY' || entry === 'DELIVERED')) return 'OUT_FOR_DELIVERY'
  return 'IN_TRANSIT'
}

/** A shipment the carrier has and has not handed over yet (the list's "On the way", Home's "In transit"). */
export const isOnTheWay = (status: ShipmentStatus): boolean => status === 'SHIPPED'

export const SHIPMENT_MILESTONES = ['PACKED', 'COLLECTED', 'IN_TRANSIT', 'DELIVERED'] as const
export type ShipmentMilestone = (typeof SHIPMENT_MILESTONES)[number]

export const SHIPMENT_MILESTONE_WORDS: Readonly<Record<ShipmentMilestone, Words>> = Object.freeze({
  PACKED: { it: 'Imballato', en: 'Packed' },
  COLLECTED: { it: 'Ritirato', en: 'Collected' },
  IN_TRANSIT: { it: 'In viaggio', en: 'In transit' },
  DELIVERED: { it: 'Consegnato', en: 'Delivered' },
})

export interface ShipmentMilestoneFacts {
  readonly status: ShipmentStatus
  readonly packedAt: Date | null
  readonly shippedAt: Date | null
  readonly deliveredAt: Date | null
  /** The carrier's events, any order. */
  readonly events: readonly { readonly status: TrackingStatus; readonly occurredAt: Date }[]
}

export interface ShipmentMilestoneView {
  readonly key: ShipmentMilestone
  readonly words: Words
  readonly done: boolean
  /** When it happened, when known. */
  readonly at: Date | null
}

const ON_THE_WAY: readonly TrackingStatus[] = ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']

/** Packed, Collected, In transit, Delivered: each done with its time when the records say so. */
export function shipmentMilestonesOf(facts: ShipmentMilestoneFacts): ShipmentMilestoneView[] {
  const left = facts.status === 'SHIPPED' || facts.status === 'DELIVERED' || facts.status === 'RETURNED'
  const firstOnTheWay = facts.events
    .filter((event) => ON_THE_WAY.includes(event.status))
    .reduce<Date | null>((first, event) => (first === null || event.occurredAt < first ? event.occurredAt : first), null)
  const delivered = facts.status === 'DELIVERED'
  const at: Readonly<Record<ShipmentMilestone, { done: boolean; at: Date | null }>> = {
    PACKED: { done: true, at: facts.packedAt },
    COLLECTED: { done: left, at: left ? facts.shippedAt : null },
    IN_TRANSIT: { done: delivered || (left && firstOnTheWay !== null), at: firstOnTheWay },
    DELIVERED: { done: delivered, at: delivered ? facts.deliveredAt : null },
  }
  return SHIPMENT_MILESTONES.map((key) => ({ key, words: SHIPMENT_MILESTONE_WORDS[key], done: at[key].done, at: at[key].at }))
}

// ---- still to ship (SAL-081) --------------------------------------------------------------------------------------------------

export interface OpenLineFacts {
  readonly id: string
  readonly seq: number
  readonly promiseDate: BusinessDate | null
}

export interface StillToShip {
  readonly lineId: string
  readonly seq: number
  /** null: a made-to-measure unit. */
  readonly size: string | null
  readonly ordered: number
  readonly shipped: number
  readonly open: number
  /** The line's own promise date, else the order's (null: none promised). */
  readonly expected: BusinessDate | null
}

/** What is still to ship, per line and size, in line order (from sales/orders orderProgress's rows). */
export function stillToShipOf(rows: readonly ProgressRow[], lines: readonly OpenLineFacts[], orderPromise: BusinessDate | null): StillToShip[] {
  return rows
    .filter((row) => row.toShip > 0)
    .map((row) => {
      const line = lines.find((entry) => entry.id === row.lineId)
      return { lineId: row.lineId, seq: row.seq, size: row.size, ordered: row.ordered, shipped: row.shipped, open: row.toShip, expected: line?.promiseDate ?? orderPromise }
    })
}

// ---- the carrier's ETA and tracking page (B-W2b-F14) -------------------------------------------------------------------

/** The link's words. */
export const TRACK_ON_CARRIER_WORDS: Words = Object.freeze({ it: 'Segui sul sito del corriere', en: "Track on the carrier's site" })

/** The ETA the customer sees: while the shipment is packed or on the way; null once it arrived or came back. */
export const customerEtaOf = (status: ShipmentStatus, expectedDeliveryAt: Date | null): Date | null => (status === 'PACKED' || status === 'SHIPPED' ? expectedDeliveryAt : null)

/** A parcel's "Track on the carrier's site" link, or null (no page kept, or not an https one). */
export function trackingLinkOf(url: string | null): { readonly url: string; readonly words: Words } | null {
  const page = trackingPageOf(url)
  return page ? { url: page, words: TRACK_ON_CARRIER_WORDS } : null
}
