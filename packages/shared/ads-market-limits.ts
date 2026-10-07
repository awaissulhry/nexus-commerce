/**
 * ads-market-limits.ts — WHAT AMAZON ACCEPTS IN EACH ADS MARKET: the currency, and the lowest and highest bid and daily
 * budget per ad product. The one table.
 *
 * 6b (2026-10-04; review G.5, I.1, I.3; Owner decision S10). Nexus counts every ads amount in hundredths of the euro
 * (`bidCents`, `Campaign.dailyBudget` × 100, the 2¢ suppression floor, the €1 budget floor). That is right only where
 * Amazon bills in euros: in Sweden 2 "cents" is 0.02 SEK, under Amazon's minimum bid, and a €1 floor is one krona. So a
 * market is writable only when it has a row here, transcribed from Amazon's published limits, and the write gate refuses
 * every other market with `marketLimitsRefusal`'s sentence — nothing is converted by an exchange rate. A bid or budget
 * outside the row's range is refused the same way, before Amazon answers with an error.
 *
 * Source: Amazon Ads API reference, "Limits" → Sponsored Products
 * (https://advertising.amazon.com/API/docs/en-us/reference/concepts/limits#sponsored-products). Germany, France, Italy
 * and Spain: EUR; keyword and product-target bid 0.02–1,000; campaign daily budget 1–1,000,000. The minimums are the
 * ones the code already used as Amazon's (`SUPPRESSION_FLOOR_CENTS` "Amazon's own SP minimum bid is 2¢",
 * `ads-budget-enforce.service.ts` "€1/day — Amazon's minimum campaign budget").
 *
 * UK, SE and PL (sandbox connections today), NL and BE have no row on purpose: a row is added only when it is transcribed
 * from that page, never from memory. Amounts are in hundredths of the currency (cents), like every Nexus ads column.
 *
 * W4-11 (2026-10-07) — Sponsored Brands and Sponsored Display, transcribed from the same page, read 2026-10-07:
 * "Bid constraints by marketplace" (https://advertising.amazon.com/API/docs/en-us/reference/concepts/limits#bid-constraints-by-marketplace)
 * and "Budget constraints by marketplace" (…/limits#budget-constraints-by-marketplace). For DE, FR, IT and ES (EUR):
 *   · SB (CPC) image 0.10/39 and SBV (CPC) video 0.15/39. Nexus does not hold which format an SB ad group runs, so the
 *     row is the range BOTH accept: 0.15–39. SB vCPM bids (image/video × brand impression share/new-to-brand) are four
 *     columns that differ per market; no row here, so an SB vCPM bid is refused.
 *   · SD (CPC) 0.02/1000 and SD (vCPM) 1/1000.
 *   · SB daily budget 1–1,000,000. SD daily budget 1–1,000,000 for a seller and 1–50,000 for a vendor; Nexus does not
 *     hold which the account is, so the row is the range both accept: 1–50,000.
 * SB and SD bid limits depend on how the campaign pays (`Campaign.costType`, cpc | vcpm): a bid in a campaign whose cost
 * type Nexus does not hold is refused, never guessed.
 */

import { SPONSORED_BRANDS, SPONSORED_DISPLAY, SPONSORED_PRODUCTS, adProductLabel } from './ads-ad-product.js'

/** Lowest and highest value Amazon accepts, both inclusive, in hundredths of the market's currency. */
export interface MinorRange {
  min: number
  max: number
}

export interface AdProductLimits {
  /** A keyword or product-target bid, and an ad group's default bid. For SB and SD: a bid in a campaign that pays per click (CPC). */
  bid: MinorRange
  /**
   * W4-11 — a bid in a campaign that pays per thousand viewable impressions (vCPM; SB and SD only). Absent: no checked
   * row, so such a bid is refused.
   */
  vcpmBid?: MinorRange
  /** A campaign's daily budget. */
  dailyBudget: MinorRange
}

export interface MarketLimits {
  /** Two-letter Nexus market code. */
  market: string
  /** ISO 4217 currency Amazon bills this market in. */
  currency: string
  /** Per ad product; an ad product with no entry has no checked limits here. */
  adProducts: Partial<Record<string, AdProductLimits>>
  /** Where the numbers come from. */
  source: string
}

const AMAZON_LIMITS_PAGE = 'https://advertising.amazon.com/API/docs/en-us/reference/concepts/limits#sponsored-products'

/** Sponsored Products in a euro market: bid €0.02–€1,000, daily budget €1–€1,000,000. */
const SP_EUR: AdProductLimits = {
  bid: { min: 2, max: 100_000 },
  dailyBudget: { min: 100, max: 100_000_000 },
}

/**
 * W4-11 — Sponsored Brands in a euro market (DE, FR, IT, ES): a CPC bid €0.15–€39 (the range image 0.10/39 and video
 * 0.15/39 both accept), no vCPM row, daily budget €1–€1,000,000.
 */
const SB_EUR: AdProductLimits = {
  bid: { min: 15, max: 3_900 },
  dailyBudget: { min: 100, max: 100_000_000 },
}

