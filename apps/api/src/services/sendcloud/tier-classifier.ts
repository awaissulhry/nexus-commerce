/**
 * CR.24 — service-name tier classifier.
 *
 * Sendcloud's /shipping_methods response doesn't carry a normalized
 * tier field — the closest signal is the service name ("BRT 0–2kg
 * Standard", "DHL Express International", "GLS Business Parcel").
 * CR.22 added a tier-based auto-fallback in resolveServiceMap that
 * picks a CarrierService.tier matching the destination tier; CR.12
 * synced rows but left tier=null on every one, so the fallback
 * always missed.
 *
 * CR.24 closes the loop: a heuristic that reads (name, carrierSubName)
 * and returns one of:
 *
 *   • PRIORITY    — next-day / overnight / time-definite
 *   • EXPRESS     — international express / 1-2 day / DHL Express
 *   • STANDARD    — default ground / B2C parcel
 *   • ECONOMY     — slowest / lowest cost / Posta1 / packetshop
 *   • null        — unclassifiable; resolveServiceMap won't tier-match
 *
 * The CR.12 catalog sync calls this after each upsert so every row
 * lands with a tier set (or honestly null when the name gives no
 * signal).
 *
 * The classifier is intentionally simple: case-insensitive substring
 * matching on a small keyword set. Operators can override per row
 * via the CR.7 service-mapping editor's tierOverride field.
 */

export type ServiceTier = 'PRIORITY' | 'EXPRESS' | 'STANDARD' | 'ECONOMY'

/**
 * Order matters here. PRIORITY checks run before EXPRESS (because
 * "DHL Express Priority" should be PRIORITY not EXPRESS); EXPRESS
 * before STANDARD (because "Express Standard" — yes Sendcloud has
 * one — is EXPRESS not STANDARD); ECONOMY last (because "Standard
 * Economy" is ECONOMY).
 *
 * Each pattern is a case-insensitive substring; the first match
 * wins. Patterns are intentionally lenient — we prefer wrong-tier
 * over null, because a tier-matched fallback that's slightly off
 * still beats falling through to the legacy JSON map.
 */
const PATTERNS: Array<{ tier: ServiceTier; needles: string[] }> = [
  // PRIORITY: time-definite / overnight / before noon
  { tier: 'PRIORITY', needles: [
    'priority', 'overnight', 'next day', 'next-day',
    'before noon', 'before 9', 'before 10', 'before 12',
    'time definite', 'time-definite',
  ] },
  // EXPRESS: international express / 1-2 day promises
  { tier: 'EXPRESS', needles: [
    'express', 'crono', 'rapido',
    '1-2 day', '1-2-day', '24h', '24-hour',
    'expedite', 'expedited',
  ] },
  // ECONOMY: cheapest / slowest / packetshop / Posta1 economy
  { tier: 'ECONOMY', needles: [
    'economy', 'budget', 'low cost', 'low-cost',
    'packetshop', 'service point', 'lockers', 'pickup point',
    'piego di libri', 'posta4', // Italian slowest tiers
  ] },
  // STANDARD: catch-all for parcel / business / B2C / standard
  { tier: 'STANDARD', needles: [
    'standard', 'business parcel', 'parcel', 'b2c',
    'home delivery', 'home',
    'posta1', 'posta2', 'posta3',
    'sda', 'brt', 'gls',  // bare-carrier-name → likely standard
  ] },
]

/**
 * Classify a service by name + carrier sub-name. Returns null when
 * no pattern matches — caller persists null and the tier fallback
 * skips the row.
 */
export function classifyServiceTier(
  name: string | null | undefined,
  carrierSubName?: string | null,
): ServiceTier | null {
  const haystack = `${name ?? ''} ${carrierSubName ?? ''}`.toLowerCase()
  if (!haystack.trim()) return null
  for (const { tier, needles } of PATTERNS) {
    for (const n of needles) {
      if (haystack.includes(n)) return tier
    }
  }
  return null
}

export const __test = { PATTERNS }
