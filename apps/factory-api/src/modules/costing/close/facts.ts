import { toMinorUnits } from '@nexus/factory-domain/core/money'
import { beyondOf, type Beyond, type CloseFigures } from '@nexus/factory-domain/costing/close/rules'
import type { WaitingView } from '@nexus/factory-domain/costing/ledger/contracts'
import { actualOf, standardOfCells } from '@nexus/factory-domain/costing/ledger/variance'
import { outputStandard, splitVariances, type Split, type SplitEntry } from '@nexus/factory-domain/costing/variances/split'
import { decimalOf, decimalText } from '@nexus/factory-domain/product/units/units'
import { wipFor } from '../../production/scans/progress'
import { planCosts } from '../actual/post'
import { costFactsOf } from '../actual/reads'
import { unique, type CostedWorkOrder, type Reader } from '../actual/store'
import { actualSettingsOf } from '../ppv/settings'

/**
 * What a work order's close is judged and settled from (B-W2b-411; MES-012, FIN-030, FIN-034), read with one client (inside
 * the close's command after its catch-up posting, or for the close check):
 *
 *   garments     planned: the cells; made: the good garments at the final operation (the floor's scans, as the record's
 *                size grid counts them), or, where no final operation was scanned at all, the garments received into
 *                finished goods (production receipts less their reversals); scrapped: the scans' and reworks' scrap
 *   material     planned: the standard material of the planned garments (each cell's frozen standard; else the estimate
 *                at release); actual: what the work order's ledger took (issues less returns, material scrapped from stock)
 *   minutes      planned: the routing's standard minutes × the planned garments; actual: the standard minutes earned on
 *                the ledger (the scans' labour, unplanned operations included): work-order totals, never a person's
 *   scrap        no allowance is kept on a work order: the planned scrap is 0
 *   tolerance    the company's close tolerance in force (ActualCostSettings: its row, the tenant's, else 5 %)
 *   split        the variance split against the standard of the garments made (factory-domain costing/variances/split)
 *   settles      the company's figures for the accountant are on (GATE-ACCOUNTANT)
 * The cost read's facts (actual/reads costFactsOf) are reused, so the close and the Labour & cost tab agree.
 */

export interface CloseFacts {
  readonly workOrder: CostedWorkOrder
  readonly figures: CloseFigures
  readonly tolerancePct: string
  readonly beyond: Beyond
  readonly settles: boolean
  readonly split: Split
  /** The items the split names (for the views). */
  readonly itemIds: readonly string[]
  /** Cost entries the ledger lacks (the close posts them first) and what cannot post yet. */
  readonly toPost: number
  readonly waiting: readonly WaitingView[]
}

/** The good garments made per cell: the final operation's scans, else the finished-goods receipts. */
async function madePerCell(db: Reader, workOrder: CostedWorkOrder, cells: readonly { readonly id: string; readonly itemId: string | null }[]) {
  const wip = await wipFor(db, workOrder)
  const scrapped = wip.cells.reduce((sum, cell) => sum + cell.scrapped, 0)
  if (wip.cells.some((cell) => cell.finished !== null)) {
    return { made: new Map(wip.cells.map((cell) => [cell.workOrderSizeId, cell.finished ?? 0])), scrapped }
  }
  const receipts = await db.stockMove.findMany({ where: { workOrderId: workOrder.id, reason: 'PRODUCTION_RECEIPT' }, select: { itemId: true, baseQuantity: true, reversalOfId: true } })
  const byItem = new Map<string, ReturnType<typeof decimalOf>>()
  for (const move of receipts) {
    const quantity = decimalOf(move.baseQuantity.toString())
    byItem.set(move.itemId, (byItem.get(move.itemId) ?? decimalOf('0')).plus(move.reversalOfId ? quantity.negated() : quantity))
  }
  const made = new Map<string, number>()
  for (const cell of cells) {
    const quantity = cell.itemId ? byItem.get(cell.itemId) : undefined
    if (cell.itemId) byItem.delete(cell.itemId)
    made.set(cell.id, quantity && quantity.gt(0) ? Number.parseInt(quantity.toDecimalPlaces(0, 1).toFixed(0), 10) : 0)
  }
  return { made, scrapped }
}

