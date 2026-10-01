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
 * The last two are the agent price tools' rules (#225, `price-bounds.service.ts`).
 */
import type { Product } from '@prisma/client'
import { masterPriceBoundsReason, priceBoundsOf } from '../price-bounds.service.js'
import { ROUND_DOWN_TO_99, roundDownTo99Outcome } from './price-rounding.js'

export type PricingUpdateOutcome = { newPrice: number; status: 'processed' | 'skipped' }

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
 * The cents the master price write stores — MasterPriceService's own rounding (`roundCurrency`: Product.basePrice is
 * a Decimal(10,2)). Rounding an already-rounded price again changes nothing, so the run may pass this value on.
 */
function storedCents(value: number): number {
  return Math.round(value * 100) / 100
}

/** The mode's own arithmetic and the job's own bounds, on the current price. */
function modeOutcome(currentPrice: number, payload: Record<string, any>): PricingUpdateOutcome {
  const adjustmentType = payload.adjustmentType
  if (adjustmentType === ROUND_DOWN_TO_99) return roundDownTo99Outcome(currentPrice, payload)

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

  // The job's bounds test the computed price, as they always have; the price returned is the cents the write stores.
  let status: PricingUpdateOutcome['status'] = 'processed'
  if (computed < 0) status = 'skipped'
  else if (typeof payload.minPrice === 'number' && computed < payload.minPrice) status = 'skipped'
  else if (typeof payload.maxPrice === 'number' && computed > payload.maxPrice) status = 'skipped'
  return { newPrice: storedCents(computed), status }
}

/**
 * The new price of one row and whether the row is processed or skipped. Throws on a payload no row can run (the item
 * then fails, as before).
 */
export function pricingUpdateOutcome(product: PricedProduct, payload: Record<string, any>): PricingUpdateOutcome {
  const outcome = modeOutcome(currentBasePrice(product), payload)
  if (outcome.status === 'skipped') return outcome
  // Never a master price of 0 or below.
  if (outcome.newPrice <= 0) return { ...outcome, status: 'skipped' }
  // Never a price the product's own floor or ceiling refuses (a floor above the ceiling refuses every price).
  if (masterPriceBoundsReason(outcome.newPrice, priceBoundsOf(product)) !== null) return { ...outcome, status: 'skipped' }
  return outcome
}
