/**
 * ADM-P6b — where a budget-utilization reading sits against its budget.
 *
 * A pure module rather than a helper inside the cell, for the same reason
 * `fleet/activity/day-grouping.ts` is one: a decision worth asserting has to be importable by a
 * test, and vitest cannot parse this app's TSX (the Next tsconfig sets `jsx: preserve`).
 */

/** Percent, not a fraction. At or above this the budget is spent and the campaign stops serving. */
export const UTIL_CAPPED_PCT = 100
/** Percent. At or above this the campaign is on course to stop serving before the day ends. */
export const UTIL_NEARLY_PCT = 85

export type UtilBand = 'capped' | 'nearly' | 'normal'

/**
 * 🔴 Colour the EXCEPTIONS, not the normal case.
 *
 * Only two bands carry colour, and both are facts rather than judgements:
 *
 *   capped  >= 100%  the budget is spent, and Amazon stops serving the campaign for the rest
 *                    of the day. Measured 2026-08-22: 20 of 83 campaigns average this or more
 *                    over the reported window, one of them at 288%.
 *   nearly  >=  85%  on course to spend the budget before the day ends.
 *
 * Everything below keeps the neutral blue. A green "all clear" band was considered and dropped
 * for two reasons:
 *
 *  1. **It would drown the signal.** Over the same 83 campaigns the split is 20 capped · 7
 *     nearly · 56 normal. Painting those 56 green puts the 20 that matter in competition with
 *     56 that do not, and colour earns its place only by marking what is exceptional.
 *  2. **Green asserts "good", and this column cannot see that.** A campaign at 3% of its budget
 *     is usually a bid or targeting problem, not a healthy one. All this column knows is whether
 *     the BUDGET is the binding constraint; it knows nothing about whether the campaign is
 *     working.
 *
 * Colour is never the only carrier: the number is always rendered, and the tooltip says what the
 * band means in words.
 */
export function utilBand(pct: number | null | undefined): UtilBand {
  // An absence has no band. The cell renders a word for it and never reaches the gauge — but a
  // caller that does reach here with null must not be handed a colour it did not earn.
  if (pct == null || !Number.isFinite(pct)) return 'normal'
  if (pct >= UTIL_CAPPED_PCT) return 'capped'
  if (pct >= UTIL_NEARLY_PCT) return 'nearly'
  return 'normal'
}
