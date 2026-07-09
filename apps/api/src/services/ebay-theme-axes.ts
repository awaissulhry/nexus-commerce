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
