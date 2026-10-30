import type { Decimal } from 'decimal.js'
import { toMinorUnits } from '../../core/money'
import { decimalOf } from '../../product/units/units'
import type { CostEntryKind } from './entries'

/**
 * Estimated vs actual on a work order (B-W2a-21; FIN-033; design finance.costing "Work orders: standard vs actual" and
 * its "WO — cost" bridge, production.workorders "Labour & cost"), pure.
 *
 *   standard    Σ cells: garments × the frozen standard of the cell's finished item (material, labour, subcontract,
 *               overhead per garment); known only when every cell has one
 *   estimate    at release: the work order's frozen materials (BOM need with waste) × each material's standard, its
 *               frozen operations' standard minutes × garments × the cost per minute in force that day, overhead
 *   actual      Σ the ledger's entries so far (reversals included), less the completions (the value moved to stock)
 *   variance    actual − the basis (the standard when known, else the estimate), and its percent of the basis
 *   bridge      the variance split into reasons that add up to it exactly: material price (each issue at its unit cost
 *               against its standard), scrap (material scrapped from stock, and the leather of garments scrapped at an
 *               operation or in a rework, at standard), material usage (the rest of the material), labour, subcontract,
 *               overhead, adjustments
 * Amounts are minor units of the work order's company's currency: every exact figure is rounded once. While the work
 * order runs, its actual grows as work is reported (the labour reason is below 0 until every garment is earned).
 */

