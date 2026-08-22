/**
 * PLC-P5 — a Placement rule's own lookback, and the two readers that have to agree about it.
 *
 * The defect: `ACTION_WINDOW` had no `placement` entry and the evaluator's per-window helper tested
 * `a0.type !== 'budget'`. Between them, a `windowDays` stored on a placement rule was read by
 * NOBODY — the grid's Lookback cell fell through to the trigger's flat 7 days and the evaluator
 * sent the rule to the default 7-day context pass. It never became a live defect only because the
 * builder offered no control to store one.
 */
import { describe, expect, it } from 'vitest'
import { ACTION_WINDOW, TRIGGER_WINDOW, ruleLookback, BID_WINDOW_MIN, BID_WINDOW_MAX } from '@nexus/shared/ads-rule-window'

/** The evaluator's helper, transcribed exactly (advertising-rule-evaluator.job.ts). */
const CAMPAIGN_WINDOW_SLUGS = new Set(['budget', 'placement'])
const TRIGGER_DEFAULT = TRIGGER_WINDOW.CAMPAIGN_PERFORMANCE_BUDGET.days as number
const campaignRuleWindow = (actions: unknown): number | null => {
  const a0 = Array.isArray(actions) ? (actions[0] as { type?: string; windowDays?: unknown } | undefined) : undefined
  if (!a0 || !CAMPAIGN_WINDOW_SLUGS.has(String(a0.type ?? ''))) return null
  if (typeof a0.windowDays !== 'number' || !Number.isFinite(a0.windowDays)) return null
  const clamped = Math.max(BID_WINDOW_MIN, Math.min(BID_WINDOW_MAX, Math.round(a0.windowDays)))
  return clamped === TRIGGER_DEFAULT ? null : clamped
}
const act = (type: string, windowDays?: unknown) => [{ type, ...(windowDays === undefined ? {} : { windowDays }) }]

describe('ACTION_WINDOW knows placement', () => {
  it('🔴 has an entry at all — without one the grid prints the trigger’s window for every rule', () => {
    expect(ACTION_WINDOW.placement).toBeDefined()
  })

  it('reads the SAME contexts as budget, so it declares the same window and settledness', () => {
    expect(ACTION_WINDOW.placement.days).toBe(ACTION_WINDOW.budget.days)
    expect(ACTION_WINDOW.placement.settled).toBe(true)
    expect(ACTION_WINDOW.placement.source).toBe(ACTION_WINDOW.budget.source)
  })

  it('is tunable with the same clamp the handler and evaluator enforce', () => {
    expect(ACTION_WINDOW.placement.tunable?.clamp).toEqual([BID_WINDOW_MIN, BID_WINDOW_MAX])
  })

  it('its default equals the trigger’s, so an unset rule reads identically either way', () => {
    expect(ACTION_WINDOW.placement.days).toBe(TRIGGER_DEFAULT)
  })
})

describe('ruleLookback — the grid cell now follows the RULE, not the trigger', () => {
  it('a placement rule with its own 30-day window says 30 days', () => {
    const r = ruleLookback('CAMPAIGN_PERFORMANCE_BUDGET', ['placement'], 30)
    expect(r.label).toBe('30 days')
    expect(r.fromAction).toBe(true)
  })

  it('a placement rule with none falls back to the trigger’s 7, and still reads from the action', () => {
    const r = ruleLookback('CAMPAIGN_PERFORMANCE_BUDGET', ['placement'], null)
    expect(r.label).toBe('7 days')
  })

  it('clamps exactly as the engine clamps — no cell may promise a window nothing reads', () => {
    expect(ruleLookback('CAMPAIGN_PERFORMANCE_BUDGET', ['placement'], 1).label).toBe('7 days')
    expect(ruleLookback('CAMPAIGN_PERFORMANCE_BUDGET', ['placement'], 9999).label).toBe('90 days')
  })

  it('says the two settling days are excluded, because these contexts go through ruleWindowBounds', () => {
    expect(ruleLookback('CAMPAIGN_PERFORMANCE_BUDGET', ['placement'], 30).why).toMatch(/still attributing/)
  })
})

describe('the evaluator routes a placement rule to its OWN context pass', () => {
  it('🔴 a placement rule with 30 days is EXCLUDED from the default pass', () => {
    // The default pass takes rules whose helper returns null. Before PLC-P5 this returned null for
    // every placement rule, so a 30-day rule was silently evaluated on 7 days of data.
    expect(campaignRuleWindow(act('placement', 30))).toBe(30)
    expect(campaignRuleWindow(act('placement', 30))).not.toBeNull()
  })

  it('budget still behaves exactly as it did — generalising must not move it', () => {
    expect(campaignRuleWindow(act('budget', 30))).toBe(30)
    expect(campaignRuleWindow(act('budget', 7))).toBeNull()
    expect(campaignRuleWindow(act('budget'))).toBeNull()
  })

  it('a window equal to the trigger’s default rides the DEFAULT pass — no redundant context build', () => {
    expect(campaignRuleWindow(act('placement', TRIGGER_DEFAULT))).toBeNull()
  })

  it('clamps out of range rather than building a context nobody asked for', () => {
    expect(campaignRuleWindow(act('placement', 1))).toBeNull() // clamps to 7 === default
    expect(campaignRuleWindow(act('placement', 9999))).toBe(90)
  })

  it('ignores a non-numeric or absent windowDays instead of guessing', () => {
    expect(campaignRuleWindow(act('placement', '30'))).toBeNull()
    expect(campaignRuleWindow(act('placement', Number.NaN))).toBeNull()
    expect(campaignRuleWindow(act('placement'))).toBeNull()
  })

  it('does not claim a slug that does not share these contexts', () => {
    for (const slug of ['bid', 'sov', 'keyword-tracker', 'negative-targeting', 'keyword-harvesting']) {
      expect(campaignRuleWindow(act(slug, 30)), `${slug} must not ride the campaign-budget pass`).toBeNull()
    }
  })
})
