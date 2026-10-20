/** Channel and account names for all identity surfaces; IDs are routing data only. */
export function channelDisplayName(channel: string): string {
  const names: Record<string, string> = {
    AMAZON: 'Amazon', AMAZON_ADS: 'Amazon Ads', EBAY: 'eBay',
    SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce', ETSY: 'Etsy', GOOGLE: 'Google', META: 'Meta',
  }
  return names[channel] ?? 'Channel'
}

export function accountDisplayName(a: {
  channel: string; label: string; labelIsPlaceholder?: boolean; labelSource?: string; id?: string
}): string {
  const label = a.label?.trim()
  if (!label || a.labelIsPlaceholder || a.labelSource === 'sellerId' || label === a.id ||
    (a.channel === 'AMAZON' && /^A(?=[A-Z0-9]*\d)[A-Z0-9]{9,19}$/.test(label)) || /^(?:Account\s+)?\d{6,}$/.test(label) ||
      /^c[a-z0-9]{24}$/.test(label) || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(label) ||
      // A Google Ads customer id ("123-456-7890") is routing data, never a name.
      /^\d{3}-\d{3}-\d{4}$/.test(label)) {
    return `${a.channel === 'AMAZON' ? 'Amazon Seller' : channelDisplayName(a.channel)} account`
  }
  return label
}
