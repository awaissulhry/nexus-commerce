import { AXIS_SYNONYM_GROUPS } from '../ebay-theme-axes.js'

/**
 * Stable variation-axis identities — the product side reads the SAME synonym table as the eBay side (Step 2.6c-3,
 * R-23). It used to keep its own short list here while the eBay side kept `AXIS_SYNONYM_GROUPS`; they disagreed on
 * `size name`, `color name`, `misura`, `kleur`, `maat`, … (eBay only), so one child's axis could be two axes.
 *
 * The table lives in `ebay-theme-axes.ts` — the source of truth since EFX Phase 2, mirrored byte-for-byte by the
 * eBay flat-file client (a no-touch area) and guarded by its parity test. Imported AND re-exported: a bare
 * `export … from` binds nothing locally, and the map below uses it.
 */
export { AXIS_SYNONYM_GROUPS }

/** The product side names the first three groups; the other two are eBay aspect synonyms only. */
const CANONICAL_NAMES = ['color', 'size', 'style'] as const
/** Two size spellings the product side knew that the table does not. Adding them to the table needs the no-touch
 * flat-file client copy changed in the same commit, so they stay product-only until the Owner lifts that for the
 * one file. Production, 2026-09-23 (`tools/axis-stores.mjs`): neither is in use. */
const PRODUCT_ONLY: Record<string, (typeof CANONICAL_NAMES)[number]> = { talla: 'size', groesse: 'size' }
const fold = (value: string) => value.toLowerCase().replace(/[\s_-]/g, '')
const CANONICAL = new Map<string, string>([
  ...AXIS_SYNONYM_GROUPS.slice(0, CANONICAL_NAMES.length).flatMap((group, i) => group.map((spelling) => [fold(spelling), CANONICAL_NAMES[i]] as const)),
  ...Object.entries(PRODUCT_ONLY),
])

/** Stable variation-axis identities, shared by source resolution and the product sheet. */
export function canonicalVariantAxis(value: string): string {
  const key = fold(value)
  return CANONICAL.get(key) ?? key
}
