import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { orderProgress, type OrderProgress, type PieceCount, type SalesOrderFacts, type SalesOrderStatus, type SettlementAnswer } from '@nexus/factory-domain/sales/orders/orders'
import { releasedPiecesOf } from '@nexus/factory-domain/sales/orders/orders' // B-OO-002: Mark ready's held counts
import { StaleVersionError, type CommandTx } from '../../../core/command'
// B-OP-043 (order page N6, lines-derived): a shipment's orders are its lines' orders (the first order first).
import { orderRefsOfShipments, shipmentsOfOrderWhere } from '../../shipping/shipments/orders-of'
// B-OS-001 (order shipments tab): each shipment's holds in force, by Warehouse's own reader.
import { holdsInForceBy, type HoldRow } from '../../shipping/holds/store'
// B-OS-002 (order shipments tab): planned and ready now by Warehouse's own backorder reader (one rule).
import { readBackorders } from '../../shipping/shipments/backorder'

/**
 * The sales orders' reads (factory-db sales.prisma SalesOrder, SalesOrderLine, SalesOrderLineSize, and what follows an
 * order: its work order cells, quality releases, shipments and invoice lines). Every read names its columns and none
 * selects a relation or runs two queries at once (inside a command's transaction Prisma would send them together on its
 * one connection); a reader takes the command's transaction or a scoped client, and row-level security decides what it
 * finds.
 */

export type Reader = FactoryClient | CommandTx

/** A calendar day stored as @db.Date. */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayOrNull = (value: Date | null): BusinessDate | null => (value ? dayOf(value) : null)
export const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

export const ORDER_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  number: true,
  quoteVersionId: true,
  customerRef: true,
  // B-SA-070b: the customer's own running number of its orders ("Your order 12"; null: made before it was given).
  customerSeq: true,
  status: true,
  orderDate: true,
  currency: true,
  language: true,
  taxMode: true,
  billTo: true,
  shipTo: true,
  // B-OO-013 (order overview §7): the delivery terms as accepted (copied from the quote, quote-terms/carry.ts) or typed.
  incoterm: true,
  incotermPlace: true,
  shipComplete: true,
  paymentTerms: true,
  // B-W2a-30: the library terms its payment schedule comes from.
  paymentTermsId: true,
  requestedDate: true,
  promiseDate: true,
  originalPromiseDate: true,
  priority: true,
  noWithdrawal: true,
  depositRequired: true,
  netAmount: true,
  vatAmount: true,
  grossAmount: true,
  costAmount: true,
  reapprovalNeededAt: true,
  cancelReason: true,
  closedAt: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SalesOrderSelect
export type OrderRow = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_COLUMNS }>

export async function readOrder(db: Reader, orderId: string): Promise<OrderRow | null> {
  if (!isUuid(orderId)) return null
  return db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_COLUMNS })
}

/**
 * Inside a command: the order's row locked (FOR UPDATE) and its state now, at the version the caller read (COL-078: a
 * stale version is a 409 naming the current one). A command on an order locks it here instead of command()'s record
 * guard: the guard's version bump is a write, and the …_sales_guards trigger refuses any write to a CLOSED or CANCELLED
 * order, so the state is read (and refused in words) before anything is written. Each write of the command then moves
 * the version by one.
 */
export async function lockOrder(tx: CommandTx, orderId: string, expectedVersion?: number): Promise<{ status: SalesOrderStatus; version: number }> {
  const rows = await tx.$queryRaw<{ status: SalesOrderStatus; version: number }[]>`SELECT status::text AS status, version FROM "SalesOrder" WHERE id = ${orderId}::uuid FOR UPDATE`
  const row = rows[0]
  if (!row) throw new NotFoundError('Sales order not found.')
  if (expectedVersion !== undefined && expectedVersion !== row.version) throw new StaleVersionError('SalesOrder', orderId, row.version, expectedVersion)
  return row
}

