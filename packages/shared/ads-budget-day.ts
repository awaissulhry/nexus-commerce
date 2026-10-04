/**
 * ads-budget-day.ts — WHEN AN AMAZON ADS BUDGET DAY STARTS. The one definition.
 *
 * 3d (2026-10-04; review G.6, I.2, N2, Owner decision D2): **the budget day runs 00:00–24:00 UTC, in every
 * marketplace.** Amazon's guide says a daily budget resets at "midnight" and names no zone; the profiles report
 * Europe/Paris. The account's own data says UTC — measured on production 2026-08-22 over 301 campaign-days
 * (`ads-budget-usage.service.ts`): hourly spend summed from 00:00 UTC matched Amazon's daily report on 298
 * (EUR 1.03 total error), summed from local midnight on 204 (EUR 46.74), and the budget-usage reading agreed.
 *
 * Every place that asks "which budget day is this?" reads it here: the write gate's day-move bound and spend
 * ceilings, the budget-usage hours, the pacer's day of the month, a budget schedule's date range and its all-day
 * windows, and the schedules screen's Status pill. A schedule's timed windows (18:00–22:00) are clock hours in the
 * schedule's own time zone and do NOT come from here.
 *
 * `marketplace` does not change the answer today. It is in the signature so every caller says which market it
 * asks for: if Amazon ever resets a market at local midnight, this file changes and the callers do not.
 * Re-check after the 2026-10-25 clock change: the boundary should move from 02:00 to 01:00 Rome time.
 */

/** The start of the budget day that `at` falls in: 00:00 UTC on `at`'s UTC date. */
export function budgetDayStart(at: Date, marketplace?: string | null): Date {
  void marketplace // the same boundary in every market (see the header)
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** The budget day that `at` falls in, as `YYYY-MM-DD`. */
export function budgetDayKey(at: Date, marketplace?: string | null): string {
  const d = budgetDayStart(at, marketplace)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
