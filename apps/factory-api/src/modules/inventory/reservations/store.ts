import type { Prisma } from '@nexus/factory-db'
import { isOpenOrder, isOpenWorkOrder, type HeldReservation, type StockPart } from '@nexus/factory-domain/inventory/reservations/rules'
import { isHeld, type LotQualityStatus } from '@nexus/factory-domain/inventory/stock/overview'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { readLots, readSiteStock, type Reader } from '../issue/store'
// B-W2a-26: stock under an ACTIVE quality hold is held too.
import { heldByQualityHolds } from '../../quality/holds/stock'

/**
 * The reservations' reads and lock (B-W2a-11). Every read names its columns and selects no relation, so it runs the same
 * inside a command's transaction (one query after another on its one connection) and for the floor (its issue path reads
 * Reservation, WorkOrder and WorkOrderSize of its own site; it may not read sales orders).
 *
 * The lock: one transaction advisory lock per site, item and colour (`factory.reserve|tenant|site|item|colour`), taken
 * by every command that reserves, releases, issues against reservations or writes stock off, sorted, BEFORE the stock
 * locks (postMoves): reserve and release take only it; an issue takes the work order's issue lock → (a hide's cut lock)
 * → this → the stock locks; a write-off this → the stock locks. So two requests never reserve the same stock, and an
 * issue never takes what a reservation being written holds.
 */

export interface ReserveKey {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId: string | null
}

export const reserveKeyOf = (key: ReserveKey): string => `${key.siteId}|${key.itemId}|${key.itemColourId ?? '-'}`

/** Takes the reserve lock of each key, sorted (no deadlock between two batches). */
export async function lockReservations(tx: CommandTx, tenantId: string, keys: readonly ReserveKey[]): Promise<void> {
  const unique = [...new Map(keys.map((key) => [reserveKeyOf(key), key])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [, key] of unique) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.reserve', ${tenantId}::uuid, ${key.siteId}::uuid, ${key.itemId}::uuid, coalesce(${key.itemColourId}::uuid::text, '-')), 0))`
  }
}

export const RESERVATION_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  kind: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  quantity: true,
  issuedQuantity: true,
  workOrderId: true,
  salesOrderLineId: true,
  partyId: true,
  needDate: true,
  status: true,
  issuedAt: true,
  releasedAt: true,
  releasedById: true,
  releaseReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ReservationSelect
export type ReservationRow = Prisma.ReservationGetPayload<{ select: typeof RESERVATION_COLUMNS }>

/** The demands of some reservations: each work order's number and status, each order line's order, number, seq and status. */
export interface Demands {
  readonly workOrders: ReadonlyMap<string, { readonly id: string; readonly number: string; readonly status: string; readonly siteId: string }>
  /** Empty for the floor: it reads no sales order. */
  readonly orderLines: ReadonlyMap<string, { readonly id: string; readonly seq: number; readonly orderId: string; readonly number: string; readonly status: string }>
  readonly withOrders: boolean
}

export async function readDemands(db: Reader, rows: readonly Pick<ReservationRow, 'workOrderId' | 'salesOrderLineId'>[], options: { readonly withOrders: boolean }): Promise<Demands> {
  const workOrderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
  const lineIds = [...new Set(rows.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))]
  const workOrders = workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true, siteId: true } }) : []
  const orderLines = new Map<string, { id: string; seq: number; orderId: string; number: string; status: string }>()
  if (options.withOrders && lineIds.length > 0) {
    const lines = await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true, orderId: true } })
    const orders = new Map(
      (await db.salesOrder.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.orderId))] } }, select: { id: true, number: true, status: true } })).map((order) => [order.id, order]),
    )
    for (const line of lines) {
      const order = orders.get(line.orderId)
      if (order) orderLines.set(line.id, { id: line.id, seq: line.seq, orderId: order.id, number: order.number, status: order.status })
    }
  }
  return { workOrders: new Map(workOrders.map((row) => [row.id, row])), orderLines, withOrders: options.withOrders }
}

/** The demand still needs the stock: its work order is open, or its order is (an order the reader cannot see: assumed open). */
export function demandOpen(row: Pick<ReservationRow, 'workOrderId' | 'salesOrderLineId'>, demands: Demands): boolean {
  if (row.workOrderId) {
    const workOrder = demands.workOrders.get(row.workOrderId)
    return workOrder ? isOpenWorkOrder(workOrder.status) : true
  }
  if (row.salesOrderLineId && demands.withOrders) {
    const line = demands.orderLines.get(row.salesOrderLineId)
    return line ? isOpenOrder(line.status) : true
  }
  return true
}

