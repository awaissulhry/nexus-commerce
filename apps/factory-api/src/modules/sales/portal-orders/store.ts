import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { PromiseMove } from '@nexus/factory-domain/sales/portal-orders/promise'

/**
 * The reads of customer orders in the portal (B-W2b-175). Two kinds, never mixed in one query:
 *
 *   the partner's own (the session's party scope: factory_partner_runtime, row-level security by party): orders, lines,
 *   sizes, deposit requests, portal requests, shipments, their lines, parcels, tracking events, DDTs and the files shared
 *   with the party. Every select names its columns and never one the partner role cannot read (Prisma would fail with
 *   "permission denied"): no cost, no internal note, no office person, no freight cost, no closing reason.
 *
 *   the tenant's (the office scope, read as the person, only AFTER the partner read found the order): the names of the
 *   styles and colourways, the order's audit rows (the promise moves, the days its status moved), the production counts
 *   (work orders, bundles and scans, quality releases) and the customer's PortalSettings — none of them partner-readable.
 *
 * Every reader runs one query at a time (one connection runs one query at a time).
 */

export type Reader = FactoryClient

/** A calendar day stored as @db.Date. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)

/** At most this many orders of a party in one portal answer (a party has far fewer). */
export const ORDERS_MAX = 1000

export const ORDER_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  number: true,
  customerRef: true,
  status: true,
  orderDate: true,
  currency: true,
  language: true,
  shipTo: true,
  paymentTerms: true,
  requestedDate: true,
  promiseDate: true,
  originalPromiseDate: true,
  noWithdrawal: true,
  depositRequired: true,
  netAmount: true,
  vatAmount: true,
  grossAmount: true,
  reapprovalNeededAt: true,
  closedAt: true,
  version: true,
} as const satisfies Prisma.SalesOrderSelect
export type PortalOrderRow = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_SELECT }>

/** The session's company's orders of the party (row-level security keeps them the party's), by promise date. */
export const readOrders = (db: Reader, companyId: string): Promise<PortalOrderRow[]> =>
  db.salesOrder.findMany({ where: { companyId }, select: ORDER_SELECT, orderBy: [{ promiseDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }], take: ORDERS_MAX })

/** One order of the party in the session's company, or null (another party's is as unknown as a wrong id). */
export async function readOrder(db: Reader, companyId: string, orderId: string): Promise<PortalOrderRow | null> {
  if (!isUuid(orderId)) return null
  const row = await db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_SELECT })
  return row && row.companyId === companyId ? row : null
}

export const LINE_SELECT = {
  id: true,
  orderId: true,
  seq: true,
  kind: true,
  styleId: true,
  colourwayId: true,
  measurementProfileId: true,
  baseSize: true,
  description: true,
  quantity: true,
  unitPrice: true,
  netAmount: true,
  vatAmount: true,
  requestedDate: true,
  promiseDate: true,
  closedShortQuantity: true,
  closedShortAt: true,
} as const satisfies Prisma.SalesOrderLineSelect
export type PortalLineRow = Prisma.SalesOrderLineGetPayload<{ select: typeof LINE_SELECT }>

export interface PortalLine extends PortalLineRow {
  readonly sizes: { readonly size: string; readonly quantity: number; readonly unitPrice: Prisma.Decimal | null }[]
}

/** The orders' lines in their order, each with its size rows. */
export async function readLines(db: Reader, orderIds: readonly string[]): Promise<PortalLine[]> {
  if (orderIds.length === 0) return []
  const lines = await db.salesOrderLine.findMany({ where: { orderId: { in: [...orderIds] } }, select: LINE_SELECT, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] })
  if (lines.length === 0) return []
  const sizes = await db.salesOrderLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true } })
  return lines.map((line) => ({ ...line, sizes: sizes.filter((row) => row.lineId === line.id).map(({ size, quantity, unitPrice }) => ({ size, quantity, unitPrice })) }))
}

export const SHIPMENT_SELECT = {
  id: true,
  salesOrderId: true,
  number: true,
  status: true,
  transportBy: true,
  carrierName: true,
  serviceCode: true,
  packedAt: true,
  shippedAt: true,
  deliveredAt: true,
  returnedAt: true,
} as const satisfies Prisma.ShipmentSelect
export type PortalShipmentRow = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_SELECT }>

/** The shipments of these orders (every status: the caller decides what it shows). */
export const readShipments = (db: Reader, orderIds: readonly string[]): Promise<PortalShipmentRow[]> =>
  orderIds.length === 0 ? Promise.resolve([]) : db.shipment.findMany({ where: { salesOrderId: { in: [...orderIds] } }, select: SHIPMENT_SELECT, orderBy: [{ number: 'asc' }] })

/** Shipments whose garments count as shipped (they left; a RETURNED one came back): modules/sales/orders' LEFT. */
export const LEFT = ['SHIPPED', 'DELIVERED'] as const
export const hasLeft = (status: string): boolean => (LEFT as readonly string[]).includes(status)

