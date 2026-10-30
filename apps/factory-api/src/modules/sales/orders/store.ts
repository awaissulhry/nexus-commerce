import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { orderProgress, type OrderProgress, type PieceCount, type SalesOrderFacts, type SalesOrderStatus, type SettlementAnswer } from '@nexus/factory-domain/sales/orders/orders'
import { StaleVersionError, type CommandTx } from '../../../core/command'

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
  status: true,
  orderDate: true,
  currency: true,
  language: true,
  taxMode: true,
  billTo: true,
  shipTo: true,
  paymentTerms: true,
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

  const shipments = await db.shipment.findMany({ where: { salesOrderId: order.id }, select: { id: true, number: true, status: true, shippedAt: true, deliveredAt: true }, orderBy: { number: 'asc' } })
  const leftIds = shipments.filter((row) => (LEFT as readonly string[]).includes(row.status)).map((row) => row.id)
  const shipped = leftIds.length > 0 ? await db.shipmentLine.groupBy({ by: ['salesOrderLineId', 'size'], where: { shipmentId: { in: leftIds } }, _sum: { quantity: true } }) : []

  const invoiceLines = lineIds.length > 0 ? await db.invoiceLine.findMany({ where: { salesOrderLineId: { in: lineIds }, kind: 'GOODS' }, select: { invoiceId: true, salesOrderLineId: true, size: true, quantity: true } }) : []
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
    inWorkOrders: cells.filter((cell) => statusOf.get(cell.workOrderId) !== 'CANCELLED').map((cell): PieceCount => ({ lineId: cell.salesOrderLineId, size: cell.size, quantity: cell.quantity })),
    released: released.flatMap((row): PieceCount[] => {
      const cell = cellOf.get(row.workOrderSizeId)
      return cell ? [{ lineId: cell.salesOrderLineId, size: cell.size, quantity: (row._sum.quantity ?? 0) - (reversedOf.get(row.workOrderSizeId) ?? 0) }] : []
    }),
    shipped: shipped.map((row): PieceCount => ({ lineId: row.salesOrderLineId, size: row.size, quantity: row._sum.quantity ?? 0 })),
    invoiced,
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
    ...(settlement ? { settlement } : {}),
  }
}

/** The company has an active SALES_ORDER number series (an order is numbered from it). */
export async function hasOrderSeries(db: Reader, companyId: string): Promise<boolean> {
  return (await db.numberSeries.count({ where: { companyId, kind: 'SALES_ORDER', status: 'ACTIVE' } })) > 0
}
