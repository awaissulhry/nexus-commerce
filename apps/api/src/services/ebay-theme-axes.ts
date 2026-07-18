/**
 * EFX D4 — the ONE eBay variation-theme parser.
 *
 * Historically the codebase split `variationTheme` in four incompatible ways
 * (`,` in create; `[/,|]` in cockpit + buildFlatRow; `[,/]` in the web themeAxes
 * helper) and NONE accepted `;`, so an operator who typed "a;b;c" got ONE axis.
 * This is the single source of truth: split on any of `, / | ;`.
 *
 * Rules:
 *   • Split on any of  ,  /  |  ;
 *   • Trim each token, drop empties.
 *   • Dedupe case-insensitively, preserving the FIRST casing seen.
 *   • Cap at 5 axes (eBay's variation-axis limit).
 *   • Non-string / empty input → [].
 */
export function parseThemeAxes(theme: unknown): string[] {
  if (typeof theme !== 'string') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of theme.split(/[,/|;]/)) {
    const name = raw.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= 5) break // eBay allows at most 5 variation axes
  }
  return out
}

// ── Variation-axis synonym groups ──────────────────────────────────────────
// Axes within the same group are the same physical dimension expressed in
// different locales / naming conventions (Colore ≡ Color ≡ Colour, …).
//
// EFX D5 — moved here from ebay-variation-push.service.ts (still re-exported
// there for back-compat) so the pure create-logic module can consume
// axisSynonymKey WITHOUT importing the push service (which would create a
// create.logic → push-service import cycle).
export const AXIS_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]

// Incident #19 — language-duplicate ASPECTS (Brand+Marca, Season+Stagione…):
// legacy products carry English aspect keys beside the Italian schema keys,
// and both leaked into new Trading listings (4 declared axes, twin specifics).
// ADDITIVE list — AXIS_SYNONYM_GROUPS' order is load-bearing (__dimN__ keys in
// stored _axisSortOrder) and must never change. Group[0] = canonical
// (localized) name, per the owner's rule: the flat file's language wins.
export const ASPECT_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ...AXIS_SYNONYM_GROUPS,
  ['marca', 'brand', 'marke', 'marque'],
  ['stagione', 'season'],
  ['paese di fabbricazione', 'country/region of manufacture', 'country of manufacture', 'made in'],
  ['tipo di giacca', 'jacket type'],
  ['tipo di prodotto', 'product type'],
  ['adatto a', 'suitable for'],
  ['livello di protezione', 'protection level'],
  ['reparto', 'department'],
  ['vestibilità', 'vestibilita', 'fit'],
  ['condizione', 'condition'],
]

/** Canonical (localized) name for ANY aspect via the synonym groups; unmapped
 *  names pass through lowercased. */
export function aspectCanonicalName(name: string): string {
  const lk = name.toLowerCase().trim()
  for (const group of ASPECT_SYNONYM_GROUPS) {
    if ((group as string[]).includes(lk)) return group[0]
  }
  return lk
}

/** Maps an axis name to its stable synonym-dimension key.
 *  Known synonym groups → __dim0__ / __dim1__ / …
 *  Custom/unmapped axes → lowercase axis name (the name itself is the stable key). */
export function axisSynonymKey(name: string): string {
  const lk = name.toLowerCase().trim()
  for (let i = 0; i < AXIS_SYNONYM_GROUPS.length; i++) {
    if ((AXIS_SYNONYM_GROUPS[i] as string[]).includes(lk)) return `__dim${i}__`
  }
  return lk
}

/**
 * EFX P3 — self-heal the legacy raw-name-keyed `_axisSortOrder` when a save
 * writes the canonical synonym-keyed `_axisValueOrder`.
 *
 * Any legacy entry whose axis maps to a synonym key that was just written is
 * now superseded and is dropped. Entries whose synonym key was NOT written are
 * left untouched (the push service still merges them for back-compat), so this
 * only prunes what has genuinely been migrated. Pure + order-preserving so the
 * PATCH route stays trivially testable.
 *
 * @param prevSortOrder      current `_axisSortOrder` (raw-name keyed) or undefined
 * @param writtenValueOrder  the `_axisValueOrder` being persisted (synonym keyed)
 * @returns the pruned `_axisSortOrder` (may be empty)
 */
/**
 * EFX P3.1 — merge a written synonym-keyed `_axisValueOrder` over the existing
 * stored map instead of replacing it. The flat-file modal and the cockpit card
 * derive their axis sets from DIFFERENT sources (grid rows' aspect_* columns vs
 * children's categoryAttributes.variations), so each writer may legitimately
 * omit an axis the other ordered; a full replace silently dropped the other
 * surface's entries. Written keys win; unwritten stored keys survive.
 */
export function mergeAxisValueOrderWrite(
  prev: Record<string, string[]> | undefined,
  written: Record<string, string[]>,
): Record<string, string[]> {
  return { ...(prev ?? {}), ...written }
}

export function selfHealAxisSortOrder(
  prevSortOrder: Record<string, string[]> | undefined,
  writtenValueOrder: Record<string, string[]>,
): Record<string, string[]> {
  if (!prevSortOrder) return {}
  const writtenKeys = new Set(Object.keys(writtenValueOrder))
  const out: Record<string, string[]> = {}
  for (const [rawName, vals] of Object.entries(prevSortOrder)) {
    if (writtenKeys.has(axisSynonymKey(rawName))) continue // superseded — drop
    out[rawName] = vals
  }
  return out
}
