const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i

/** Accept the forms operators commonly copy, but always send Shopify's permanent domain. */
export function normalizeShopifyDomain(input: string): string {
  const value = input.trim().toLowerCase()
  if (!value) return ''
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    if (url.hostname === 'admin.shopify.com') {
      const match = url.pathname.match(/^\/store\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i)
      return match ? `${match[1]}.myshopify.com` : ''
    }
    if (SHOPIFY_DOMAIN.test(url.hostname)) return url.hostname
    return /^[a-z0-9][a-z0-9-]*$/i.test(url.hostname) ? `${url.hostname}.myshopify.com` : ''
  } catch {
    return SHOPIFY_DOMAIN.test(value)
      ? value
      : /^[a-z0-9][a-z0-9-]*$/i.test(value)
        ? `${value}.myshopify.com`
        : ''
  }
}

export function isShopifyDomain(input: string): boolean {
  return SHOPIFY_DOMAIN.test(normalizeShopifyDomain(input))
}
