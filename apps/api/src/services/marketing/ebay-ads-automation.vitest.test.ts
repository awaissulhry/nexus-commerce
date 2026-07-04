import { describe, it, expect } from 'vitest'
import {
  evalCondition, evalConditionDetailed, benchmarkValue, metricValue, windowBounds, validateRuleBody, estimateImpact, ruleConfigChanged, ruleConfigOf,
  type Condition, type EntityFacts, type BenchFacts, type RuleBody,
} from './ebay-ads-automation.service.js'

// ER3.2 — protects the benchmark-relative condition maths (Pacvue adopt +
// break-even beat), the window-honesty bounds, and the rule-body validation
// the editor / preview / create / edit endpoints all share.

const facts = (p: Partial<EntityFacts>): EntityFacts => ({ impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0, ...p })
const cond = (p: Partial<Condition>): Condition => ({ metric: 'clicks', windowDays: 14, op: 'gt', threshold: 0, ...p })

describe('evalCondition — absolute thresholds (v1 behaviour preserved)', () => {
  it('compares plain counters', () => {
    expect(evalCondition(cond({ metric: 'clicks', op: 'gte', threshold: 30 }), facts({ clicks: 30 }), null, null)).toBe(true)
    expect(evalCondition(cond({ metric: 'clicks', op: 'gte', threshold: 30 }), facts({ clicks: 29 }), null, null)).toBe(false)
  })
  it('ratio metrics are null (fail-safe) with a zero denominator', () => {
    expect(evalCondition(cond({ metric: 'acos_pct', op: 'gt', threshold: 25 }), facts({ adFeesCents: 500 }), null, null)).toBeNull()
    expect(evalCondition(cond({ metric: 'ctr_pct', op: 'lt', threshold: 0.2 }), facts({ clicks: 3 }), null, null)).toBeNull()
  })
  it('rate_minus_breakeven needs both sides', () => {
    expect(evalCondition(cond({ metric: 'rate_minus_breakeven', op: 'gt', threshold: 0 }), facts({}), 12, 9.5)).toBe(true)
    expect(evalCondition(cond({ metric: 'rate_minus_breakeven', op: 'gt', threshold: 0 }), facts({}), 12, null)).toBeNull()
  })
})

describe('benchmarkValue — population semantics', () => {
  const bench: BenchFacts = { sums: facts({ adFeesCents: 2_000, salesCents: 20_000, clicks: 100, impressions: 50_000 }), entities: 4 }
  it('ratio metrics use the aggregate ratio (not mean-of-ratios)', () => {
    // account ACOS = 2000/20000 = 10%
    expect(benchmarkValue(cond({ metric: 'acos_pct', benchmark: 'account_avg' }), null, bench)).toBeCloseTo(10)
    expect(benchmarkValue(cond({ metric: 'acos_pct', benchmark: 'account_avg', multiplier: 1.5 }), null, bench)).toBeCloseTo(15)
  })
  it('count metrics are per-entity means', () => {
    expect(benchmarkValue(cond({ metric: 'clicks', benchmark: 'account_avg' }), null, bench)).toBeCloseTo(25)
    expect(benchmarkValue(cond({ metric: 'ad_fees_cents', benchmark: 'account_avg', multiplier: 2 }), null, bench)).toBeCloseTo(1_000)
  })
  it('break_even rides the entity economics, not the population', () => {
    expect(benchmarkValue(cond({ metric: 'acos_pct', benchmark: 'break_even' }), 9.5, null)).toBeCloseTo(9.5)
    expect(benchmarkValue(cond({ metric: 'acos_pct', benchmark: 'break_even', multiplier: 0.8 }), 10, null)).toBeCloseTo(8)
    expect(benchmarkValue(cond({ metric: 'acos_pct', benchmark: 'break_even' }), null, bench)).toBeNull()
  })
  it('fail-safe nulls: empty population, rate_minus_breakeven', () => {
    expect(benchmarkValue(cond({ metric: 'clicks', benchmark: 'account_avg' }), null, { sums: facts({}), entities: 0 })).toBeNull()
    expect(benchmarkValue(cond({ metric: 'clicks', benchmark: 'account_avg' }), null, undefined)).toBeNull()
    expect(benchmarkValue(cond({ metric: 'rate_minus_breakeven', benchmark: 'account_avg' }), null, bench)).toBeNull()
  })
})

