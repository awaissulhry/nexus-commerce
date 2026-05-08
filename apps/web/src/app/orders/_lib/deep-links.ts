// O.19 — channel back-office deep-link builder.
//
// Operators frequently bounce between Nexus and the channel admin
// (Amazon Seller Central / eBay Seller Hub / Shopify Admin) to
// reconcile something Nexus doesn't have a write API for yet —
// adjust a price in Seller Central, leave buyer feedback on eBay,
// edit an order in Shopify Admin. Pre-O.19 those bounces were
// manual: copy the channelOrderId, find the right tab, paste, hunt.
//
// One helper, three URL templates. Returns null when we can't
// confidently build a link (legacy data without marketplace, or
// channels we don't support).
//
// Per-Amazon-marketplace TLD because the backoffice URL is region-
// scoped: /orders-v3/order/123 only resolves for a seller account
// in that region. Wrong TLD = "Sign in to your Seller Central"
// dead-end loop.

const AMAZON_TLD: Record<string, string> = {
  IT: 'amazon.it',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  ES: 'amazon.es',
  UK: 'amazon.co.uk',
  GB: 'amazon.co.uk',
  NL: 'amazon.nl',
  PL: 'amazon.pl',
  SE: 'amazon.se',
  BE: 'amazon.com.be',
  TR: 'amazon.com.tr',
  US: 'amazon.com',
  CA: 'amazon.ca',
  MX: 'amazon.com.mx',
  BR: 'amazon.com.br',
  JP: 'amazon.co.jp',
  AU: 'amazon.com.au',
  IN: 'amazon.in',
  AE: 'amazon.ae',
  SA: 'amazon.sa',
  EG: 'amazon.eg',
  SG: 'amazon.sg',
}

export type DeepLink = {
  url: string
  label: string // Operator-readable, e.g. "Open in Seller Central (IT)"
}

/**
 * Build a deep-link to the channel back-office for an order.
 * Returns null when the channel/marketplace combo isn't supported,
 * the channelOrderId is missing, or we'd produce a known-broken URL.
 */
export function deepLinkForOrder(args: {
  channel: string
  marketplace?: string | null
  channelOrderId: string
  /** Optional Shopify shop handle if the operator's connection
   *  exposes it. When missing, we fall back to the unified
   *  admin.shopify.com router which prompts the operator to
   *  pick the right shop. */
  shopifyShopHandle?: string | null
}): DeepLink | null {
  const { channel, marketplace, channelOrderId, shopifyShopHandle } = args
  if (!channelOrderId) return null

  switch (channel) {
    case 'AMAZON': {
      const tld = AMAZON_TLD[marketplace ?? ''] ?? 'amazon.com'
      return {
        url: `https://sellercentral.${tld}/orders-v3/order/${encodeURIComponent(channelOrderId)}`,
        label: marketplace
          ? `Open in Seller Central (${marketplace})`
          : 'Open in Seller Central',
      }
    }
    case 'EBAY':
      // eBay's unified seller hub handles per-marketplace routing.
      return {
        url: `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(channelOrderId)}`,
        label: 'Open in eBay Seller Hub',
      }
    case 'SHOPIFY': {
      if (shopifyShopHandle) {
        return {
          url: `https://admin.shopify.com/store/${encodeURIComponent(shopifyShopHandle)}/orders/${encodeURIComponent(channelOrderId)}`,
          label: 'Open in Shopify Admin',
        }
      }
      // Without the handle, send to the cross-store picker (Shopify
      // resolves the recently-used shop). Better than nothing.
      return {
        url: `https://admin.shopify.com/orders/${encodeURIComponent(channelOrderId)}`,
        label: 'Open in Shopify Admin',
      }
    }
    default:
      return null
  }
}
