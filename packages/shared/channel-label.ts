/**
 * ONE operator-facing channel name, for both apps (LX.F P2-15).
 *
 * `studio-sheet.service.ts` carried the four-way chain
 * `channel === 'AMAZON' ? 'Amazon' : … : 'Etsy'` TWICE — once for the
 * acknowledgement's pin label and once for its reach list — so a fifth channel
 * was labelled "Etsy" by both: a hardcoded member list standing in for a derived
 * one. Meanwhile `_studio/scopes.ts` and `settings/channels/[type]/channelDetail.ts`
 * already had real label maps with a Title-Case fallback, and the API had three
 * more in `insights-*.service.ts`.
 *
 * The map's VALUES are operator copy (Appendix A's orthography: `eBay` and
 * `WooCommerce` are spelled that way everywhere in the console), which is another
 * reason they should exist once. Anything not listed falls back to Title Case
 * rather than being shown as a database constant.
 */
export const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

export function channelLabel(channel: string): string {
  if (!channel) return ''
  return CHANNEL_LABELS[channel.toUpperCase()] ?? channel.charAt(0).toUpperCase() + channel.slice(1).toLowerCase()
}
