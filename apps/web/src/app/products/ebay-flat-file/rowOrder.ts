/** Move blank/padding rows (empty sku + _isNew) to the end, preserving the
 *  relative order of real rows and of blanks. Fixes imported/added rows landing
 *  AFTER the grid's trailing blank padding (which wedged blanks mid-data). */
export function pinBlankRowsLast<T extends { sku?: unknown; _isNew?: unknown }>(rows: T[]): T[] {
  const isBlank = (r: T) => !String((r as { sku?: unknown }).sku ?? '').trim() && (r as { _isNew?: unknown })._isNew === true
  const reals: T[] = []
  const blanks: T[] = []
  for (const r of rows) (isBlank(r) ? blanks : reals).push(r)
  return [...reals, ...blanks]
}