export const BRIDGE_REASONS = ['MATERIAL_PRICE', 'MATERIAL_USAGE', 'SCRAP', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT'] as const
export type BridgeReason = (typeof BRIDGE_REASONS)[number]

export const COST_PARTS = ['MATERIAL', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD'] as const
export type CostPart = (typeof COST_PARTS)[number]

/** Exact amounts per part, in major units of the currency. */
export interface ExactParts {
  readonly material: Decimal
  readonly labour: Decimal
  readonly subcontract: Decimal
  readonly overhead: Decimal
}

/** Parts in minor units. */
export interface MinorParts {
  readonly material: number
  readonly labour: number
  readonly subcontract: number
  readonly overhead: number
  readonly total: number
}

const ZERO = (): Decimal => decimalOf('0')

/** The parts rounded once each, and the total (the exact sum rounded once). */
export function minorParts(parts: ExactParts, currency: string): MinorParts {
  const exactTotal = parts.material.plus(parts.labour).plus(parts.subcontract).plus(parts.overhead)
  return {
    material: toMinorUnits(parts.material.toFixed(), currency),
    labour: toMinorUnits(parts.labour.toFixed(), currency),
    subcontract: toMinorUnits(parts.subcontract.toFixed(), currency),
    overhead: toMinorUnits(parts.overhead.toFixed(), currency),
    total: toMinorUnits(exactTotal.toFixed(), currency),
  }
}

/** A cell's garments and its finished item's frozen standard per garment (null: none). */
export interface CellStandard {
  readonly cellId: string
  readonly quantity: number
  readonly standard: { readonly materialCost: string; readonly labourCost: string; readonly subcontractCost: string; readonly overheadCost: string } | null
}

/** The standard of the work order: Σ garments × each part, exact; null when a cell has no standard. */
export function standardOfCells(cells: readonly CellStandard[]): ExactParts | null {
  if (cells.length === 0 || cells.some((cell) => cell.standard === null)) return null
  return cells.reduce<ExactParts>(
    (sum, cell) => ({
      material: sum.material.plus(decimalOf(cell.standard!.materialCost).times(cell.quantity)),
      labour: sum.labour.plus(decimalOf(cell.standard!.labourCost).times(cell.quantity)),
      subcontract: sum.subcontract.plus(decimalOf(cell.standard!.subcontractCost).times(cell.quantity)),
      overhead: sum.overhead.plus(decimalOf(cell.standard!.overheadCost).times(cell.quantity)),
    }),
    { material: ZERO(), labour: ZERO(), subcontract: ZERO(), overhead: ZERO() },
  )
}

/** The estimate's inputs: planned base quantities × a price per base unit (null: unknown), minutes × a cost per minute. */
export interface EstimateFacts {
  readonly materials: readonly { readonly itemId: string; readonly baseQuantity: string; readonly unitCost: string | null }[]
  readonly operations: readonly { readonly operationId: string; readonly minutes: string; readonly perMinute: string | null }[]
  /** Percent on material + labour; null: no overhead rule. */
  readonly overheadPct: string | null
}

export interface Estimate {
  readonly parts: ExactParts
  /** Every price and rate was known (else the parts hold the known part only). */
  readonly complete: boolean
  readonly missingItems: readonly string[]
  readonly missingOperations: readonly string[]
}

export function estimateOf(facts: EstimateFacts): Estimate {
  const missingItems = [...new Set(facts.materials.filter((row) => row.unitCost === null).map((row) => row.itemId))]
  const missingOperations = facts.operations.filter((row) => row.perMinute === null).map((row) => row.operationId)
  const material = facts.materials.reduce((sum, row) => (row.unitCost === null ? sum : sum.plus(decimalOf(row.baseQuantity).times(decimalOf(row.unitCost)))), ZERO())
  const labour = facts.operations.reduce((sum, row) => (row.perMinute === null ? sum : sum.plus(decimalOf(row.minutes).times(decimalOf(row.perMinute)))), ZERO())
  const overhead = facts.overheadPct === null ? ZERO() : material.plus(labour).times(decimalOf(facts.overheadPct)).div(100)
  return {
    parts: { material, labour, subcontract: ZERO(), overhead },
    complete: missingItems.length === 0 && missingOperations.length === 0 && facts.materials.length > 0 && facts.operations.length > 0,
    missingItems,
    missingOperations,
  }
}

/** A posted entry as the actual and the bridge read it. */
export interface EntryFacts {
  readonly kind: CostEntryKind
  readonly amount: number
  /** Base units, signed as the amount. */
  readonly quantity: string | null
  readonly unitCost: string | null
  readonly standardUnitCost: string | null
  /** A SCRAP from a scan or a rework (a record of the loss, amount 0), not a SCRAP move from stock. */
  readonly scrapRecord: boolean
}

export interface Actual {
  /** MATERIAL + SCRAP from stock. */
  readonly material: number
  readonly labour: number
  readonly subcontract: number
  readonly overhead: number
  readonly adjustment: number
  /** Σ of the above. */
  readonly total: number
  /** COMPLETION: the value moved to finished goods (0 or less). */
  readonly movedToStock: number
  /** What is still on the work order: total + movedToStock. */
  readonly onWorkOrder: number
  /** The leather of scrapped garments at the issue's value (a part of `material`). */
  readonly scrapLost: number
  /** SCRAP from stock (a part of `material`). */
  readonly scrapFromStock: number
}

const sumOf = (entries: readonly EntryFacts[], kinds: readonly CostEntryKind[]): number => entries.filter((entry) => kinds.includes(entry.kind)).reduce((sum, entry) => sum + entry.amount, 0)

/** Σ quantity × a unit cost over entries, exact (major units); entries without that unit cost are skipped. */
const valueAt = (entries: readonly EntryFacts[], unit: (entry: EntryFacts) => string | null): Decimal =>
  entries.reduce((sum, entry) => {
    const cost = unit(entry)
    return entry.quantity === null || cost === null ? sum : sum.plus(decimalOf(entry.quantity).times(decimalOf(cost)))
  }, ZERO())

export function actualOf(entries: readonly EntryFacts[], currency: string): Actual {
  const material = sumOf(entries, ['MATERIAL', 'SCRAP'])
  const labour = sumOf(entries, ['LABOUR'])
  const subcontract = sumOf(entries, ['SUBCONTRACT'])
  const overhead = sumOf(entries, ['OVERHEAD'])
  const adjustment = sumOf(entries, ['ADJUSTMENT'])
  const total = material + labour + subcontract + overhead + adjustment
  const movedToStock = sumOf(entries, ['COMPLETION'])
  const records = entries.filter((entry) => entry.kind === 'SCRAP' && entry.scrapRecord)
  return {
    material,
    labour,
    subcontract,
    overhead,
    adjustment,
    total,
    movedToStock,
    onWorkOrder: total + movedToStock,
    scrapLost: toMinorUnits(valueAt(records, (entry) => entry.unitCost).toFixed(), currency),
    scrapFromStock: entries.filter((entry) => entry.kind === 'SCRAP' && !entry.scrapRecord).reduce((sum, entry) => sum + entry.amount, 0),
  }
}

export interface BridgeStep {
  readonly reason: BridgeReason
  readonly amount: number
}

/**
 * The bridge from the basis to the actual: each reason in minor units, adding up exactly to actual − basis (material
 * usage takes the material's remainder, so the rounding of the others lands there).
 */
export function bridgeOf(basis: MinorParts, actual: Actual, entries: readonly EntryFacts[], currency: string): BridgeStep[] {
  const issues = entries.filter((entry) => entry.kind === 'MATERIAL' && entry.standardUnitCost !== null)
  const price = issues.reduce((sum, entry) => sum + entry.amount, 0) - toMinorUnits(valueAt(issues, (entry) => entry.standardUnitCost).toFixed(), currency)
  const records = entries.filter((entry) => entry.kind === 'SCRAP' && entry.scrapRecord)
  const scrap = actual.scrapFromStock + toMinorUnits(valueAt(records, (entry) => entry.standardUnitCost ?? entry.unitCost).toFixed(), currency)
  const usage = actual.material - basis.material - price - scrap
  const steps: BridgeStep[] = [
    { reason: 'MATERIAL_PRICE', amount: price },
    { reason: 'MATERIAL_USAGE', amount: usage },
    { reason: 'SCRAP', amount: scrap },
    { reason: 'LABOUR', amount: actual.labour - basis.labour },
    { reason: 'SUBCONTRACT', amount: actual.subcontract - basis.subcontract },
    { reason: 'OVERHEAD', amount: actual.overhead - basis.overhead },
    { reason: 'ADJUSTMENT', amount: actual.adjustment },
  ]
  // The basis's parts are rounded one by one, its total once: a cent of difference goes to usage, so the steps add up.
  const drift = actual.total - basis.total - steps.reduce((sum, step) => sum + step.amount, 0)
  return steps.map((step) => (step.reason === 'MATERIAL_USAGE' ? { ...step, amount: step.amount + drift } : step)).map((step) => ({ ...step, amount: step.amount === 0 ? 0 : step.amount }))
}

/** The reason with the largest effect (null when every step is 0). */
export function biggestReason(steps: readonly BridgeStep[]): BridgeReason | null {
  const best = steps.reduce<BridgeStep | null>((top, step) => (step.amount !== 0 && (top === null || Math.abs(step.amount) > Math.abs(top.amount)) ? step : top), null)
  return best?.reason ?? null
}

/** The variance's percent of the basis, two places (null when the basis is 0). */
export function variancePct(variance: number, basis: number): string | null {
  if (basis === 0) return null
  return decimalOf(String(variance)).times(100).div(basis).toDecimalPlaces(2, 4).toFixed(2)
}

/** Over the basis by more than `pct` percent (the design's tile: 5 %). */
export const isOver = (variance: number, basis: number, pct = 5): boolean => basis > 0 && variance * 100 > basis * pct

/** Per garment, minor units, rounded once (null without garments). */
export const perGarment = (amount: number, pieces: number): number | null => (pieces > 0 ? Number.parseInt(decimalOf(String(amount)).div(pieces).toDecimalPlaces(0, 4).toFixed(0), 10) : null)
