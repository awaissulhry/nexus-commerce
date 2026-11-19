import type { Order } from '../../api'
import type { Phrase } from '../../model'
// F-OP-121: where Create shipment… leads.
import { createShipmentHref, mayCreateShipment, type OrderAbilities } from '../../model'
// F-OP-122: the joinable read and its reasons in the Warehouse's words.
import type { JoinableShipments } from '../../../../warehouse/shipments/api'
import { joinHeld } from '../../../../warehouse/shipments/model'

/**
 * F-OP-119 (order page plan N5; 10-order-page §8.1, §8.2; review R-7) — the Shipments tab's rows, pure: who carries each shipment
 * ("BRT, booked by hand", our van, the customer collecting, the aggregator's carrier), its tracking (a typed number with "No live
 * tracking", or its labels' parcel numbers with their carrier pages), whether its number may be typed here — held with the words
 * of the order read's refusal, and the door that fixes it (the shipment's page; "Change how it travels…" before it leaves) — and
 * the cancelled rows behind "Show N cancelled". The words are this catalogue's (`orders`: `ship.*`).
 */

export type ShipmentRow = Order['chain']['shipments'][number]

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Who carries it, in words; null: not said (the carrier is withheld from this reader, or nobody is chosen yet). */
export function carrierOf(row: ShipmentRow): Phrase | null {
  if (row.transportBy === 'SENDER') return phrase('ship.carrier.ownVan')
  if (row.transportBy === 'RECIPIENT') return phrase('ship.carrier.collects')
  const name = row.carrier?.name ?? row.carrier?.code ?? null
  if (name === null) return null
  return row.tracking?.source === 'TYPED' ? phrase('ship.carrier.manual', { carrier: name }) : phrase('ship.carrier.named', { name })
}

/** The pieces of its tracking the row shows: a typed number (no carrier feeds it) or its labels' parcels. */
export function trackingOf(row: ShipmentRow): { readonly typed: string | null; readonly live: boolean; readonly parcels: readonly { readonly number: string; readonly url: string | null }[] } | null {
  const tracking = row.tracking ?? null
  if (!tracking) return null
  if (tracking.source === 'TYPED') return { typed: tracking.number, live: false, parcels: [] }
  return { typed: null, live: tracking.live, parcels: tracking.parcels.map((parcel) => ({ number: parcel.number, url: httpsOrNull(parcel.url) })) }
}

/** A carrier's page opens only on https (the API keeps no other; checked again here). */
export const httpsOrNull = (url: string | null | undefined): string | null => (typeof url === 'string' && /^https:\/\/\S+$/i.test(url.trim()) ? url.trim() : null)

/** The door to the tracking number: open it here, or held — with the words and the door that fixes it, if any. */
export type TrackingDoor =
  | { readonly kind: 'open' }
  | { readonly kind: 'held'; readonly words: Phrase; readonly door: 'shipment' | 'arrange' | null }

/** Before the goods leave, how they travel may still change on the shipment's page. */
const BEFORE_LEAVING = new Set(['DRAFT', 'PACKED'])

export function trackingDoorOf(row: ShipmentRow): TrackingDoor {
  const may = row.mayTypeTracking
  if (!may) return { kind: 'held', words: phrase('ship.tracking.held.NO_RIGHT'), door: null }
  if (may.allowed) return { kind: 'open' }
  switch (may.code) {
    case 'LABELLED':
      return { kind: 'held', words: phrase('ship.tracking.held.LABELLED'), door: 'shipment' }
    case 'NOT_A_CARRIER':
      return { kind: 'held', words: phrase(BEFORE_LEAVING.has(row.status) ? 'ship.tracking.held.NOT_A_CARRIER' : 'ship.tracking.held.NOT_A_CARRIER_LEFT'), door: BEFORE_LEAVING.has(row.status) ? 'arrange' : null }
    case 'CARRIER_TRACKED':
    case 'CANCELLED':
    case 'NO_RIGHT':
      return { kind: 'held', words: phrase(`ship.tracking.held.${may.code}`), door: null }
    default:
      return { kind: 'held', words: phrase('ship.tracking.held.other'), door: null }
  }
}

/** The rows shown: the cancelled ones only once asked ("Show N cancelled"), in the read's order. */
export function shownShipments(rows: readonly ShipmentRow[], showCancelled: boolean): { readonly rows: readonly ShipmentRow[]; readonly cancelled: number } {
  const cancelled = rows.filter((row) => row.status === 'CANCELLED').length
  return { rows: showCancelled ? [...rows] : rows.filter((row) => row.status !== 'CANCELLED'), cancelled }
}

// ── F-OP-121 (order page plan N6): where Create shipment… leads ──────────────────────────────────────────────────────────────────
export type CreateShipmentDoor = { readonly kind: 'inPlace' } | { readonly kind: 'warehouse'; readonly href: string }

/**
 * Released garments not shipped yet and the right to make a shipment: opened in place on the order page (its container mounts
 * Warehouse's New shipment), else Warehouse's page with this order chosen; null: nothing to offer.
 */
export function createShipmentDoor(order: Pick<Order, 'id' | 'status' | 'progress'>, can: Pick<OrderAbilities, 'createShipment'>, prefix: string, inPlace: boolean): CreateShipmentDoor | null {
  if (!mayCreateShipment(order, can)) return null
  return inPlace ? { kind: 'inPlace' } : { kind: 'warehouse', href: createShipmentHref(prefix, order.id) }
}
// ── end F-OP-121 ──

// ── F-OP-122 (order page plan N6): shared shipments on the order ─────────────────────────────────────────────────────────────────
/** "Also carries SO-0151": the other orders a shipment of this order carries (all of this customer's), the first first. */
export function alsoCarries(row: ShipmentRow, orderId: string): { readonly id: string; readonly number: string }[] {
  return (row.orders ?? []).filter((entry) => entry.id !== orderId).map((entry) => ({ id: entry.id, number: entry.number }))
}

/** A DRAFT of the same customer this order may join, as the Shipments tab offers it: "Add this order's garments…", held with why. */
export interface JoinableRow {
  readonly shipmentId: string
  readonly number: string
  /** Null: it may join (B-OP-047: the only rows offered); the field stays the row's shape for the view's held button. */
  readonly held: Phrase | null
}

/**
 * The DRAFTs the Shipments tab offers from the joinable read: the same customer, site and delivery address, every rule passed
 * (B-OP-047: several orders in one shipment are on); a DRAFT held for any reason — another site or address … — is not offered.
 */
export function joinableRows(shipments: JoinableShipments['shipments']): JoinableRow[] {
  return shipments.flatMap((row) => {
    const held = joinHeld(row.joinable)
    return row.status === 'DRAFT' && held === null ? [{ shipmentId: row.shipmentId, number: row.number, held }] : []
  })
}
// ── end F-OP-122 ──

// ── F-OP-135 (order page plan N5/N6, B-OP-034): the link typed beside a hand-booked carrier's number ─────────────────────────────────
/** The row's Track ›: the tracking link typed beside the number (https only, checked again here); null: none, or not a typed number. */
export function typedLinkOf(row: ShipmentRow): string | null {
  return row.tracking?.source === 'TYPED' && row.tracking.number ? httpsOrNull(row.tracking.url) : null
}
// ── end F-OP-135 ──
