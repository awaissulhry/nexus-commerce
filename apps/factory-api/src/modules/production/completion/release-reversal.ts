import { newId } from '@nexus/factory-domain/core/ids'
import { releaseTakeOut, type TakeOutReceipt } from '@nexus/factory-domain/production/completion/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { tenantOf } from '../../shipping/cells'
import { postFinishedReceipts, reverseFinishedReceipts, skuKey, type OverReserved } from '../../inventory/finished/post'
import { cellLabel, readWorkOrder } from '../work-orders/store'
import { completionView, readCompletionFacts, reportsOf, shareGate } from './store'

/**
 * A quality release reversal takes the garments out of finished goods (B-W2b-10; B-W2a-12's follow-up: "a release
 * reversal of garments already in finished goods does NOT take them out of stock"). quality/final reversals.ts calls this
 * INSIDE its command, after the QualityReleaseReversal row (so the cell's released garments are already less the ones
 * taken back), under the work order's release lock and the cell's shipping lock (the report's own order: release → gate
 * → cells; the gate is taken here, SHARED, before any receipt moves).
 *
 * factory-domain production/completion releaseTakeOut decides: the cell's garments in finished goods beyond what stays
 * released (less those on shipments that did not take them from stock), at most the ones reversed. A report's receipt is
 * taken back whole (its mirror out of the place it went to, the database's rule), newest first, from a place that still
 * holds it; the rest of it goes back in at once as a new receipt into the same place while the work order takes receipts.
 * What could not be taken out is said in words. Each report touched answers `workorder.finished_reversed`, the rest put
 * back `workorder.finished_to_stock`, as "Report finished to stock" does; the work order's audit row says why.
 */

export interface TakeOutAnswer {
  readonly takenOut: number
  readonly putBack: number
  readonly left: number
  /** The receipts' mirrors, then the receipt of what went back in. */
  readonly moveIds: readonly string[]
  readonly overReserved: readonly OverReserved[]
  readonly words: string
}

const pieces = (value: { toString(): string }) => Number(new Dec(value.toString()).toFixed(0))

export async function takeOutOnReleaseReversal(tools: CommandTools, input: { readonly workOrderId: string; readonly cellId: string; readonly reversed: number; readonly reversalId: string; readonly reason: string }): Promise<TakeOutAnswer> {
  const { tx } = tools
  const tenantId = tenantOf(tools.context)
  const workOrder = (await readWorkOrder(tx, input.workOrderId))!
  await shareGate(tx, tenantId, workOrder.id)
  const facts = await readCompletionFacts(tx, workOrder)
  const figures = facts.figures.find((cell) => cell.cellId === input.cellId)
  const cell = facts.cells.find((row) => row.id === input.cellId)
  const itemId = cell ? (facts.skus.get(skuKey(cell.colourwayId, cell.size))?.itemId ?? null) : null
  const nothing = (words: string): TakeOutAnswer => ({ takenOut: 0, putBack: 0, left: 0, moveIds: [], overReserved: [], words })
  if (!figures || !cell || !itemId) return nothing('None of these garments went into finished goods.')

  const reversedIds = new Set(facts.moves.filter((move) => move.reversalOfId).map((move) => move.reversalOfId!))
  const open = facts.moves.filter((move) => !move.reversalOfId && move.itemId === itemId && !reversedIds.has(move.id)).reverse()
  const receipts: TakeOutReceipt[] = open.map((move) => ({ moveId: move.id, quantity: pieces(move.baseQuantity), placeId: move.toLocationId! }))
  const placeHolds = new Map<string, number>()
  for (const placeId of new Set(receipts.map((receipt) => receipt.placeId))) {
    const moves = await tx.stockMove.findMany({ where: { siteId: workOrder.siteId, itemId, OR: [{ toLocationId: placeId }, { fromLocationId: placeId }] }, select: { toLocationId: true, baseQuantity: true } })
    placeHolds.set(placeId, moves.reduce((sum, move) => sum + (move.toLocationId === placeId ? 1 : -1) * pieces(move.baseQuantity), 0))
  }
  const plan = releaseTakeOut({
    label: cellLabel(cell),
    netReleased: figures.netReleased,
    onShipments: figures.onShipments,
    received: figures.received,
    reversed: input.reversed,
    receipts,
    placeHolds,
    canReceive: workOrder.status === 'IN_PROGRESS' || workOrder.status === 'COMPLETED',
  })
  if (plan.reverse.length === 0) return { ...nothing(plan.words), left: plan.left }

  const note = `Release reversed: ${input.reason}`
  const originals = open.filter((move) => plan.reverse.includes(move.id))
  const { moves: mirrors, overReserved } = await reverseFinishedReceipts(tools, tenantId, originals, note, `quality.garments.reverse.finished:${input.reversalId}`)
  const back =
    plan.putBack > 0
      ? await postFinishedReceipts(
          tools,
          [{ siteId: workOrder.siteId, companyId: workOrder.companyId, workOrderId: workOrder.id, itemId, quantity: plan.putBack, toLocationId: plan.putBackPlaceId!, reference: workOrder.batchNumber, note: `The rest of a report taken back with a release reversal: ${input.reason}` }],
          `production.finish:${newId()}`,
        )
      : []
  tools.audit({
    recordType: 'WorkOrder',
    recordId: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    after: { finishedTakenOut: { reversalId: input.reversalId, cellId: cell.id, pieces: plan.takeOut, putBack: plan.putBack, left: plan.left, moveIds: mirrors.map((move) => move.id), putBackMoveIds: back.map((move) => move.id) } },
    reason: note,
  })
  // As "Report finished to stock" says it: each report taken back, and the rest reported again.
  for (const report of reportsOf(facts.moves)) {
    const mine = report.moves.filter((entry) => plan.reverse.includes(entry.move.id))
    if (mine.length === 0) continue
    tools.emit({
      type: 'workorder.finished_reversed',
      subject: workOrder.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      payload: {
        workOrderId: workOrder.id,
        number: workOrder.number,
        siteId: workOrder.siteId,
        reportId: report.id,
        moveIds: mine.map((entry) => mirrors[originals.findIndex((move) => move.id === entry.move.id)]!.id),
        pieces: mine.reduce((sum, entry) => sum + pieces(entry.move.baseQuantity), 0),
      },
    })
  }
  if (back.length > 0) {
    const after = completionView(await readCompletionFacts(tx, workOrder))
    tools.emit({
      type: 'workorder.finished_to_stock',
      subject: workOrder.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      payload: {
        workOrderId: workOrder.id,
        number: workOrder.number,
        siteId: workOrder.siteId,
        reportId: back[0]!.id,
        locationId: plan.putBackPlaceId!,
        moveIds: back.map((move) => move.id),
        cells: [{ workOrderSizeId: cell.id, itemId, quantity: plan.putBack }],
        pieces: plan.putBack,
        allInStock: after.allInStock,
      },
    })
  }
  return { takenOut: plan.takeOut, putBack: plan.putBack, left: plan.left, moveIds: [...mirrors.map((move) => move.id), ...back.map((move) => move.id)], overReserved, words: plan.words }
}
