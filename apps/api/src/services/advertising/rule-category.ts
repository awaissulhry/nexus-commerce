/**
 * ACR.7 — the rule category taxonomy: colour instead of emoji.
 *
 * Operator decision 2026-08-05: emojis in rule names read as unprofessional; grouping is
 * carried by CATEGORY COLOUR instead. One derivation, server-side, so the dock, the rules
 * tabs and the cockpit can never colour the same rule two different ways.
 *
 * Derived from what the rule DOES (its action types), matching the action-type map the
 * Rules & Automation tabs already filter by — a rule appearing under the Bid tab is coloured
 * as a bid rule, by construction. First category to claim any of the rule's actions wins,
 * ordered by how consequential the action family is.
 */

export type RuleCategory = 'bid' | 'budget' | 'harvest' | 'negative' | 'placement' | 'guard' | 'alert' | 'other'

/** Presentation constants — hex lives here so every surface renders the identical swatch. */
export const RULE_CATEGORY_META: Record<RuleCategory, { label: string; color: string }> = {
  bid: { label: 'Bids', color: '#1f6fde' }, // blue — moves what a click costs
  budget: { label: 'Budget', color: '#b8860b' }, // amber — moves how much a day may spend
  harvest: { label: 'Harvest', color: '#14724d' }, // green — grows the keyword set
  negative: { label: 'Negation', color: '#b3352f' }, // red — removes targeting
  placement: { label: 'Placement', color: '#7c4dbe' }, // purple — moves where ads appear
  guard: { label: 'Protection', color: '#0f766e' }, // teal — stops something bad
  alert: { label: 'Alerts', color: '#64748b' }, // slate — informs, never writes
  other: { label: 'Other changes', color: '#a21caf' }, // magenta — writes, but not one of the families above
}

/**
 * RA.2 — actions that never reach Amazon. Everything else is a write of some kind,
 * and the distinction is what keeps `alert` honest (see the fallback below).
 */
const NON_WRITING_ACTIONS = new Set(['notify', 'alert_operator', 'log_only'])

const CATEGORY_ACTIONS: Array<[RuleCategory, string[]]> = [
  ['negative', ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'archive_keyword']],
  ['harvest', ['promote_to_exact']],
  ['budget', ['adjust_ad_budget', 'budget_apply', 'shift_budget']],
  // RA.2 — `refresh_dayparting` rewrites the dayparting plan the engine turns into
  // hour-window bid multipliers, which is the same family as rank-defense already here.
  ['placement', ['set_placement_multiplier', 'defend_top_of_search', 'raise_bids_for_rank_defense', 'refresh_dayparting']],
  // RA.2 — `pause_ad_group` and `pause_all_campaigns` suppress spend exactly as
  // `pause_campaign` does; they differ only in blast radius, not in kind.
  ['guard', ['retail_guard', 'pause_campaign', 'pause_ads_for_product', 'pause_target', 'pause_ad_group', 'pause_all_campaigns']],
  ['bid', ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'set_bid']],
]

/**
 * RA.2 — the fallback used to be a flat `return 'alert'`, and `alert`'s own definition
 * is "informs, never writes".
 *
 * Measured on prod 2026-08-10 (`scripts/_ra2-category.mts`): **8 of 51 rules were
 * labelled Alerts while carrying a writing action** — among them "Monthly spend cap
 * (pause everything)" and "Monthly budget cap", whose action is `pause_all_campaigns`,
 * the largest blast radius in the system. Four writing action types had no mapping at
 * all: `pause_ad_group`, `refresh_dayparting`, `pause_all_campaigns`,
 * `create_amazon_promotion`.
 *
 * All eight happened to be OFF, so nothing had acted on the mislabel — but the colour is
 * exactly what an operator scans to decide what is safe to arm, and slate said "this one
 * cannot touch anything". Mapping the first three above fixes them by family; the fallback
 * fixes the CLASS, so the next unmapped write cannot inherit the same lie.
 */
export function ruleCategory(actionTypes: string[]): RuleCategory {
  for (const [cat, actions] of CATEGORY_ACTIONS) {
    if (actionTypes.some((t) => actions.some((a) => t === a || t.startsWith(`${a}:`)))) return cat
  }
  // Unmapped, but it writes → say so rather than filing it with the things that don't.
  if (actionTypes.some((t) => t && !NON_WRITING_ACTIONS.has(t))) return 'other'
  return 'alert'
}
