/**
 * HV.8 — the rule-path repairs. **A MARKER, NOT A UI SECTION.**
 *
 * This file renders null and always will. It exists so the repairs have a home in the same list as
 * the other seven, and so nobody has to rediscover them from the study. Every one is backend work
 * on files HV.1 was explicitly forbidden to touch.
 *
 *   1. 🔴 **The auto-targeting blind spot, on the RULE path.** HV.1 repaired it for the READ only.
 *      `advertising-rule-evaluator.job.ts:685` still filters
 *      `matchType IN ('BROAD','PHRASE') OR matchType IS NULL`, with a comment explaining the null
 *      branch as "auto-targeting, no match type" — and **not one row in this account has a NULL
 *      matchType.** Auto campaigns carry `TARGETING_EXPRESSION_PREDEFINED`, product targeting
 *      carries `TARGETING_EXPRESSION`: 2,798 rows and 26 orders, structurally invisible to
 *      `promote_to_exact`. One array literal.
 *   2. 🔴 **The adapter drops six of the eleven metrics the builder offers.**
 *      `ads-rule-adapter.service.ts`'s `SEARCHTERM_METRIC` map holds five (Orders, PPC Orders,
 *      Clicks, Spend, Sales); `translateConditions` logs a warning and `continue`s on ACOS, ROAS,
 *      Impressions, CVR, CTR and CPC — all reachable from the UI today. **Dropping an
 *      AND-condition makes the rule LOOSER, not stricter:** "PPC Orders ≥ 2 AND ACoS ≤ 25%"
 *      executes as "PPC Orders ≥ 2", and the ACoS ceiling is the one condition standing between
 *      harvesting and buying unprofitable traffic. Map them, or refuse the rule at save time.
 *   3. **Delete the `bidEur` overrides** at `automation-action-handlers.ts:904/906/1034` — CPC
 *      inheritance already exists in `applyHarvest` and the constants defeat it. See HvPromote.
 *   4. **Give the standalone rule a `destinations` map**, and with it the H.3 isolation negative.
 *      See HvDestination: promoting into the source and not negating the source are ONE defect.
 *   5. **Record whether a write reached Amazon** — `createKeywordLocal` must not report success
 *      for a local-only row. 209 of 218 engine graduations did.
 *   6. **Give `harvest_and_negate` a real `proposedKey`** — 18 duplicate cards collapse to 2.
 *   7. **Reconcile the two engines' windows and latency skip.** 60 days with no latency skip vs
 *      30 days with the provisional tail excluded; one concept, two answers, five bid constants.
 *
 * Explicitly NOT here, because other sessions own them: the builder Preview's response keys, the
 * daily-cap counter, the `ads-console` HarvestTab's inert Apply button, and the one-time cleanup
 * of the 206 duplicate + 54 ASIN-as-keyword rows (which needs repair 5's reached-Amazon flag
 * first, or the rows cannot be told apart from real ones).
 */
import type { HvSlotProps } from './slot-contract'

export function HvRepairs(_props: HvSlotProps) {
  return null
}
