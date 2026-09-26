/**
 * NCF D2 A (`docs/studies/native-channel-files.md` §8) — Shopify's compare-at price (the struck-through "was" price).
 *
 * Nexus already keeps it per Shopify listing: the Shopify spec's `compareAtPrice` field stores it at
 * `platformAttributes.compareAtPrice` (legacy `shopifyCompareAtPrice`, `channel-specs/store.ts`), and the Shopify
 * publisher sends it with each variant (`shopify/content-workspace.service.ts`). It is the same concept as Amazon's
 * `list_price` (RRP), which is also a per-listing platform fact, so no new column is added: the one price door
 * (`writeChannelPrices`) records it, and the product-CSV import and export read it through this one function.
 * Pure.
 */
export const COMPARE_AT_KEY = 'compareAtPrice'
const LEGACY_KEY = 'shopifyCompareAtPrice'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const amount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'object' && value && 'toNumber' in value ? (value as { toNumber(): number }).toNumber() : Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/** The compare-at price a listing holds: `stored` (a number, or `null` = "Shopify holds none") or `inherited` (never recorded). */
export function storedCompareAt(platformAttributes: unknown): { state: 'stored' | 'inherited'; value: number | null } {
  const bag = record(platformAttributes)
  for (const key of [COMPARE_AT_KEY, LEGACY_KEY]) if (Object.prototype.hasOwnProperty.call(bag, key)) return { state: 'stored', value: amount(bag[key]) }
  return { state: 'inherited', value: null }
}

/** The platform bag with the compare-at price recorded under its current key (the legacy key is retired, never read again). */
export function withCompareAt(platformAttributes: unknown, value: number | null): Record<string, unknown> {
  const { [LEGACY_KEY]: _legacy, ...bag } = record(platformAttributes)
  return { ...bag, [COMPARE_AT_KEY]: value }
}
