/**
 * AG.3 — the row-filter pipeline, lifted out of `WorkspaceGrid` so BOTH engines run the
 * IDENTICAL code rather than two implementations that agree on the day they are written.
 *
 * This is a straight extraction: every branch below was inline in `WorkspaceGrid`'s `filtered`
 * memo and is unchanged. It lives here because the AG Grid engine has to filter the same rows
 * the same way, and this codebase has already paid for the alternative — a design system carried
 * as a COPY in apps/factory, two Customize dialogs, and a fork-drift ratchet that exists
 * precisely because "apply the same change to the other copy" is not something people remember.
 *
 * ⚠ The three behaviours here are load-bearing and none of them are the obvious default:
 *
 *  1. **NaN is "not measured", and an unmeasured row NEVER matches a SET range.** Every consumer
 *     uses NaN for "no data" and their filter tips promise exactly this. NaN compares false in
 *     both directions, so without the explicit guard an unmeasured row would silently PASS a
 *     range it was never measured against — the same family of bug as a `null` that matches
 *     every `lte`, and as a `null` that sorts as `0`.
 *  2. **An empty filter is not a filter.** A range with neither bound, a multiselect with no
 *     values, an unset select — each `continue`s rather than excluding everything.
 *  3. **A filter with no accessor is inert, not fatal.** A range reads `filter.value` first and
 *     falls back to the matching column's `filterValue`; with neither it is skipped, because a
 *     misconfigured filter must not empty an operator's grid.
 *
 * Server mode and tree mode bypass this entirely — that decision stays at the call site, where
 * the reason lives: those rows arrived in a deliberate order and re-deriving one would lie.
 */
import type { FilterState, GridColumn, GridFilter, RangeVal } from './WorkspaceGrid'

export function filterRows<T>(
  rows: readonly T[],
  filters: readonly GridFilter[] | undefined,
  fstate: FilterState,
  columns: readonly GridColumn<T>[],
): T[] {
  if (!filters?.length) return rows as T[]

  const byKey = new Map<string, GridColumn<T>>()
  for (const c of columns) byKey.set(c.key, c)

  return (rows as T[]).filter((row) => {
    for (const f of filters) {
      const st = fstate[f.key]

      if (f.kind === 'range') {
        const r = st as RangeVal | undefined
        if (!r || (!r.min && !r.max)) continue
        const acc = f.value ?? byKey.get(f.key)?.filterValue
        if (!acc) continue
        const v = (acc as (row: T) => number)(row)
        // See (1) above — this line is the whole reason an unmeasured row behaves.
        if (Number.isNaN(v)) return false
        if (r.min !== '' && v < Number(r.min)) return false
        if (r.max !== '' && v > Number(r.max)) return false
      } else if (f.kind === 'multiselect') {
        const vals = (st as string[] | undefined) ?? []
        if (vals.length === 0) continue
        const acc = f.value as ((row: T) => string) | undefined
        if (!acc) continue
        if (!vals.includes(acc(row))) return false
      } else {
        const val = st as string | undefined
        if (!val) continue
        const acc = f.value as ((row: T) => string) | undefined
        if (!acc) continue
        if (acc(row) !== val) return false
      }
    }
    return true
  })
}
