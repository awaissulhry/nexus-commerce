/**
 * ADX N3 — how far a rule is allowed to be trusted.
 *
 * The dial (N2) lets an operator move a rule up a notch. This decides how far up it may
 * go at all, and why. Without it, "set everything to AUTO" is one bulk action away, and
 * the rules that should never be automatic are indistinguishable from the ones that
 * should.
 *
 * The line comes from the market, where it is unusually consistent:
 *
 *   Automatic, within bounds — bids on mature campaigns, search-term negations under
 *   clear criteria, budget rebalancing within limits.
 *   Always gated — new campaign creation, structural restructuring.
 *
 * The reasoning behind that line is Quartile's documented failure mode: automation
 * should leave behind a structure a human could still run by hand. A bid is a number
 * that moves and moves back. A campaign, keyword or negative is a thing that now exists
 * and must be reaped by someone. Creation is where automation stops being reversible.
 *
 * Two things this deliberately does NOT do. It does not decide whether a rule is a good
 * idea — a badly-conditioned bid rule is still allowed to reach AUTO, because that is a
 * judgement about evidence, which is what the accountability strip is for. And it does
 * not bound the blast radius; the write gate and `maxExecutionsPerDay` do that.
 */

import type { AutonomyLevel } from './ads-autonomy.js'

/**
 * Actions that move a number the engine can move back. Reversible, bounded by the write
 * gate, and the ones the market agrees should run unattended.
 */
const REVERSIBLE_ACTIONS = new Set([
  'bid_to_target_acos',
  'bid_up',
  'bid_down',
  'lower_bid_to_floor',
  'raise_bids_for_rank_defense',
  'adjust_ad_budget',
  'set_placement_multiplier',
  'defend_top_of_search',
  'refresh_dayparting',
  'retail_guard',
  'archive_keyword_restore',
])

/**
 * Actions that CREATE or DESTROY something. Each needs a retirement path designed
 * alongside it, and none has one yet, so none may run unattended.
 *
 * `promote_to_exact` creates a keyword. `add_negative_exact` and
 * `sync_negatives_across_campaigns` create negatives, which are the hardest thing in an
 * ads account to notice later and the easiest to regret. `archive_keyword` destroys
 * history. Pausing is here because this account's house rule is to suppress with a 2c
 * bid rather than pause at all — a rule that pauses is doing something the operator has
 * said not to do.
 */
const STRUCTURAL_ACTIONS = new Set([
  'promote_to_exact',
  'add_negative_exact',
  'add_negative_phrase',
  'sync_negatives_across_campaigns',
  'harvest_and_negate',
  'archive_keyword',
  'pause_campaign',
  'pause_ad_group',
  'pause_all_campaigns',
  'create_amazon_promotion',
])

/** Actions that only tell someone something. Harmless at any level. */
const NOTIFY_ACTIONS = new Set(['notify', 'alert_operator', 'log_only'])

export interface GraduationInput {
  /** Action types on the rule. */
  actionTypes: string[]
  /** True when at least one protected term exists — see the negation gate below. */
  hasKeywordProtections: boolean
}

export interface GraduationVerdict {
  /** The highest level this rule may be set to. */
  maxLevel: AutonomyLevel
  /** Why, in a sentence an operator can act on. */
  reason: string
  /** The action types responsible for the ceiling, when there is one. */
  blockedBy: string[]
}

/**
 * Decide the ceiling.
 *
 * A rule is judged by its most dangerous action: a rule that adjusts a bid AND creates a
 * negative is a structural rule, because the negative is the part that cannot be undone
 * by moving a number back.
 */
export function graduationCeiling(input: GraduationInput): GraduationVerdict {
  const acts = input.actionTypes.filter((t) => !NOTIFY_ACTIONS.has(t))

  if (acts.length === 0) {
    return { maxLevel: 'AUTO', reason: 'Only notifies — nothing to gate.', blockedBy: [] }
  }

  const structural = acts.filter((t) => STRUCTURAL_ACTIONS.has(t))
  if (structural.length > 0) {
    // The negation family is the one case with a precondition rather than a hard ceiling:
    // negating is reversible IF the terms you must never negate are written down first.
    const onlyNegations = structural.every((t) =>
      t === 'harvest_and_negate' || t === 'add_negative_exact' || t === 'add_negative_phrase',
    )
    if (onlyNegations && !input.hasKeywordProtections) {
      return {
        maxLevel: 'PROPOSE',
        reason: 'Negates search terms and no protected terms are configured — add a whitelist first, or a brand term can be negated with nothing to stop it.',
        blockedBy: structural,
      }
    }
    if (onlyNegations) {
      return {
        maxLevel: 'PROPOSE',
        reason: 'Creates negatives. A negative is the hardest thing in an account to notice later; this stays gated until a retirement path exists for them.',
        blockedBy: structural,
      }
    }
    return {
      maxLevel: 'PROPOSE',
      reason: 'Creates or destroys entities. Automation should leave behind a structure a human could still run by hand.',
      blockedBy: structural,
    }
  }

  const unknown = acts.filter((t) => !REVERSIBLE_ACTIONS.has(t))
  if (unknown.length > 0) {
    // Default-deny: an action nobody has classified is not assumed safe.
    return {
      maxLevel: 'PROPOSE',
      reason: `Unclassified action${unknown.length > 1 ? 's' : ''} — classify in ads-graduation.ts before trusting this unattended.`,
      blockedBy: unknown,
    }
  }

  return { maxLevel: 'AUTO', reason: 'Adjusts values the engine can move back, inside the write gate’s bounds.', blockedBy: [] }
}

const ORDER: AutonomyLevel[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']

/** True when `wanted` is at or below the ceiling. */
export function isLevelAllowed(wanted: AutonomyLevel, ceiling: AutonomyLevel): boolean {
  return ORDER.indexOf(wanted) <= ORDER.indexOf(ceiling)
}
