/**
 * PRICING_UPDATE — what one row of the job does, in every mode. Pure: no Prisma.
 *
 * The run (`processPricingUpdate`) and the preview (`computePreview`) both call `pricingUpdateOutcome` on
 * `currentBasePrice(product)`, so the preview shows the number the run writes. Before 2026-10-01 the preview read
 * `variation.price` — a column a Product row does not have — and showed "NaN" as the current price in every mode and
 * as the new price for PERCENT and DELTA; it also printed the raw computed price, not the cents the write stores.
 *
 * Modes (`payload.adjustmentType`):
 *   ABSOLUTE          price := value
 *   PERCENT           price := current × (1 + value / 100)
 *   DELTA             price := current + value
 *   ROUND_DOWN_TO_99  the largest X.99 at or below the current price; no value (`price-rounding.ts`)
 * A row is skipped, not failed, when the computed price is below zero or outside `minPrice` / `maxPrice`.
 */
import type { Product } from '@prisma/client'
import { ROUND_DOWN_TO_99, roundDownTo99Outcome } from './price-rounding.js'

export type PricingUpdateOutcome = { newPrice: number; status: 'processed' | 'skipped' }

/** The price a PRICING_UPDATE row starts from: the product's master price (`basePrice`); none = 0. */
export function currentBasePrice(product: Pick<Product, 'basePrice'>): number {
  return product.basePrice != null ? Number(product.basePrice) : 0
}

/**
 * The cents the master price write stores — MasterPriceService's own rounding (`roundCurrency`: Product.basePrice is
 * a Decimal(10,2)). Rounding an already-rounded price again changes nothing, so the run may pass this value on.
 */
function storedCents(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * The new price of one row and whether the row is processed or skipped. Throws on a payload no row can run (the item
 * then fails, as before). The bounds test the computed price, as they always have; the price returned is the cents
 * the write stores.
 */
export function pricingUpdateOutcome(currentPrice: number, payload: Record<string, any>): PricingUpdateOutcome {
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

  let status: PricingUpdateOutcome['status'] = 'processed'
  if (computed < 0) status = 'skipped'
  else if (typeof payload.minPrice === 'number' && computed < payload.minPrice) status = 'skipped'
  else if (typeof payload.maxPrice === 'number' && computed > payload.maxPrice) status = 'skipped'
  return { newPrice: storedCents(computed), status }
}
