/**
 * HV.4 — the paired write. NOT BUILT YET.
 *
 * Promote a candidate AND negate it at source, as ONE transaction. Not two buttons, not two
 * confirmations: `applyHarvest` couples them already (see HvDestination's header) and a UI that
 * separated them would let an operator ship half a funnel.
 *
 * What it inherits from the study and must fix on the way through:
 *
 *   · **The five bid constants for one decision.** `promote_to_exact` 0.50 and
 *     `harvest_and_negate` 0.50 at `automation-action-handlers.ts:904/906` and `:1034`; the
 *     adapter's "suggested" 0.75 at `ads-rule-adapter.service.ts:187`; the templates' 0.60 and
 *     0.65 in `automation-templates.ts`. `applyHarvest` ALREADY implements CPC inheritance —
 *     `bidEur ?? (clicks > 0 ? max(0.05, costCents/clicks/100) : 0.5)` — and every caller defeats
 *     it by always passing a value. Against the account's own evidence the observed CPC median is
 *     €0.46, so €0.50 overpays on 60% of candidates, €0.60 on 90%, €0.65 on 92%, €0.75 on 93%.
 *     **"Inherit the bid" is not a build; it is deleting an argument at three call sites.**
 *   · **The clamp must be visible.** `Campaign.maxBidCents` is IT €0.80 · DE €1.90 · ES €0.90 and
 *     `minBidCents` is unset on every campaign the candidates live in. Two of today's candidates
 *     have observed CPCs of €1.26 and €1.69, above the IT ceiling. A CPC-inherited bid must expect
 *     to be clamped and say so BEFORE it writes.
 *   · **Never propose what already exists.** At the default threshold 0 of 14 keyword candidates
 *     are new. The grid states it; this section must refuse to act on it.
 *   · **D5 — a term the negation base already blocks.** 9 of 17 candidates are already negated
 *     somewhere; `giacca moto` in 72 rows, 16 of them live and confirmed at Amazon. HV.1 shows the
 *     flag; HV.4 decides what refusing looks like.
 *   · **Record whether the write reached Amazon.** 209 of 218 engine graduations reported success
 *     and do not exist at Amazon, because `createKeywordLocal` writes the local row and the audit
 *     row either way and `applyHarvest` increments `keywordsGraduated` regardless.
 *
 * What it must NOT own: the negatives inventory or the retirement path — a promotion's isolation
 * negative is created here and LISTED in Negative Targeting (session 7). That link does not exist
 * in `applyHarvest` today and is a hard dependency, not a preference.
 *
 * Renders null. Hidden, not disabled — and note that HV.1 deliberately ships with NO disabled
 * approve/reject control rather than a greyed one that will never enable.
 */
import type { HvSlotProps } from './slot-contract'

export function HvPromote(_props: HvSlotProps) {
  return null
}
