/**
 * PES.2 / #716 — what the identity band's SECOND LINE says, as a rule so it can be tested.
 *
 * The band shows either the product NAME or the row's axis values ("Nero · XS"). The choice is made
 * ONCE PER FAMILY, never per row, and that is the whole substance of this module.
 *
 * 🔴 Why per family. On the programme's own fixture only 2 of 20 variants carry any axis value —
 * and PES.5 established (#718) that those two are a rehearsal artefact (`[object Object]`, one batch
 * at 04:04:55.866Z), so the true coverage is 0/20 and the other 18 rows' colour and size live
 * NOWHERE (Owner item 46). A per-row fallback would therefore print axis values on two rows and a
 * product name on eighteen, in one column, with nothing on screen saying why they differ. One
 * column, one kind of sentence.
 *
 * 🔴 `{}` is not absence. The parent row carries `axisValues: {}` rather than omitting the key, so
 * `'axisValues' in row` and any truthiness test both report that a parent HAS axis values. Emptiness
 * is the only safe test, and it is why `hasAxisValues` exists rather than a `!!row.axisValues`
 * at each call site.
 */
import type { SheetColumn, StudioRow } from './types'

/** The family's axis KEYS, from the contract's own flag — never from a localised label (#711). */
export function axisKeysOf(columns: readonly SheetColumn[]): string[] {
  return columns.filter((c) => c.axis === true).map((c) => c.key)
}

const valueFor = (row: StudioRow, axisKey: string): string => {
  const bag = row.axisValues ?? {}
  /* Case-insensitive: the column key is the schema's spelling (`color`) and the stored bag uses the
     family's axis key (`Color`). Matching exactly here would reproduce P11's defect one layer down —
     a rule that looks right and silently finds nothing. */
  const hit = Object.keys(bag).find((k) => k.toLowerCase() === axisKey.toLowerCase())
  return hit ? String(bag[hit] ?? '').trim() : ''
}

export const hasAxisValues = (row: StudioRow): boolean => Object.keys(row.axisValues ?? {}).length > 0

/**
 * Do the axis values cover the family well enough to BE the second line?
 *
 * Every variant must carry every axis. A partial answer is worse than the name: the operator cannot
 * tell a row whose colour is genuinely unset from one the read did not answer for.
 *
 * 🔴 Guarded against the vacuous yes in both directions. No axis columns, or no variants, is not
 * "fully covered" — it is nothing to cover, and `Array.every` on an empty list would answer `true`
 * and put an empty line on every row.
 */
export function axesFullyCovered(rows: readonly StudioRow[], columns: readonly SheetColumn[]): boolean {
  const keys = axisKeysOf(columns)
  if (keys.length === 0) return false
  const variants = rows.filter((r) => !r.isParent)
  if (variants.length === 0) return false
  return variants.every((r) => keys.every((k) => valueFor(r, k) !== ''))
}

/**
 * What the whole sheet's second line is made of. Decided ONCE per family, never per row.
 *
 * 🔴 `'none'`, not `'name'` (#725). The Owner, seeing the name under the SKU: *"no need for it, we
 * already have a column dedicated to the product name."* The band shows the axis values that tell
 * the rows APART, or nothing — a second line repeating a column already on screen spends the width
 * §9.1 is fighting for and tells the operator nothing new.
 */
export interface SecondaryPlan {
  mode: 'axes' | 'none'
  axisKeys: string[]
}

/**
 * 🔴 Computed once for the sheet and handed to the renderer, not derived inside it. Coverage is a
 * question about EVERY row, so asking it per row is both O(n²) across a family and an invitation to
 * answer it differently on two rows — which is the per-row fallback this rule exists to prevent.
 */
export function secondaryPlan(rows: readonly StudioRow[], columns: readonly SheetColumn[]): SecondaryPlan {
  return { mode: axesFullyCovered(rows, columns) ? 'axes' : 'none', axisKeys: axisKeysOf(columns) }
}

/**
 * The second line for one row — the axis values, or nothing at all (#725).
 *
 * The PARENT gets nothing under any plan: it carries `{}` by design, and the band row's own
 * secondary is a variant COUNT, supplied by the caller rather than derived here.
 */
export function identitySecondary(row: StudioRow, plan: SecondaryPlan): string | null {
  if (plan.mode !== 'axes' || !hasAxisValues(row)) return null
  const parts = plan.axisKeys.map((k) => valueFor(row, k)).filter((v) => v !== '')
  /* A row that passes coverage but formats to nothing renders NO line rather than an empty one —
     belt and braces, since coverage is measured over the same values. */
  return parts.length > 0 ? parts.join(' · ') : null
}