export const LINE_COLUMNS = {
  id: true,
  orderId: true,
  seq: true,
  kind: true,
  quoteLineId: true,
  styleId: true,
  styleRevisionId: true,
  colourwayId: true,
  measurementProfileId: true,
  baseSize: true,
  description: true,
  note: true,
  quantity: true,
  unitPrice: true,
  netAmount: true,
  vatRatePct: true,
  vatNature: true,
  vatAmount: true,
  unitCost: true,
  costAmount: true,
  requestedDate: true,
  promiseDate: true,
  priority: true,
  siteId: true,
  // B-W2a-30 (SAL-210): closed short — all four or none.
  closedShortQuantity: true,
  closedShortAt: true,
  closedShortById: true,
  closeShortReason: true,
  // B-W2b-16: the CANCEL reason code of the close (kept as text; cleared on reopen).
  closedShortReasonCode: true,
  version: true,
} as const satisfies Prisma.SalesOrderLineSelect
export type LineRow = Prisma.SalesOrderLineGetPayload<{ select: typeof LINE_COLUMNS }>

export interface LineRecord extends LineRow {
  readonly sizes: { readonly size: string; readonly quantity: number; readonly unitPrice: Prisma.Decimal | null }[]
}

/** The order's lines in their order, each with its size rows. */
export async function readLines(db: Reader, orderId: string): Promise<LineRecord[]> {
  const lines = await db.salesOrderLine.findMany({ where: { orderId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
  if (lines.length === 0) return []
  const sizes = await db.salesOrderLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true } })
  return lines.map((line) => ({ ...line, sizes: sizes.filter((row) => row.lineId === line.id).map(({ size, quantity, unitPrice }) => ({ size, quantity, unitPrice })) }))
}

export interface WorkOrderLink {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly siteId: string
  readonly releasedAt: Date | null
}

export interface ShipmentLink {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly shippedAt: Date | null
  readonly deliveredAt: Date | null
  // ── B-OP-043 (order page N6, lines-derived): its first order, how it was made, its paper DDT, every order it carries ──
  readonly salesOrderId: string
  readonly origin: 'NEXUS' | 'ELSEWHERE'
  /** A shipment recorded as made elsewhere: the paper DDT it left with (number and date); null otherwise. */
  readonly externalDdt: { readonly number: string; readonly date: Date } | null
  /** Every order it carries (its lines' orders), the first first: all of the order's own customer (the line FK). */
  readonly orders: readonly { readonly id: string; readonly number: string; readonly customerRef: string | null }[]
  // ── end B-OP-043 ──
}

export interface InvoiceLink {
  readonly id: string
  readonly number: string | null
  readonly docType: string
  readonly status: string
  readonly issueDate: Date | null
  /** A deposit invoice (TD02): the request it bills. */
  readonly depositRequestId: string | null
}

/** Everything that followed the order, and its per-size progress. */
export interface OrderFacts {
  readonly lines: LineRecord[]
  readonly progress: OrderProgress
  readonly workOrders: WorkOrderLink[]
  readonly shipments: ShipmentLink[]
  readonly invoices: InvoiceLink[]
}

/** Shipments whose garments count as shipped (they left; a RETURNED one came back). */
export const LEFT = ['SHIPPED', 'DELIVERED'] as const
/** Issued (not DRAFT) invoices count; a TD02 bills the deposit, not the goods. */
const BILLS_GOODS = new Set(['TD01', 'TD24'])
const CREDITS_GOODS = 'TD04'

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/**
 * The order's lines and what followed them: the work orders of its lines (every cell, the work order's state), the
 * quality releases of those cells less their reversals, the garments of its shipments that left, the GOODS lines of
 * issued invoices less issued credit notes; then the per-size progress (factory-domain sales/orders orderProgress).
 */