/** "work order WO-00031", "order SO-2026-0004 line 10" (or "a sales order line" for a reader that sees no order). */
export function demandWords(row: Pick<ReservationRow, 'workOrderId' | 'salesOrderLineId'>, demands: Demands): string {
  if (row.workOrderId) {
    const workOrder = demands.workOrders.get(row.workOrderId)
    return workOrder ? `work order ${workOrder.number}${isOpenWorkOrder(workOrder.status) ? '' : ` (${workOrder.status})`}` : 'another work order'
  }
  const line = row.salesOrderLineId ? demands.orderLines.get(row.salesOrderLineId) : undefined
  return line ? `order ${line.number} line ${line.seq}${isOpenOrder(line.status) ? '' : ` (${line.status})`}` : 'a sales order line'
}

export const heldOf = (row: ReservationRow, demands: Demands): HeldReservation => ({
  id: row.id,
  kind: row.kind,
  lotId: row.lotId,
  hideId: row.hideId,
  quantity: row.quantity.toString(),
  issuedQuantity: row.issuedQuantity.toString(),
  workOrderId: row.workOrderId,
  salesOrderLineId: row.salesOrderLineId,
  demandOpen: demandOpen(row, demands),
})

/** What one key's checks read: the site's stock of the item and colour per lot and hide, and its ACTIVE reservations. */
export interface KeyFacts {
  readonly key: ReserveKey
  readonly stock: StockPart[]
  readonly rows: ReservationRow[]
  readonly reservations: HeldReservation[]
  readonly demands: Demands
  /** Per lot: its code and whether it is held. */
  readonly lots: ReadonlyMap<string, { readonly code: string; readonly qualityStatus: string }>
}

/** The site's stock of one item and colour summed over its locations, per lot and hide, with what is held. */
export async function readStockParts(db: Reader, key: ReserveKey): Promise<{ stock: StockPart[]; lots: Map<string, { code: string; qualityStatus: string }> }> {
  const balances = await readSiteStock(db, key.siteId, { itemIds: [key.itemId], itemColourId: key.itemColourId })
  const sums = new Map<string, { lotId: string | null; hideId: string | null; onHand: Decimal }>()
  for (const balance of balances) {
    const id = `${balance.lotId ?? '-'}|${balance.hideId ?? '-'}`
    const entry = sums.get(id) ?? { lotId: balance.lotId, hideId: balance.hideId, onHand: ZERO }
    entry.onHand = entry.onHand.plus(balance.onHand)
    sums.set(id, entry)
  }
  const lotRows = await readLots(db, [...new Set([...sums.values()].flatMap((entry) => (entry.lotId ? [entry.lotId] : [])))])
  const lots = new Map([...lotRows.values()].map((lot) => [lot.id, { code: lot.code, qualityStatus: lot.qualityStatus }]))
  const quality = await heldByQualityHolds(db, { lotIds: [...sums.values()].map((entry) => entry.lotId), hideIds: [...sums.values()].map((entry) => entry.hideId) })
  const stock = [...sums.values()].map((entry) => ({
    lotId: entry.lotId,
    hideId: entry.hideId,
    onHand: entry.onHand.toFixed(4),
    held: (entry.lotId ? isHeld(lots.get(entry.lotId)?.qualityStatus as LotQualityStatus | undefined) : false) || quality.holds(entry),
  }))
  return { stock, lots }
}

/** Everything the checks of one key read (after its lock, inside a command; or as a plain read). */
export async function readKeyFacts(db: Reader, key: ReserveKey, options: { readonly withOrders: boolean }): Promise<KeyFacts> {
  const { stock, lots } = await readStockParts(db, key)
  const rows = await db.reservation.findMany({
    where: { siteId: key.siteId, itemId: key.itemId, itemColourId: key.itemColourId, status: 'ACTIVE' },
    select: RESERVATION_COLUMNS,
    orderBy: { id: 'asc' },
  })
  const demands = await readDemands(db, rows, options)
  return { key, stock, rows, reservations: rows.map((row) => heldOf(row, demands)), demands, lots }
}

/** The order lines a work order makes (its cells' lines): their reservations count as the work order's own. */
export async function orderLinesOf(db: Reader, workOrderId: string): Promise<Set<string>> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { salesOrderLineId: true } })
  return new Set(cells.map((cell) => cell.salesOrderLineId))
}

export const decimalOf = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))