export async function closeFactsOf(db: Reader, workOrder: CostedWorkOrder, now: Date): Promise<CloseFacts> {
  const [facts] = await costFactsOf(db, [workOrder], now)
  const currency = workOrder.currency
  const minor = (value: ReturnType<typeof decimalOf>): number => toMinorUnits(value.toFixed(), currency)
  const { made, scrapped } = await madePerCell(db, workOrder, facts!.cells)
  const madeGarments = [...made.values()].reduce((sum, value) => sum + value, 0)
  const planned = facts!.pieces

  // The basis, as the cost read decides it: every cell's frozen standard, else the complete estimate at release.
  const exactStandard = standardOfCells(facts!.cells.map((cell) => ({ cellId: cell.id, quantity: cell.quantity, standard: cell.standard })))
  const basis = exactStandard ? 'STANDARD' : facts!.estimate.complete ? 'ESTIMATE' : null
  const plannedMaterial = exactStandard ? exactStandard.material : facts!.estimate.parts.material
  const actual = actualOf(facts!.variance, currency)
  const routing = facts!.operations.filter((operation) => !operation.unplanned)
  const plannedMinutes = routing.reduce((sum, operation) => sum.plus(decimalOf(operation.plannedMinutes)), decimalOf('0'))
  const earned = facts!.entries.filter((entry) => entry.kind === 'LABOUR' && entry.minutes !== null).reduce((sum, entry) => sum.plus(decimalOf(entry.minutes!)), decimalOf('0'))
  const figures: CloseFigures = {
    plannedQuantity: planned,
    actualQuantity: madeGarments,
    plannedScrapQuantity: 0,
    scrapQuantity: scrapped,
    plannedMaterialCost: Math.max(0, minor(plannedMaterial)),
    actualMaterialCost: Math.max(0, actual.material),
    plannedMinutes: decimalText(plannedMinutes.toDecimalPlaces(4, 4)),
    actualMinutes: decimalText((earned.isNegative() ? decimalOf('0') : earned).toDecimalPlaces(4, 4)),
  }
  const settings = await actualSettingsOf(db, workOrder.companyId)
  const tolerancePct = decimalText(decimalOf(settings.closeTolerancePct))

  const entries: SplitEntry[] = facts!.entries.map((entry, index) => ({
    kind: entry.kind,
    amount: entry.amount,
    itemId: entry.itemId,
    quantity: entry.quantity,
    minutes: entry.minutes,
    unitCost: entry.unitCost,
    standardUnitCost: facts!.variance[index]!.standardUnitCost,
    scrapRecord: facts!.variance[index]!.scrapRecord,
  }))
  const output = outputStandard(basis, facts!.cells.map((cell) => ({ made: made.get(cell.id) ?? 0, standard: cell.standard })), basis === 'ESTIMATE' ? facts!.estimate.parts : null, planned, madeGarments)
  const split = splitVariances({
    currency,
    basis,
    output,
    plannedGarments: planned,
    madeGarments,
    needs: [...facts!.materials.entries()].map(([itemId, row]) => ({ itemId, baseQuantity: row.planned, unitCost: row.unitCost })),
    minutesPerGarment: planned > 0 ? decimalText(plannedMinutes.div(planned)) : '0',
    entries,
  })
  const plan = await planCosts(db, workOrder, undefined)
  return {
    workOrder,
    figures,
    tolerancePct,
    beyond: beyondOf(figures, tolerancePct),
    settles: settings.postingsOn,
    split,
    itemIds: unique(split.lines.map((line) => line.itemId)),
    toPost: plan.drafts.length,
    waiting: plan.waiting,
  }
}
