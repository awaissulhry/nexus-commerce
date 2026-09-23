/**
 * Stable variation-axis identities — ONE synonym table for the product side and the eBay side (Step 2.6c-3, R-23).
 * The product side used its own short list here while the eBay side kept `AXIS_SYNONYM_GROUPS`; they disagreed on
 * `talla` / `groesse` (product only) and `size name`, `color name`, `misura`, `kleur`, `maat`, … (eBay only).
 *
 * ⚠ APPEND-ONLY, and the ORDER is load-bearing: the eBay push stores `__dimN__` keys in `_axisValueOrder` /
 * `_axisSortOrder` by GROUP POSITION (`axisSynonymKey`, `ebay-theme-axes.ts`). New groups go at the END; existing
 * groups gain entries at their END only. Production, 2026-09-23: the stored keys are `__dim0__` and `__dim1__`, and
 * the axis names in use are Colore, Taglia, Color, Size — so the two spellings appended below re-key nothing.
 */
export const AXIS_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko', 'talla', 'groesse'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]

/** The product side names the first three groups; the other two are eBay aspect synonyms only. */
const CANONICAL_NAMES = ['color', 'size', 'style'] as const
const fold = (value: string) => value.toLowerCase().replace(/[\s_-]/g, '')
const CANONICAL = new Map<string, string>(AXIS_SYNONYM_GROUPS.slice(0, CANONICAL_NAMES.length)
  .flatMap((group, i) => group.map((spelling) => [fold(spelling), CANONICAL_NAMES[i]] as const)))

/** Stable variation-axis identities, shared by source resolution and the product sheet. */
export function canonicalVariantAxis(value: string): string {
  const key = fold(value)
  return CANONICAL.get(key) ?? key
}
