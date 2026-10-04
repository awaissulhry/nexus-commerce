/**
 * ads-ad-product.ts — WHICH AMAZON AD PRODUCT A CAMPAIGN IS, and the one sentence that refuses a change Nexus cannot make.
 *
 * 6a (2026-10-04; review G.1, Owner decision S8). Nexus changes Sponsored Products campaigns only. Every update path
 * sends to a Sponsored Products endpoint (/sp/campaigns, /sp/adGroups, /sp/keywords, /sp/targets, /sp/productAds,
 * /sp/negativeKeywords), and a Sponsored Brands or Display id is unknown there: a budget lands nowhere, and a keyword
 * Amazon answers "not found" for is marked orphaned although it is healthy. Native SB/SD updates are not built, so
 * those changes are refused before Nexus or Amazon changes, with the sentence below — everywhere the same words.
 *
 * Creating SB/SD campaigns, ad groups, keywords and ads is NOT refused here: those calls go to their own endpoints.
 */

export type AdProduct = 'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS' | 'SPONSORED_DISPLAY' | 'SPONSORED_TELEVISION' | 'DSP'

export const SPONSORED_PRODUCTS: AdProduct = 'SPONSORED_PRODUCTS'

/** The write gate's `deniedAt` (and a placement refusal's) for a change to a campaign that is not Sponsored Products. */
export const AD_PRODUCT_UNSUPPORTED = 'ad_product_unsupported'

/** The two columns a Campaign row carries: v1 `adProduct` (may be null on old rows) and the legacy `type` enum (required). */
export interface AdProductSource {
  adProduct?: string | null
  type?: string | null
  name?: string | null
}

/** The legacy `CampaignType` codes, also accepted in the `adProduct` column. */
const FROM_CODE: Record<string, AdProduct> = {
  SP: 'SPONSORED_PRODUCTS',
  SB: 'SPONSORED_BRANDS',
  SD: 'SPONSORED_DISPLAY',
  DSP: 'DSP',
}

const LABEL: Record<string, string> = {
  SPONSORED_PRODUCTS: 'Sponsored Products',
  SPONSORED_BRANDS: 'Sponsored Brands',
  SPONSORED_DISPLAY: 'Sponsored Display',
  SPONSORED_TELEVISION: 'Sponsored TV',
  DSP: 'Amazon DSP',
}

/**
 * The campaign's ad product: the v1 `adProduct` column when set, else the legacy `type` enum. Null when neither says
 * (a select that left both out). An unrecognised value is returned as given, upper-cased, so it is never mistaken for
 * Sponsored Products.
 */
export function adProductOf(campaign: AdProductSource | null | undefined): string | null {
  const read = (v: string | null | undefined) => {
    const s = (v ?? '').trim().toUpperCase()
    return s ? (FROM_CODE[s] ?? s) : null
  }
  return read(campaign?.adProduct) ?? read(campaign?.type)
}

/** Plain name of an ad product for a sentence ("Sponsored Brands"); null when unknown. */
export function adProductLabel(adProduct: string | null | undefined): string | null {
  return adProduct ? (LABEL[adProduct] ?? adProduct) : null
}

/**
 * The one sentence that refuses a change to a campaign that is not Sponsored Products; null when Nexus may make it.
 *
 * `unknown` decides a campaign whose ad product neither column states: `'refuse'` (the default, fail closed — Claude's
 * change tools) or `'allow'` (the mutation layer and the write gate: `Campaign.type` is a required column, so a real row
 * always states it, and a partial select must not refuse a Sponsored Products write).
 */
export function adProductRefusal(
  campaign: AdProductSource | null | undefined,
  opts: { unknown?: 'refuse' | 'allow' } = {},
): string | null {
  const product = adProductOf(campaign)
  if (product === SPONSORED_PRODUCTS) return null
  if (product == null && opts.unknown === 'allow') return null
  const who = campaign?.name?.trim() || 'This campaign'
  const what = product ? ` (it is ${adProductLabel(product)})` : ''
  return `${who} is not a Sponsored Products campaign${what}. Nexus changes Sponsored Products campaigns only for now, so nothing was sent to Amazon; make this change in Amazon's advertising console.`
}
