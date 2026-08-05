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

export type RuleCategory = 'bid' | 'budget' | 'harvest' | 'negative' | 'placement' | 'guard' | 'alert'

/** Presentation constants — hex lives here so every surface renders the identical swatch. */
export const RULE_CATEGORY_META: Record<RuleCategory, { label: string; color: string }> = {
  bid: { label: 'Bids', color: '#1f6fde' }, // blue — moves what a click costs
  budget: { label: 'Budget', color: '#b8860b' }, // amber — moves how much a day may spend
  harvest: { label: 'Harvest', color: '#14724d' }, // green — grows the keyword set
  negative: { label: 'Negation', color: '#b3352f' }, // red — removes targeting
  placement: { label: 'Placement', color: '#7c4dbe' }, // purple — moves where ads appear
  guard: { label: 'Protection', color: '#0f766e' }, // teal — stops something bad
  alert: { label: 'Alerts', color: '#64748b' }, // slate — informs, never writes
}

const CATEGORY_ACTIONS: Array<[RuleCategory, string[]]> = [
  ['negative', ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'archive_keyword']],
  ['harvest', ['promote_to_exact']],
  ['budget', ['adjust_ad_budget', 'budget_apply', 'shift_budget']],
  ['placement', ['set_placement_multiplier', 'defend_top_of_search', 'raise_bids_for_rank_defense']],
  ['guard', ['retail_guard', 'pause_campaign', 'pause_ads_for_product', 'pause_target']],
  ['bid', ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'set_bid']],
]

export function ruleCategory(actionTypes: string[]): RuleCategory {
  for (const [cat, actions] of CATEGORY_ACTIONS) {
    if (actionTypes.some((t) => actions.some((a) => t === a || t.startsWith(`${a}:`)))) return cat
  }
  return 'alert'
}
