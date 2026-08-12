/**
 * HV.7 — the harvest suggestions. NOT BUILT YET.
 *
 * The harvest rows filtered out of the SECTION'S ONE INBOX. 🔴 §11 C10: Negative Targeting,
 * Keyword Harvest and Bid all queue `AdsRuleSuggestion` rows; they FILTER the one inbox, they do
 * not build their own. One dedupe key, one expiry policy, one applied-vs-applied-with-edit
 * distinction — because the graduation model reads that distinction and three implementations
 * would disagree about it.
 *
 * The 23 harvest suggestions split cleanly by defect (measured 2026-08-12):
 *   · `promote_to_exact` — 5 rows, 5 distinct queries. **Correct.** The dedupe key
 *     (ruleId, entityId, proposedKey) collapses 300 executions into one card per term.
 *   · 🔴 `harvest_and_negate` — 18 rows: 9 identical cards from "Auto harvest & negate" and 9
 *     identical from "Daily automation digest", all the same day, all proposing the same
 *     account-wide sweep. `proposedKey` is the bare action type and a sweep action has no
 *     `entityId`, so **the dedupe key cannot collapse an action whose scope is the whole account.**
 *
 * 🔴 The dependency this section exists to clear: **an engine on PROPOSE cannot queue a
 * suggestion.** `AdsRuleSuggestion` requires a `ruleId` and `ads-auto-harvest` has none, so HV.0's
 * propose-only is NOTIFY-only until this section gives engines a queue row. That is the stated,
 * accepted cost of HV.0 and it is this section's job to end it.
 *
 * ⚠ Context for whoever builds it: 225 pending, **1 applied ever**, median age 5 days, max 51.
 * A queue nobody works is not an inbox.
 *
 * Renders null. Hidden, not disabled.
 */
import type { HvSlotProps } from './slot-contract'

export function HvQueue(_props: HvSlotProps) {
  return null
}
