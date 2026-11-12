import type { PlanLevel } from './parameters'

/**
 * Plan by style, colour or size (B-W2b-318; PLN-008), pure: how the run's make and subcontract pass (planning/planned-
 * orders `proposeWork`) splits a style-colourway's open sizes into planned work orders, by the plan level of its finished
 * garments at the site (ItemPlanning.planLevel of each SKU's FINISHED item):
 *
 *   SKU            each size its own planned work order (its group: the size code)
 *   STYLE_COLOUR   the colourway's sizes in one grid, whatever the site's size groups
 *   STYLE          the same as STYLE_COLOUR: a planned work order makes one colourway (PlannedWorkOrder.colourwayId),
 *                  so the style's colourways stay apart
 *   none           the site's size-run rule (B-W2b-293: one grid, or the site's size groups)
 *
 * When the SKUs of a colourway are set differently, the finest level wins (SKU before STYLE_COLOUR before STYLE): a
 * shortage of one size is never hidden in a bigger order. Due dates and the revision the lines name still split the
 * orders (B-W2b-293's key).
 */

const FINENESS: Readonly<Record<PlanLevel, number>> = Object.freeze({ SKU: 3, STYLE_COLOUR: 2, STYLE: 1 })

/** The level of a style-colourway from its SKUs' levels (null ones are not set); null: none set. */
export function planLevelOf(levels: readonly (PlanLevel | null | undefined)[]): PlanLevel | null {
  let found: PlanLevel | null = null
  for (const level of levels) if (level && (found === null || FINENESS[level] > FINENESS[found])) found = level
  return found
}

/** The size groups of a plan level (codes in run order, with their words); null: the site's size-run rule decides. */
export function sizeSplitByLevel(level: PlanLevel | null | undefined, sizes: readonly string[]): { readonly codes: string[]; readonly words: string | null }[] | null {
  if (!level || sizes.length === 0) return null
  if (level === 'SKU') return sizes.map((size) => ({ codes: [size], words: size }))
  return [{ codes: [...sizes], words: null }]
}
