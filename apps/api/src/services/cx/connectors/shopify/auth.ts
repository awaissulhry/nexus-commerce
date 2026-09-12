import { createHmac, timingSafeEqual } from 'node:crypto'

/** Shopify requires an anchored check before a merchant-supplied shop becomes a URL host. */
export const SHOPIFY_SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i

export function shopifyShopDomain(value: string | null | undefined): string | null {
  const domain = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SHOPIFY_SHOP_DOMAIN.test(domain) ? domain : null
}

/** Verify the signed query Shopify sends to the authorization-code callback. */
export function verifyShopifyCallbackHmac(
  query: Record<string, string | undefined>,
  clientSecret: string,
): boolean {
  const supplied = query.hmac
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied) || !clientSecret) return false
  const message = Object.entries(query)
    .filter(([key, value]) => key !== 'hmac' && value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const expected = createHmac('sha256', clientSecret).update(message).digest()
  const received = Buffer.from(supplied, 'hex')
  return expected.length === received.length && timingSafeEqual(expected, received)
}
