import type { FastifyInstance, FastifyRequest } from 'fastify'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  customerEtaOf,
  customerShipmentStatusOf,
  SHIPMENT_STATUS_WORDS,
  shipmentMilestonesOf,
  SHOWN_SHIPMENT_STATUSES,
  stillToShipOf,
  trackingLinkOf,
  TRACKING_WORDS,
} from '@nexus/factory-domain/sales/portal-orders/shipments'
import { partnerOrder, portalReader } from './access'
import { latestByShipment, progressOfLines } from './orders'
import { dayOrNull, hasLeft, liveDdts, namesOf, readLines, readPapers, readParcels, readShipmentLines, readShipments, readTracking, shippedPieces, type PortalShipmentRow, type PortalTrackingRow } from './store'
import { walledForOutside } from '../../../platform/files/content-wall' // fix-wall-1
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers' // fix-portal-numbers-1
import { trackingPageOf } from '@nexus/factory-domain/shipping/labels/tracking' // B-OP-034: a typed link, https only
import { isTestLabel } from '@nexus/factory-domain/shipping/test-mode/rules' // B-OS-006
import { atWarehouseOf } from '../../shipping/warehouse-leg/portal' // owb- po2.6 (S3's ss1, imported)

/**
 * Shipments and tracking for the customer (B-W2b-175; SAL-080, SAL-081; design portal.customer.orders › Shipments &
 * tracking):
 *
 *   GET /portal/sales-orders/:orderId/shipments   each shipment that was packed or left: its DDT (number, date), carrier,
 *                                                 parcels with their tracking number and latest status, the four steps
 *                                                 (Packed, Collected, In transit, Delivered), the carrier's events, what it
 *                                                 carries, the papers shared with the portal; and what is still to ship per
 *                                                 line and size with the day expected (backorders after a partial shipment)
 * B-W2b-F14: each shipment's expected delivery as the carrier says it (while packed or on the way) and each parcel's "Track
 * on the carrier's site" link (an https tracking page only). B-OP-031: the number typed for a carrier booked by hand (no carrier
 * feeds it: "No live tracking").
 * Partner reads only (the party's scope); the style and colourway names are the tenant's (office scope, after the partner
 * read). The carrier's own words of an event pass as written; no office note, no freight, no person.
 */

const LIVE = { events: ['partner_notification.created'] }

// ── B-OS-006 (order shipments tab; X2-B1) ──
/** A parcel's tracking number the customer may read: a carrier's label only — a TEST label (test mode) is never one. */
// B-OS-022 (order shipments 1/1): else the number typed by hand for a parcel no label tracks (an air waybill, a courier's number).
type CustomerParcel = { readonly trackingNumber: string | null; readonly carrierParcelId: string | null; readonly trackingUrl: string | null; readonly manualTrackingNumber: string | null; readonly manualTrackingUrl: string | null }
const labelShown = (parcel: CustomerParcel): boolean => parcel.trackingNumber !== null && !isTestLabel(parcel.carrierParcelId)
const customerNumberOfParcel = (parcel: CustomerParcel): string | null => (labelShown(parcel) ? parcel.trackingNumber : parcel.trackingNumber === null && parcel.carrierParcelId === null ? parcel.manualTrackingNumber : null)
/** The carrier page of the number the customer reads (the label's, or the link typed beside the typed number). */
const customerUrlOfParcel = (parcel: CustomerParcel): string | null => (labelShown(parcel) ? parcel.trackingUrl : customerNumberOfParcel(parcel) !== null ? parcel.manualTrackingUrl : null)
// ── end B-OS-006 ──

/** The customer's ETA (B-W2b-F14): while packed or on the way. */
const etaOf = (shipment: PortalShipmentRow): string | null => {
  const eta = customerEtaOf(shipment.status, shipment.expectedDeliveryAt)
  return eta ? toUtcIso(eta) : null
}

function eventView(event: PortalTrackingRow, parcelSeq: number | null) {
  return { at: toUtcIso(event.occurredAt), status: event.status, words: TRACKING_WORDS[event.status], description: event.description, location: event.location, parcelSeq }
}

