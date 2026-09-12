/**
 * How a closed-list CODE is shown to an operator (#501).
 *
 * 🔴 ONE function, because a code shown two ways is a code an operator cannot search for. The sheet
 * renders `PK` as "Pakistan"; an import diff that rendered the raw code beside it would read as a
 * change where there is none — the whole point of a diff being that identical values look identical.
 *
 * It lives here rather than in `columns.tsx` because the grid is no longer the only consumer:
 * IO.1's import diff imports it, and any future surface that shows a coded value must too.
 *
 * The rule that is easy to get wrong when copying rather than importing: **an unmapped code falls
 * back to the CODE, never to blank.** A missing label is a gap in the schema, and blanking the cell
 * would present it as a missing value — the operator would be looking at a cell that has data and
 * being told it has none.
 */
export function optionLabel(value: unknown, optionLabels?: Record<string, string> | null): string {
  // Empty is empty: `null`, `undefined` and `''` are the absence of a value, not a code to look up.
  // A lookup of `''` would happily return a label if the schema ever carried one for it.
  if (value == null || value === '') return ''
  const code = String(value)
  return optionLabels?.[code] ?? code
}
