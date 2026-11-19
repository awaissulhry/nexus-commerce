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
import { assertNotOnHold } from '../../parties/holds/stops'
// B-W2b-304 (SAL-241): the customer's credit checked again before the goods leave.
import { creditGateInCommand } from '../../sales/credit/check'
// B-W2b-395 (LOG-053): a shipment the customer's own carrier collects leaves only with who collected, the plate and the signed DDT.
import { assertCollectedInCommand } from '../collection/collection'

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
// ---- B-OP-032 (order page N5; R-2, R-9): how the goods leave --------------------------------------------------------------
export interface LeaveOptions {
  readonly periodLockOverride?: PeriodLockOverride | null | undefined
  /**
   * B-OP-032: recorded as made ELSEWHERE — the fact already happened outside Nexus: the customer collecting is not asked who
   * collected (the paper DDT carries it), and the customer's account hold and credit hold were overridden by a person who
   * may release holds, with a reason (`holdsOverridden`; R-9: else the recording is refused before this, in words).
   */
  readonly elsewhere?: { readonly holdsOverridden: boolean } | undefined
  /** When the goods left (the audit names it beside the recording time; stock and cost of sales post now, D5). */
  readonly shippedAt?: Date | undefined
}
// ---- end B-OP-032

export async function whenShipped(tools: CommandTools, shipment: ShipmentHeader, options: LeaveOptions = {}): Promise<void> {
  const periodLockOverride = options.periodLockOverride
  const overridden = options.elsewhere?.holdsOverridden === true // B-OP-032 (R-9)
  // B-W2b-290 (SAL-023): a shipment does not leave while its customer is on hold for its company (409 in words).
  if (!overridden) await assertNotOnHold(tools.tx, { partyId: shipment.partyId, companyId: shipment.companyId }, 'SHIPMENT')
  // B-W2b-395 (LOG-053): the customer collecting: who collected, the plate and the signed DDT first (409 in words).
  // B-OP-032: not for goods recorded as made elsewhere (they left with their paper DDT, signed outside Nexus).
  if (!options.elsewhere) await assertCollectedInCommand(tools, shipment)
  // B-W2b-304: over the credit limit where the company holds, the shipment waits for a yes (409 in words; the caller's
  // withCreditHolds writes the hold and asks for the yes after the rollback).
  if (!overridden) await creditGateInCommand(tools, { step: 'SHIPMENT', recordType: 'Shipment', recordId: shipment.id, label: `Shipment ${shipment.number}`, companyId: shipment.companyId, partyIds: [shipment.partyId] })
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
      // B-OP-032 (D5): goods recorded as made elsewhere left on this day; their stock moved at the recording (tools.now).
      ...(options.elsewhere ? { madeElsewhere: true, shippedAt: (options.shippedAt ?? tools.now).toISOString(), recordedAt: tools.now.toISOString(), holdsOverridden: overridden } : {}),
    },
  })
}
