/**
 * PRICING_UPDATE — what one row of the job does, in every mode. No database call.
 *
 * The run (`processPricingUpdate`) and the preview (`computePreview`) both call `pricingUpdateOutcome` on the product
 * row the job loaded, so the preview shows the number the run writes. Before 2026-10-01 the preview read
 * `variation.price` — a column a Product row does not have — and showed "NaN" as the current price in every mode and
 * as the new price for PERCENT and DELTA; it also printed the raw computed price, not the cents the write stores.
 *
 * Modes (`payload.adjustmentType`):
 *   ABSOLUTE          price := value
 *   PERCENT           price := current × (1 + value / 100)
 *   DELTA             price := current + value
 *   ROUND_DOWN_TO_99  the largest X.99 at or below the current price; no value (`price-rounding.ts`)
 * A row is skipped, not failed, when:
 *   - the computed price is below zero, or outside the job's `minPrice` / `maxPrice` (as always);
 *   - the price it would store is 0 or below — a bulk change never stores a master price of 0 (2026-10-01);
 *   - the price it would store is outside the PRODUCT's own floor / ceiling (`Product.minPrice` / `maxPrice`,
 *     2026-10-01). The push refuses such a price after Nexus stored it, so Nexus and the channel would disagree.
 * The last two are the agent price tools' rules (#225, `price-bounds.service.ts`). Every skipped row says why, in plain
 * words: the job item keeps it as its message (`BulkActionItem.errorMessage`, status SKIPPED) and the preview shows it.
 */
import { masterPriceBoundsReason, priceBoundsOf, zeroPriceReason } from '../price-bounds.service.js'
import { roundCents } from '@nexus/shared/listing-price'
import { ROUND_DOWN_TO_99, roundDownTo99Outcome } from './price-rounding.js'

/** One row's result. A skipped row always says why, in plain words (the job item's message and the preview's). */
export type PricingUpdateOutcome =
  | { newPrice: number; status: 'processed' }
  | { newPrice: number; status: 'skipped'; reason: string }

/**
 * The columns of the product row the rule reads: its master price and its own floor and ceiling. A whole Product row
 * (as `getItemsForJob` loads it) has all three; a narrower select must name them.
 */
export type PricedProduct = { basePrice: unknown; minPrice: unknown; maxPrice: unknown }

/** The price a PRICING_UPDATE row starts from: the product's master price (`basePrice`); none = 0. */
export function currentBasePrice(product: Pick<PricedProduct, 'basePrice'>): number {
  return product.basePrice != null ? Number(product.basePrice) : 0
}

/**
 * The cents the master price write stores — MasterPriceService's own rounding, the one cents helper (`roundCents`,
 * @nexus/shared/listing-price: 1.005 → 1.01). Rounding an already-rounded price again changes nothing, so the run may
 * pass this value on.
 */
function storedCents(value: number): number {
  return roundCents(value)
}

/**
 * A price as the job's own bounds tested it: in cents when it is whole cents, otherwise to four places — those bounds
 * test the computed price, so "10.00 is below the minimum of 10.00" would be a false sentence for 9.996.
 */
function asTested(n: number): string {
  const four = Number(n.toFixed(4))
  return Math.abs(four * 100 - Math.round(four * 100)) < 1e-6 ? four.toFixed(2) : String(four)
}

/** The mode's own arithmetic on the current price: the computed price and its stored cents, or the mode's own skip. */
function modeOutcome(
  currentPrice: number,
  payload: Record<string, any>,
): { computed: number; newPrice: number } | { newPrice: number; reason: string } {
  const adjustmentType = payload.adjustmentType
  if (adjustmentType === ROUND_DOWN_TO_99) {
    const rounded = roundDownTo99Outcome(currentPrice)
    return rounded.status === 'skipped' ? rounded : { computed: rounded.newPrice, newPrice: rounded.newPrice }
  }

  const rawValue = payload.value
  const value = typeof rawValue === 'number' ? rawValue : Number(rawValue)
  if (!adjustmentType || Number.isNaN(value)) {
    throw new Error('Invalid PRICING_UPDATE payload: adjustmentType + numeric value required')
  }
  let computed: number
  switch (adjustmentType) {
    case 'ABSOLUTE':
      computed = value
      break
    case 'PERCENT':
      computed = currentPrice * (1 + value / 100)
      break
    case 'DELTA':
      computed = currentPrice + value
      break
    default:
      throw new Error(`Invalid PRICING_UPDATE adjustmentType: ${adjustmentType}`)
  }
  return { computed, newPrice: storedCents(computed) }
}

/**
 * The new price of one row and whether the row is processed or skipped — and, when skipped, why. Throws on a payload
 * no row can run (the item then fails, as before). In order:
 *   1. the mode's own skip (ROUND_DOWN_TO_99: below 0.99, or already .99);
 *   2. a stored price of 0 or below (a computed price below 0 included);
 *   3. the job's own minPrice / maxPrice, on the computed price as always;
 *   4. the product's own floor / ceiling, on the price that would be stored.
 */
export function pricingUpdateOutcome(product: PricedProduct, payload: Record<string, any>): PricingUpdateOutcome {
  const mode = modeOutcome(currentBasePrice(product), payload)
  if ('reason' in mode) return { newPrice: mode.newPrice, status: 'skipped', reason: mode.reason }
  const { computed, newPrice } = mode
  const skip = (reason: string): PricingUpdateOutcome => ({ newPrice, status: 'skipped', reason: `Not changed: ${reason}.` })

  // The zero rule and the bounds clause are the ones the master-price write itself refuses with (`storedPriceReason`
  // = `zeroPriceReason` + `masterPriceBoundsReason`), checked here in this mode's order so the preview names the reason.
  const zero = zeroPriceReason(newPrice)
  if (zero !== null) return skip(zero)
  if (typeof payload.minPrice === 'number' && computed < payload.minPrice) {
    return skip(`${asTested(computed)} is below this job's minimum price of ${asTested(payload.minPrice)}`)
  }
  if (typeof payload.maxPrice === 'number' && computed > payload.maxPrice) {
    return skip(`${asTested(computed)} is above this job's maximum price of ${asTested(payload.maxPrice)}`)
  }
  // Never a price the product's own floor or ceiling refuses (a floor above the ceiling refuses every price).
  const outside = masterPriceBoundsReason(newPrice, priceBoundsOf(product))
  if (outside !== null) return skip(outside)
  return { newPrice, status: 'processed' }
}
