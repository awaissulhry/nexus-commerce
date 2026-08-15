/**
 * HV.8 — the rule-path repairs. **A MARKER, NOT A UI SECTION.**
 *
 * This file renders null and always will. It exists so the repairs have a home in the same list as
 * the other seven, and so nobody has to rediscover them from the study. Every one is backend work
 * on files HV.1 was explicitly forbidden to touch.
 *
 *   1. ✅ CLOSED (HV.8c) — the auto-targeting blind spot on the RULE path: the evaluator's
 *      search-term filter now includes TARGETING_EXPRESSION / TARGETING_EXPRESSION_PREDEFINED
 *      alongside BROAD/PHRASE, with the null branch kept and the reason documented in place.
 *   2. ✅ CLOSED (Phase 2 of the 2026-08-15 finish programme) — `ads-rule-adapter.service.ts` now
 *      maps ALL eleven builder metrics, and an untranslatable condition REFUSES the save
 *      (`untranslatable_conditions`, metrics named) instead of logging and dropping — a dropped
 *      AND-condition made the rule looser. Pinned by `ads-rule-adapter.vitest.test.ts`.
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
