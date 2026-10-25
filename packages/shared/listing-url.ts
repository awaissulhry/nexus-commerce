/**
 * The public page of a listing on its channel, from what Nexus holds (no channel call). Moved here from
 * apps/api/src/routes/listings-syndication.routes.ts (live layer step 3, 25 October 2026) so the Listings page's live
 * layer and the old listings routes build the same link.
 *
 * - Amazon: `https://www.amazon.<tld>/dp/<ASIN>` (GB and UK are the same store).
 * - eBay: `https://www.ebay.<tld>/itm/<Item ID>`.
 * - Etsy: `https://www.etsy.com/listing/<listing id>`.
 * - Shopify and WooCommerce: null (a product id has no public page without the store's handle).
 */
const AMAZON_TLD: Readonly<Record<string, string>> = {
  US: 'com', CA: 'ca', MX: 'com.mx', BR: 'com.br',
  UK: 'co.uk', GB: 'co.uk', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', NL: 'nl', PL: 'pl', SE: 'se', BE: 'com.be', TR: 'com.tr',
  AE: 'ae', SA: 'sa', EG: 'eg',
  JP: 'co.jp', AU: 'com.au', SG: 'sg', IN: 'in',
}
const EBAY_TLD: Readonly<Record<string, string>> = {
  US: 'com', UK: 'co.uk', GB: 'co.uk', DE: 'de', IT: 'it', FR: 'fr', ES: 'es', AU: 'com.au', CA: 'ca',
}

export function listingUrlFor(channel: string, marketplace: string, externalId: string | null): string | null {
  if (!externalId) return null
  switch (channel) {
    case 'AMAZON':
      return `https://www.amazon.${AMAZON_TLD[marketplace.toUpperCase()] ?? 'com'}/dp/${externalId}`
    case 'EBAY':
      return `https://www.ebay.${EBAY_TLD[marketplace.toUpperCase()] ?? 'com'}/itm/${externalId}`
    case 'ETSY':
      return `https://www.etsy.com/listing/${externalId}`
    default:
      // Shopify product ids are not URLable without the store handle; WooCommerce and the rest have no page here.
      return null
  }
}