export async function readOrderFacts(db: Reader, order: Pick<OrderRow, 'id'>): Promise<OrderFacts> {
  const lines = await readLines(db, order.id)
  const lineIds = lines.map((line) => line.id)
  // B-W2a-12: a REPAIR work order's cell repairs a garment the order sold; it is not the order's production.
  const cells = lineIds.length > 0 ? await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds }, workOrder: { kind: { not: 'REPAIR' } } }, select: { id: true, workOrderId: true, salesOrderLineId: true, size: true, quantity: true } }) : []
  const workOrders =
    cells.length > 0
      ? await db.workOrder.findMany({ where: { id: { in: unique(cells.map((cell) => cell.workOrderId)) } }, select: { id: true, number: true, status: true, siteId: true, releasedAt: true }, orderBy: { number: 'asc' } })
      : []
  const statusOf = new Map(workOrders.map((row) => [row.id, row.status as string]))
  const cellIds = cells.map((cell) => cell.id)
  const released = cellIds.length > 0 ? await db.qualityRelease.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const reversed = cellIds.length > 0 ? await db.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } }) : []
  const reversedOf = new Map(reversed.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
  const cellOf = new Map(cells.map((cell) => [cell.id, cell]))

  // B-OP-043 (order page N6, lines-derived): the order's shipments are those made for it and those that carry its garments
  // (the database's factory_order_shipments); each with every order it carries. Shipped counts only this order's lines.
  const shipmentRows = await db.shipment.findMany({
    where: shipmentsOfOrderWhere(order.id),
    select: { id: true, number: true, status: true, shippedAt: true, deliveredAt: true, salesOrderId: true, origin: true, externalDdtNumber: true, externalDdtDate: true },
    orderBy: { number: 'asc' },
  })
  const ordersOf = await orderRefsOfShipments(db, shipmentRows)
  const shipments: ShipmentLink[] = shipmentRows.map(({ externalDdtNumber, externalDdtDate, ...row }) => ({
    ...row,
    externalDdt: externalDdtNumber !== null && externalDdtDate !== null ? { number: externalDdtNumber, date: externalDdtDate } : null,
    orders: (ordersOf.get(row.id) ?? []).map((ref) => ({ id: ref.id, number: ref.number, customerRef: ref.customerRef })),
  }))
  const leftIds = shipments.filter((row) => (LEFT as readonly string[]).includes(row.status)).map((row) => row.id)
  const shipped = leftIds.length > 0 && lineIds.length > 0 ? await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { shipmentId: { in: leftIds }, salesOrderLineId: { in: lineIds } }, _sum: { quantity: true } }) : []

  // B-W2b-330 (SAL-181): a fee line is billed by the SERVICE line that names it (modules/sales/price-waterfall/fee-invoicing).
  const feeIds = lines.filter((line) => line.kind === 'FEE').map((line) => line.id)
  const invoiceLines =
    lineIds.length > 0
      ? await db.invoiceLine.findMany({ where: { salesOrderLineId: { in: lineIds }, OR: [{ kind: 'GOODS' }, ...(feeIds.length > 0 ? [{ kind: 'SERVICE' as const, salesOrderLineId: { in: feeIds } }] : [])] }, select: { invoiceId: true, salesOrderLineId: true, size: true, quantity: true } })
      : []
  const invoices = await db.invoice.findMany({
    where: { OR: [{ salesOrderId: order.id }, ...(invoiceLines.length > 0 ? [{ id: { in: unique(invoiceLines.map((line) => line.invoiceId)) } }] : [])] },
    select: { id: true, number: true, docType: true, status: true, issueDate: true, depositRequestId: true },
    orderBy: [{ issueDate: 'asc' }, { id: 'asc' }],
  })
  const invoiceOf = new Map(invoices.map((row) => [row.id, row]))
  const invoiced = invoiceLines.flatMap((line) => {
    const invoice = invoiceOf.get(line.invoiceId)
    if (!invoice || invoice.status === 'DRAFT' || line.salesOrderLineId === null) return []
    if (BILLS_GOODS.has(invoice.docType)) return [{ lineId: line.salesOrderLineId, size: line.size, quantity: line.quantity.toString() }]
    if (invoice.docType === CREDITS_GOODS) return [{ lineId: line.salesOrderLineId, size: line.size, quantity: line.quantity.negated().toString() }]
    return []
  })

  const progress = orderProgress({
    lines: lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, sizes: line.sizes.map(({ size, quantity }) => ({ size, quantity })) })),
    // B-W2b-275: the cells of this order's lines (a SAMPLE cell may name none).
    inWorkOrders: cells.flatMap((cell): PieceCount[] => (statusOf.get(cell.workOrderId) === 'CANCELLED' || cell.salesOrderLineId === null ? [] : [{ lineId: cell.salesOrderLineId, size: cell.size, quantity: cell.quantity }])),
    released: released.flatMap((row): PieceCount[] => {
      const cell = cellOf.get(row.workOrderSizeId)
      return cell?.salesOrderLineId ? [{ lineId: cell.salesOrderLineId, size: cell.size, quantity: (row._sum.quantity ?? 0) - (reversedOf.get(row.workOrderSizeId) ?? 0) }] : []
    }),
    shipped: shipped.map((row): PieceCount => ({ lineId: row.salesOrderLineId, size: row.size, quantity: row._sum.quantity ?? 0 })),
    invoiced,
    // B-W2a-30: a line closed short is done (its left pieces will not be made or shipped).
    closedShort: new Set(lines.filter((line) => line.closedShortQuantity !== null).map((line) => line.id)),
    // B-W2b-330 (SAL-181): a fee is never made or shipped: it never holds the order back.
    fees: new Set(feeIds),
  })
  return { lines, progress, workOrders, shipments, invoices }
}

