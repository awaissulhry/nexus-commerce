import type { FastifyInstance, FastifyRequest } from 'fastify'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { customerShipmentStatusOf, isOnTheWay, SHIPMENT_STATUS_WORDS, shipmentMilestonesOf, SHOWN_SHIPMENT_STATUSES, stillToShipOf, TRACKING_WORDS } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { partnerOrder, portalReader } from './access'
import { latestByShipment, progressOfLines } from './orders'
import { dayOrNull, hasLeft, liveDdts, namesOf, readLines, readOrders, readPapers, readParcels, readShipmentLines, readShipments, readTracking, shippedPieces, type PortalTrackingRow } from './store'

/**
 * Shipments and tracking for the customer (B-W2b-175; SAL-080, SAL-081; design portal.customer.orders › Shipments &
 * tracking, "On the way"):
 *
 *   GET /portal/sales-orders/:orderId/shipments   each shipment that was packed or left: its DDT (number, date), carrier,
 *                                                 parcels with their tracking number and latest status, the four steps
 *                                                 (Packed, Collected, In transit, Delivered), the carrier's events, what it
 *                                                 carries, the papers shared with the portal; and what is still to ship per
 *                                                 line and size with the day expected (backorders after a partial shipment)
 *   GET /portal/sales-orders/in-transit           every shipment of the party on the way, across its orders
 * Partner reads only (the party's scope); the style and colourway names are the tenant's (office scope, after the partner
 * read). The carrier's own words of an event pass as written; no office note, no freight, no person.
 */

const LIVE = { events: ['partner_notification.created'] }

function eventView(event: PortalTrackingRow, parcelSeq: number | null) {
  return { at: toUtcIso(event.occurredAt), status: event.status, words: TRACKING_WORDS[event.status], description: event.description, location: event.location, parcelSeq }
}

export async function orderShipments(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  const read = await request.withClient(async (client) => {
    const lines = await readLines(client, [order.id])
    const shipments = (await readShipments(client, [order.id])).filter((row) => SHOWN_SHIPMENT_STATUSES.includes(row.status))
    const ids = shipments.map((row) => row.id)
    return {
      lines,
      shipments,
      shipped: await shippedPieces(client, shipments.filter((row) => hasLeft(row.status)).map((row) => row.id)),
      contents: await readShipmentLines(client, ids),
      parcels: await readParcels(client, ids),
      tracking: await readTracking(client, ids),
      ddts: await liveDdts(client, ids),
      papers: await readPapers(client, ids),
    }
  })
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
      number: shipment.number,
      status,
      words: SHIPMENT_STATUS_WORDS[status],
      transportBy: shipment.transportBy,
      carrierName: shipment.carrierName,
      packedAt: shipment.packedAt ? toUtcIso(shipment.packedAt) : null,
      shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null,
      deliveredAt: shipment.deliveredAt ? toUtcIso(shipment.deliveredAt) : null,
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
          return { seq: parcel.seq, trackingNumber: parcel.trackingNumber, status: last?.status ?? null, words: last ? TRACKING_WORDS[last.status] : null, lastEvent: last ? eventView(last, parcel.seq) : null }
        }),
      events: [...events].reverse().map((event) => eventView(event, event.parcelId ? (parcelSeq.get(event.parcelId) ?? null) : null)),
      lines: read.contents
        .filter((row) => row.shipmentId === shipment.id)
        .map((row) => ({ lineSeq: lineOf.get(row.salesOrderLineId)?.seq ?? 0, style: styleOf(row.salesOrderLineId), colourway: colourwayOf(row.salesOrderLineId), size: sizeless.has(row.salesOrderLineId) ? null : row.size, quantity: row.quantity }))
        .sort((a, b) => a.lineSeq - b.lineSeq),
      papers: read.papers.filter((file) => file.recordId === shipment.id).map((file) => ({ fileId: file.id, name: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, versionNo: file.versionNo })),
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

export async function inTransit(app: FastifyInstance, request: FastifyRequest, now: Date) {
  const reader = portalReader(app, request)
  const read = await request.withClient(async (client) => {
    const orders = await readOrders(client, reader.session.company.id)
    const shipments = (await readShipments(client, orders.map((order) => order.id))).filter((row) => isOnTheWay(row.status))
    const ids = shipments.map((row) => row.id)
    return { orders, shipments, parcels: await readParcels(client, ids), tracking: await readTracking(client, ids) }
  })
  const orderOf = new Map(read.orders.map((order) => [order.id, order]))
  const latest = latestByShipment(read.tracking)
  const parcelSeq = new Map(read.parcels.map((parcel) => [parcel.id, parcel.seq]))
  const items = read.shipments
    .sort((a, b) => (a.shippedAt?.getTime() ?? 0) - (b.shippedAt?.getTime() ?? 0))
    .map((shipment) => {
      const order = orderOf.get(shipment.salesOrderId)!
      const status = customerShipmentStatusOf(shipment.status, latest.get(shipment.id) ?? [])
      const last = read.tracking.filter((event) => event.shipmentId === shipment.id).at(-1) ?? null
      return {
        shipmentId: shipment.id,
        number: shipment.number,
        order: { id: order.id, number: order.number, customerRef: order.customerRef },
        status,
        words: SHIPMENT_STATUS_WORDS[status],
        carrierName: shipment.carrierName,
        shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null,
        trackingNumbers: read.parcels.filter((parcel) => parcel.shipmentId === shipment.id && parcel.trackingNumber !== null).map((parcel) => parcel.trackingNumber!),
        lastEvent: last ? eventView(last, last.parcelId ? (parcelSeq.get(last.parcelId) ?? null) : null) : null,
      }
    })
  return { asOf: toUtcIso(now), items, live: LIVE }
}
