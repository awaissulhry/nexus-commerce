import type { Prisma } from '@nexus/factory-db'
import { peggingTreeOf, type PegDemandNode, type PeggingDemandKind, type PeggingSupplyKind } from '@nexus/factory-domain/planning/pegging/pegging'
import type { Reader } from '../store'
import { dayOf } from '../store'
import { quantityOf } from '../views'

/**
 * The pegging a run wrote (B-W2a-22; PLN-071), as a tree with names: per demand (an order line in one size, or a work
 * order's pieces of it) the supplies that cover it — a reservation (its lot or hide), free stock, a purchase order line
 * (its order, number and state, its date), or the planned order (firm or not, its date). Every read names its columns;
 * one query after another. No money, no person.
 */

export const PEG_COLUMNS = {
  id: true,
  runId: true,
  requirementId: true,
  seq: true,
  demandKind: true,
  salesOrderLineId: true,
  size: true,
  workOrderId: true,
  demandDate: true,
  quantity: true,
  supplyKind: true,
  reservationId: true,
  purchaseOrderLineId: true,
  supplyDate: true,
} as const satisfies Prisma.RequirementPeggingSelect
export type PegRowRead = Prisma.RequirementPeggingGetPayload<{ select: typeof PEG_COLUMNS }>

interface StoredRow {
  readonly requirementId: string
  readonly seq: number
  readonly demandKind: PeggingDemandKind
  readonly salesOrderLineId: string | null
  readonly size: string | null
  readonly workOrderId: string | null
  readonly demandDate: string
  readonly quantity: string
  readonly supplyKind: PeggingSupplyKind
  readonly reservationId: string | null
  readonly purchaseOrderLineId: string | null
  readonly supplyDate: string | null
}

const storedOf = (row: PegRowRead): StoredRow => ({
  requirementId: row.requirementId,
  seq: row.seq,
  demandKind: row.demandKind,
  salesOrderLineId: row.salesOrderLineId,
  size: row.size,
  workOrderId: row.workOrderId,
  demandDate: dayOf(row.demandDate),
  quantity: quantityOf(row.quantity),
  supplyKind: row.supplyKind,
  reservationId: row.reservationId,
  purchaseOrderLineId: row.purchaseOrderLineId,
  supplyDate: row.supplyDate ? dayOf(row.supplyDate) : null,
})

/** The tree of some stored rows, named. `firmOf`: whether a requirement's planned order is firm. */
export async function pegTreeView(db: Reader, rows: readonly PegRowRead[], firmOf: ReadonlyMap<string, boolean>) {
  const nodes: PegDemandNode<StoredRow>[] = peggingTreeOf(rows.map(storedOf))
  const lineIds = [...new Set(rows.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))]
  const lines = lineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true, order: { select: { id: true, number: true } } } })
  const workOrderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
  const workOrders = workOrderIds.length === 0 ? [] : await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true } })
  const reservationIds = [...new Set(rows.flatMap((row) => (row.reservationId ? [row.reservationId] : [])))]
  const reservations =
    reservationIds.length === 0
      ? []
      : await db.reservation.findMany({ where: { id: { in: reservationIds } }, select: { id: true, kind: true, lot: { select: { id: true, code: true } }, hide: { select: { id: true, code: true } } } })
  const purchaseLineIds = [...new Set(rows.flatMap((row) => (row.purchaseOrderLineId ? [row.purchaseOrderLineId] : [])))]
  const purchaseLines =
    purchaseLineIds.length === 0 ? [] : await db.purchaseOrderLine.findMany({ where: { id: { in: purchaseLineIds } }, select: { id: true, seq: true, purchaseOrder: { select: { id: true, number: true, status: true } } } })
  const lineOf = new Map(lines.map((line) => [line.id, line]))
  const workOrderOf = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]))
  const reservationOf = new Map(reservations.map((reservation) => [reservation.id, reservation]))
  const purchaseOf = new Map(purchaseLines.map((line) => [line.id, line]))
  return nodes.map((node) => {
    const line = node.salesOrderLineId ? lineOf.get(node.salesOrderLineId) : undefined
    return {
      requirementId: node.requirementId,
      kind: node.demandKind,
      order: line ? { id: line.order.id, number: line.order.number } : null,
      orderLine: line ? { id: line.id, seq: line.seq } : null,
      size: node.size,
      workOrder: node.workOrderId ? (workOrderOf.get(node.workOrderId) ?? null) : null,
      demandDate: node.demandDate,
      quantity: node.quantity,
      planned: node.planned,
      supplies: node.supplies.map((row) => {
        const reservation = row.reservationId ? reservationOf.get(row.reservationId) : undefined
        const purchase = row.purchaseOrderLineId ? purchaseOf.get(row.purchaseOrderLineId) : undefined
        return {
          seq: row.seq,
          kind: row.supplyKind,
          quantity: row.quantity,
          date: row.supplyDate,
          reservation: reservation ? { id: reservation.id, kind: reservation.kind, lot: reservation.lot, hide: reservation.hide } : null,
          purchaseOrder: purchase ? { id: purchase.purchaseOrder.id, number: purchase.purchaseOrder.number, status: purchase.purchaseOrder.status, lineId: purchase.id, seq: purchase.seq } : null,
          firm: row.supplyKind === 'PLANNED' && (firmOf.get(row.requirementId) ?? false),
        }
      }),
    }
  })
}

export type PegDemandView = Awaited<ReturnType<typeof pegTreeView>>[number]
