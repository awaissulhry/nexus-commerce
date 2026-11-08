import type { FastifyInstance, FastifyRequest } from 'fastify'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { orderProgress, type OrderProgress } from '@nexus/factory-domain/sales/orders/orders'
import { customerPromiseHistory } from '@nexus/factory-domain/sales/portal-orders/promise'
import { customerEtaOf, customerShipmentStatusOf, isOnTheWay, SHIPMENT_STATUS_WORDS, SHOWN_SHIPMENT_STATUSES } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { chipCounts, CUSTOMER_STATUS_WORDS, customerStatusOf, DATE_MOVED_DAYS, inChip, isStillToShip, milestonesOf, type CustomerOrderStatus, type OrderChip } from '@nexus/factory-domain/sales/portal-orders/status'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import type { TrackingStatus } from '@nexus/factory-domain/shipping/labels/tracking'
import { partnerOrder, portalReader } from './access'
import { progressFor } from './progress'
import {
  dayOf,
  dayOrNull,
  firstRelease,
  hasLeft,
  lastPromiseMoves,
  namesOf,
  orderHistory,
  progressShared,
  readDeposits,
  readLines,
  readOrders,
  readProfiles,
  readShipments,
  readTracking,
  requestSends,
  sentRequests,
  shippedPieces,
  stylesMatching,
  type PortalLine,
  type PortalOrderRow,
  type PortalShipmentRow,
} from './store'

/**
 * A customer's orders in the portal (B-W2b-175; SAL-075, SAL-081; design portal.customer.orders "Which orders", "Your
 * orders", the record's Status & progress and Lines tabs; portal.customer.home "Your next deliveries"):
 *
 *   GET /portal/sales-orders              the party's orders in the portal's company and its portal requests waiting for
 *                                         us, their PO first, the status in their words, the promise (moved mark), pieces
 *                                         ordered / shipped / open, the value (price grain), the next shipment; chips with
 *                                         counts; search by their PO, our number or a style; sorted by promise date
 *   GET /portal/sales-orders/:orderId     the order: the six steps with their days, the promise and every move in their
 *                                         words, the facts agreed, the deposits, the lines and sizes with what is open
 * Reads only: the partner's rows in its party's scope, then (for its own orders only) the tenant's names, audit rows and
 * settings in the office scope. Never an office person, never a cost, never the office's typed reason.
 */

const PROGRESS_ROWS = 10
const LIVE = { events: ['partner_notification.created'] }

const text = (value: { toString(): string } | null): string | null => (value === null ? null : priceText(value.toString()))

/** Pieces ordered, shipped and open of each line (a line closed short has nothing open). */
function piecesOfLines(lines: readonly PortalLine[], shipped: readonly { lineId: string; quantity: number }[]) {
  const out = new Map<string, number>()
  for (const row of shipped) out.set(row.lineId, (out.get(row.lineId) ?? 0) + row.quantity)
  return new Map(
    lines.map((line) => {
      const left = out.get(line.id) ?? 0
      return [line.id, { ordered: line.quantity, shipped: left, open: line.closedShortQuantity !== null ? 0 : Math.max(0, line.quantity - left) }] as const
    }),
  )
}

const sumPieces = (rows: readonly { ordered: number; shipped: number; open: number }[]) => ({
  ordered: rows.reduce((sum, row) => sum + row.ordered, 0),
  shipped: rows.reduce((sum, row) => sum + row.shipped, 0),
  open: rows.reduce((sum, row) => sum + row.open, 0),
})

/** The shipment the customer waits for next: one on the way, else one packed. */
function nextShipmentOf(shipments: readonly PortalShipmentRow[], latest: ReadonlyMap<string, TrackingStatus[]>) {
  const onTheWay = shipments.filter((row) => isOnTheWay(row.status)).sort((a, b) => (a.shippedAt?.getTime() ?? 0) - (b.shippedAt?.getTime() ?? 0))[0]
  const packed = shipments.filter((row) => row.status === 'PACKED').sort((a, b) => (a.packedAt?.getTime() ?? 0) - (b.packedAt?.getTime() ?? 0))[0]
  const next = onTheWay ?? packed
  if (!next) return null
  const status = customerShipmentStatusOf(next.status, latest.get(next.id) ?? [])
  const eta = customerEtaOf(next.status, next.expectedDeliveryAt)
  return { id: next.id, number: next.number, status, words: SHIPMENT_STATUS_WORDS[status], date: dayOrNull(next.shippedAt ?? next.packedAt), carrierName: next.carrierName, expectedDeliveryAt: eta ? toUtcIso(eta) : null }
}

/**
 * Each shipment's parcels' latest tracking statuses, from its events in time order: an event of the whole shipment (no
 * parcel) is news for every parcel tracked so far, or the shipment's only status while no parcel has an event.
 */
