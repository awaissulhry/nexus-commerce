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
import { BUILDER_SLUG_ACTIONS } from './ads-rule-adapter.service.js'
import { stopWasteCeiling } from './ads-graduation-stopwaste.js'

/**
 * Actions that move a number the engine can move back. Reversible, bounded by the write
 * gate, and the ones the market agrees should run unattended.
 *
 * P2.4 — the `*_apply` family is the builder-rule execution vocabulary (what the adapter
 * translates a slug into): value moves with `payloadBefore` recorded, same reversibility class
 * as their engine-native cousins above.
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
  'budget_apply',
  'bid_apply',
  'placement_apply',
])

/**
 * 1f — floors bids for a time window and restores them after (it no longer pauses). Not reversible
 * enough for AUTO yet: if its rule is switched off or deleted inside a pause window, nothing gives the
 * bids back (review 3.2). It may PROPOSE until that restore exists.
 */
const WINDOW_FLOOR_ACTIONS = new Set(['dayparting_apply'])

/**
 * Actions that CREATE or DESTROY something. Each needs a retirement path designed
 * alongside it, and none has one yet, so none may run unattended.
 *
 * `promote_to_exact` creates a keyword. `add_negative_exact` and
 * `sync_negatives_across_campaigns` create negatives, which are the hardest thing in an
 * ads account to notice later and the easiest to regret. `archive_keyword` destroys
 * history.
 *
 * 🔴 C2 (2026-08-20) — WHY PAUSING IS STILL HERE, now that it is allowed.
 *
 * Until today the reason was "the operator has said not to do it": the house rule is to suppress
 * with a 2¢ bid so Amazon keeps its learning state. That is no longer accurate for TARGETS. The
 * operator's H10 study lists Pause/Unpause Target as rule actions and they chose the literal verbs
 * over the suppression equivalent, so `pause_target` / `enable_target` exist and are theirs to use.
 *
 * They stay capped anyway, and for a better reason than policy: **a paused target re-enters
 * Amazon's learning phase when it is unpaused.** That is a real, delayed cost that no condition in
 * the builder can see and no execution log will attribute back — exactly the shape of consequence
 * this ceiling exists for. So a pausing rule PROPOSES and a human accepts it, which is one click
 * and a decision rather than a silent status change.
 *
 * `enable_target` is capped for symmetry, not for danger: unpausing is the recovery from a pause,
 * and a recovery that can act on its own while the action it recovers from cannot is a trap.
 * Campaign- and ad-group-level pausing is unchanged and remains house-rule forbidden.
 */
const STRUCTURAL_ACTIONS = new Set([
  'promote_to_exact',
  'add_negative_exact',
  'add_negative_phrase',
  'sync_negatives_across_campaigns',
  'harvest_and_negate',
  // PB-7 — a playbook's isolation negatives: one product's own campaigns only, still negatives (PROPOSE).
  'isolate_product_terms',
  'archive_keyword',
  'pause_campaign',
  'pause_ad_group',
  'pause_all_campaigns',
  'pause_target',
  'enable_target',
  'create_amazon_promotion',
])

/**
 * D2 (Owner 2026-10-10, Keyword Harvest page) — the harvest family: a harvest rule may run on Auto, INSIDE ITS CAPS
 * (HARVEST_RULE_CAPS, enforced where its harvest writes: ads-harvest.service.ts applyHarvest): at most so many new
 * keywords a day per rule, only into the product's own campaigns (never a shared or another product's campaign), and
 * never a new campaign (a new campaign is always a person's: the Keyword Harvest page or an approved request). Its source
 * negatives keep the negation family's precondition: protected terms written down first.
 * The builder's keyword-harvesting slug expands to promote_to_exact + add_negative_exact (its source block): the same
 * family when they come together.
 */
const HARVEST_ACTIONS = new Set(['harvest_and_negate', 'promote_to_exact'])

/** D2 — the caps a harvest rule runs inside on Auto (Owner 2026-10-10). */
export const HARVEST_RULE_CAPS = Object.freeze({
  /** New keywords (and product targets) one rule creates a day (UTC), across its products. */
  keywordsPerDay: Math.max(0, Number(process.env.NEXUS_HARVEST_RULE_KEYWORDS_PER_DAY ?? 10) || 0),
  /** New campaigns a rule may create a week: none (a new campaign is a person's). */
  campaignsPerWeek: 0,
  /** Only into the product's own campaigns (brain/ownership.ts: a campaign that advertises that product alone). */
  ownCampaignsOnly: true,
})

