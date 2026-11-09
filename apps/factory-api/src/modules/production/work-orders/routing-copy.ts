import type { FactoryClient } from '@nexus/factory-db'
import type { ReleaseCheck } from '@nexus/factory-domain/production/work-orders/release'
import type { MissingWorkCentre } from '@nexus/factory-domain/production/work-orders/spec'
import { stepsForCells, workCentresForCells, type CellFacts, type LeftOut, type StepVariants } from '@nexus/factory-domain/product/routing-depth/rules'
import type { CommandTx } from '../../../core/command'

/**
 * A work order's copy of its revision's routing (B-W2b-225; PRD-124, PRD-128). A released work order keeps the copy its
 * release made (WorkOrderOperation, one per step it takes, frozen by the …_production_guards trigger; its revision frozen
 * with it), so a later revision of the style never changes it: a work order made before a release keeps its frozen
 * routing (effective days: modules/product/routing-depth/effectivity.ts). What the copy takes:
 *
 *   steps     every step for every cell, and a step only for some sizes, colourways or options when one of the work
 *             order's cells is one of them (factory-domain product/routing-depth `stepsForCells`); a step for other cells
 *             only is left out, and said (`leftOut`). The release (./facts planSpec) plans the operations from the kept
 *             steps; its WORK_CENTRES check holds a work order none of whose kept steps is scanned (`workCentresCheck`).
 *   depth     the checkpoint, the machine settings, the set-up / wait / move minutes and the extra minutes per size stay on
 *             the revision's step, frozen with it, and are read through the operation's (styleRevisionId, routingSeq): the
 *             work order's view (modules/product/routing-depth/work-order.ts) and the tablet read them there.
 *
 * Only the parts ./facts.ts needs live here (a leaf: it imports nothing of the work orders' own files).
 */

type Reader = FactoryClient | CommandTx

/** What each step of the revision is for, by step id (W2b-4 columns of RoutingOperation). */
export async function readStepVariants(db: Reader, revisionId: string | null): Promise<Map<string, StepVariants>> {
  if (!revisionId) return new Map()
  const rows = await db.routingOperation.findMany({ where: { revisionId }, select: { id: true, appliesToSizes: true, appliesToColourwayIds: true, appliesToOptionValueIds: true } })
  return new Map(rows.map((row) => [row.id, { sizes: [...row.appliesToSizes], colourwayIds: [...row.appliesToColourwayIds], optionValueIds: [...row.appliesToOptionValueIds] }]))
}

/** The steps the work order's cells need, and those left out (no variants read: every step is kept). */
export function stepsForWorkOrder<Step extends { readonly id: string }>(steps: readonly Step[], variants: ReadonlyMap<string, StepVariants> | undefined, cells: readonly CellFacts[]): { readonly kept: Step[]; readonly leftOut: LeftOut<Step>[] } {
  if (!variants || variants.size === 0) return { kept: [...steps], leftOut: [] }
  return stepsForCells(steps, (stepId) => variants.get(stepId), cells)
}

/** The release's WORK_CENTRES check on the kept steps (W1's answer when none is left out). */
export function workCentresCheck<Step extends { readonly id: string; readonly seq: number; readonly code: string; readonly name: string; readonly scanRequired: boolean }>(
  siteCode: string,
  steps: readonly Step[],
  variants: ReadonlyMap<string, StepVariants> | undefined,
  cells: readonly (CellFacts & { readonly label: string })[],
  missing: readonly MissingWorkCentre[],
): ReleaseCheck {
  const { kept, leftOut } = stepsForWorkOrder(steps, variants, cells)
  return workCentresForCells(siteCode, steps.length, kept, leftOut, missing, cells.map((cell) => cell.label))
}
