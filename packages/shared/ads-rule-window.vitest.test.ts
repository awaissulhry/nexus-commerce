/**
 * B2 — the Lookback map, and the properties that make it worth trusting.
 *
 * The point of this file is NOT that `ruleLookback` returns strings. It is that the map cannot
 * quietly become decoration: the numbers here are the numbers the evaluator queries on, and the
 * three cases that are not a plain window stay distinguishable from one that is.
 */
import { describe, it, expect } from 'vitest'
import {
  TRIGGER_WINDOW, ACTION_WINDOW, ruleLookback, PROVISIONAL_DAYS,
  TOS_WINDOW_MIN, TOS_WINDOW_MAX,
} from './ads-rule-window.js'

describe('TRIGGER_WINDOW — the values the engine runs on', () => {
  /**
   * 🔴 These twelve are asserted as LITERALS on purpose. They are what
   * `advertising-rule-evaluator.job.ts` passed to `ruleWindowBounds` before B2 pointed it at this
   * map, so this test is the diff that proves the refactor changed no dates. Change a number here
   * only when you intend every rule on that trigger to start reading a different span of history.
   */
  it('matches the windows the evaluator used before it read this map', () => {
    expect(TRIGGER_WINDOW.AD_TARGET_UNDERPERFORMING.days).toBe(14)
    expect(TRIGGER_WINDOW.CAMPAIGN_PERFORMANCE_BUDGET.days).toBe(7)
    expect(TRIGGER_WINDOW.KEYWORD_ZERO_IMPRESSIONS.days).toBe(7)
    expect(TRIGGER_WINDOW.KEYWORD_LOW_CTR.days).toBe(14)
    expect(TRIGGER_WINDOW.KEYWORD_WASTED_SPEND.days).toBe(14)
    expect(TRIGGER_WINDOW.SEARCH_TERM_CONVERTING.days).toBe(30)
    expect(TRIGGER_WINDOW.SEARCH_TERM_WASTING.days).toBe(30)
    expect(TRIGGER_WINDOW.KEYWORD_HIGH_ACOS.days).toBe(14)
    expect(TRIGGER_WINDOW.KEYWORD_SCALE_OPPORTUNITY.days).toBe(14)
    expect(TRIGGER_WINDOW.AD_GROUP_UNDERPERFORMING.days).toBe(14)
    expect(TRIGGER_WINDOW.NEW_TO_BRAND_WINNER.days).toBe(14)
    expect(TRIGGER_WINDOW.CAMPAIGN_NO_SALES.days).toBe(30)
  })

  it('every trigger the evaluator can call WINDOW() for has a usable number', () => {
    // The evaluator throws for a missing or null-day entry; these are exactly the twelve it asks
    // for, so a rename that drops one fails here rather than at 00:15 in production.
    const asked = [
      'AD_TARGET_UNDERPERFORMING', 'CAMPAIGN_PERFORMANCE_BUDGET', 'KEYWORD_ZERO_IMPRESSIONS',
      'KEYWORD_LOW_CTR', 'KEYWORD_WASTED_SPEND', 'SEARCH_TERM_CONVERTING', 'KEYWORD_HIGH_ACOS',
      'KEYWORD_SCALE_OPPORTUNITY', 'AD_GROUP_UNDERPERFORMING', 'NEW_TO_BRAND_WINNER',
      'CAMPAIGN_NO_SALES', 'SEARCH_TERM_WASTING',
    ]
    for (const t of asked) {
      expect(TRIGGER_WINDOW[t], t).toBeDefined()
      expect(typeof TRIGGER_WINDOW[t].days, t).toBe('number')
      expect(TRIGGER_WINDOW[t].kind, t).toBe('window')
    }
  })

  it('marks the three hand-rolled comparisons as unsettled, not as plain windows', () => {
    // These build their own dates instead of calling ruleWindowBounds, so they count today.
    for (const t of ['CVR_DROP', 'CAMPAIGN_ROAS_DECLINING', 'KEYWORD_RISING_STAR']) {
      expect(TRIGGER_WINDOW[t].kind, t).toBe('compare')
      expect(TRIGGER_WINDOW[t].settled, t).toBe(false)
    }
  })

  it('does not dress a rule that reads nothing as a rule that reads a window', () => {
    expect(TRIGGER_WINDOW.SCHEDULE.kind).toBe('none')
    expect(TRIGGER_WINDOW.SCHEDULE.days).toBeNull()
    expect(TRIGGER_WINDOW.CAC_SPIKE.kind).toBe('stored')
    expect(TRIGGER_WINDOW.CAC_SPIKE.days).toBeNull()
  })
})

