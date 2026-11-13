import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { furthestStage, stageRank, type OrderFreezeStage, type StageReached } from '@nexus/factory-domain/sales/order-changes/freeze'
import { LEFT, type Reader } from '../orders/store'

/**
 * How far production got with each size of an order's lines (B-W2b-309; SAL-218 "needs floor stage signals"): the production
 * data the freeze rules are read against (factory-domain sales/order-changes/freeze). Of the line's cells (WorkOrderSize of
 * its work orders, not a REPAIR, not CANCELLED):
 *
 *   RELEASED   a work order of the cell was released (WorkOrder.releasedAt)
 *   CUT        cutting started: a cut of leather logged for the cell that was not reversed, or a bundle of the cell made (not
 *              VOID) — B-W2b-183's reading (change-requests/store readCuts), per cell here
 *   SEWING     a bundle of the cell was started or reported at an operation of a SEWING work centre
 *   FINISHED   quality released pieces of the cell (net of reversals)
 *   SHIPPED    a shipment that left carried pieces of the line in that size
 *
 * The first day each stage was reached is kept (Europe/Rome business days); a size cell's stage is the furthest reached.
 */

export interface LineStages {
  /** Per size (made-to-measure: ''). */
  readonly sizes: ReadonlyMap<string, StageReached>
  /** The furthest of its sizes. */
  readonly line: StageReached
}

export interface OrderStages {
  readonly lines: ReadonlyMap<string, LineStages>
  /** The furthest of its lines. */
  readonly order: StageReached
}

const NONE: StageReached = Object.freeze({ stage: null, on: null })

function furthest(entries: readonly StageReached[]): StageReached {
  const stage = furthestStage(entries.map((entry) => entry.stage))
  if (stage === null) return NONE
  const days = entries.filter((entry) => entry.stage === stage && entry.on !== null).map((entry) => entry.on!)
  return { stage, on: days.length > 0 ? days.sort()[0]! : null }
}

/** The stages of the given lines of one order (lines with no production: no entry). */
export async function readStages(db: Reader, lineIds: readonly string[]): Promise<OrderStages> {
  const reached = new Map<string, Map<string, StageReached>>()
  const note = (lineId: string, size: string, stage: OrderFreezeStage, at: Date | BusinessDate) => {
    const day = typeof at === 'string' ? at : businessDate(at)
    const sizes = reached.get(lineId) ?? new Map<string, StageReached>()
    const known = sizes.get(size)
    if (!known || known.stage === null || stageRank(stage) > stageRank(known.stage) || (known.stage === stage && known.on !== null && day < known.on)) sizes.set(size, { stage, on: day })
    reached.set(lineId, sizes)
  }
  if (lineIds.length > 0) {
    const cells = await db.workOrderSize.findMany({
      where: { salesOrderLineId: { in: [...lineIds] }, workOrder: { kind: { not: 'REPAIR' }, status: { not: 'CANCELLED' } } },
      select: { id: true, salesOrderLineId: true, size: true, workOrder: { select: { releasedAt: true } } },
    })
    const cellOf = new Map(cells.map((cell) => [cell.id, cell]))
    const cellIds = cells.map((cell) => cell.id)
    for (const cell of cells) if (cell.salesOrderLineId && cell.workOrder.releasedAt) note(cell.salesOrderLineId, cell.size ?? '', 'RELEASED', cell.workOrder.releasedAt)
    if (cellIds.length > 0) {
      // Cutting: per cell (B-W2b-183 reads it per line; the same two signals).
      const pieces = await db.cutLogPiece.findMany({ where: { workOrderSizeId: { in: cellIds }, pieces: { gt: 0 }, cutLog: { reversalOfId: null, reversals: { none: {} } } }, select: { workOrderSizeId: true, serverTime: true } })
      const bundles = await db.bundle.findMany({ where: { workOrderSizeId: { in: cellIds }, status: { not: 'VOID' } }, select: { id: true, workOrderSizeId: true, createdAt: true } })
      for (const row of [...pieces.map((piece) => ({ cellId: piece.workOrderSizeId, at: piece.serverTime })), ...bundles.map((bundle) => ({ cellId: bundle.workOrderSizeId, at: bundle.createdAt }))]) {
        const cell = cellOf.get(row.cellId)
        if (cell?.salesOrderLineId) note(cell.salesOrderLineId, cell.size ?? '', 'CUT', row.at)
      }
      // Sewing: a bundle of the cell started or reported at a SEWING work centre.
      if (bundles.length > 0) {
        const cellOfBundle = new Map(bundles.map((bundle) => [bundle.id, bundle.workOrderSizeId]))
        const scans = await db.operationScan.findMany({
          where: { bundleId: { in: bundles.map((bundle) => bundle.id) }, kind: { in: ['START', 'REPORT', 'CORRECTION'] }, operation: { workCentre: { kind: 'SEWING' } } },
          select: { bundleId: true, serverTime: true },
        })
        for (const scan of scans) {
          const cell = cellOf.get(cellOfBundle.get(scan.bundleId) ?? '')
          if (cell?.salesOrderLineId) note(cell.salesOrderLineId, cell.size ?? '', 'SEWING', scan.serverTime)
        }
      }
      // Finished: quality released pieces of the cell, net of reversals.
      const releases = await db.qualityRelease.findMany({ where: { workOrderSizeId: { in: cellIds } }, select: { workOrderSizeId: true, quantity: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const reversed = await db.qualityReleaseReversal.groupBy({ by: ['workOrderSizeId'], where: { workOrderSizeId: { in: cellIds } }, _sum: { quantity: true } })
      const reversedOf = new Map(reversed.map((row) => [row.workOrderSizeId, row._sum.quantity ?? 0]))
      const releasedOf = new Map<string, { quantity: number; first: Date }>()
      for (const row of releases) {
        const known = releasedOf.get(row.workOrderSizeId)
        releasedOf.set(row.workOrderSizeId, { quantity: (known?.quantity ?? 0) + row.quantity, first: known?.first ?? row.createdAt })
      }
      for (const [cellId, released] of releasedOf) {
        const cell = cellOf.get(cellId)
        if (cell?.salesOrderLineId && released.quantity - (reversedOf.get(cellId) ?? 0) > 0) note(cell.salesOrderLineId, cell.size ?? '', 'FINISHED', released.first)
      }
    }
    // Shipped: a shipment that left carried the line's pieces in that size.
    const shipped = await db.shipmentLine.findMany({ where: { salesOrderLineId: { in: [...lineIds] }, quantity: { gt: 0 }, shipment: { status: { in: [...LEFT] } } }, select: { salesOrderLineId: true, size: true, shipment: { select: { shippedAt: true } } } })
    for (const row of shipped) if (row.salesOrderLineId && row.shipment.shippedAt) note(row.salesOrderLineId, row.size ?? '', 'SHIPPED', row.shipment.shippedAt)
  }
  const lines = new Map<string, LineStages>()
  for (const [lineId, sizes] of reached) lines.set(lineId, { sizes, line: furthest([...sizes.values()]) })
  return { lines, order: furthest([...lines.values()].map((entry) => entry.line)) }
}

/** A size cell's stage (none: not in production). */
export const stageOfSize = (stages: OrderStages, lineId: string, size: string): StageReached => stages.lines.get(lineId)?.sizes.get(size) ?? NONE
/** A line's stage. */
export const stageOfLine = (stages: OrderStages, lineId: string): StageReached => stages.lines.get(lineId)?.line ?? NONE