/** The facts the machine's guards read, from what followed the order (and the settlement when asked). */
export function moveFactsOf(facts: OrderFacts, settlement?: SettlementAnswer): SalesOrderFacts {
  return {
    releasedWorkOrders: facts.workOrders.filter((row) => row.releasedAt !== null).length,
    draftWorkOrders: facts.workOrders.filter((row) => row.status === 'DRAFT').map((row) => row.number),
    shipped: facts.progress.shipped,
    released: facts.progress.released,
    // B-OO-002 (order overview N13, Owner D1): how many of the pieces to release quality released (Mark ready's held words).
    releasedPieces: releasedPiecesOf(facts.lines.map((line) => ({ kind: line.kind, rows: facts.progress.rows.filter((row) => row.lineId === line.id) }))),
    // B-W2b-398 (LOG-067): every shipment that left arrived (one DELIVERED at least, none still travelling).
    delivered: facts.shipments.some((row) => row.status === 'DELIVERED') && !facts.shipments.some((row) => row.status === 'SHIPPED'),
    ...(settlement ? { settlement } : {}),
  }
}

/** The company has an active SALES_ORDER number series (an order is numbered from it). */
export async function hasOrderSeries(db: Reader, companyId: string): Promise<boolean> {
  return (await db.numberSeries.count({ where: { companyId, kind: 'SALES_ORDER', status: 'ACTIVE' } })) > 0
}

// ── B-OP-023 (order page plan N5; review R-7): each shipment of the order as its Shipments tab reads it ───────────────────────────
const SHIPMENT_DETAIL = {
  id: true,
  companyId: true,
  siteId: true,
  version: true,
  status: true,
  transportBy: true,
  carrierCode: true,
  carrierName: true,
  manualTrackingNumber: true,
  /* F-OP-135 */ manualTrackingUrl: true,
  expectedDeliveryAt: true,
  // ── B-OS-001 (order shipments tab; 13-backend §1): its customer (for the rights), why it was cancelled, the shipment it was split
  // from, whether a DDT travels with it, when it was packed. No value, no freight (the price grain's columns are never read here).
  partyId: true,
  cancelReason: true,
  cancelledAt: true,
  splitFromId: true,
  splitReason: true,
  ddtRequired: true,
  packedAt: true,
  // ── end B-OS-001 ──
} as const satisfies Prisma.ShipmentSelect
// B-OS-022: + the number (and link) typed by hand for a parcel no label tracks — named, an office read (the floor reads none of it).
const PARCEL_DETAIL = { shipmentId: true, seq: true, trackingNumber: true, trackingUrl: true, carrierParcelId: true, /* B-OS-001 */ id: true, /* B-OS-022 */ manualTrackingNumber: true, manualTrackingUrl: true } as const satisfies Prisma.ParcelSelect
/** B-OS-001: one shipment of the order as its detail is read. */
export type ShipmentDetailRow = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_DETAIL }>

export interface ShipmentDetails {
  readonly shipments: ReadonlyMap<string, Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_DETAIL }>>
  readonly parcels: readonly Prisma.ParcelGetPayload<{ select: typeof PARCEL_DETAIL }>[]
  /** Each shipment's live DDT (the newest one not cancelled). */
  readonly ddts: ReadonlyMap<string, { readonly number: string; readonly date: BusinessDate }>
  // ── B-OS-001 (order shipments tab; 13-backend §1) ──
  /** Every line of the shipments (every order's: the view keeps this order's and counts the others'), by shipment, order line and size. */
  readonly lineCounts: readonly PieceRow[]
  /** What each parcel holds, by order line and size (carton contents; else a whole line packed in it). */
  readonly parcelCounts: readonly ParcelPieceRow[]
  /** The holds in force of each shipment, oldest first. */
  readonly holds: ReadonlyMap<string, readonly HoldRow[]>
  /** The shipments the split ones were split from: their numbers. */
  readonly parents: ReadonlyMap<string, string>
  /** A cancelled shipment merged into another: that one (the newest shipping.merge audit row naming it). */
  readonly mergedInto: ReadonlyMap<string, { readonly id: string; readonly number: string }>
  // ── end B-OS-001 ──
}

