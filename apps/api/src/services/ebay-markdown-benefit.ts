/**
 * The discount an eBay markdown sends (createItemPriceMarkdownPromotion → selectedInventoryDiscounts[].discountBenefit).
 *
 * eBay takes exactly one of two fields for a markdown, each from a preset list:
 *   - percentageOffItem — a whole percent from 5 to 80;
 *   - amountOffItem — an amount off: 5 to 100 in steps of 1, 105 to 1000 in steps of 5, 1100 to 15000 in steps of 100
 *     (developer.ebay.com/api-docs/sell/static/marketing/pm-amountoffitems-values.html).
 * The `…OffOrder` fields belong to threshold discounts; eBay does not take them for a markdown.
 *
 * In Nexus a FIXED_PRICE markdown's value is the NEW price: the eBay markdowns page and set-ebay-price-promotion both
 * store and show it so. eBay is sent the amount off: the listing's price minus that new price.
 */

export const EBAY_MARKDOWN_PERCENT_MIN = 5
export const EBAY_MARKDOWN_PERCENT_MAX = 80

export type EbayMarkdownBenefit =
  | { percentageOffItem: string }
  | { amountOffItem: { value: string; currency: string } }

// Each side names the other's fields as absent: apps/api is not strict, so `!result.ok` alone does not narrow.
export type EbayMarkdownBenefitResult =
  | { ok: true; benefit: EbayMarkdownBenefit; markdownPrice: number; reason?: undefined }
  | { ok: false; reason: string; benefit?: undefined; markdownPrice?: undefined }

const cents = (value: number) => Math.round(value * 100)
const money = (valueCents: number) => (valueCents / 100).toFixed(2)

/** Whether eBay takes this amount off (in cents) for a markdown. */
export function isEbayMarkdownAmountCents(offCents: number): boolean {
  if (!Number.isInteger(offCents) || offCents % 100 !== 0) return false
  const off = offCents / 100
  if (off >= 5 && off <= 100) return true
  if (off >= 105 && off <= 1000) return off % 5 === 0
  if (off >= 1100 && off <= 15000) return off % 100 === 0
  return false
}

/** The nearest amounts off (in cents) eBay takes, below and above the one asked, within (0, priceCents). */
function nearestAmountsCents(offCents: number, priceCents: number): number[] {
  const near: number[] = []
  for (let c = Math.floor(offCents / 100) * 100; c >= 500; c -= 100) if (isEbayMarkdownAmountCents(c)) { near.push(c); break }
  for (let c = Math.ceil(offCents / 100) * 100; c <= 1_500_000; c += 100) if (isEbayMarkdownAmountCents(c)) { near.push(c); break }
  return [...new Set(near)].filter((c) => c !== offCents && c < priceCents)
}

/**
 * The discountBenefit for one listing at `price` (in the market's currency), or why eBay would refuse it.
 * PERCENTAGE: `discountValue` is the percent off. FIXED_PRICE: `discountValue` is the new price.
 */
export function ebayMarkdownBenefit(input: {
  discountType: 'PERCENTAGE' | 'FIXED_PRICE'
  discountValue: number
  price: number
  currency: string
}): EbayMarkdownBenefitResult {
  const { discountType, discountValue: value, price, currency } = input
  if (!(price > 0)) return { ok: false, reason: 'the listing has no price to mark down' }
  if (discountType === 'PERCENTAGE') {
    if (!Number.isInteger(value) || value < EBAY_MARKDOWN_PERCENT_MIN || value > EBAY_MARKDOWN_PERCENT_MAX) {
      return { ok: false, reason: `eBay takes a markdown of ${EBAY_MARKDOWN_PERCENT_MIN} to ${EBAY_MARKDOWN_PERCENT_MAX} % in whole numbers (asked: ${value} %)` }
    }
    return { ok: true, benefit: { percentageOffItem: String(value) }, markdownPrice: Math.round(price * (100 - value)) / 100 }
  }
  const priceCents = cents(price)
  const newCents = cents(value)
  if (newCents >= priceCents) return { ok: false, reason: `the new price ${money(newCents)} is not below the eBay price ${money(priceCents)}` }
  const offCents = priceCents - newCents
  if (!isEbayMarkdownAmountCents(offCents)) {
    const suggestions = nearestAmountsCents(offCents, priceCents).map((c) => money(priceCents - c))
    return {
      ok: false,
      reason: `eBay takes an amount off of 5 to 100 in steps of 1, 105 to 1000 in steps of 5, or 1100 to 15000 in steps of 100: `
        + `${money(priceCents)} → ${money(newCents)} is ${money(offCents)} off`
        + (suggestions.length ? `; a new price of ${suggestions.join(' or ')} works` : ''),
    }
  }
  return { ok: true, benefit: { amountOffItem: { value: money(offCents), currency } }, markdownPrice: newCents / 100 }
}
