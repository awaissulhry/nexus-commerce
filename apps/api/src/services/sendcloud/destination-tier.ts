/**
 * CR.22 — destination-tier classifier.
 *
 * Closes audit bug #10 ("International detection — manual via service
 * map; auto-tier still pending"). Given a (originCountry,
 * destinationCountry) pair, returns one of:
 *
 *   • DOMESTIC  — same country (same VAT zone, no customs)
 *   • EU        — different country, both inside the EU customs union
 *                 (no customs declarations needed; no tariffs)
 *   • INTL      — anything else (customs forms required, longer SLA)
 *
 * resolveServiceMap consults this when no exact CarrierServiceMapping
 * row matches: it picks a CarrierService whose `tier` matches the
 * detected destination tier, falling back to the legacy JSON map only
 * when nothing is tier-classified yet.
 *
 * Origin defaults to IT when no warehouse is bound — Xavia is IT-based
 * and that's the operator-base configured today. Future: pull origin
 * from Warehouse.country at the resolveServiceMap call site.
 *
 * Country codes are ISO-3166 alpha-2, uppercased. Lowercase / mixed
 * inputs are normalized.
 *
 * The EU member set is the customs-union member list as of 2026-05.
 * It does NOT include EFTA (CH/NO/IS/LI), which look like neighbours
 * but are customs-borders. UK is post-Brexit — INTL.
 */

const EU_MEMBERS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

export type DestinationTier = 'DOMESTIC' | 'EU' | 'INTL'

/**
 * Classify a shipment route. Both args are ISO-3166 alpha-2; case-
 * insensitive. Empty / invalid inputs default to INTL (safer than
 * DOMESTIC, which would skip customs preflight).
 */
export function classifyDestinationTier(
  originCountry: string | null | undefined,
  destinationCountry: string | null | undefined,
): DestinationTier {
  const origin = (originCountry ?? '').trim().toUpperCase()
  const dest = (destinationCountry ?? '').trim().toUpperCase()
  if (!origin || !dest) return 'INTL'
  if (origin === dest) return 'DOMESTIC'
  if (EU_MEMBERS.has(origin) && EU_MEMBERS.has(dest)) return 'EU'
  return 'INTL'
}

/**
 * Map a destination tier to the carrier-service tier we want to
 * fall back to. CarrierService.tier values come from the catalog
 * sync (CR.12) and are normalized to STANDARD / EXPRESS / PRIORITY /
 * ECONOMY. The mapping is intentionally simple: DOMESTIC → STANDARD,
 * EU → STANDARD (treat as domestic-like), INTL → EXPRESS (faster
 * service masks customs delay).
 *
 * Operators who want different defaults express them via ShippingRule
 * with the destinationCountry condition — those fire BEFORE
 * resolveServiceMap, so the rule takes precedence.
 */
export function preferredTierFor(tier: DestinationTier): string {
  switch (tier) {
    case 'DOMESTIC': return 'STANDARD'
    case 'EU':       return 'STANDARD'
    case 'INTL':     return 'EXPRESS'
  }
}

export const __test = { EU_MEMBERS }
