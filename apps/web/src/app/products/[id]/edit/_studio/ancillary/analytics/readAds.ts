/**
 * PES.7 — reading the ads payload honestly. Pure, tested.
 *
 * 🔴 **ACOS is `null` when there are no ad sales, and that is not 0%.**
 *
 * Measured on the wire: a search term with `spendCents: 759, adSalesCents: 0, acos: null` — money
 * spent, nothing returned. Rendering that as "0%" says the campaign was free and perfectly
 * efficient; rendering it as "—" says the number is missing. Both are wrong. The honest reading is
 * "spent, no sales", which is the worst outcome on the table and must not look like the best.
 *
 * 🔴 **A parent has no ad rows of its own — they belong to the variants.** Measured on
 * GALE-JACKET: the parent returns 0 for every identifier it has (`productId`, `sku`, and its own
 * `amazonAsin` B0F7J163XJ), while **every child sampled returns 93–107 product ads and 70–76
 * campaigns**. B0BMSH19GY, the ASIN the ad rows actually reference, belongs to one child
 * (GALE-JACKET-BLACK-MEN-XL), not to the parent.
 *
 * So "no ads are running against this product" is true of the parent ROW and false about the
 * family, and an operator reads it as the family. This is the same shape as the sales finding in
 * `readAnalytics` and gets the same treatment: name where the figures live rather than report an
 * absence that reads as a zero.
 *
 * The query still carries every identifier the product has (the route ORs them), because on a
 * CHILD it is the ASIN that matches and neither `productId` nor `sku` would.
 */
import type { AdCampaign, AdSearchTerm, AdsSummary, ProductAdsPayload } from './types'

/** Every identifier we hold, because only one of them matches. */
export function adsQuery(args: {
  productId: string
  sku?: string | null
  asin?: string | null
  windowDays: number
}): string {
  const q = new URLSearchParams({ windowDays: String(args.windowDays), productId: args.productId })
  if (args.sku) q.set('sku', args.sku)
  if (args.asin) q.set('asin', args.asin)
  return q.toString()
}

export type EfficiencyReading =
  | { kind: 'acos'; percent: number; label: string }
  /** Spend with no return. The number is undefined; the situation is not. */
  | { kind: 'spentNoSales'; label: string }
  /** Nothing spent, so there is nothing to be efficient about. */
  | { kind: 'noSpend'; label: string }

export function readEfficiency(row: { spendCents: number; adSalesCents: number; acos: number | null }): EfficiencyReading {
  if (row.spendCents <= 0) return { kind: 'noSpend', label: 'No spend' }
  if (row.acos === null || row.adSalesCents <= 0) {
    return { kind: 'spentNoSales', label: 'No sales' }
  }
  return { kind: 'acos', percent: row.acos, label: `${row.acos.toFixed(1)}%` }
}

/** Money, from the integer cents the wire carries. Never float arithmetic on the way in. */
export function money(cents: number, currency: string | null): string {
  const value = (cents / 100).toFixed(2)
  return currency ? `${value} ${currency}` : value
}

export interface AdsReading {
  hasAds: boolean
  summary: AdsSummary | null
  campaigns: AdCampaign[]
  searchTerms: AdSearchTerm[]
  /** Campaigns that spent money and returned none — the ones worth looking at first. */
  spendingNothingBack: number
  /** Campaigns with no impressions at all in the window: they are not running, whatever the status says. */
  silent: number
  windowDays: number
}

export function readAds(payload: ProductAdsPayload | null): AdsReading {
  if (!payload || payload.productAds === 0) {
    return {
      hasAds: false, summary: null, campaigns: [], searchTerms: [],
      spendingNothingBack: 0, silent: 0, windowDays: payload?.windowDays ?? 0,
    }
  }
  const campaigns = payload.campaigns ?? []
  return {
    hasAds: true,
    summary: payload.summary,
    campaigns,
    searchTerms: payload.searchTerms ?? [],
    spendingNothingBack: campaigns.filter((c) => c.spendCents > 0 && c.adSalesCents <= 0).length,
    silent: campaigns.filter((c) => c.impressions === 0).length,
    windowDays: payload.windowDays,
  }
}

/**
 * The sentence above the campaign table.
 *
 * 🔴 Leads with money that returned nothing, not with the campaign count. "74 campaigns" is a
 * number an operator can do nothing with; "12 spent and returned nothing" is a decision.
 */
export function adsHeadline(
  reading: AdsReading,
  product?: { isParent: boolean },
): string {
  if (!reading.hasAds) {
    return product?.isParent
      ? 'Advertising is recorded against each variant, and this parent row has none of its own. '
        + 'Open a variant to see the campaigns running for it. This is not a statement that nothing '
        + 'is being advertised.'
      : 'No ads are running against this product.'
  }
  const s = reading.summary
  const spend = s ? money(s.totalSpendCents, reading.campaigns[0]?.currencyCode ?? null) : null
  const bits: string[] = []
  if (spend) bits.push(`${spend} spent over ${reading.windowDays} days`)
  if (reading.spendingNothingBack > 0) {
    bits.push(`${reading.spendingNothingBack} campaign${reading.spendingNothingBack === 1 ? '' : 's'} returned nothing`)
  }
  if (reading.silent > 0) {
    bits.push(`${reading.silent} had no impressions at all`)
  }
  return bits.length > 0 ? `${bits.join(' · ')}.` : `${reading.campaigns.length} campaigns.`
}
