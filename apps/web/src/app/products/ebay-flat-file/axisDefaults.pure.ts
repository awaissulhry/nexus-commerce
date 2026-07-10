/**
 * Safeguard S1 — localized aspect defaults for NEW eBay products.
 *
 * Pure, dependency-free helpers so vitest can import them without loading the
 * React client. Two concerns:
 *
 *   • localizedAxisName — strip the parenthesized English gloss the API appends
 *     to a category-schema aspect label ("Colore (Color)" → "Colore") so the
 *     AXIS NAME VALUE carried into the theme/columns is the marketplace-local
 *     name, not the English one. The full "Name (English)" label is still shown
 *     verbatim in UI lists for comprehension — only the value we persist is
 *     stripped. A label with no trailing parenthetical (a custom axis like
 *     "Tipo di prodotto") passes through unchanged.
 *
 *   • marketplaceDefaultAxes — a marketplace-aware fallback for when NO category
 *     schema is loaded yet, so a new IT family defaults to Colore/Taglia rather
 *     than the hard-coded English Color/Size.
 */

/**
 * Return the localized axis name from a category-schema label, dropping a
 * trailing " (English)" gloss.
 *
 *   "Colore (Color)"      → "Colore"
 *   "Taglia (Size)"       → "Taglia"
 *   "Tipo di prodotto"    → "Tipo di prodotto"   (no gloss — unchanged)
 *   "Color"               → "Color"              (already English, unchanged)
 *
 * Only the LAST trailing parenthetical is stripped; internal text is preserved.
 * Falls back to the original label if stripping would leave an empty string.
 */
export function localizedAxisName(label: string): string {
  const raw = (label ?? '').trim()
  const m = raw.match(/^(.*?)\s*\([^()]*\)\s*$/)
  const stripped = (m ? m[1] : raw).trim()
  return stripped || raw
}

/**
 * Marketplace → default [colour, size] axis names, in the marketplace's own
 * language. Used only as a fallback when no category schema has loaded; once a
 * category loads, the localized schema names (via {@link localizedAxisName})
 * take over. Unknown / non-EU marketplaces fall back to English Color/Size.
 */
const AXIS_DEFAULTS_BY_MARKET: Record<string, [string, string]> = {
  IT: ['Colore', 'Taglia'],
  DE: ['Farbe', 'Größe'],
  FR: ['Couleur', 'Taille'],
  ES: ['Color', 'Talla'],
  UK: ['Colour', 'Size'],
}

export function marketplaceDefaultAxes(marketplace?: string): string[] {
  const code = (marketplace ?? '').toUpperCase().replace(/^EBAY_/, '')
  return [...(AXIS_DEFAULTS_BY_MARKET[code] ?? ['Color', 'Size'])]
}
