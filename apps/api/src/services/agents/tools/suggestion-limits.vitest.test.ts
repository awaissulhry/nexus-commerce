/**
 * ADS AUTONOMY W2 (AA-W2-10) — decide-automation-suggestions by rule, pure (suggestion-limits.ts). Values and names are
 * made up (public repo). The reads (the rows, the strategy, the change set) run on PGlite in decide-suggestions.vitest.test.ts.
 *
 *   measured   the bid, budget and placement an apply would set, as the rule's own handler computes it: the same
 *              defaults, the budget's baseline anchor, the rule's own min and max; a computed bid, a starting bid that
 *              follows the cost per click, or an unknown op cannot be measured (null)
 *   limits     every raise and a new keyword's starting bid default to 0; cuts to the strategy; named so tightening stays
 *              a free brake
 *   refusals   eBay, no facts, the request's size, an apply Nexus cannot measure, and each family's limit: each can refuse
 *              and each can pass, after the kit's own checks
 */
import { describe, expect, it } from 'vitest'
import { limitsTighten } from '../claude-trust.service.js'
import { LIMIT_FACTS_VERSION, type LimitFacts } from './ads-autonomy-kit.js'
import { SUGGESTION_LIMITS, appliedBidCents, appliedBudgetCents, appliedPlacementPct, startBidCents, suggestionRefusal, type SuggestionRuleFacts } from './suggestion-limits.js'

describe('what an apply would set, as its handler computes it', () => {
  it('bids: the handlers\' defaults and floor, the rule\'s own min and max; a computed bid is not known before it runs', () => {
    expect(appliedBidCents({ type: 'bid_down' }, 100)).toBe(80) // 20 % by default
    expect(appliedBidCents({ type: 'bid_down', percent: 10 }, 100)).toBe(90)
    expect(appliedBidCents({ type: 'bid_up' }, 100)).toBe(115) // 15 % by default: never read as "no change"
    expect(appliedBidCents({ type: 'bid_down', percent: 90 }, 20)).toBe(5) // the 5-cent floor
    expect(appliedBidCents({ type: 'lower_bid_to_floor' }, 100)).toBe(5)
    expect(appliedBidCents({ type: 'bid_apply', op: 'set', value: 0.42 }, 100)).toBe(42)
    expect(appliedBidCents({ type: 'bid_apply', op: 'incPct', value: 50, maxEur: 1.2 }, 100)).toBe(120)
    expect(appliedBidCents({ type: 'bid_apply', op: 'decAbs', value: 0.9, minEur: 0.3 }, 100)).toBe(30)
    expect(appliedBidCents({ type: 'bid_apply', op: 'targetAcos', value: 30 }, 100)).toBeNull()
    expect(appliedBidCents({ type: 'raise_bids_for_rank_defense' }, 100)).toBeNull()
  })

  it('budgets: a relative change anchors to the captured baseline, as the handler does (a cut of the current can be a raise)', () => {
    const anchored = { dailyBudgetCents: 1000, baselineCents: 2000 }
    expect(appliedBudgetCents({ type: 'budget_apply', op: 'decPct', value: 10 }, anchored)).toBe(1800) // up from 10.00, not down to 9.00
    expect(appliedBudgetCents({ type: 'budget_apply', op: 'decPct', value: 10 }, { dailyBudgetCents: 1000, baselineCents: null })).toBe(900)
    expect(appliedBudgetCents({ type: 'budget_apply', op: 'incPct', value: 50, maxEur: 12 }, { dailyBudgetCents: 1000, baselineCents: null })).toBe(1200)
    expect(appliedBudgetCents({ type: 'budget_apply', op: 'set', value: 0.5 }, anchored)).toBe(100) // Amazon's 1.00 floor
    expect(appliedBudgetCents({ type: 'adjust_ad_budget', percent: 20 }, anchored)).toBe(2400)
    expect(appliedBudgetCents({ type: 'adjust_ad_budget', newDailyBudget: 7 }, anchored)).toBe(700)
    expect(appliedBudgetCents({ type: 'set_daily_budget', budgetEur: 15 }, anchored)).toBe(1500)
    expect(appliedBudgetCents({ type: 'set_daily_budget', budgetEur: 0.5 }, anchored)).toBeNull() // refused by its handler
    expect(appliedBudgetCents({ type: 'reroute_marketplace_budget' }, anchored)).toBeNull()
  })

  it('placements and new keywords', () => {
    expect(appliedPlacementPct({ type: 'placement_apply', op: 'incAbs', value: 30, maxPct: 40 }, 20)).toBe(40)
    expect(appliedPlacementPct({ type: 'placement_apply', op: 'decPct', value: 50 }, 60)).toBe(30)
    expect(appliedPlacementPct({ type: 'set_placement_multiplier', percentage: 2000 }, 0)).toBe(900)
    expect(startBidCents({ type: 'promote_to_exact' })).toBe(50) // an engine-native action's constant bid
    expect(startBidCents({ type: 'promote_to_exact', bidEur: 0.35 })).toBe(35)
    expect(startBidCents({ type: 'promote_to_exact', harvest: {}, bid: { mode: 'fixed', value: 0.4 } })).toBe(40)
    expect(startBidCents({ type: 'promote_to_exact', harvest: {}, bid: { mode: 'cpc' } })).toBeNull()
  })
})