export function latestByShipment(events: readonly { shipmentId: string; parcelId: string | null; status: TrackingStatus }[]): Map<string, TrackingStatus[]> {
  const latest = new Map<string, { parcels: Map<string, TrackingStatus>; whole: TrackingStatus | null }>()
  for (const event of events) {
    const entry = latest.get(event.shipmentId) ?? { parcels: new Map<string, TrackingStatus>(), whole: null }
    if (event.parcelId === null) {
      entry.whole = event.status
      for (const parcelId of entry.parcels.keys()) entry.parcels.set(parcelId, event.status)
    } else entry.parcels.set(event.parcelId, event.status)
    latest.set(event.shipmentId, entry)
  }
  return new Map([...latest].map(([shipmentId, entry]) => [shipmentId, entry.parcels.size > 0 ? [...entry.parcels.values()] : entry.whole ? [entry.whole] : []]))
}

/** The customer's status of an order from its shipments. */
export function statusOfOrder(order: Pick<PortalOrderRow, 'status'>, shipments: readonly PortalShipmentRow[]): CustomerOrderStatus {
  const left = shipments.filter((row) => hasLeft(row.status))
  return customerStatusOf(order.status, { left: left.length, delivered: left.filter((row) => row.status === 'DELIVERED').length })
}

export interface ListQuery {
  readonly chip: OrderChip
  readonly q?: string | undefined
  readonly progress: 'true' | 'false'
  readonly limit: number
  readonly offset: number
}

export async function listOrders(app: FastifyInstance, request: FastifyRequest, query: ListQuery, now: Date) {
  const reader = portalReader(app, request)
  const companyId = reader.session.company.id
  const read = await request.withClient(async (client) => {
    const orders = await readOrders(client, companyId)
    const ids = orders.map((order) => order.id)
    const lines = await readLines(client, ids)
    const shipments = await readShipments(client, ids)
    const shown = shipments.filter((row) => SHOWN_SHIPMENT_STATUSES.includes(row.status))
    const shipped = await shippedPieces(client, shipments.filter((row) => hasLeft(row.status)).map((row) => row.id))
    const tracking = await readTracking(client, shown.filter((row) => isOnTheWay(row.status)).map((row) => row.id))
    const requests = await sentRequests(client, companyId)
    return { orders, lines, shipments: shown, shipped, tracking, requests }
  })
  const since = new Date(now.getTime() - DATE_MOVED_DAYS * 86_400_000)
  const q = query.q?.trim() ?? ''
  const styleIds = [...new Set([...read.lines.map((line) => line.styleId), ...read.requests.flatMap((request) => request.styleIds)])]
  const tenant = await reader.inTenant(async (client) => ({
    moved: await lastPromiseMoves(client, read.orders.map((order) => order.id), since),
    matching: q === '' ? new Set<string>() : await stylesMatching(client, styleIds, q),
    shared: await progressShared(client, reader.session.partyId),
  }))
  const latest = latestByShipment(read.tracking)
  const pieces = piecesOfLines(read.lines, read.shipped)
  const found = (values: readonly (string | null)[], styles: readonly string[]): boolean =>
    q === '' || values.some((value) => value !== null && value.toLowerCase().includes(q.toLowerCase())) || styles.some((styleId) => tenant.matching.has(styleId))

  const orderRows = read.orders.map((order) => {
    const lines = read.lines.filter((line) => line.orderId === order.id)
    const shipments = read.shipments.filter((row) => row.salesOrderId === order.id)
    const status = statusOfOrder(order, shipments)
    const promiseDate = dayOrNull(order.promiseDate)
    const originalPromiseDate = dayOrNull(order.originalPromiseDate)
    return {
      sortKey: promiseDate ?? '9999-12-31',
      styles: lines.map((line) => line.styleId),
      row: {
        kind: 'ORDER' as const,
        id: order.id,
        customerRef: order.customerRef,
        number: order.number,
        orderedOn: dayOf(order.orderDate),
        status,
        words: CUSTOMER_STATUS_WORDS[status],
        promiseDate,
        originalPromiseDate,
        promiseMoved: originalPromiseDate !== null && promiseDate !== originalPromiseDate,
        movedLately: tenant.moved.has(order.id),
        requestedDate: dayOrNull(order.requestedDate),
        pieces: sumPieces(lines.map((line) => pieces.get(line.id)!)),
        netAmount: asMoney('price', order.netAmount),
        currency: order.currency,
        nextShipment: nextShipmentOf(shipments, latest),
        progressPercent: null as number | null,
      },
    }
  })
  const requestRows = read.requests.map((request) => ({
    sortKey: dayOrNull(request.requestedDate) ?? '9999-12-31',
    styles: request.styleIds,
    row: {
      kind: 'REQUEST' as const,
      id: request.id,
      customerRef: request.customerRef,
      number: request.number,
      orderedOn: request.sentAt ? businessDate(request.sentAt) : null,
      status: 'REQUESTED' as CustomerOrderStatus,
      words: CUSTOMER_STATUS_WORDS.REQUESTED,
      promiseDate: null,
      originalPromiseDate: null,
      promiseMoved: false,
      movedLately: false,
      requestedDate: dayOrNull(request.requestedDate),
      pieces: { ordered: request.pieces, shipped: 0, open: request.pieces },
      netAmount: asMoney('price', null as number | null),
      currency: request.currency,
      nextShipment: null,
      progressPercent: null as number | null,
    },
  }))
  const searched = [...orderRows, ...requestRows].filter((entry) => found([entry.row.customerRef, entry.row.number], entry.styles))
  const inChipRows = searched.filter((entry) => inChip(query.chip, entry.row.status, entry.row.movedLately))
  inChipRows.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || (a.row.number ?? '').localeCompare(b.row.number ?? ''))
  const page = inChipRows.slice(query.offset, query.offset + query.limit).map((entry) => entry.row)
  if (query.progress === 'true' && tenant.shared) {
    for (const row of page.slice(0, PROGRESS_ROWS)) {
      if (row.kind !== 'ORDER' || !isStillToShip(row.status)) continue
      const lines = read.lines.filter((line) => line.orderId === row.id)
      row.progressPercent = (await progressFor(reader, row.id, lines, now)).view.percent
    }
  }
  return {
    asOf: toUtcIso(now),
    seesPrices: reader.seesPrices,
    progressShared: tenant.shared,
    chip: query.chip,
    chips: chipCounts(searched.map((entry) => entry.row)),
    count: inChipRows.length,
    items: page,
    live: LIVE,
  }
}