/** Pieces of each order line and size on these shipments. */
export async function shippedPieces(db: Reader, shipmentIds: readonly string[]): Promise<{ lineId: string; size: string; quantity: number }[]> {
  if (shipmentIds.length === 0) return []
  const rows = await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { shipmentId: { in: [...shipmentIds] } }, _sum: { quantity: true } })
  return rows.map((row) => ({ lineId: row.salesOrderLineId, size: row.size, quantity: row._sum.quantity ?? 0 }))
}

export const SHIPMENT_LINE_SELECT = { shipmentId: true, parcelId: true, salesOrderLineId: true, size: true, quantity: true } as const satisfies Prisma.ShipmentLineSelect
export const readShipmentLines = (db: Reader, shipmentIds: readonly string[]) =>
  shipmentIds.length === 0 ? Promise.resolve([]) : db.shipmentLine.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: SHIPMENT_LINE_SELECT, orderBy: [{ id: 'asc' }] })

export const readParcels = (db: Reader, shipmentIds: readonly string[]) =>
  shipmentIds.length === 0 ? Promise.resolve([]) : db.parcel.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: { id: true, shipmentId: true, seq: true, trackingNumber: true }, orderBy: [{ shipmentId: 'asc' }, { seq: 'asc' }] })

export const TRACKING_SELECT = { id: true, shipmentId: true, parcelId: true, status: true, description: true, location: true, occurredAt: true, recordedAt: true } as const satisfies Prisma.TrackingEventSelect
export type PortalTrackingRow = Prisma.TrackingEventGetPayload<{ select: typeof TRACKING_SELECT }>
export const readTracking = (db: Reader, shipmentIds: readonly string[]): Promise<PortalTrackingRow[]> =>
  shipmentIds.length === 0 ? Promise.resolve([]) : db.trackingEvent.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: TRACKING_SELECT, orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }, { id: 'asc' }] })

/** Each shipment's live DDT (the newest one not cancelled): number and date. */
export async function liveDdts(db: Reader, shipmentIds: readonly string[]): Promise<Map<string, { number: string; date: BusinessDate }>> {
  if (shipmentIds.length === 0) return new Map()
  const ddts = await db.ddt.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: { id: true, shipmentId: true, number: true, documentDate: true, issuedAt: true }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }] })
  if (ddts.length === 0) return new Map()
  const cancelled = new Set((await db.ddtCancellation.findMany({ where: { ddtId: { in: ddts.map((row) => row.id) } }, select: { ddtId: true } })).map((row) => row.ddtId))
  const live = new Map<string, { number: string; date: BusinessDate }>()
  for (const ddt of ddts) if (ddt.shipmentId && !cancelled.has(ddt.id) && !live.has(ddt.shipmentId)) live.set(ddt.shipmentId, { number: ddt.number, date: dayOf(ddt.documentDate) })
  return live
}

/** The shipments' papers the office shared with the party's portal (available, the newest version of each). */
export const readPapers = (db: Reader, shipmentIds: readonly string[]) =>
  shipmentIds.length === 0
    ? Promise.resolve([])
    : db.storedFile.findMany({
        where: { recordType: 'Shipment', recordId: { in: [...shipmentIds] }, status: 'AVAILABLE', supersededAt: null, visibility: { has: 'PARTNER' } },
        select: { id: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, versionNo: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })

/** The portal requests the orders came from (their send is the day the customer asked). */
export async function requestSends(db: Reader, orderIds: readonly string[]): Promise<Map<string, Date>> {
  if (orderIds.length === 0) return new Map()
  const rows = await db.portalOrderRequest.findMany({ where: { salesOrderId: { in: [...orderIds] }, sentAt: { not: null } }, select: { salesOrderId: true, sentAt: true } })
  return new Map(rows.flatMap((row) => (row.salesOrderId && row.sentAt ? [[row.salesOrderId, row.sentAt] as const] : [])))
}

/** The party's SENT portal requests with no order yet (the list's "Requested"), with their pieces. */
export async function sentRequests(db: Reader, companyId: string) {
  const requests = await db.portalOrderRequest.findMany({
    where: { companyId, status: 'SENT' },
    select: { id: true, number: true, customerRef: true, requestedDate: true, sentAt: true, currency: true },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    take: ORDERS_MAX,
  })
  if (requests.length === 0) return []
  const lines = await db.portalOrderRequestLine.findMany({ where: { requestId: { in: requests.map((row) => row.id) } }, select: { id: true, requestId: true, styleId: true } })
  const sizes = lines.length > 0 ? await db.portalOrderRequestSize.groupBy({ by: ['lineId'], where: { lineId: { in: lines.map((line) => line.id) } }, _sum: { quantity: true } }) : []
  const piecesOf = new Map(sizes.map((row) => [row.lineId, row._sum.quantity ?? 0]))
  return requests.map((request) => {
    const mine = lines.filter((line) => line.requestId === request.id)
    return { ...request, styleIds: [...new Set(mine.map((line) => line.styleId))], pieces: mine.reduce((sum, line) => sum + (piecesOf.get(line.id) ?? 0), 0) }
  })
}

export const DEPOSIT_SELECT = { id: true, orderId: true, kind: true, status: true, currency: true, amount: true, dueDate: true, paidAt: true } as const satisfies Prisma.DepositRequestSelect
export const readDeposits = (db: Reader, orderId: string) => db.depositRequest.findMany({ where: { orderId }, select: DEPOSIT_SELECT, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })

/** A made-to-measure line's rider and measurement revision (the party's own profiles). */
export const readProfiles = (db: Reader, profileIds: readonly string[]) =>
  profileIds.length === 0 ? Promise.resolve([]) : db.measurementProfile.findMany({ where: { id: { in: [...profileIds] } }, select: { id: true, riderName: true, revision: true } })

// ---- the tenant's reads (office scope, after the partner read found the order) ------------------------------------------

/** The styles and colourways the lines name: code and name only. */
export async function namesOf(db: Reader, styleIds: readonly string[], colourwayIds: readonly string[]) {
  const styles = styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: [...styleIds] } }, select: { id: true, code: true, name: true, sizes: true } }) : []
  const colourways = colourwayIds.length > 0 ? await db.colourway.findMany({ where: { id: { in: [...colourwayIds] } }, select: { id: true, code: true, name: true } }) : []
  return { styles: new Map(styles.map((row) => [row.id, row])), colourways: new Map(colourways.map((row) => [row.id, row])) }
}

