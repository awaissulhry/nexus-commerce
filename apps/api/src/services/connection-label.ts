/** Human-facing account identity. Technical keys remain available for routing, never as names. */
export interface LabelledConnection {
  channelType: string
  id?: string | null
  externalAccountId?: string | null
  accountLabel?: string | null
  ebayStoreName?: string | null
  displayName?: string | null
  ebaySignInName?: string | null
}

const CHANNEL_NAMES: Record<string, string> = {
  AMAZON: 'Amazon Seller', AMAZON_ADS: 'Amazon Ads', EBAY: 'eBay',
  SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce', ETSY: 'Etsy',
}
const PLACEHOLDERS = new Set(['eBay seller (verified)', 'eBay seller'])

export function connectionLabel(row: LabelledConnection) {
  const candidates = [
    ['accountLabel', row.accountLabel], ['storeName', row.ebayStoreName],
    ['displayName', row.displayName], ['signInName', row.ebaySignInName],
  ] as const
  for (const [source, value] of candidates) {
    const label = value?.trim()
    if (!label || PLACEHOLDERS.has(label)) continue
    // Provider usernames may equal externalAccountId (eBay); only opaque keys are excluded.
    if (label === row.id || (row.channelType === 'AMAZON' && /^A(?=[A-Z0-9]*\d)[A-Z0-9]{9,19}$/.test(label)) ||
        /^(?:Account\s+)?\d{6,}$/.test(label) ||
        /^c[a-z0-9]{24}$/.test(label) ||
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(label)) continue
    if (source !== 'accountLabel' && label === row.externalAccountId && row.channelType !== 'EBAY') continue
    return { label, labelSource: source, labelIsPlaceholder: false }
  }
  return { label: `${CHANNEL_NAMES[row.channelType] ?? 'Channel'} account`, labelSource: 'channel' as const, labelIsPlaceholder: true }
}
