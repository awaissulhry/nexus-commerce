/**
 * HV.3 — the destination resolver and picker. NOT BUILT YET.
 *
 * Where a graduated keyword actually goes, per source ad group, plus the match-type matrix.
 *
 * The structure to promote INTO already exists: 72 EXACT ad groups, 61 PHRASE, 58 BROAD, 40 AUTO
 * across 161 manual and 39 auto campaigns. `applyHarvest` already accepts a `destinations` map and
 * honours it (H.2) — and **only the wizard ever populates it.** The standalone rule and the cron
 * both pass `undefined`, which falls back to the source ad group.
 *
 * 🔴 The finding this section exists to fix, and it is one defect rather than two: in
 * `applyHarvest` the H.3 isolation negative fires ONLY when a `destinations` map moved the keyword
 * elsewhere (`promotedElsewhere`). So "promoted into the source ad group" and "did not negate the
 * source" are the same bug. A destination picker that cannot offer an auto campaign is what makes
 * the funnel loop structurally impossible — steal SellerApp's restriction to manual
 * keyword-targeted campaigns.
 *
 * What it must NOT own: the write itself. HV.4 owns that, and takes the destination from here.
 *
 * Renders null. Hidden, not disabled.
 */
import type { HvSlotProps } from './slot-contract'

export function HvDestination(_props: HvSlotProps) {
  return null
}
