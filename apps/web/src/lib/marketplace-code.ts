/**
 * Map Amazon marketplace IDs (e.g. APJ6JRA9NG5V4) to their human-
 * readable country codes (IT, DE, FR, …). Operators want to see "IT",
 * not the opaque marketplace identifier, on dashboards and tables.
 *
 * Canonical mappings per Amazon SP-API / Ads API marketplace registry.
 * If a marketplace ID isn't in this table, the helper falls back to
 * the raw ID so the screen still shows *something* rather than an
 * empty cell — operators can then add the mapping here.
 *
 * Note: an existing mapping in /fulfillment/stock/fba-pan-eu had
 * A1C3SOZRARQ6R3 = PL; that's incorrect per Amazon docs (should be BE).
 * The advertising UI uses this file as the source of truth.
 */

const MARKETPLACE_ID_TO_CODE: Record<string, string> = {
  // EU
  APJ6JRA9NG5V4:   'IT', // Italy
  A1PA6795UKMFR9:  'DE', // Germany
  A13V1IB3VIYZZH:  'FR', // France
  A1RKKUPIHCS9HS:  'ES', // Spain
  A1F83G8C2ARO7P:  'UK', // United Kingdom
  A1805IZSGTT6HS:  'NL', // Netherlands
  A2NODRKZP88ZB9:  'SE', // Sweden
  A1C3SOZRARQ6R3:  'BE', // Belgium
  AMEN7PMS3EDWL:   'PL', // Poland
  A1AT7YVPFBWXBL:  'CZ', // Czech Republic
  A33AVAJ2PDY3EV:  'TR', // Turkey
  ARBP9OOSHTCHU:   'EG', // Egypt
  A2VIGQ35RCS4UG:  'AE', // United Arab Emirates
  A17E79C6D8DWNP:  'SA', // Saudi Arabia
  A21TJRUUN4KGV:   'IN', // India
  // NA
  ATVPDKIKX0DER:   'US',
  A2EUQ1WTGCTBG2:  'CA',
  A1AM78C64UM0Y8:  'MX',
  A2Q3Y263D00KWC:  'BR',
  // FE
  A1VC38T7YXB528:  'JP',
  A39IBJ37TRP1C6:  'AU',
  A19VAU5U5O7RUS:  'SG',
}

/**
 * Returns the 2-letter country code for a marketplace ID, or the raw
 * ID itself when unknown. Pass `null`/`undefined` to get an em-dash.
 *
 * The marketplace field on our schema sometimes ALREADY contains a
 * country code (Phase 31b's clean per-marketplace key for ChannelListing).
 * To stay safe, if the input already matches a known 2-3 letter code
 * pattern we return it unchanged.
 */
export function marketplaceCode(mp: string | null | undefined): string {
  if (!mp) return '—'
  // Already a short code (e.g. 'IT', 'GLOBAL') — pass through
  if (mp.length <= 6 && /^[A-Z_]+$/.test(mp)) return mp
  return MARKETPLACE_ID_TO_CODE[mp] ?? mp
}

const COUNTRY_NAME: Record<string, string> = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', UK: 'United Kingdom',
  NL: 'Netherlands', SE: 'Sweden', BE: 'Belgium', PL: 'Poland', CZ: 'Czech Republic',
  TR: 'Turkey', EG: 'Egypt', AE: 'UAE', SA: 'Saudi Arabia', IN: 'India',
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil',
  JP: 'Japan', AU: 'Australia', SG: 'Singapore', GLOBAL: 'Global',
}

/** Full country name for tooltips. Returns the code itself when unknown. */
export function marketplaceCountryName(mp: string | null | undefined): string {
  const code = marketplaceCode(mp)
  return COUNTRY_NAME[code] ?? code
}

/**
 * DS.3 — Pretty channel name. Maps the storage code to the brand
 * casing operators (and B2B buyers) expect to read on a printed
 * handout. Unknown channels fall back to title-case.
 */
const CHANNEL_PRETTY: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

export function prettyChannelName(channel: string | null | undefined): string {
  if (!channel) return '—'
  return (
    CHANNEL_PRETTY[channel] ??
    channel.charAt(0) + channel.slice(1).toLowerCase()
  )
}

/**
 * DS.3 — Combined "Amazon Italy" / "eBay Germany" / "Shopify"
 * label. Single-store channels (Shopify / Woo / Etsy) typically
 * carry marketplace="GLOBAL" or "DEFAULT" — in those cases we
 * collapse the suffix so the label reads as "Shopify" rather than
 * "Shopify Global".
 */
export function prettyChannelMarketplace(
  channel: string | null | undefined,
  marketplace: string | null | undefined,
): string {
  const ch = prettyChannelName(channel)
  if (!marketplace) return ch
  const code = marketplaceCode(marketplace)
  if (code === 'GLOBAL' || code === 'DEFAULT' || code === '—') return ch
  const name = COUNTRY_NAME[code] ?? code
  return `${ch} ${name}`
}

/**
 * DS.3 — Amazon TLD by marketplace, used to build the customer-
 * facing listing URL for the QR code on the datasheet. Falls back
 * to ".it" (Xavia's primary market) when the marketplace is
 * unrecognised so the QR still scans to a working storefront.
 */
const AMAZON_TLD: Record<string, string> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', UK: 'co.uk',
  NL: 'nl', SE: 'se', BE: 'com.be', PL: 'pl', CZ: 'com',
  TR: 'com.tr', EG: 'eg', AE: 'ae', SA: 'sa', IN: 'in',
  US: 'com', CA: 'ca', MX: 'com.mx', BR: 'com.br',
  JP: 'co.jp', AU: 'com.au', SG: 'sg',
}

export function amazonTld(mp: string | null | undefined): string {
  const code = marketplaceCode(mp)
  return AMAZON_TLD[code] ?? 'it'
}
