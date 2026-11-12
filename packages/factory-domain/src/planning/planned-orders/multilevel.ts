import type { Decimal } from 'decimal.js'
import { MAX_BOM_LEVELS } from '../../product/bom-structure/rules'
import { decimalOf } from '../../product/units/units'
import { planRequirements, type PlanInput, type PlanOrderLine, type PlanResult, type PlanWarning } from '../explode'
import { garmentNeeds, problemWarning, shareKey, type GarmentSource, type Shares } from './explosion'
// B-W2b-318 (PLN-081): a made part's scrap and yield multiply what is below it.
import { withComponentFactors } from '../lot-sizing/scrap'

/**
 * The run on the multi-level explosion (B-W2b-293; MR1:01), pure: W1's netting (../explode `planRequirements`) with each
 * garment exploded through every level (./explosion), and the parts we make netted level by level, as an MRP does with
 * its low-level codes:
 *
 *   pass 1     every garment's materials, and its made sub-assemblies as parts to make (W1's MAKE lines), each netted
 *              against its own stock, reservations, purchase lines and firm planned orders
 *   pass n+1   what is below a made sub-assembly is needed only for the share of it that pass n left to make (per order
 *              line and size: what its parts still need ÷ what they asked), so stock of a made liner is never bought twice
 *              (once as the liner, once as its fabric); a deeper sub-assembly's share follows in the next pass
 *
 * It stops when no share changes (one pass when nothing is made below the garment or every part is still to make), at
 * most MAX_BOM_LEVELS + 1 passes. Without `garments` (no line has an explosion) it is W1's run exactly.
 */

/** The explosion of each order line that has one (the line's revision read with its sub-assemblies). */
export interface Garments {
  readonly sourceOf: (orderLineId: string) => GarmentSource | null
  /** The colourway's code of each colourway the order lines name. */
  readonly colourwayCodeOf: (colourwayId: string) => string
}

export interface LevelledPlan extends PlanResult {
  /** How many netting passes it took (1: no made part below a garment changed anything). */
  readonly passes: number
}

const ONE = decimalOf('1')
const ZERO = decimalOf('0')

/** The garment's needs of one order line and size under these shares (null: W1's one level for the line). */
function needsOf(garments: Garments, shares: Shares, line: PlanOrderLine, size: string) {
  const source = garments.sourceOf(line.orderLineId)
  if (!source) return null
  return garmentNeeds(source, { orderLineId: line.orderLineId, size, colourwayId: line.colourwayId, colourwayCode: garments.colourwayCodeOf(line.colourwayId) }, shares)
}

/** The shares still to make of the made sub-assemblies, from one pass's netting of their components. */
function sharesOf(input: PlanInput, garments: Garments, plan: PlanResult, before: Shares): Map<string, Decimal> {
  // The components each order line and size makes below its garment.
  const wanted = new Set<string>()
  // A made-to-measure unit's parts name no size: its one size.
  const unitSize = new Map(input.orderLines.flatMap((line) => (line.madeToMeasure && line.sizes[0] ? [[line.orderLineId, line.sizes[0].size] as const] : [])))
  for (const line of input.orderLines) {
    for (const row of line.sizes) {
      if (row.pieces <= 0) continue
      const needs = needsOf(garments, before, line, row.size)
      for (const component of needs?.components ?? []) wanted.add(shareKey(line.orderLineId, row.size, component.itemId, component.itemColourId))
    }
  }
  const asked = new Map<string, Decimal>()
  const left = new Map<string, Decimal>()
  for (const entry of plan.netting) {
    for (const coverage of entry.pegging.coverage) {
      const key = shareKey(coverage.part.orderLineId, coverage.part.size ?? unitSize.get(coverage.part.orderLineId) ?? '', entry.itemId, entry.itemColourId)
      if (!wanted.has(key)) continue
      // What the part still needed (less what is issued to its work order) and what is still uncovered.
      const need = decimalOf(coverage.part.quantity).minus(decimalOf(coverage.part.issued))
      asked.set(key, (asked.get(key) ?? ZERO).plus(need.gt(0) ? need : ZERO))
      left.set(key, (left.get(key) ?? ZERO).plus(decimalOf(coverage.uncovered)))
    }
  }
  const shares = new Map<string, Decimal>()
  for (const key of wanted) {
    const total = asked.get(key) ?? ZERO
    const share = total.gt(0) ? (left.get(key) ?? ZERO).dividedBy(total) : ZERO
    shares.set(key, share.gt(ONE) ? ONE : share.lt(0) ? ZERO : share)
  }
  return shares
}

const sameShares = (a: Shares, b: Shares): boolean => {
  const keys = new Set([...a.keys(), ...b.keys()])
  for (const key of keys) if (!(a.get(key) ?? ONE).equals(b.get(key) ?? ONE)) return false
  return true
}

/** The site's run with every garment exploded through its levels; the explosion's problems join the warnings. */
export function planLevelled(input: PlanInput, garments: Garments | null): LevelledPlan {
  // B-W2b-318 (PLN-081): each part's factor passed on to what is below it (../lot-sizing/scrap).
  return levelled(input, garments && input.scrapYield ? withComponentFactors(garments, input.scrapYield.itemFactor) : garments)
}

function levelled(input: PlanInput, garments: Garments | null): LevelledPlan {
  if (!garments) return { ...planRequirements(input), passes: 1 }
  let shares: Shares = new Map()
  let plan: PlanResult | null = null
  let passes = 0
  for (let pass = 0; pass <= MAX_BOM_LEVELS; pass += 1) {
    const current = shares
    plan = planRequirements({ ...input, perGarment: (line, size) => needsOf(garments, current, line, size)?.needs ?? null })
    passes += 1
    const next = sharesOf(input, garments, plan, current)
    if (sameShares(current, next)) break
    shares = next
  }
  // The explosion's problems, once per order line, size and message.
  const warnings: PlanWarning[] = []
  const seen = new Set<string>()
  for (const line of input.orderLines) {
    for (const row of line.sizes) {
      if (row.pieces <= 0) continue
      for (const problem of needsOf(garments, shares, line, row.size)?.problems ?? []) {
        const key = `${line.orderLineId}|${problem.lineId}|${problem.code}`
        if (seen.has(key)) continue
        seen.add(key)
        warnings.push(problemWarning(problem, line, row.size))
      }
    }
  }
  return { ...plan!, warnings: [...plan!.warnings, ...warnings], passes }
}
