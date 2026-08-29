/**
 * AG.3 — the sort comparison both grid engines run, in one place.
 *
 * Before this, the KT.3 blank rule existed TWICE, written two different ways that happened to
 * agree. `WorkspaceGrid` returned the blank case before applying the direction flip;
 * `AgWorkspaceGrid` returned pre-inverted values so they would survive the negation AG Grid
 * applies to a descending comparator. Both were correct. Nothing made them stay correct together
 * — and "two implementations that agree on the day they are written" is the exact shape of every
 * fork this codebase is still paying for.
 *
 * ⚠ KT.3: **a blank sorts to the BOTTOM in BOTH directions.** It is decided BEFORE the direction
 * flip, so it is not merely reversed. Otherwise "sort by spend ascending" surfaces every campaign
 * we never paid for instead of the cheapest one we did — the blanks bury the answer.
 *
 * ⚠ A blank is `null`/`undefined`, and it is NOT zero. Of the 321 `sortValue` definitions in the
 * ads tree, 28 substitute a sentinel like NEGATIVE_INFINITY, which is precisely the flaw a column
 * can now opt out of. A value that reads as 0 because it was never measured is the same damage as
 * a rounded 0.00% that was really "no data", a `Number(null)` that matched every `lte`, and a
 * Decimal that arrived as a silent zero.
 */
export type SortDir = 'asc' | 'desc'
export type SortValue = number | string | null | undefined

/** The comparator, in the direction given. Returns the FINAL order — no caller negates it. */
export function compareSortValues(va: SortValue, vb: SortValue, dir: SortDir): number {
  // Decided before the flip below — this line is the whole of KT.3.
  if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1
  const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
  return dir === 'asc' ? cmp : -cmp
}

/**
 * The same comparison, shaped for AG Grid.
 *
 * AG Grid NEGATES a comparator's result on a descending sort. Handing it the descending answer
 * pre-inverted means the negation restores it, so the row order that lands is identical to the
 * one `compareSortValues` describes — blanks at the bottom, both directions.
 *
 * This is the only reason the adapter exists. Do not "simplify" it by dropping the inversion:
 * the blanks then float to the TOP on a descending sort, which is a bug a screenshot of a
 * descending grid looks entirely correct for, because the blanks are off the first page.
 */
export function compareForAgGrid(a: unknown, b: unknown, isDescending: boolean): number {
  const cmp = compareSortValues(a as SortValue, b as SortValue, isDescending ? 'desc' : 'asc')
  return isDescending ? -cmp : cmp
}