describe('the limits', () => {
  it('every raise and a new keyword\'s starting bid wait for a person by default; tightening is a free brake', () => {
    const defaults = SUGGESTION_LIMITS.parse({})
    expect(defaults).toMatchObject({ maxItems: 25, maxBidRaisePct: 0, maxBudgetRaisePct: 0, maxPlacementRaisePoints: 0, maxStartBidCents: 0, maxBidCutPct: 100, maxChangesPerEntityPerDay: 1, allowEngineOwned: false })
    expect(limitsTighten({ limits: SUGGESTION_LIMITS }, defaults, { ...defaults, maxBidCutPct: 20, maxItems: 5 })).toBe(true)
    expect(limitsTighten({ limits: SUGGESTION_LIMITS }, defaults, { ...defaults, maxBidRaisePct: 10 })).toBe(false)
    expect(limitsTighten({ limits: SUGGESTION_LIMITS }, defaults, { ...defaults, maxStartBidCents: 40 })).toBe(false)
  })
})

describe('is a preview inside the business\'s rule', () => {
  const limitFacts: LimitFacts = {
    v: LIMIT_FACTS_VERSION, tool: 'decide-automation-suggestions', action: 'suggestion',
    markets: { IT: { strategy: { version: '1' }, currency: 'EUR', maxActionsPerRun: null, maxChangesPerDay: 10, maxRaisesPerDay: 10, maxBudgetIncreasePerDayCents: 10_000, sources: {} } },
    scopes: {}, entityScopes: {}, labels: {},
    this: {
      markets: ['IT'], items: 1, writes: 1, raises: 0, cuts: 1, largestRaisePct: 0, largestCutPct: 10, largestRaisePoints: 0, largestCutPoints: 0,
      highestNewBidCents: 90, budgetIncreaseCents: 0, byMarket: { IT: { changes: 1, writes: 1, raises: 0, budgetIncreaseCents: 0, addedDailyCents: 0 } },
      entities: ['target:t1'], rowsOutsideStrategy: 0, firstOutside: null,
    },
    today: { IT: { changes: 0, writes: 0, raises: 0, budgetIncreaseCents: 0 } }, perEntityToday: { maxChangesByRule: 0, entity: null },
    unplaced: [], engineOwned: [], protectedHit: [],
  }
  const families = (patch: Partial<SuggestionRuleFacts> = {}): SuggestionRuleFacts => ({
    decisions: 1, applies: 1, unjudged: 0, firstUnjudged: null,
    bids: { raises: 0, largestRaisePct: 0, largestCutPct: 10 }, budgets: { raises: 0, largestRaisePct: 0, largestCutPct: 0 },
    placements: { raises: 0, largestRaisePoints: 0, largestCutPoints: 0 }, newKeywords: { count: 0, highestStartBid: null }, ...patch,
  })
  const preview = (patch: Partial<SuggestionRuleFacts> = {}) => ({ kind: 'amazon-ads', limitFacts, suggestions: families(patch) })
  const defaults = SUGGESTION_LIMITS.parse({}) as Record<string, unknown>

  it('a bid cut inside the strategy and the limits runs by rule', () => {
    expect(suggestionRefusal(preview(), defaults)).toBeNull()
  })

  it('eBay, no facts, no preview: a person decides', () => {
    expect(suggestionRefusal({ kind: 'ebay-ads' }, defaults)).toContain('an eBay proposal is not decided by rule')
    expect(suggestionRefusal({ kind: 'amazon-ads' }, defaults)).toContain('there are no limit facts in this preview')
    expect(suggestionRefusal({ kind: 'amazon-ads', limitFacts }, defaults)).toContain('there are no suggestion facts in this preview')
    expect(suggestionRefusal(null, defaults)).toEqual(expect.any(String))
  })

  it('the request\'s size counts dismissals too; an apply Nexus cannot measure waits', () => {
    expect(suggestionRefusal(preview({ decisions: 30 }), defaults)).toContain('it decides 30 suggestions, more than the 25')
    expect(suggestionRefusal(preview({ decisions: 30 }), { ...defaults, maxItems: 30 })).toBeNull()
    expect(suggestionRefusal(preview({ unjudged: 2, firstUnjudged: 'TEST rule on the whole account: it acts across a market or the account' }), defaults))
      .toBe('TEST rule on the whole account: it acts across a market or the account (and 1 more); a person decides')
  })

  it('each family is held to its own limit; 0 says every raise waits', () => {
    expect(suggestionRefusal(preview({ bids: { raises: 1, largestRaisePct: 12, largestCutPct: 0 } }), defaults)).toContain('its largest bid raise is 12 %, more than the 0 % this tool\'s limits let run without a person (0: every bid raise waits for a person)')
    expect(suggestionRefusal(preview({ bids: { raises: 1, largestRaisePct: 12, largestCutPct: 0 } }), { ...defaults, maxBidRaisePct: 15 })).toBeNull()
    expect(suggestionRefusal(preview(), { ...defaults, maxBidCutPct: 5 })).toContain('its largest bid cut is 10 %, more than the 5 %')
    expect(suggestionRefusal(preview({ budgets: { raises: 1, largestRaisePct: 40, largestCutPct: 0 } }), { ...defaults, maxBidRaisePct: 50 })).toContain('budget raise is 40 %')
    expect(suggestionRefusal(preview({ placements: { raises: 1, largestRaisePoints: 25, largestCutPoints: 0 } }), defaults)).toContain('placement raise is 25 points')
    expect(suggestionRefusal(preview({ placements: { raises: 0, largestRaisePoints: 0, largestCutPoints: 150 } }), defaults)).toContain('placement cut is 150 points, more than the 100 points')
    const keyword = { newKeywords: { count: 2, highestStartBid: { cents: 40, currency: 'EUR' } } }
    expect(suggestionRefusal(preview(keyword), defaults)).toContain('it creates 2 new keywords starting at up to EUR 0.40, above the EUR 0.00 this tool\'s limits allow without a person (0: every new keyword waits for a person)')
    expect(suggestionRefusal(preview(keyword), { ...defaults, maxStartBidCents: 40 })).toBeNull()
  })

  it('the kit\'s checks come first: a strategy that is not there refuses whatever the family limits say', () => {
    const bare = { ...preview(), limitFacts: { ...limitFacts, markets: { IT: { ...limitFacts.markets.IT, strategy: null } } } }
    expect(suggestionRefusal(bare, { ...defaults, maxBidRaisePct: 100 })).toContain('there is no ads strategy for IT')
  })
})
