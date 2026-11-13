import { stepIsFor, type CellFacts, type StepVariants } from '@nexus/factory-domain/product/routing-depth/rules'

/**
 * Only the steps a cell is for, in capacity (B-W2b-365; follow-up of B-W2b-F40; B-W2b-225's PRD-128 "Only for sizes, colours
 * or options"). A released work order keeps a routing step only for some cells when one of its cells is one of them; its
 * operation is then done on THOSE cells' garments, not on every garment of the work order. The capacity world (./service:
 * booked minutes, the heatmap, the promise's lanes) and the board (../schedule/service: what is left of an operation) count
 * an operation's garments here.
 *
 *   variants   the operation's routing step (RoutingOperation.appliesTo…, read through the operation's revision and routing
 *              seq); none (an unplanned operation, a step for every cell): every garment
 *   cells      the work order's cells with their colourway, size, pieces and chosen options (WorkOrderSize.optionValueIds)
 */

/** A work order's cell as capacity reads it. */
export interface LoadCell extends CellFacts {
  readonly quantity: number
}

/** The variants of a routing step as the database keeps them (null: none read). */
export interface StepColumns {
  readonly appliesToSizes: readonly string[]
  readonly appliesToColourwayIds: readonly string[]
  readonly appliesToOptionValueIds: readonly string[]
}

/** The routing step's columns every capacity reader selects with an operation (the relation through revision and seq). */
export const STEP_VARIANT_COLUMNS = { appliesToSizes: true, appliesToColourwayIds: true, appliesToOptionValueIds: true } as const

/** The work order's cell columns capacity needs (with the chosen options). */
export const LOAD_CELL_COLUMNS = { colourwayId: true, size: true, quantity: true, optionValueIds: true } as const

export const variantsOf = (step: StepColumns | null | undefined): StepVariants | null =>
  step ? { sizes: [...step.appliesToSizes], colourwayIds: [...step.appliesToColourwayIds], optionValueIds: [...step.appliesToOptionValueIds] } : null

/** The garments an operation is done on: those of the cells its step is for (every garment for a step for every cell). */
export function garmentsOf(step: StepColumns | null | undefined, cells: readonly LoadCell[]): number {
  const variants = variantsOf(step)
  return cells.filter((cell) => variants === null || stepIsFor(variants, cell)).reduce((sum, cell) => sum + cell.quantity, 0)
}
