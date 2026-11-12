import type { Decimal } from 'decimal.js'
import type { GarmentNeed, PlanOrderLine } from '../explode'
import type { Garments } from '../planned-orders/multilevel'

/**
 * Scrap and yield on top of the BOM's wastage (B-W2b-318; PLN-081), pure: the run's hook (planning/explode
 * `PlanInput.scrapYield`). What one garment of an order line's size takes of a material (or a part we make) is multiplied
 * by the material's own factor at the site (ItemPlanning.scrapPct, yieldPct: (1 + scrap) ÷ yield; ./parameters
 * `scrapYieldFactor`) and by the garment's: the factor of the finished garment of that SKU (the style, colourway and size
 * of the cell), for the garments lost on the way (operation scrap, the final check). A part we make passes its factor on
 * to what is below it (./multilevel through `withComponentFactors`: a 5 % scrap of liners takes 5 % more lining), a
 * phantom too. No factor (none set, or 1): the numbers are W1's exactly. Exact; the run rounds once per order line and
 * size (W1).
 */

export interface ScrapYield {
  /** A material's (or a part's) factor at the site, its colour's row first; null: 1. */
  readonly itemFactor: (itemId: string, itemColourId: string | null) => Decimal | null
  /** The finished garment's factor of an order line's size (its SKU's row at the site); null: 1. */
  readonly garmentFactor: (line: PlanOrderLine, size: string) => Decimal | null
}

/** One garment's needs with the factors applied (the same list when there is none). */
export function withScrapYield(rules: ScrapYield | undefined, line: PlanOrderLine, size: string, needs: readonly GarmentNeed[]): readonly GarmentNeed[] {
  if (!rules) return needs
  const garment = rules.garmentFactor(line, size)
  return needs.map((need) => {
    const own = rules.itemFactor(need.itemId, need.itemColourId)
    if (!own && !garment) return need
    let quantity = need.quantity
    if (own) quantity = quantity.times(own)
    if (garment) quantity = quantity.times(garment)
    return { ...need, quantity }
  })
}

/** The garments' explosions with each made part's (and phantom's) factor passed on to what is below it. */
export function withComponentFactors(garments: Garments, factorOf: (itemId: string, itemColourId: string | null) => Decimal | null): Garments {
  return {
    ...garments,
    sourceOf: (orderLineId) => {
      const source = garments.sourceOf(orderLineId)
      return source ? { ...source, factorOf } : null
    },
  }
}