/** B-OP-044: the customer's other orders on a shipment, with their pieces, by their own number (never another customer's). */
function otherOrdersOn(
  read: { readonly contents: readonly { readonly shipmentId: string; readonly salesOrderLineId: string; readonly quantity: number }[]; readonly orderOfLine: ReadonlyMap<string, string>; readonly otherOrders: ReadonlyMap<string, { readonly id: string; readonly partyId: string; readonly customerSeq: number | null; readonly customerRef: string | null }> },
  shipmentId: string,
  partyId: string,
): { yourNumber: ReturnType<typeof customerNumberOf>; customerRef: string | null; pieces: number }[] {
  const pieces = new Map<string, number>()
  for (const row of read.contents) {
    if (row.shipmentId !== shipmentId) continue
    const orderId = read.orderOfLine.get(row.salesOrderLineId)
    if (orderId) pieces.set(orderId, (pieces.get(orderId) ?? 0) + row.quantity)
  }
  return [...pieces]
    .flatMap(([orderId, count]) => {
      const other = read.otherOrders.get(orderId)
      return other && other.partyId === partyId ? [{ yourNumber: customerNumberOf('ORDER', other.customerSeq), customerRef: other.customerRef, pieces: count, seq: other.customerSeq ?? Number.MAX_SAFE_INTEGER }] : []
    })
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq: _seq, ...rest }) => rest)
}