/** Actions that only tell someone something. Harmless at any level. */
const NOTIFY_ACTIONS = new Set(['notify', 'alert_operator', 'log_only'])

export interface GraduationInput {
  /** Action types on the rule. */
  actionTypes: string[]
  /** True when at least one protected term exists — see the negation gate below. */
  hasKeywordProtections: boolean
  /**
   * The rule's actions (as stored, or as translated for this run). Only with them can the Negative Targeting page's
   * stop-waste rule be told apart (D1, ads-graduation-stopwaste.ts); without them the ceiling answers as before.
   */
  actions?: unknown
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
  // P2.4 — a stored builder rule carries its SLUG as the action type; the engine translates it
  // at evaluation. Judge the rule by what it will actually DO: expand each slug into its
  // translated action types (BUILDER_SLUG_ACTIONS lives beside the translation, so the two
  // cannot drift). Before this, every builder slug fell into the unclassified default-deny —
  // safe, but the reason said "classify me" instead of naming the real ceiling, and a
  // negation-slug rule was not recognised as the negation family the whitelist gate exists for.
  const expanded = input.actionTypes.flatMap((t) => BUILDER_SLUG_ACTIONS[t] ?? [t])
  const acts = expanded.filter((t) => !NOTIFY_ACTIONS.has(t))

  if (acts.length === 0) {
    return { maxLevel: 'AUTO', reason: 'Only notifies — nothing to gate.', blockedBy: [] }
  }

  // D1 (Negative Targeting, Owner 2026-10-10) — the page's stop-waste rule (its test, a pause kept paused, or a negative
  // exact in the ad group) may be set to Auto; each change it makes alone is capped in the evaluator (ads-graduation-stopwaste.ts).
  const stopWaste = stopWasteCeiling(acts, input.actions)
  if (stopWaste) return stopWaste

  const structural = acts.filter((t) => STRUCTURAL_ACTIONS.has(t))
  // D2 — a harvest rule (only harvest actions, with the builder's source block) may reach Auto inside its caps.
  const harvestFamily = structural.some((t) => HARVEST_ACTIONS.has(t))
    && structural.every((t) => HARVEST_ACTIONS.has(t) || t === 'add_negative_exact')
    && acts.every((t) => HARVEST_ACTIONS.has(t) || t === 'add_negative_exact')
  if (harvestFamily) {
    // A harvest_and_negate rule that also blocks terms that waste spend (no `mode: 'harvest'`): only its harvest half is
    // D2's; the blocking half has no Auto of its own here, so the rule asks.
    const wasteHalf = (Array.isArray(input.actions) ? input.actions : []).some((a) => (a as { type?: unknown } | null)?.type === 'harvest_and_negate' && (a as { mode?: unknown }).mode !== 'harvest')
    if (wasteHalf) {
      return {
        maxLevel: 'PROPOSE',
        reason: 'It also blocks terms that waste spend: only a rule that adds keywords alone runs on Auto (D2); this one asks.',
        blockedBy: ['harvest_and_negate'],
      }
    }
    if (!input.hasKeywordProtections) {
      return {
        maxLevel: 'PROPOSE',
        reason: 'Harvests and blocks the source, and no protected terms are configured — add a whitelist first, or a brand term can be blocked with nothing to stop it.',
        blockedBy: structural,
      }
    }
    return {
      maxLevel: 'AUTO',
      reason: `Harvests inside its caps on Auto: at most ${HARVEST_RULE_CAPS.keywordsPerDay} new keywords a day, only into the product's own campaigns, never a new campaign (D2).`,
      blockedBy: [],
    }
  }
  if (structural.length > 0) {
    // The negation family is the one case with a precondition rather than a hard ceiling:
    // negating is reversible IF the terms you must never negate are written down first.
    const onlyNegations = structural.every((t) =>
      t === 'harvest_and_negate' || t === 'add_negative_exact' || t === 'add_negative_phrase' || t === 'isolate_product_terms',
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

  const windowFloors = acts.filter((t) => WINDOW_FLOOR_ACTIONS.has(t))
  if (windowFloors.length > 0) {
    return {
      maxLevel: 'PROPOSE',
      reason: 'Lowers bids for a time window. If the rule is removed inside a window, nothing gives the bids back yet, so a person accepts each change.',
      blockedBy: windowFloors,
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