// ---- one order ------------------------------------------------------------------------------------------------------------------

/** Each line's pieces per size: ordered, shipped, open, closed short (sales/orders orderProgress over the partner's rows). */
export function progressOfLines(lines: readonly PortalLine[], shipped: readonly { lineId: string; size: string; quantity: number }[]): OrderProgress {
  return orderProgress({
    lines: lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })) })),
    inWorkOrders: [],
    released: [],
    shipped,
    invoiced: [],
    closedShort: new Set(lines.filter((line) => line.closedShortQuantity !== null).map((line) => line.id)),
  })
}

export async function orderRecord(app: FastifyInstance, request: FastifyRequest, orderId: string, now: Date) {
  const reader = portalReader(app, request)
  const order = await partnerOrder(request, reader, orderId)
  const read = await request.withClient(async (client) => {
    const lines = await readLines(client, [order.id])
    const shipments = (await readShipments(client, [order.id])).filter((row) => SHOWN_SHIPMENT_STATUSES.includes(row.status))
    const shipped = await shippedPieces(client, shipments.filter((row) => hasLeft(row.status)).map((row) => row.id))
    const deposits = await readDeposits(client, order.id)
    const profiles = await readProfiles(client, [...new Set(lines.flatMap((line) => (line.measurementProfileId ? [line.measurementProfileId] : [])))])
    const sent = (await requestSends(client, [order.id])).get(order.id) ?? null
    return { lines, shipments, shipped, deposits, profiles, sent }
  })
  const tenant = await reader.inTenant(async (client) => ({
    history: await orderHistory(client, order.id),
    names: await namesOf(client, [...new Set(read.lines.map((line) => line.styleId))], [...new Set(read.lines.map((line) => line.colourwayId))]),
    released: await firstRelease(client, read.lines.map((line) => line.id)),
    shared: await progressShared(client, reader.session.partyId),
  }))
  const status = statusOfOrder(order, read.shipments)
  const left = read.shipments.filter((row) => hasLeft(row.status))
  const firstShipped = left.reduce<Date | null>((first, row) => (row.shippedAt && (first === null || row.shippedAt < first) ? row.shippedAt : first), null)
  const lastShipped = left.reduce<Date | null>((last, row) => (row.shippedAt && (last === null || row.shippedAt > last) ? row.shippedAt : last), null)
  const lastDelivered = left.reduce<Date | null>((last, row) => (row.deliveredAt && (last === null || row.deliveredAt > last) ? row.deliveredAt : last), null)
  const reachedOn = (key: string): BusinessDate | null => {
    const at = tenant.history.reached.get(key)
    return at ? businessDate(at) : null
  }
  const promiseDate = dayOrNull(order.promiseDate)
  const originalPromiseDate = dayOrNull(order.originalPromiseDate)
  const milestones = milestonesOf({
    status,
    requestedOn: read.sent ? businessDate(read.sent) : dayOf(order.orderDate),
    confirmedOn: dayOf(order.orderDate),
    productionOn: reachedOn('IN_PRODUCTION') ?? (tenant.released ? businessDate(tenant.released) : null),
    readyOn: reachedOn('READY'),
    firstShippedOn: firstShipped ? businessDate(firstShipped) : null,
    allShippedOn: reachedOn('SHIPPED') ?? (status === 'SHIPPED' || status === 'DELIVERED' ? (lastShipped ? businessDate(lastShipped) : null) : null),
    deliveredOn: status === 'DELIVERED' && lastDelivered ? businessDate(lastDelivered) : null,
    promiseDate,
  })
  const seqOf = new Map(read.lines.map((line) => [line.id, line.seq]))
  const progress = progressOfLines(read.lines, read.shipped)
  const profiles = new Map(read.profiles.map((row) => [row.id, row]))
  const lines = read.lines.map((line) => {
    const style = tenant.names.styles.get(line.styleId)
    const colourway = tenant.names.colourways.get(line.colourwayId)
    const range = style?.sizes ?? []
    const place = (size: string | null) => (size === null || range.indexOf(size) === -1 ? range.length : range.indexOf(size))
    const rows = progress.rows.filter((row) => row.lineId === line.id).sort((a, b) => place(a.size) - place(b.size) || (a.size ?? '').localeCompare(b.size ?? ''))
    const priceOf = (size: string | null) => text(line.sizes.find((entry) => entry.size === size)?.unitPrice ?? null)
    const profile = line.measurementProfileId ? profiles.get(line.measurementProfileId) : undefined
    const totals = progress.lines.find((entry) => entry.lineId === line.id)!
    return {
      id: line.id,
      seq: line.seq,
      kind: line.kind,
      style: style ? { code: style.code, name: style.name } : null,
      colourway: colourway ? { code: colourway.code, name: colourway.name } : null,
      description: line.description,
      measurement: profile ? { riderName: profile.riderName, revision: profile.revision } : null,
      baseSize: line.baseSize,
      quantity: line.quantity,
      unitPrice: asMoney('price', text(line.unitPrice)!),
      netAmount: asMoney('price', line.netAmount),
      vatAmount: asMoney('price', line.vatAmount),
      requestedDate: dayOrNull(line.requestedDate),
      promiseDate: dayOrNull(line.promiseDate),
      closedShort: line.closedShortQuantity === null ? null : { quantity: line.closedShortQuantity, on: line.closedShortAt ? businessDate(line.closedShortAt) : null },
      sizes: rows.map((row) => ({ size: row.size, ordered: row.ordered, shipped: row.shipped, open: row.toShip, closedShort: row.closedShort, unitPrice: asMoney('price', priceOf(row.size)) })),
      pieces: { ordered: totals.ordered, shipped: totals.shipped, open: totals.toShip },
    }
  })
  return {
    asOf: toUtcIso(now),
    seesPrices: reader.seesPrices,
    order: {
      id: order.id,
      customerRef: order.customerRef,
      number: order.number,
      status,
      words: CUSTOMER_STATUS_WORDS[status],
      orderDate: dayOf(order.orderDate),
      requestedDate: dayOrNull(order.requestedDate),
      promiseDate,
      originalPromiseDate,
      promiseMoved: originalPromiseDate !== null && promiseDate !== originalPromiseDate,
      currency: order.currency,
      language: order.language,
      shipTo: order.shipTo as Record<string, unknown>,
      paymentTerms: order.paymentTerms,
      noWithdrawal: order.noWithdrawal,
      depositRequired: order.depositRequired,
      netAmount: asMoney('price', order.netAmount),
      vatAmount: asMoney('price', order.vatAmount),
      grossAmount: asMoney('price', order.grossAmount),
      reconfirmNeeded: order.reapprovalNeededAt !== null,
      cancelledOn: order.status === 'CANCELLED' && order.closedAt ? businessDate(order.closedAt) : null,
      version: order.version,
    },
    milestones,
    promiseHistory: customerPromiseHistory(tenant.history.moves, (lineId) => seqOf.get(lineId)).map((move) => ({ ...move, lines: [...move.lines] })),
    deposits: read.deposits.map((row) => ({ id: row.id, kind: row.kind, status: row.status, amount: asMoney('price', row.amount), currency: row.currency, dueDate: dayOf(row.dueDate), paidAt: row.paidAt ? toUtcIso(row.paidAt) : null })),
    lines,
    pieces: { ordered: progress.totals.ordered, shipped: progress.totals.shipped, open: progress.totals.toShip, closedShort: progress.totals.closedShort },
    progressShared: tenant.shared,
    shipments: { shown: read.shipments.length, onTheWay: read.shipments.filter((row) => isOnTheWay(row.status)).length },
    live: LIVE,
  }
}