export async function orderShipments(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  const read = await request.withClient(async (client) => {
    const lines = await readLines(client, [order.id])
    const shipments = (await readShipments(client, [order.id])).filter((row) => SHOWN_SHIPMENT_STATUSES.includes(row.status))
    const ids = shipments.map((row) => row.id)
    // ── B-OP-044 (order page N6): a shared shipment shows this order's own lines, and the customer's other orders it carries
    // as "also N pieces of your order #12" (their own numbers: the same customer, by the line FK) ──
    const contents = await readShipmentLines(client, ids)
    const ownLines = new Set(lines.map((line) => line.id))
    const otherLineIds = [...new Set(contents.flatMap((row) => (ownLines.has(row.salesOrderLineId) ? [] : [row.salesOrderLineId])))]
    const orderOfLine = new Map((otherLineIds.length > 0 ? await client.salesOrderLine.findMany({ where: { id: { in: otherLineIds } }, select: { id: true, orderId: true } }) : []).map((row) => [row.id, row.orderId]))
    const otherOrderIds = [...new Set(orderOfLine.values())]
    const otherOrders = new Map((otherOrderIds.length > 0 ? await client.salesOrder.findMany({ where: { id: { in: otherOrderIds } }, select: { id: true, partyId: true, customerSeq: true, customerRef: true } }) : []).map((row) => [row.id, row]))
    // ── end B-OP-044 ──
    return {
      lines,
      shipments,
      shipped: await shippedPieces(client, shipments.filter((row) => hasLeft(row.status)).map((row) => row.id), [order.id] /* B-OP-044 */),
      contents,
      orderOfLine,
      otherOrders,
      parcels: await readParcels(client, ids),
      tracking: await readTracking(client, ids),
      ddts: await liveDdts(client, ids),
      papers: await readPapers(client, ids, reader.seesPrices), // of-fx6s (B-OF-005)
    }
  })
  // fix-wall-1: a paper whose content is another customer's (an old copy of a mixed lot's photo on the shipment) is not listed.
  const walled = await walledForOutside(request, read.papers.map((file) => file.id))
  // owb- po2.6 (S3's seam, ss1): a shipment that goes through the factory's warehouse first — where it is there, as S3 answers it (the
  // tenant's scope after the partner read found the shipments; S3's party filter keeps the brand wall; no person field).
  const legs = await reader.inTenant((client) => atWarehouseOf(client, { partyId: reader.session.partyId, shipmentIds: read.shipments.map((row) => row.id) }))
  const names = await reader.inTenant((client) => namesOf(client, [...new Set(read.lines.map((line) => line.styleId))], [...new Set(read.lines.map((line) => line.colourwayId))]))
  const lineOf = new Map(read.lines.map((line) => [line.id, line]))
  const styleOf = (lineId: string) => {
    const style = names.styles.get(lineOf.get(lineId)?.styleId ?? '')
    return style ? { code: style.code, name: style.name } : null
  }
  const colourwayOf = (lineId: string) => {
    const colourway = names.colourways.get(lineOf.get(lineId)?.colourwayId ?? '')
    return colourway ? { code: colourway.code, name: colourway.name } : null
  }
  const sizeless = new Set(read.lines.filter((line) => line.sizes.length === 0).map((line) => line.id))
  const parcelSeq = new Map(read.parcels.map((parcel) => [parcel.id, parcel.seq]))
  const latest = latestByShipment(read.tracking)

  const shipments = read.shipments.map((shipment) => {
    const events = read.tracking.filter((event) => event.shipmentId === shipment.id)
    const status = customerShipmentStatusOf(shipment.status, latest.get(shipment.id) ?? [])
    return {
      id: shipment.id,
      // owb-po2c (the brand wall, plan §0.5 "counts do not leak"): never the office's shipment series (SH-…) — the web names a parcel
      // by its place on the order ("Parcel 1, 2…"); the carrier's tracking numbers stay on its parcels.
      status,
      words: SHIPMENT_STATUS_WORDS[status],
      transportBy: shipment.transportBy,
      carrierName: shipment.carrierName,
      packedAt: shipment.packedAt ? toUtcIso(shipment.packedAt) : null,
      shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null,
      deliveredAt: shipment.deliveredAt ? toUtcIso(shipment.deliveredAt) : null,
      expectedDeliveryAt: etaOf(shipment),
      // B-OP-031: the number of a carrier booked by hand (the page says "No live tracking": no carrier feeds it).
      typedTrackingNumber: shipment.manualTrackingNumber,
      // B-OP-034: its typed tracking link ("Track ›"), https only.
      typedTrackingUrl: trackingPageOf(shipment.manualTrackingUrl),
      ddt: read.ddts.get(shipment.id) ?? null,
      milestones: shipmentMilestonesOf({ status: shipment.status, packedAt: shipment.packedAt, shippedAt: shipment.shippedAt, deliveredAt: shipment.deliveredAt, events }).map((view) => ({
        key: view.key,
        words: view.words,
        done: view.done,
        at: view.at ? toUtcIso(view.at) : null,
      })),
      parcels: read.parcels
        .filter((parcel) => parcel.shipmentId === shipment.id)
        .map((parcel) => {
          // Its own events and those of the whole shipment (the carrier often reports the shipment), the newest one.
          const last = events.filter((event) => event.parcelId === parcel.id || event.parcelId === null).at(-1) ?? null
          // B-OS-006: a TEST label's number and page never reach the customer (the parcel itself is listed, untracked).
          const number = customerNumberOfParcel(parcel)
          return {
            seq: parcel.seq,
            trackingNumber: number,
            trackingLink: number === null ? null : trackingLinkOf(customerUrlOfParcel(parcel)), // B-OS-022
            status: last?.status ?? null,
            words: last ? TRACKING_WORDS[last.status] : null,
            lastEvent: last ? eventView(last, parcel.seq) : null,
          }
        }),
      events: [...events].reverse().map((event) => eventView(event, event.parcelId ? (parcelSeq.get(event.parcelId) ?? null) : null)),
      // B-OP-044: this order's own lines first and only (another order's pieces are counted below).
      lines: read.contents
        .filter((row) => row.shipmentId === shipment.id && lineOf.has(row.salesOrderLineId))
        .map((row) => ({ lineSeq: lineOf.get(row.salesOrderLineId)?.seq ?? 0, style: styleOf(row.salesOrderLineId), colourway: colourwayOf(row.salesOrderLineId), size: sizeless.has(row.salesOrderLineId) ? null : row.size, quantity: row.quantity }))
        .sort((a, b) => a.lineSeq - b.lineSeq),
      // B-OP-044 (N6): "also N pieces of your order #12": the customer's other orders on this shipment (B-OP-047: N6 on).
      otherOrders: otherOrdersOn(read, shipment.id, order.partyId),
      papers: read.papers.filter((file) => file.recordId === shipment.id && !walled.has(file.id)).map((file) => ({ fileId: file.id, name: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, versionNo: file.versionNo })),
      atWarehouse: legs.get(shipment.id) ?? null, // owb- po2.6: S3's value as is (null: it goes straight to the customer)
    }
  })

  const progress = progressOfLines(read.lines, read.shipped)
  // Sizes in the style's range order (50, 52, 54), as the order record shows them.
  const placeOf = (lineId: string, size: string | null): number => {
    const range = names.styles.get(lineOf.get(lineId)?.styleId ?? '')?.sizes ?? []
    return size === null || range.indexOf(size) === -1 ? range.length : range.indexOf(size)
  }
  const rows = [...progress.rows].sort((a, b) => a.seq - b.seq || placeOf(a.lineId, a.size) - placeOf(b.lineId, b.size) || (a.size ?? '').localeCompare(b.size ?? ''))
  const open = stillToShipOf(
    rows,
    read.lines.map((line) => ({ id: line.id, seq: line.seq, promiseDate: dayOrNull(line.promiseDate) })),
    dayOrNull(order.promiseDate),
  )
  const expected = open.map((row) => row.expected).filter((day): day is string => day !== null)
  return {
    asOf: toUtcIso(now),
    shipments,
    stillToShip: open.map((row) => ({ ...row, style: styleOf(row.lineId), colourway: colourwayOf(row.lineId) })),
    firstExpected: shipments.length === 0 && expected.length > 0 ? expected.sort()[0]! : null,
    live: LIVE,
  }
}
