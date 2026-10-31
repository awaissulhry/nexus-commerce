import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { closedShortAtShipProblems, repairCellWords } from '@nexus/factory-domain/shipping/shipments/backorder'
import type { CommandTools } from '../../../core/command'
import { lockCells, tenantOf } from '../cells'
import { markAwaitedInCommand } from '../documents/evidence'
import type { ShipmentHeader } from '../store'
import { closedShortLinesOf, lockOrderLinesForShipping } from './backorder'
import { applyFreightInCommand } from './freight'
import { shippedCells, takeFromFinishedGoodsInCommand } from './stock'

/**
 * What happens when a shipment leaves, every day (B-W2a-48), inside the ONE leaving command (modules/shipping/ddt's
 * shipGoods, called by the DDT issue with `ship` and by POST …/ship; office only), after the shipment is SHIPPED and its
 * serials with it:
 *
 *   1. its cells' shipping locks (sorted, after the shipment's row), then its order lines' locks: an order line closed
 *      short after its garments were planned stops the shipment (409 in words, B-W2a-30's gap)
 *   2. the garments its work orders have in finished goods leave from there (shipments/stock.ts: SHIPMENT moves out
 *      naming their lines, postMoves; B-W2b-19); the rest leaves straight from the release. A repair work order's
 *      cell never leaves on a shipment of the order (B-W2b-19: a line of one made before the rule stops it, 409)
 *   3. the freight charged: the site's rule, unless the office typed one (shipments/freight.ts)
 *   4. a zero-rated intra-EU sale's transport evidence is AWAITED (documents/evidence.ts)
 *
 * One audit row (`shipping.left`) says what came from stock and what from the release, cell by cell.
 */
export async function whenShipped(tools: CommandTools, shipment: ShipmentHeader, periodLockOverride?: PeriodLockOverride | null): Promise<void> {
  const tenantId = tenantOf(tools.context)
  const cells = await shippedCells(tools.tx, shipment.id)
  const repairs = cells.filter((cell) => cell.repair)
  if (repairs.length > 0) throw new InvalidStateError([...new Set(repairs.map((cell) => repairCellWords(cell.workOrderNumber)))].join(' ') + ' Unpack the shipment and take that line off first.')
  await lockCells(tools.tx, tenantId, cells.map((cell) => cell.cellId))
  const orderLines = await tools.tx.shipmentLine.findMany({ where: { shipmentId: shipment.id }, select: { salesOrderLineId: true } })
  await lockOrderLinesForShipping(tools.tx, tenantId, orderLines.map((line) => line.salesOrderLineId))
  const lines = await closedShortLinesOf(tools.tx, shipment.id)
  const closed = closedShortAtShipProblems(lines)
  if (closed.length > 0) throw new InvalidStateError(closed.join(' '))
  const stock = await takeFromFinishedGoodsInCommand(tools, shipment, cells, periodLockOverride)
  const freight = await applyFreightInCommand(tools, shipment)
  const evidence = await markAwaitedInCommand(tools, shipment)
  tools.audit({
    action: 'shipping.left',
    recordType: 'Shipment',
    recordId: shipment.id,
    companyId: shipment.companyId,
    siteId: shipment.siteId,
    after: {
      cells: stock.takes.map((take) => ({ cellId: take.cellId, label: take.label, garments: take.garments, fromStock: take.fromStock, fromRelease: take.fromRelease, places: take.fromPlaces })),
      stockMoveIds: stock.moveIds,
      freightBasis: freight?.basis ?? null,
      transportEvidence: evidence,
    },
  })
}
