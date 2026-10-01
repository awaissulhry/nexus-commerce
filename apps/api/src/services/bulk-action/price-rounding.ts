/**
 * The PRICING_UPDATE rounding mode (2026-10-01): each price becomes the largest price ending in .99 that is at or
 * below it — 25.40 → 24.99, 25.00 → 24.99, 25.99 stays. Used by the built-in "Round prices to .99" template.
 *
 * Pure functions, no Prisma. The bulk run (`processPricingUpdate`) and its preview (`computePreview`) both reach
 * `roundDownTo99Outcome` through `pricingUpdateOutcome` (`pricing-update.ts`), so the preview cannot show a number the
 * run would not write. The new price then goes through the same master price write as every other PRICING_UPDATE mode.
 */

/** The `adjustmentType` of the mode. It takes no `value`. */
export const ROUND_DOWN_TO_99 = 'ROUND_DOWN_TO_99' as const

/**
 * The largest X.99 at or below `price`, or null when there is none (a price under 0.99). Worked in whole cents:
 * a master price is a Decimal(10,2), so `price * 100` is a whole number up to float noise, which the rounding
 * removes before any arithmetic.
 */
export function roundDownTo99(price: number): number | null {
  if (!Number.isFinite(price)) return null
  const cents = Math.round(price * 100)
  if (cents < 99) return null
  return (Math.floor((cents - 99) / 100) * 100 + 99) / 100
}

/**
 * What the mode does to one price. Skipped, with the price kept and the reason in plain words, when there is nothing
 * to write: no X.99 at or below it (under 0.99), or it already ends in .99. The job's and the product's bounds apply
 * after this, to every mode alike (`pricingUpdateOutcome`).
 */
export function roundDownTo99Outcome(
  currentPrice: number,
): { newPrice: number; status: 'processed' } | { newPrice: number; status: 'skipped'; reason: string } {
  const rounded = roundDownTo99(currentPrice)
  if (rounded == null) {
    return { newPrice: currentPrice, status: 'skipped', reason: `Not changed: ${currentPrice.toFixed(2)} is below 0.99, so there is no lower price ending in .99.` }
  }
  if (rounded === currentPrice) return { newPrice: currentPrice, status: 'skipped', reason: 'Not changed: the price already ends in .99.' }
  return { newPrice: rounded, status: 'processed' }
}