/** The party's styles among these whose code or name holds the words searched. */
export async function stylesMatching(db: Reader, styleIds: readonly string[], q: string): Promise<Set<string>> {
  if (styleIds.length === 0) return new Set()
  const rows = await db.style.findMany({ where: { id: { in: [...styleIds] }, OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }, select: { id: true } })
  return new Set(rows.map((row) => row.id))
}

interface StatusAudit {
  status?: unknown
  promiseDate?: unknown
  previous?: unknown
  lineIds?: unknown
}

export interface OrderHistory {
  /** The first time the order reached each status (the office's moves and the system's). */
  readonly reached: ReadonlyMap<string, Date>
  readonly moves: readonly PromiseMove[]
}

/** The order's audit rows read for the customer: when each status was first reached, and the promise moves. */
export async function orderHistory(db: Reader, orderId: string): Promise<OrderHistory> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'SalesOrder', recordId: orderId }, select: { at: true, action: true, after: true, reason: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const reached = new Map<string, Date>()
  const moves: PromiseMove[] = []
  for (const row of rows) {
    const after = (row.after ?? {}) as StatusAudit
    if (typeof after.status === 'string' && !reached.has(after.status)) reached.set(after.status, row.at)
    if (row.action === 'orders.changePromise' && typeof after.promiseDate === 'string') {
      moves.push({
        at: row.at,
        from: typeof after.previous === 'string' ? after.previous : null,
        to: after.promiseDate,
        lineIds: Array.isArray(after.lineIds) ? after.lineIds.filter((id): id is string => typeof id === 'string') : [],
        reason: row.reason,
      })
    }
  }
  return { reached, moves }
}

/** When each of these orders' promise last moved (the list's "Date moved"). */
export async function lastPromiseMoves(db: Reader, orderIds: readonly string[], since: Date): Promise<Map<string, Date>> {
  if (orderIds.length === 0) return new Map()
  const rows = await db.auditLog.findMany({ where: { recordType: 'SalesOrder', recordId: { in: [...orderIds] }, action: 'orders.changePromise', at: { gte: since } }, select: { recordId: true, at: true } })
  const last = new Map<string, Date>()
  for (const row of rows) if (!last.has(row.recordId) || last.get(row.recordId)! < row.at) last.set(row.recordId, row.at)
  return last
}

/** The first work order released for the order's lines (production started), when the audit has no move for it. */
export async function firstRelease(db: Reader, lineIds: readonly string[]): Promise<Date | null> {
  if (lineIds.length === 0) return null
  const cells = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: [...lineIds] }, workOrder: { kind: { not: 'REPAIR' } } }, select: { workOrderId: true } })
  if (cells.length === 0) return null
  const first = await db.workOrder.findFirst({ where: { id: { in: [...new Set(cells.map((cell) => cell.workOrderId))] }, releasedAt: { not: null } }, select: { releasedAt: true }, orderBy: { releasedAt: 'asc' } })
  return first?.releasedAt ?? null
}

/** The customer shares production progress (C1): its PortalSettings row, read in the tenant's scope. */
export async function progressShared(db: Reader, partyId: string): Promise<boolean> {
  const settings = await db.portalSettings.findUnique({ where: { id: partyId }, select: { partyId: true, progressShared: true } })
  return settings?.partyId === partyId && settings.progressShared
}
