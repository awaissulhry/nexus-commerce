/**
 * HV.6 — the actors. NOT BUILT YET.
 *
 * The 5 rules carrying a harvest action, plus `ads-auto-harvest`, plus you, as ONE list — because
 * the page's structural finding is that they were not treated as one.
 *
 * Every RULE carrying `promote_to_exact` or `harvest_and_negate` is capped at PROPOSE by
 * `ads-graduation.ts`, whose own comment says these actions "may not run unattended". The ENGINE
 * doing the identical thing had no ceiling, no mode, no scope and no row on any surface — until
 * HV.0 armed it down behind `NEXUS_ADS_AUTO_HARVEST_ARMED` on 2026-08-12.
 *
 * What it must NOT own: the mode dial, the ceiling control, the conflict detector. Automations
 * owns all of them (§11 C1, C2, C3, C6). This section CONSUMES them and must resolve every actor
 * name through the shared registry (§11 C8) — `Rank & Dayparting`, never `ad-rank-defend`, never
 * `automation:rank-defend-cmr2693xx…`. Three pages describe the same engine today and none names
 * it the same way.
 *
 * ⚠ It must also carry the four words (§11 C7): **acted · proposed · refused · failed.** No
 * percentage may merge them. And it must not render a daily cap as a live brake:
 * `maxExecutionsPerDay` is NOT enforced (`automation-rule.service.ts:568` — `NOT: { errorMessage }`
 * is NULL, not TRUE, for the null every SUCCESS row carries), and the 693,704 `DAILY_CAP_EXCEEDED`
 * rows are historical residue with nothing newer than 2026-08-03.
 *
 * ⚠ And it must not repeat the engine's own overstatement: `neg=8/8 grad=14/14` counts candidates
 * PROCESSED, not writes MADE. Measured 2026-08-12: 6 log rows in 30 days against ~12 such nights.
 *
 * Renders null. Hidden, not disabled.
 */
import type { HvSlotProps } from './slot-contract'

export function HvActors(_props: HvSlotProps) {
  return null
}