describe('evalConditionDetailed — benchmark comparisons end to end', () => {
  const account: BenchFacts = { sums: facts({ adFeesCents: 1_000, salesCents: 10_000 }), entities: 5 } // ACOS 10%
  const campaign: BenchFacts = { sums: facts({ adFeesCents: 900, salesCents: 3_000 }), entities: 3 } // ACOS 30%
  it('entity vs account average', () => {
    const r = evalConditionDetailed(
      cond({ metric: 'acos_pct', op: 'gt', benchmark: 'account_avg', multiplier: 1.5 }),
      facts({ adFeesCents: 800, salesCents: 4_000 }), null, null, { account, campaign }) // entity ACOS 20% vs 15%
    expect(r).toEqual({ pass: true, value: 20, cmp: 15 })
  })
  it('campaign_avg picks the campaign population', () => {
    const r = evalConditionDetailed(
      cond({ metric: 'acos_pct', op: 'lt', benchmark: 'campaign_avg' }),
      facts({ adFeesCents: 800, salesCents: 4_000 }), null, null, { account, campaign }) // 20% < 30%
    expect(r.pass).toBe(true)
    expect(r.cmp).toBeCloseTo(30)
  })
  it('unresolvable benchmark ⇒ null pass (fail-safe), value still reported', () => {
    const r = evalConditionDetailed(cond({ metric: 'acos_pct', op: 'gt', benchmark: 'campaign_avg' }), facts({ adFeesCents: 500, salesCents: 1_000 }), null, null, { account, campaign: null })
    expect(r.pass).toBeNull()
    expect(r.value).toBeCloseTo(50)
  })
  it('threshold missing without benchmark ⇒ null pass', () => {
    const c: Condition = { metric: 'clicks', windowDays: 7, op: 'gt' }
    expect(evalConditionDetailed(c, facts({ clicks: 10 }), null, null).pass).toBeNull()
  })
})

describe('windowBounds — exclusion maths (72h reconciliation honesty)', () => {
  const now = new Date('2026-07-03T15:30:00Z')
  it('exclude 0 keeps the original open-ended window', () => {
    const { since, until } = windowBounds(14, 0, now)
    expect(until).toBeNull()
    expect(since.toISOString()).toBe('2026-06-19T15:30:00.000Z')
  })
  it('exclude 1 drops today only', () => {
    const { since, until } = windowBounds(14, 1, now)
    expect(until!.toISOString()).toBe('2026-07-03T00:00:00.000Z')
    expect(since.toISOString()).toBe('2026-06-19T00:00:00.000Z')
  })
  it('exclude 3 drops today + 2 full days, window stays N full days', () => {
    const { since, until } = windowBounds(30, 3, now)
    expect(until!.toISOString()).toBe('2026-07-01T00:00:00.000Z') // Jul 1/2/3 rows all < filter? no: date < Jul 1 excludes them
    expect(since.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect((until!.getTime() - since.getTime()) / 86_400_000).toBe(30)
  })
})

describe('metricValue — sanity', () => {
  it('fee % of sales', () => {
    expect(metricValue('fee_pct_of_sales', facts({ adFeesCents: 300, salesCents: 1_500 }), null, null)).toBeCloseTo(20)
  })
})

describe('validateRuleBody — the editor/create/edit/preview contract', () => {
  const valid: RuleBody = {
    name: 'Fee creep-down',
    trigger: { scope: 'CPS_AD', all: [
      { metric: 'fee_pct_of_sales', windowDays: 14, op: 'gt', threshold: 20, excludeRecentDays: 3 },
      { metric: 'acos_pct', windowDays: 14, op: 'gt', benchmark: 'break_even', multiplier: 1 },
    ] },
    action: { type: 'adjust_ad_rate', deltaPct: -15, minRatePct: 2 },
    scope: { campaignIds: ['c1'] }, marketplace: 'EBAY_IT', cooldownHours: 24,
  }
  it('accepts a well-formed body (incl. benchmark + exclusion)', () => {
    expect(validateRuleBody(valid)).toEqual([])
  })
  it('rejects unknown metric/op and bad windows', () => {
    const errs = validateRuleBody({ ...valid, trigger: { scope: 'CPS_AD', all: [{ metric: 'nope' as never, windowDays: 0, op: 'eq' as never, threshold: 1 }] } })
    expect(errs.join(' ')).toMatch(/unknown metric/)
    expect(errs.join(' ')).toMatch(/unknown operator/)
    expect(errs.join(' ')).toMatch(/windowDays 1–90/)
  })
  it('rejects exclusion ≥ window', () => {
    const errs = validateRuleBody({ ...valid, trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 3, op: 'gt', threshold: 1, excludeRecentDays: 3 }] } })
    expect(errs.join(' ')).toMatch(/excludeRecentDays/)
  })
  it('requires threshold OR benchmark', () => {
    const errs = validateRuleBody({ ...valid, trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 7, op: 'gt' }] } })
    expect(errs.join(' ')).toMatch(/threshold required/)
  })
  it('break_even benchmark is CPS + ACOS/fee-% only', () => {
    const cpc = validateRuleBody({ ...valid, trigger: { scope: 'CPC_KEYWORD', all: [{ metric: 'acos_pct', windowDays: 14, op: 'gt', benchmark: 'break_even' }] }, action: { type: 'pause_keyword' } })
    expect(cpc.join(' ')).toMatch(/break-even benchmark/)
    const wrongMetric = validateRuleBody({ ...valid, trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 14, op: 'gt', benchmark: 'break_even' }] } })
    expect(wrongMetric.join(' ')).toMatch(/break-even benchmark/)
  })
  it('action must match scope; params bounded', () => {
    expect(validateRuleBody({ ...valid, action: { type: 'pause_keyword' } }).join(' ')).toMatch(/action\.type/)
    expect(validateRuleBody({ ...valid, action: { type: 'adjust_ad_rate', deltaPct: 0 } }).join(' ')).toMatch(/deltaPct/)
    expect(validateRuleBody({ ...valid, action: { type: 'set_rate_to_breakeven_factor', factor: 2 } }).join(' ')).toMatch(/factor/)
    const cpcBid = validateRuleBody({ name: 'x', trigger: { scope: 'CPC_KEYWORD', all: [{ metric: 'clicks', windowDays: 30, op: 'gte', threshold: 20 }] }, action: { type: 'bid_down_keyword', bidDeltaPct: 5 } })
    expect(cpcBid.join(' ')).toMatch(/bidDeltaPct/)
  })
  it('bounds cooldown, marketplace shape, scope size, multiplier', () => {
    expect(validateRuleBody({ ...valid, cooldownHours: 0 }).join(' ')).toMatch(/cooldownHours/)
    expect(validateRuleBody({ ...valid, marketplace: 'ebay_it' }).join(' ')).toMatch(/marketplace/)
    expect(validateRuleBody({ ...valid, trigger: { scope: 'CPS_AD', all: [{ metric: 'acos_pct', windowDays: 14, op: 'gt', benchmark: 'account_avg', multiplier: 99 }] } }).join(' ')).toMatch(/multiplier/)
  })
  it('rate_minus_breakeven refuses a benchmark', () => {
    const errs = validateRuleBody({ ...valid, trigger: { scope: 'CPS_AD', all: [{ metric: 'rate_minus_breakeven', windowDays: 7, op: 'gt', benchmark: 'account_avg' }] } })
    expect(errs.join(' ')).toMatch(/already benchmark-relative/)
  })
})