describe('ruleLookback', () => {
  it('lets the action override the trigger when the action re-queries', () => {
    // "Profit-native bid optimisation": SCHEDULE (no window) + bid_to_target_acos (30d).
    const r = ruleLookback('SCHEDULE', ['bid_to_target_acos', 'notify'])
    expect(r.fromAction).toBe(true)
    expect(r.days).toBe(30)
    expect(r.label).toBe('30 days')
  })

  it('keeps the trigger window when no action carries one', () => {
    // "Low CTR bid reduction": KEYWORD_LOW_CTR (14d) + bid_down (acts on the context's entity).
    const r = ruleLookback('KEYWORD_LOW_CTR', ['bid_down', 'notify'])
    expect(r.fromAction).toBe(false)
    expect(r.days).toBe(14)
    expect(r.settled).toBe(true)
  })

  it('says None — not a number — for a SCHEDULE rule whose action reads nothing either', () => {
    // "Rank control — Top +100%": SCHEDULE + raise_bids_for_rank_defense, which takes the campaign
    // id and writes. No performance data is consulted anywhere in that path.
    const r = ruleLookback('SCHEDULE', ['raise_bids_for_rank_defense', 'notify'])
    expect(r.label).toBe('None')
    expect(r.days).toBeNull()
    expect(r.why).toContain('no performance data at all')
  })

  it('warns in the tooltip when a window includes the still-settling days', () => {
    const unsettled = ruleLookback('SCHEDULE', ['bid_to_target_acos'])
    expect(unsettled.settled).toBe(false)
    expect(unsettled.why).toContain(`INCLUDES the last ${PROVISIONAL_DAYS} days`)

    const settled = ruleLookback('KEYWORD_WASTED_SPEND', ['lower_bid_to_floor'])
    expect(settled.settled).toBe(true)
    expect(settled.why).not.toContain('INCLUDES')
  })

  it('carries the bid optimiser caveat, because a declared window it never reads is worse than none', () => {
    const r = ruleLookback('CAC_SPIKE', ['bid_to_target_acos'])
    expect(r.why).toContain('NEXUS_BID_OPTIMIZER_SOURCE=daily')
    // and it still explains what the TRIGGER selected on, not only what the action computes from
    expect(r.why).toContain('stored campaign columns')
  })

  it('honours and clamps a per-action windowDays where the handler does', () => {
    expect(ruleLookback('SCHEDULE', ['defend_top_of_search'], 14).days).toBe(14)
    expect(ruleLookback('SCHEDULE', ['defend_top_of_search'], 1).days).toBe(TOS_WINDOW_MIN)
    expect(ruleLookback('SCHEDULE', ['defend_top_of_search'], 400).days).toBe(TOS_WINDOW_MAX)
    // absent → the handler's own default, not the trigger's
    expect(ruleLookback('SCHEDULE', ['defend_top_of_search']).days).toBe(ACTION_WINDOW.defend_top_of_search.days)
  })

  it('an unmapped trigger reads as a gap in the map, never as a rule that reads nothing', () => {
    // 🔴 The distinction the operator's standing law turns on: "we do not know" and "there is
    // nothing" must not render the same.
    const r = ruleLookback('SOME_TRIGGER_ADDED_LATER', ['bid_down'])
    expect(r.label).toBe('Unknown')
    expect(r.label).not.toBe('None')
    expect(r.why).toContain('gap in the map')
  })
})