// ── B-OS-001 (order shipments tab; 13-backend §1) ──
/** Pieces of one order line and size on one shipment. */
export interface PieceRow {
  readonly shipmentId: string
  readonly lineId: string
  readonly size: string
  readonly pieces: number
}

/** Pieces of one order line and size in one parcel. */
export interface ParcelPieceRow {
  readonly parcelId: string
  readonly lineId: string
  readonly size: string
  readonly pieces: number
}

/**
 * The lines of the shipments and what each parcel holds, in two reads for all of them (never a query per row): the shipments'
 * lines, then the carton contents of those lines. A line with carton contents lies in those cartons; one without, in the parcel
 * it is packed in (if any).
 */
async function readShipmentPieces(db: Reader, shipmentIds: readonly string[]): Promise<{ lineCounts: PieceRow[]; parcelCounts: ParcelPieceRow[] }> {
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: { id: true, shipmentId: true, parcelId: true, salesOrderLineId: true, size: true, quantity: true }, orderBy: [{ shipmentId: 'asc' }, { id: 'asc' }] })
  const cartons = lines.length > 0 ? await db.parcelLine.findMany({ where: { shipmentLineId: { in: lines.map((line) => line.id) } }, select: { parcelId: true, shipmentLineId: true, quantity: true }, orderBy: [{ parcelId: 'asc' }, { id: 'asc' }] }) : []
  const add = <T extends { pieces: number }>(map: Map<string, T>, key: string, row: T) => {
    const found = map.get(key)
    map.set(key, found ? { ...found, pieces: found.pieces + row.pieces } : row)
  }
  const byLine = new Map<string, PieceRow>()
  for (const line of lines) add(byLine, `${line.shipmentId}|${line.salesOrderLineId}|${line.size}`, { shipmentId: line.shipmentId, lineId: line.salesOrderLineId, size: line.size, pieces: line.quantity })
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const inCartons = new Set(cartons.map((row) => row.shipmentLineId))
  const byParcel = new Map<string, ParcelPieceRow>()
  for (const row of cartons) {
    const line = lineOf.get(row.shipmentLineId)
    if (line) add(byParcel, `${row.parcelId}|${line.salesOrderLineId}|${line.size}`, { parcelId: row.parcelId, lineId: line.salesOrderLineId, size: line.size, pieces: row.quantity })
  }
  for (const line of lines) {
    if (line.parcelId !== null && !inCartons.has(line.id)) add(byParcel, `${line.parcelId}|${line.salesOrderLineId}|${line.size}`, { parcelId: line.parcelId, lineId: line.salesOrderLineId, size: line.size, pieces: line.quantity })
  }
  return { lineCounts: [...byLine.values()], parcelCounts: [...byParcel.values()] }
}