describe('ER4 E3 — estimateImpact (honest weekly extrapolation)', () => {
  const f = facts({ adFeesCents: 1_400, salesCents: 7_000 }) // 14d window
  it('rate step scales fees with the rate', () => {
    const ei = estimateImpact('adjust_ad_rate', f, 14, { fromPct: 10, toPct: 8 })!
    expect(ei.feesDeltaCentsPerWeek).toBe(-140) // 1400 × (0.8−1) × 7/14
    expect(ei.assumption).toMatch(/unchanged/)
  })
  it('bid down is framed as an upper bound', () => {
    const ei = estimateImpact('bid_down_keyword', f, 14, { fromBidCents: 50, toBidCents: 40 })!
    expect(ei.feesDeltaCentsPerWeek).toBe(-140)
    expect(ei.assumption).toMatch(/upper bound/)
  })
  it('pause shows BOTH saved fees and sales at risk', () => {
    const ei = estimateImpact('pause_ad', f, 14)!
    expect(ei.feesDeltaCentsPerWeek).toBe(-700)
    expect(ei.salesAtRiskCentsPerWeek).toBe(3_500)
  })
  it('null on kinds with no defensible model / bad params', () => {
    expect(estimateImpact('reactivate_ad', f, 14)).toBeNull()
    expect(estimateImpact('alert', f, 14)).toBeNull()
    expect(estimateImpact('adjust_ad_rate', f, 14, { fromPct: 0, toPct: 8 })).toBeNull()
  })
})

describe('ER5 — ruleConfigChanged (versioning diff)', () => {
  const base = ruleConfigOf({ name: 'A', marketplace: 'EBAY_IT', scope: { campaignIds: ['c1'] }, trigger: { scope: 'CPS_AD', all: [{ metric: 'clicks', windowDays: 7, op: 'gt', threshold: 5 }] }, action: { type: 'pause_ad' }, guardrails: null, cooldownHours: 24 })
  it('identical configs are unchanged regardless of key order', () => {
    const reordered = ruleConfigOf({ cooldownHours: 24, guardrails: null, action: { type: 'pause_ad' }, trigger: { all: [{ threshold: 5, op: 'gt', windowDays: 7, metric: 'clicks' }], scope: 'CPS_AD' } as never, scope: { campaignIds: ['c1'] }, marketplace: 'EBAY_IT', name: 'A' })
    expect(ruleConfigChanged(base, reordered)).toBe(false)
  })
  it('a threshold change is a change', () => {
    const b = structuredClone(base) as typeof base
    ;(b.trigger as { all: Array<{ threshold: number }> }).all[0].threshold = 6
    expect(ruleConfigChanged(base, b)).toBe(true)
  })
  it('null vs missing guardrails are equal (normalised)', () => {
    const b = { ...base, guardrails: null }
    expect(ruleConfigChanged(base, b)).toBe(false)
  })
})
