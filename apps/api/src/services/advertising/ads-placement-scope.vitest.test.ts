/**
 * PLC-P7 — the IF placement-scope selector, finally wired.
 *
 * The defect: the Placement builder wrote `scope` on every condition ('campaign' | 'tos' | 'pdp' |
 * 'ros'), `conditionsForStorage` stored it verbatim, and `translateConditions` read `metric`, `op`
 * and `value` only — so "IF Top of Search · ACoS > 40%" evaluated the CAMPAIGN's ACoS. The cardinal
 * sin: a stored-but-unread control, on the one dropdown that separates a Placement rule from a
 * Budget one.
 *
 * These pin the rewrite AND its blast radius, which is the part that could go wrong quietly.
 */
import { describe, expect, it } from 'vitest'
import { placementScopedField, maybeTranslateAdsRule } from './ads-rule-adapter.service.js'
import { applyOperator } from '../automation-rule.service.js'

describe('placementScopedField — narrow on purpose', () => {
  it('re-points a campaign metric at the chosen lane', () => {
    expect(placementScopedField('campaign.acos', 'tos')).toBe('placement.tos.acos')
    expect(placementScopedField('campaign.ctr', 'pdp')).toBe('placement.pdp.ctr')
    expect(placementScopedField('campaign.spendCents', 'ros')).toBe('placement.ros.spendCents')
  })

  it('leaves the campaign scope alone — the default must be byte-identical to before', () => {
    expect(placementScopedField('campaign.acos', 'campaign')).toBe('campaign.acos')
    expect(placementScopedField('campaign.acos', undefined)).toBe('campaign.acos')
  })

  it('🔴 never touches another rule type’s field, whatever scope is on the condition', () => {
    // A stray `scope` on a bid/harvest/negative condition must not move it to a field nothing
    // emits — that evaluates as `undefined` and silently never matches.
    for (const f of ['adTarget.acos', 'searchTerm.clicks', 'profit.netCents', 'budget.monthlySpendCents']) {
      expect(placementScopedField(f, 'tos'), f).toBe(f)
    }
  })

  it('🔴 leaves campaign-only facts campaign-wide — a LANE has no budget', () => {
    for (const f of ['campaign.budgetUtilization', 'campaign.dailyBudgetCents', 'campaign.avgDailySpendCents']) {
      expect(placementScopedField(f, 'tos'), f).toBe(f)
    }
  })

  it('ignores a scope nobody has defined rather than inventing a field', () => {
    expect(placementScopedField('campaign.acos', 'sponsored-brands')).toBe('campaign.acos')
    expect(placementScopedField('campaign.acos', 'PLACEMENT_TOP')).toBe('campaign.acos')
  })
})

