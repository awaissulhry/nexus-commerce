/**
 * HV.5 — did the last batch work? NOT BUILT YET.
 *
 * The second half of this page's question, and **the thing no competitor ships** — because none
 * of them owns the write path, the performance table and the audit log at once. We own all three.
 *
 * The join is measured and works: `AmazonAdsDailyPerformance` where `entityType = 'AD_TARGET'`,
 * joined on `localEntityId`, 6,356 of 8,000 rows (79%) resolve to a positive keyword and 443
 * distinct keywords have a performance row. Over the whole 2,129-keyword population: 439 (21%)
 * took an impression after creation, €2,837.28 spend / €8,806.39 sales, cohort ACoS 32%.
 *
 * The engine's own 218, isolated: 9 reached Amazon, 6 of those took impressions — 135,007
 * impressions · €167.00 · €913.06 · 11 orders → **18% ACoS against a 32% cohort average.**
 * Harvesting works in this account when the keyword actually gets there. Nine keywords is thin
 * evidence and this section must not claim more than it carries.
 *
 * 🔴 Two laws it inherits:
 *   · **Never read `AdTarget.impressions/clicks/spendCents/salesCents/ordersCount`** — measured 0
 *     on all 5,213 rows. A surface reading them renders a zero for every keyword in the account.
 *   · Performance rows begin 2026-07-05, so keywords created before that have no measurable
 *     "after" and must render **`not measurable`**, never a zero. That is one of the four empty
 *     states, and "never ran" and "nothing to do" must never render the same (doctrine D4).
 *
 * Renders null. Hidden, not disabled.
 */
import type { HvSlotProps } from './slot-contract'

export function HvCohort(_props: HvSlotProps) {
  return null
}
