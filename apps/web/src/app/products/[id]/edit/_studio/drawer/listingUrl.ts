/**
 * PES.4 — the public URL of a listing, or nothing.
 *
 * The drawer's `↗ <id>` was a plain `<div>`: the one control that looks like "go and see the real
 * listing" did nothing at all (SR.1, #327 item 8). Making it a link needs a marketplace domain,
 * and the repo has eight hand-rolled versions of that — most of them
 * `https://www.ebay.com/itm/${id}`, which is wrong for every listing that is not on the US site.
 * An eBay·IT item opened on ebay.com is a "this listing has ended" page, so the hardcode does not
 * fail loudly; it shows an operator a plausible wrong answer.
 *
 * 🔴 Returns `null` for anything not in the table, and the caller renders plain text instead. A
 * guessed domain is worse than no link: the operator follows it, sees nothing, and concludes the
 * listing is gone. Semantics are taken from `useEbayCompositor` (the one call site that derives the
 * domain properly, from the Marketplace seed) rather than its code — this lane cannot reach that
 * seed, so the mapping is explicit and testable, and unknown means unknown.
 */

/** Marketplace code → domain suffix. Keyed by the codes the studio scope actually carries. */
const TLD: Record<string, string> = {
  IT: 'it',
  DE: 'de',
  FR: 'fr',
  ES: 'es',
  NL: 'nl',
  BE: 'be',
  PL: 'pl',
  SE: 'se',
  IE: 'ie',
  US: 'com',
  CA: 'ca',
  MX: 'com.mx',
  BR: 'com.br',
  JP: 'co.jp',
  AU: 'com.au',
}

/** eBay's UK site is `ebay.co.uk`; Amazon's is `amazon.co.uk`. Both differ from the generic table. */
const UK = new Set(['UK', 'GB'])

export function listingUrl(
  channel: string | null | undefined,
  marketplace: string | null | undefined,
  externalListingId: string | null | undefined,
): string | null {
  if (!channel || !marketplace || !externalListingId) return null
  const market = marketplace.trim().toUpperCase()
  const tld = UK.has(market) ? 'co.uk' : TLD[market]
  if (!tld) return null
  // The id goes in a path segment, so it is encoded — an id with a slash would otherwise
  // silently retarget the URL.
  const id = encodeURIComponent(externalListingId.trim())
  if (!id) return null
  switch (channel.trim().toUpperCase()) {
    case 'EBAY':
      return `https://www.ebay.${tld}/itm/${id}`
    case 'AMAZON':
      return `https://www.amazon.${tld}/dp/${id}`
    default:
      // Shopify, WooCommerce and Etsy listings are not addressable from a marketplace code alone —
      // they need the shop's own domain, which this scope does not carry.
      return null
  }
}