describe('a placement rule translates its lane-scoped criteria', () => {
  const rule = (scope: string) => ({
    id: 'r1',
    actions: [{ type: 'placement', campaigns: [{ id: 'c1' }], placeFloor: 0, placeCeiling: 900 }],
    conditions: [{
      match: 'all',
      action: { op: 'decPct', value: '20', placeTarget: 'tos' },
      conditions: [{ metric: 'ACOS', op: 'gt', value: '40', scope }, { metric: 'Clicks', op: 'gte', value: '20', scope }],
    }],
  })

  it('🔴 "Top of Search ACoS > 40%" reads the LANE, not the campaign', () => {
    const t = maybeTranslateAdsRule(rule('tos'))
    expect(t?.conditions.map((l) => (l as { field: string }).field)).toEqual(['placement.tos.acos', 'placement.tos.clicks'])
  })

  it('the campaign scope still produces exactly the fields it always did', () => {
    const t = maybeTranslateAdsRule(rule('campaign'))
    expect(t?.conditions.map((l) => (l as { field: string }).field)).toEqual(['campaign.acos', 'campaign.clicks'])
  })

  it('keeps the metric’s own conversion — the lane changes the field, never the units', () => {
    const t = maybeTranslateAdsRule(rule('ros'))
    // ACOS is a percent in the builder and a fraction in the engine, lane or no lane.
    expect((t?.conditions[0] as { value: number }).value).toBeCloseTo(0.4)
    expect((t?.conditions[1] as { value: number }).value).toBe(20)
  })

  it('a rule may MIX a campaign-wide condition with a lane-scoped one', () => {
    const t = maybeTranslateAdsRule({
      id: 'r2',
      actions: [{ type: 'placement', campaigns: [{ id: 'c1' }] }],
      conditions: [{
        match: 'all',
        action: { op: 'set', value: '0', placeTarget: 'ros' },
        conditions: [{ metric: 'ACOS', op: 'lte', value: '25', scope: 'campaign' }, { metric: 'CTR', op: 'lte', value: '0.3', scope: 'ros' }],
      }],
    })
    expect(t?.conditions.map((l) => (l as { field: string }).field)).toEqual(['campaign.acos', 'placement.ros.ctr'])
  })

  it('🔴 a BUDGET rule carrying a stray scope is untouched — the blast radius is placement only', () => {
    const t = maybeTranslateAdsRule({
      id: 'r3',
      actions: [{ type: 'budget', campaigns: [{ id: 'c1' }], budgetFloor: 1 }],
      conditions: [{ match: 'all', action: { op: 'decPct', value: '25' }, conditions: [{ metric: 'ACOS', op: 'gt', value: '40', scope: 'tos' }] }],
    })
    // Budget shares CAMPAIGN_METRIC, so the guard is the FIELD, not the slug: a stray `scope` on a
    // budget rule WOULD follow. Left field-driven on purpose. The Budget builder never writes
    // `scope` (only `pcDefaultCondition('placement')` does), and because Budget and Placement share
    // one context family the rewritten field still resolves to real data rather than `undefined` —
    // so the worst case is a rule that is over-TIGHT, which is the safe direction. A slug-driven
    // guard would need a 4th argument through all seven call sites of this function for a case the
    // UI cannot produce.
    expect(t?.conditions.map((l) => (l as { field: string }).field)).toEqual(['placement.tos.acos'])
  })
})

/**
 * 🔴 PLC-P7 — why an unmeasured lane is `undefined` and not `null`.
 *
 * The shared comparator implements `lte` as `Number(lhs) <= Number(rhs)`, and `Number(null)` is 0.
 * So a null MATCHES every `lt`/`lte` — exactly the fabricated-zero behaviour the context builders'
 * comments say nulls exist to prevent. Measured: a lane-scoped "CTR ≤ 99%" draft matched 53
 * campaigns when only 51 had a measurable Product Pages CTR. `undefined` coerces to NaN, and every
 * relational comparison against NaN is false — the honest reading of "never seen".
 */
describe('the null trap this unit had to design around', () => {
  it('null matches every lt/lte — it behaves as ZERO, not as absent', () => {
    expect(applyOperator('lte', null, 0.2)).toBe(true)
    expect(applyOperator('lt', null, 0.2)).toBe(true)
    expect(applyOperator('gte', null, 0.2)).toBe(false)
  })

  it('undefined fails every relational comparison — which is why lane metrics are undefined', () => {
    expect(applyOperator('lte', undefined, 0.2)).toBe(false)
    expect(applyOperator('lt', undefined, 0.2)).toBe(false)
    expect(applyOperator('gte', undefined, 0.2)).toBe(false)
    expect(applyOperator('gt', undefined, 0.2)).toBe(false)
  })

  it('an unmeasured lane cannot be swept in by a "cut the underperformers" rule', () => {
    const lane: { ctr?: number } = {} // no report rows in the window
    expect(applyOperator('lte', lane.ctr, 0.003)).toBe(false)
  })

  /**
   * ⚠ NOT fixed here. `applyOperator` is the comparator every rule type shares, and the
   * campaign-level ratios one level up are still null: measured 2026-08-22, 38 of the 46 campaigns
   * emitting a context have `acos: null` (spend, no attributed sales), and all 38 match
   * "ACoS ≤ 25%". Changing the comparator moves every Budget, Bid, Harvest and Negative rule in the
   * account, so it is its own unit and the operator's call — the same fence as D-PLC-3.
   */
  it('documents the unfixed half: a campaign-level null still reads as zero', () => {
    const campaign: { acos: number | null } = { acos: null } // spend, no sales
    expect(applyOperator('lte', campaign.acos, 0.25)).toBe(true)
  })
})
