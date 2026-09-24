/**
 * Step 4.3 #2 (T1, A-44) — the content-language control, one slot, two modes.
 *
 * The nine language chips became ONE control: a single-choice `Listbox` normally, and — when the
 * sheet's Languages view is on (`locales` is a list) — a `MultiSelect` that can never drop below one
 * language. These two helpers are the pure half, so the rules are testable in node.
 */

/**
 * The selection the URL receives, in the AVAILABLE order, never empty. `MultiSelect` appends a newly
 * ticked language at the END; the sheet compares its column languages against this list in order
 * (`languageProjectionReady`), so an out-of-order list would leave the Languages view pending.
 * `null` = nothing valid to write (the control refuses rather than clearing the view).
 */
export function orderedLocales(next: readonly string[], available: readonly string[], min = 1): string[] | null {
  const chosen = new Set(next)
  const ordered = available.filter((code) => chosen.has(code))
  return ordered.length >= min ? ordered : null
}

/** The multi trigger's label — `Italian`, `Italian +2` — the first chosen language in the available order. */
export function languageSummary(codes: readonly string[], available: readonly string[], label: (code: string) => string): string {
  const ordered = available.filter((code) => codes.includes(code))
  if (!ordered.length) return 'No language'
  return ordered.length === 1 ? label(ordered[0]) : `${label(ordered[0])} +${ordered.length - 1}`
}
