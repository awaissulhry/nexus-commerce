/**
 * EFX P4 — required-aspect push preflight (pure, no I/O).
 *
 * The flat-file push route checks — per row, per target market — that every
 * aspect the row's eBay category marks REQUIRED carries a non-empty aspect_*
 * value, and turns misses into the same per-SKU { status: 'ERROR' } rows the
 * variation-axis pre-check produces, instead of letting eBay reject the whole
 * group with an opaque 25007 after the network round-trip.
 *
 * Requirement definitions come from the same mapped schema payload the
 * GET /ebay/flat-file/category-schema route serves/caches (id like
 * 'aspect_Marca', label like 'Marca (Brand)', required boolean).
 */

export interface AspectRequirement {
  /** Column id as served by the category-schema route, e.g. 'aspect_Marca'. */
  id: string
  /** Display label, e.g. 'Marca (Brand)'. Falls back to a name derived from id. */
  label?: string
  required?: boolean
}

// The push injects the market-localised brand aspect from Product.brand
// (row._brand) — see BRAND_ASPECT/BRAND_ALIASES in ebay-variation-push.service.
const BRAND_ALIASES = new Set(['marca', 'brand', 'marke', 'marque', 'marka'])

/** Human-readable name for error messages. */
export function aspectDisplayName(a: AspectRequirement): string {
  const fromId = a.id.startsWith('aspect_') ? a.id.slice('aspect_'.length) : a.id
  return (a.label ?? fromId.replace(/_/g, ' ')).trim()
}

/**
 * Display names of REQUIRED aspects that have no non-empty aspect_* value on
 * the row.
 *
 * - Key matching is case-insensitive: buildFlatRow emits BOTH aspect_Colore
 *   and aspect_colore for variation axes, and operators may type either.
 * - Values satisfied by push-time injection are honored:
 *     brand-like aspects (Marca/Brand/Marke/Marque) ← row._brand
 *     EAN ← row.ean, MPN ← row.mpn
 */
export function findMissingRequiredAspects(
  row: Record<string, unknown>,
  aspects: AspectRequirement[],
): string[] {
  const present = new Set<string>()
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('aspect_')) continue
    if (v === null || v === undefined || String(v).trim() === '') continue
    present.add(k.toLowerCase())
  }

  const missing: string[] = []
  for (const a of aspects) {
    if (!a.required) continue
    const keyLower = a.id.toLowerCase()
    if (present.has(keyLower)) continue
    const nameLower = keyLower.startsWith('aspect_')
      ? keyLower.slice('aspect_'.length).replace(/_/g, ' ')
      : keyLower.replace(/_/g, ' ')
    if (BRAND_ALIASES.has(nameLower) && String(row._brand ?? '').trim() !== '') continue
    if (nameLower === 'ean' && String(row.ean ?? '').trim() !== '') continue
    if (nameLower === 'mpn' && String(row.mpn ?? '').trim() !== '') continue
    missing.push(aspectDisplayName(a))
  }
  return missing
}
