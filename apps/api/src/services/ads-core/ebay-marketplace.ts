/**
 * D3 — the one eBay marketplace mapping.
 *
 * There were SEVEN ad-hoc copies of `{ EBAY_IT: 'IT', … }` and four of them
 * omitted `EBAY_GB`:
 *
 *   ebay-ads.routes.ts:633       no GB, NO FALLBACK   → undefined
 *   ebay-ads.routes.ts:651       no GB, `?? 'IT'`     → wrong market
 *   ebay-ads-automation.ts:283   no GB, `?? 'IT'`     → wrong market
 *   ebay-ads-automation.ts:563   no GB, `?? 'IT'`     → wrong market
 *
 * The first is the dangerous one. `undefined` flows into
 * `getLiveEbayItemIds(pid, undefined)`, which drops the marketplace predicate
 * entirely — so a GB campaign could be promoted with **Italian item IDs**.
 * The other three silently write GB intent to the Italian marketplace.
 *
 * Hence `marketplaceShort()` THROWS on an unknown code. Returning `undefined`
 * is what let a missing predicate through, and defaulting to `'IT'` is what
 * turned a GB request into an Italian write. Both failure modes were silent,
 * and silence is the thing being fixed — a thrown error surfaces at the API
 * boundary as a 400 the operator can read.
 */

/** eBay marketplace id → the 2-letter code the listing index and stock keys use. */
export const EBAY_MARKETPLACE_SHORT: Record<string, string> = {
  EBAY_IT: 'IT',
  EBAY_DE: 'DE',
  EBAY_FR: 'FR',
  EBAY_ES: 'ES',
  EBAY_GB: 'UK', // eBay says GB, our listing index says UK. This is the seam.
}

/** Every marketplace id the ads layer accepts. */
export const EBAY_MARKETPLACE_IDS = Object.keys(EBAY_MARKETPLACE_SHORT)

export class UnknownEbayMarketplaceError extends Error {
  constructor(public readonly marketplace: string) {
    super(
      `Unknown eBay marketplace "${marketplace}". Known: ${EBAY_MARKETPLACE_IDS.join(', ')}. `
      + 'Refusing rather than defaulting — a silent fallback here previously resolved Italian listings into a GB campaign.',
    )
    this.name = 'UnknownEbayMarketplaceError'
  }
}

/**
 * Resolve a marketplace id to its short code. Throws on anything unknown.
 *
 * Deliberately has no default parameter: every caller must decide what it means
 * when the marketplace is absent, rather than inheriting 'IT' by accident.
 */
export function marketplaceShort(marketplace: string | null | undefined): string {
  if (!marketplace) throw new UnknownEbayMarketplaceError(String(marketplace))
  const short = EBAY_MARKETPLACE_SHORT[marketplace]
  if (!short) throw new UnknownEbayMarketplaceError(marketplace)
  return short
}

/** Non-throwing variant for read paths that legitimately tolerate "unknown". */
export function marketplaceShortOrNull(marketplace: string | null | undefined): string | null {
  if (!marketplace) return null
  return EBAY_MARKETPLACE_SHORT[marketplace] ?? null
}

export function isKnownEbayMarketplace(marketplace: string | null | undefined): boolean {
  return !!marketplace && marketplace in EBAY_MARKETPLACE_SHORT
}
