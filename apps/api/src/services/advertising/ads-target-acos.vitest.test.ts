import { describe, it, expect } from 'vitest'
import { breakevenAcos, targetFromBreakeven, profitShareFor } from './ads-target-acos.service.js'

describe('breakevenAcos', () => {
  it('computes contribution-before-ads / revenue', () => {
    // €100 rev, €40 COGS, €15 referral, €10 FBA → €35 contribution → 35% break-even.
    const be = breakevenAcos({
      grossRevenueCents: 10000, cogsCents: 4000, referralFeesCents: 1500,
      fbaFulfillmentFeesCents: 1000, fbaStorageFeesCents: 0, returnsRefundsCents: 0, otherFeesCents: 0,
    })
    expect(be).toBeCloseTo(0.35, 5)
  })

  it('returns 0 when non-ad costs already exceed revenue (no room for ads)', () => {
    const be = breakevenAcos({
      grossRevenueCents: 10000, cogsCents: 8000, referralFeesCents: 1500,
      fbaFulfillmentFeesCents: 1000, fbaStorageFeesCents: 500, returnsRefundsCents: 0, otherFeesCents: 0,
    })
    expect(be).toBe(0)
  })

  it('returns null when there is no revenue', () => {
    expect(breakevenAcos({ grossRevenueCents: 0, cogsCents: 0, referralFeesCents: 0, fbaFulfillmentFeesCents: 0, fbaStorageFeesCents: 0, returnsRefundsCents: 0, otherFeesCents: 0 })).toBeNull()
  })

  it('subtracts storage, returns, and other fees too', () => {
    const be = breakevenAcos({
      grossRevenueCents: 10000, cogsCents: 3000, referralFeesCents: 1500,
      fbaFulfillmentFeesCents: 1000, fbaStorageFeesCents: 500, returnsRefundsCents: 500, otherFeesCents: 500,
    })
    // contribution = 10000 - 3000 - 1500 - 1000 - 500 - 500 - 500 = 3000 → 30%
    expect(be).toBeCloseTo(0.30, 5)
  })
})

describe('targetFromBreakeven', () => {
  it('profit mode keeps 35% of margin back', () => {
    // breakeven 40% → target = 0.40 * (1 - 0.35) = 0.26
    expect(targetFromBreakeven(0.4, { mode: 'profit' })).toBeCloseTo(0.26, 5)
  })

  it('growth mode spends almost the whole margin', () => {
    // breakeven 40% → target = 0.40 * (1 - 0.05) = 0.38
    expect(targetFromBreakeven(0.4, { mode: 'growth' })).toBeCloseTo(0.38, 5)
  })

  it('an explicit profitShare overrides the mode default', () => {
    expect(targetFromBreakeven(0.5, { profitShare: 0.5 })).toBeCloseTo(0.25, 5)
  })

  it('clamps to the [5%, 150%] band', () => {
    expect(targetFromBreakeven(0, { mode: 'profit' })).toBe(0.05) // zero breakeven → floor
    expect(targetFromBreakeven(5, { profitShare: 0 })).toBe(1.5) // absurd breakeven → cap
  })

  it('profitShareFor: profit > balanced > growth keeps progressively less back', () => {
    expect(profitShareFor('profit')).toBeGreaterThan(profitShareFor('balanced'))
    expect(profitShareFor('balanced')).toBeGreaterThan(profitShareFor('growth'))
  })
})

/**
 * ACR.0.5 — the shape of the defect this guards against, held as a test because the numbers
 * are the argument.
 *
 * With no cost loaded, cogsCents is 0 and breakevenAcos happily returns a large, confident
 * number. Measured on prod 2026-08-05, that was EVERY product: costPrice null on 362/362 and
 * weightedAvgCostCents 240 null / 122 zero / 0 real. The service now routes that case to the
 * `fallback` basis instead, because callers act only on `profit-data`.
 */
describe('ACR.0.5 — a zero COGS is a missing cost, not a free product', () => {
  it('THE TRAP: zero COGS yields a break-even that looks great and is meaningless', () => {
    const withCost = breakevenAcos({
      grossRevenueCents: 10000, cogsCents: 4000, referralFeesCents: 1500,
      fbaFulfillmentFeesCents: 1000, fbaStorageFeesCents: 0, returnsRefundsCents: 0, otherFeesCents: 0,
    })
    const withoutCost = breakevenAcos({
      grossRevenueCents: 10000, cogsCents: 0, referralFeesCents: 1500,
      fbaFulfillmentFeesCents: 1000, fbaStorageFeesCents: 0, returnsRefundsCents: 0, otherFeesCents: 0,
    })
    expect(withCost).toBeCloseTo(0.35, 5)
    expect(withoutCost).toBeCloseTo(0.75, 5)
    // The missing-cost answer is not conservative — it is more than twice as permissive.
    // breakevenAcos is pure and correct given its inputs; the caller must not feed it a
    // zero it invented, which is what resolveTargetAcos now refuses to do.
    expect(withoutCost).toBeGreaterThan((withCost as number) * 2)
  })

  it('targetFromBreakeven propagates the inflation rather than damping it', () => {
    const share = profitShareFor('balanced')
    const honest = targetFromBreakeven(0.35, share)
    const inflated = targetFromBreakeven(0.75, share)
    expect(inflated).toBeGreaterThan(honest as number)
  })
})
