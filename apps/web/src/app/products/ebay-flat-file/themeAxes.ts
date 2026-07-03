/**
 * parseThemeAxes — parse a variation_theme string into an array of axis names.
 * Splits on comma OR forward-slash (eBay stores themes as both "Size,Color"
 * and "Size / Color" depending on the API version / editor). Returns [] for
 * empty/null/undefined input.
 */
export function parseThemeAxes(theme: string | null | undefined): string[] {
  if (!theme) return []
  return theme.split(/[,/]/).map((s) => s.trim()).filter(Boolean)
}
