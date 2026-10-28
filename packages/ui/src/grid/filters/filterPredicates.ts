/**
 * GDS / PES.2 — what the DS column filters MEAN, as pure functions.
 *
 * 🔴 The defect this closes. Every DS filter shared one callback object:
 *
 *     const SERVER_FILTERS = { doesFilterPass: () => true }
 *
 * That is correct under the Server-Side Row Model, where the server has already filtered and the
 * grid must not filter again — which is the only row model `/products/next` uses, so it was never
 * wrong there. But `doesFilterPass` is EXACTLY what the Client-Side Row Model calls, and a sheet is
 * client-side. On any CSRM grid the DS filters therefore lit their funnel, wrote a filter model,
 * showed an active-filter mark in the header — and passed every row. A control that reports a state
 * it does not have is the one thing the honest-UI rule forbids.
 *
 * So the predicates live here, pure and tested, and both row models are served by the same object:
 * SSRM never calls `doesFilterPass`, CSRM now gets a true answer.
 *
 * A NULL CELL NEVER PASSES A FILTER. It reads as "no answer", not as zero and not as the empty
 * string — the same rule the blank-sinking comparator keeps on the sort side, and the same trap
 * that `null <= x` produces in SQL. Selecting "(Blanks)" in a set filter is how an operator asks
 * for them, and that is an explicit choice rather than an accident of coercion.
 */
import type { GridNumberFilterModel, GridSetFilterModel, GridTextFilterModel } from '@nexus/shared/products-grid'

/** What a set filter's operator picks to mean "the ones with nothing here". */
export const BLANK_FILTER_VALUE = '(Blanks)'

const isBlank = (value: unknown): boolean => value === null || value === undefined || value === ''

/**
 * Set: the cell's value, as text, is one of the chosen ones.
 *
 * Compared as STRINGS because that is what the wire model holds and what the option list offers —
 * a number column filtered to "10" must match the number 10, and `String(10) === '10'` is the only
 * comparison that survives a value arriving as either.
 */
export function setFilterPasses(model: GridSetFilterModel | null | undefined, value: unknown): boolean {
  if (!model || model.values.length === 0) return true
  if (isBlank(value)) return model.values.includes(BLANK_FILTER_VALUE)
  return model.values.includes(String(value))
}

/**
 * Number: inside the range, or past the one bound that was given.
 *
 * An absent bound is OPEN, an absent cell value is OUT. `filter` and `filterTo` are both nullable
 * in the wire model, so "min only", "max only" and "neither" all have to work — and "neither" means
 * the operator cleared the filter, which passes everything.
 */
export function numberFilterPasses(model: GridNumberFilterModel | null | undefined, value: unknown): boolean {
  if (!model) return true
  const { type, filter, filterTo } = model
  if (filter == null && filterTo == null) return true
  if (isBlank(value)) return false
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return false
  switch (type) {
    case 'equals':
      return filter == null || n === filter
    case 'greaterThanOrEqual':
      return filter == null || n >= filter
    case 'lessThanOrEqual':
      return filter == null || n <= filter
    case 'inRange':
    default:
      if (filter != null && n < filter) return false
      if (filterTo != null && n > filterTo) return false
      return true
  }
}

/**
 * Text: a case-insensitive substring.
 *
 * Trimmed on the filter side only — an operator's trailing space is a typo, a value's is data.
 * A filter of nothing but whitespace is not a filter.
 */
export function textFilterPasses(model: GridTextFilterModel | null | undefined, value: unknown): boolean {
  if (!model) return true
  const needle = model.filter.trim().toLowerCase()
  if (needle === '') return true
  if (isBlank(value)) return false
  return String(value).toLowerCase().includes(needle)
}
