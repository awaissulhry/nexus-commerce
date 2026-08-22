/**
 * PLC-P3 — the three SP placement lanes, in ONE place.
 *
 * The builder's THEN picker and the rules grid's Criteria cell both have to name a lane, and
 * before this they could not: the grid never read `placeTarget` at all, so "Top of Search Set to
 * 50%", "Product Pages Set to 50%" and "Rest of Search Set to 50%" all rendered as the identical
 * string `ACoS > 40% → Set 50%` — three different rules, one cell, on the tab whose entire subject
 * is which lane you are paying for.
 *
 * Two labels for one lane in two files is the same class of defect one step later
 * ([[reference_shared_rule_column_cells]]), so both readers import this.
 *
 * 🔴 The KEYS are the BUILDER's words (`tos` · `pdp` · `ros`) because that is what a stored rule
 * carries in `conditions[].action.placeTarget`. The Amazon enums (`PLACEMENT_TOP` …) live in the
 * API's `ads-placement-math.ts`; the adapter's `PLACEMENT_ENUM` is the one place they meet, and
 * this file deliberately does not duplicate that mapping.
 */
export type PlacementLaneKey = 'tos' | 'pdp' | 'ros'

export const PLACEMENT_LANES: ReadonlyArray<{ value: PlacementLaneKey; label: string }> = [
  { value: 'tos', label: 'Top of Search' },
  { value: 'pdp', label: 'Product Pages' },
  { value: 'ros', label: 'Rest of Search' },
]

/**
 * The lane a stored rule names, in the operator's words.
 *
 * Falls back to Top of Search only for a MISSING key, because that is the builder's own default
 * (`placeTarget ?? 'tos'`) and therefore what the engine will act on. An UNKNOWN key returns the
 * raw string instead: inventing "Top of Search" over a value nobody recognises would put a
 * confident wrong lane in the one cell that decides what the rule does.
 */
export function placementLaneLabel(key: string | null | undefined): string {
  if (key == null || key === '') return 'Top of Search'
  return PLACEMENT_LANES.find((l) => l.value === key)?.label ?? key
}

/**
 * The THEN half of a placement rule, as a sentence naming its lane.
 *
 * Extracted from the grid's `summariseRule` so it can be tested directly: the defect this fixes is
 * that three rules rendered ONE string, and the only test with teeth is one that asserts three
 * different strings come out. It reads as English rather than as arithmetic for the same reason
 * every other THEN on this grid does — `Set 50%` beside `−20%` is a cell an operator has to decode.
 *
 * Unknown ops fall through to a shape that still names the lane and the number, because a THEN
 * nobody has taught this function is still a THEN that does something to a specific lane, and
 * dropping the lane there would reintroduce the exact defect one op later.
 */
export function placementThenSentence(op: string | undefined, value: string, placeTarget?: string | null): string {
  const lane = placementLaneLabel(placeTarget)
  if (op === 'set') return `Set ${lane} to ${value}%`
  if (op === 'incPct') return `Increase ${lane} by ${value}%`
  if (op === 'decPct') return `Decrease ${lane} by ${value}%`
  return `${op ?? '—'} ${value}% on ${lane}`
}
