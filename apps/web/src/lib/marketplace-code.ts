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
