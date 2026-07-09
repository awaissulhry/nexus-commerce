/**
 * parseThemeAxes — parse a variation_theme string into an array of axis names.
 *
 * EFX D4 — mirrors the server's ONE parser (apps/api/src/services/
 * ebay-theme-axes.ts) so client and server agree on the axis set. Kept as a
 * local web module (no cross-app import).
 *
 * Rules:
 *   • Split on any of  ,  /  |  ;
 *   • Trim each token, drop empties.
 *   • Dedupe case-insensitively, preserving the FIRST casing seen.
 *   • Cap at 5 axes (eBay's variation-axis limit).
 *   • Empty/null/undefined input → [].
 */
export function parseThemeAxes(theme: string | null | undefined): string[] {
  if (!theme) return []
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