/**
 * W4-11 — Sponsored Display in a euro market (DE, FR, IT, ES): a CPC bid €0.02–€1,000, a vCPM bid €1–€1,000, daily budget
 * €1–€50,000 (a seller's 1–1,000,000 and a vendor's 1–50,000 both accept it).
 */
const SD_EUR: AdProductLimits = {
  bid: { min: 2, max: 100_000 },
  vcpmBid: { min: 100, max: 100_000 },
  dailyBudget: { min: 100, max: 5_000_000 },
}

const eur = (market: string): MarketLimits => ({
  market,
  currency: 'EUR',
  adProducts: { [SPONSORED_PRODUCTS]: SP_EUR, [SPONSORED_BRANDS]: SB_EUR, [SPONSORED_DISPLAY]: SD_EUR },
  source: AMAZON_LIMITS_PAGE,
})

/** Every market Nexus may change ads in, with Amazon's limits there. */
export const AMAZON_ADS_MARKET_LIMITS: readonly MarketLimits[] = [eur('IT'), eur('DE'), eur('FR'), eur('ES')]

/** The market codes with a checked row, in the table's order. */
export const ADS_LIMIT_MARKETS: readonly string[] = AMAZON_ADS_MARKET_LIMITS.map((r) => r.market)

/** The row for a two-letter market code (any case); null when Nexus has no checked limits there. */
export function marketLimitsOf(market: string | null | undefined): MarketLimits | null {
  const code = (market ?? '').trim().toUpperCase()
  return AMAZON_ADS_MARKET_LIMITS.find((r) => r.market === code) ?? null
}

const BID_FIELDS = new Set(['bid', 'defaultBid'])

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}

/** W4-11 — `Campaign.costType` as one of Amazon's two bid models, or null when it says neither. */
export function bidCostType(costType: string | null | undefined): 'CPC' | 'VCPM' | null {
  const c = (costType ?? '').trim().toUpperCase()
  return c === 'CPC' || c === 'VCPM' ? c : null
}

function listed(codes: readonly string[]): string {
  return codes.length > 1 ? `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}` : (codes[0] ?? '')
}

/**
 * The one sentence that refuses an ads write in this market; null when Amazon accepts it.
 *
 * Refused: a market with no row (S10, fail closed), an ad product the row has no limits for (null means Sponsored
 * Products, as in the write gate), and a bid (`bid`, `defaultBid`) or daily budget (`dailyBudget`) outside the row's
 * range. Any other field, or no value, is judged on the market alone. A suppression is not exempt: it lowers a bid to
 * Amazon's minimum, never below it, and Amazon refuses a lower one whatever Nexus intends.
 * W4-11 — an SB or SD bid is judged on the range of how its campaign pays (`costType`): CPC on `bid`, vCPM on `vcpmBid`
 * (refused where the row has none); a cost type Nexus does not hold refuses the bid.
 */
export function marketLimitsRefusal(args: {
  market: string | null | undefined
  adProduct?: string | null
  field?: string | null
  /** The new value, in hundredths of the market's currency. */
  valueMinor?: number | null
  /** W4-11 — how an SB or SD campaign pays (`Campaign.costType`: cpc | vcpm, any case); not read for Sponsored Products. */
  costType?: string | null
}): string | null {
  const row = marketLimitsOf(args.market)
  const shown = (args.market ?? '').trim() || 'this market'
  if (!row) {
    return `Nexus does not change ads in ${shown}: Amazon's bid and budget limits for this market are not known yet, so nothing was sent to Amazon. They are known for ${listed(ADS_LIMIT_MARKETS)} only.`
  }
  const product = args.adProduct ?? SPONSORED_PRODUCTS
  const limits = row.adProducts[product]
  if (!limits) {
    return `Nexus has no checked Amazon limits for ${adProductLabel(product) ?? product} in ${row.market}, so nothing was sent to Amazon.`
  }
  const v = args.valueMinor
  if (v == null || !Number.isFinite(v)) return null
  const what = args.field && BID_FIELDS.has(args.field) ? 'bid' : args.field === 'dailyBudget' ? 'daily budget' : null
  if (!what) return null
  let range = what === 'bid' ? limits.bid : limits.dailyBudget
  if (what === 'bid' && product !== SPONSORED_PRODUCTS) {
    const label = adProductLabel(product) ?? product
    const pays = bidCostType(args.costType)
    if (!pays) {
      return `Nexus does not know whether this ${label} campaign pays per click (CPC) or per thousand viewable impressions (vCPM), and Amazon's bid limits differ between them, so nothing was sent to Amazon.`
    }
    if (pays === 'VCPM') {
      if (!limits.vcpmBid) return `Nexus has no checked Amazon limits for a vCPM bid in ${label} in ${row.market}, so nothing was sent to Amazon.`
      range = limits.vcpmBid
    }
  }
  if (v < range.min) {
    return `A ${what} of ${money(v, row.currency)} is below Amazon's minimum of ${money(range.min, row.currency)} in ${row.market}, so nothing was sent to Amazon.`
  }
  if (v > range.max) {
    return `A ${what} of ${money(v, row.currency)} is above Amazon's maximum of ${money(range.max, row.currency)} in ${row.market}, so nothing was sent to Amazon.`
  }
  return null
}
