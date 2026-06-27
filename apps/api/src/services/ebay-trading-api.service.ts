/**
 * eBay Trading API module (shared-SKU multi-listing feature).
 *
 * Purpose-built for OAuth (IAF-token) auth + per-market Site IDs +
 * multi-variation AddFixedPriceItem. Distinct from the legacy
 * `eBayAPIProvider` singleton in providers/ebay.provider.ts, which uses a
 * static Auth'n'Auth token + fixed Site ID and is left untouched.
 */

const SITE_ID_BY_MARKET: Record<string, string> = {
  IT: '101',
  DE: '77',
  FR: '71',
  ES: '186',
  UK: '3',
}

export function siteIdForMarket(market: string): string {
  const id = SITE_ID_BY_MARKET[(market ?? '').toUpperCase()]
  if (!id) throw new Error(`unknown eBay market: ${market}`)
  return id
}

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildReviseInventoryStatusXml(input: {
  itemId: string
  sku: string
  quantity: number
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${escapeXml(input.itemId)}</ItemID>
    <SKU>${escapeXml(input.sku)}</SKU>
    <Quantity>${Math.max(0, Math.trunc(input.quantity))}</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
}
