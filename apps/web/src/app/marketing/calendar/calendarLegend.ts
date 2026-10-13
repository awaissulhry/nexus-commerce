/**
 * Google Ads step 1a, W3 (defect D3) — the Marketing calendar's channel legend.
 *
 * It printed the first four keys of its colour table — AMAZON, EBAY, SHOPIFY, GOOGLE — in raw capitals on every month,
 * whether or not any campaign of that channel was on the calendar: a Google dot in the key of a calendar that has no
 * Google campaign. The legend now lists only the channels whose campaigns are in the shown window, by their plain
 * names, in a fixed order.
 */

const ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY', 'GOOGLE', 'META', 'TIKTOK', 'INTERNAL']

const NAME: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  ETSY: 'Etsy',
  GOOGLE: 'Google',
  META: 'Meta',
  TIKTOK: 'TikTok',
  INTERNAL: 'Nexus',
}

/** A channel's plain name ("GOOGLE" → "Google"); an unknown code becomes "Other". */
export function channelPlainName(channel: string): string {
  return NAME[channel] ?? 'Other'
}

/** The legend: one entry per channel that has a campaign in the window, in a fixed order, by plain name. */
export function calendarLegend(campaigns: ReadonlyArray<{ channel: string }>): Array<{ channel: string; name: string }> {
  const present = new Set(campaigns.map((c) => c.channel))
  const known = ORDER.filter((ch) => present.has(ch))
  const unknown = [...present].filter((ch) => !ORDER.includes(ch)).sort()
  return [...known, ...unknown].map((channel) => ({ channel, name: channelPlainName(channel) }))
}