/** The shipment each cancelled one was merged into (B-OS-012 writes `after.into { id, number }` on the shipping.merge audit row). */
async function readMergedInto(db: Reader, cancelledIds: readonly string[]): Promise<Map<string, { id: string; number: string }>> {
  const out = new Map<string, { id: string; number: string }>()
  if (cancelledIds.length === 0) return out
  const rows = await db.auditLog.findMany({ where: { recordType: 'Shipment', recordId: { in: [...cancelledIds] }, action: 'shipping.merge' }, select: { recordId: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
  for (const row of rows) {
    if (out.has(row.recordId)) continue
    const into = row.after !== null && typeof row.after === 'object' && !Array.isArray(row.after) ? (row.after as Record<string, unknown>).into : null
    const target = into !== null && typeof into === 'object' && !Array.isArray(into) ? (into as Record<string, unknown>) : null
    if (target && typeof target.id === 'string' && typeof target.number === 'string' && target.id !== row.recordId) out.set(row.recordId, { id: target.id, number: target.number })
  }
  return out
}
// ── end B-OS-001 ──

/**
 * The detail of the order's shipments (read by `Shipment.salesOrderId`, as the chain is today; set C reads the orders of its lines):
 * its version, site, how it travels, the carrier, the typed tracking number, the expected delivery, its parcels' labels and its live
 * DDT. The view decides what each reader may see of it.
 */
export async function readShipmentDetails(db: Reader, shipmentIds: readonly string[]): Promise<ShipmentDetails> {
  if (shipmentIds.length === 0) return { shipments: new Map(), parcels: [], ddts: new Map(), /* B-OS-001 */ lineCounts: [], parcelCounts: [], holds: new Map(), parents: new Map(), mergedInto: new Map() }
  const rows = await db.shipment.findMany({ where: { id: { in: [...shipmentIds] } }, select: SHIPMENT_DETAIL })
  const parcels = await db.parcel.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: PARCEL_DETAIL, orderBy: [{ shipmentId: 'asc' }, { seq: 'asc' }] })
  const ddts = await db.ddt.findMany({ where: { shipmentId: { in: [...shipmentIds] } }, select: { id: true, shipmentId: true, number: true, documentDate: true }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }] })
  const cancelled = new Set(ddts.length > 0 ? (await db.ddtCancellation.findMany({ where: { ddtId: { in: ddts.map((row) => row.id) } }, select: { ddtId: true } })).map((row) => row.ddtId) : [])
  const live = new Map<string, { number: string; date: BusinessDate }>()
  for (const ddt of ddts) if (ddt.shipmentId && !cancelled.has(ddt.id) && !live.has(ddt.shipmentId)) live.set(ddt.shipmentId, { number: ddt.number, date: dayOf(ddt.documentDate) })
  // ── B-OS-001: what each shipment and parcel carries, its holds in force, the split parent, the merge target (one read each) ──
  const pieces = await readShipmentPieces(db, shipmentIds)
  const holds = await holdsInForceBy(db, shipmentIds)
  const parentIds = [...new Set(rows.flatMap((row) => (row.splitFromId ? [row.splitFromId] : [])))]
  const parents = new Map((parentIds.length > 0 ? await db.shipment.findMany({ where: { id: { in: parentIds } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
  const mergedInto = await readMergedInto(db, rows.filter((row) => row.status === 'CANCELLED').map((row) => row.id))
  // ── end B-OS-001 ──
  return { shipments: new Map(rows.map((row) => [row.id, row])), parcels, ddts: live, /* B-OS-001 */ ...pieces, holds, parents, mergedInto }
}
// ── end B-OP-023 ──

// ── B-OS-002 (order shipments tab; H1, O8; 13-backend §1): the buckets that add up ────────────────────────────────────────────
/** Of one size (or line, or the order): on shipments that have not left (DRAFT, PACKED), and released and on no shipment yet. */
export interface ShipFigures {
  readonly planned: number
  readonly readyNow: number
}

export const NO_SHIP_FIGURES: ShipFigures = Object.freeze({ planned: 0, readyNow: 0 })

export interface OrderShipFigures {
  /** One size of a line; a line without a size grid: size null (its one row). */
  readonly of: (lineId: string, size: string | null) => ShipFigures
  readonly line: (lineId: string) => ShipFigures
  /** The order's goods (a fee is never shipped: 0). */
  readonly all: ShipFigures
}

/**
 * The order's `planned` and `readyNow` per size, per line and for the order, by the SAME rule as Warehouse's backorder
 * (modules/shipping/shipments/backorder readBackorders, factory-domain sizeBackorder): planned = `open` (on DRAFT and PACKED
 * shipments), ready now = released less reversals less what every shipment that is not cancelled holds (a carrier return holds
 * its garments until they are received back), never more than is still to ship. `toShip` and `shipped` stay the order machine's.
 */
export async function readShipFigures(db: Reader, orderId: string): Promise<OrderShipFigures> {
  const lines = (await readBackorders(db, [orderId], null)).get(orderId) ?? []
  const sum = (sizes: readonly { readonly open: number; readonly readyNow: number }[]): ShipFigures => ({ planned: sizes.reduce((count, size) => count + size.open, 0), readyNow: sizes.reduce((count, size) => count + size.readyNow, 0) })
  const bySize = new Map<string, ShipFigures>()
  const byLine = new Map<string, ShipFigures>()
  for (const line of lines) {
    for (const size of line.sizes) bySize.set(`${line.lineId}|${size.size}`, { planned: size.open, readyNow: size.readyNow })
    byLine.set(line.lineId, sum(line.sizes))
  }
  return {
    of: (lineId, size) => (size === null ? byLine.get(lineId) : bySize.get(`${lineId}|${size}`)) ?? NO_SHIP_FIGURES,
    line: (lineId) => byLine.get(lineId) ?? NO_SHIP_FIGURES,
    all: sum(lines.flatMap((line) => line.sizes)),
  }
}
// ── end B-OS-002 ──
