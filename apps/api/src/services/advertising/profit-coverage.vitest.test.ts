/**
 * ACR.0.5 — the rule that decides whether "true profit" is a number or a dash.
 *
 * These are the cases that were actually wrong on prod, not hypotheticals: a product with
 * €4,329 of ad-attributed sales and no cost price was reporting a healthy profit, and
 * `coverage.hasCostPrice` said `true` for the 122 products whose stored cost was literally 0.
 */

import { describe, it, expect } from 'vitest'
import {
  costIsKnown,
  coverageWithCost,
  estimateCogsCents,
  marginOrUnknown,
  profitOrUnknown,
} from './profit-coverage.js'

describe('costIsKnown', () => {
  it('a zero cost against real revenue is a missing cost, not a free product', () => {
    expect(costIsKnown({ grossRevenueCents: 12_900, cogsCents: 0 })).toBe(false)
  })

  it('a real cost is knowable', () => {
    expect(costIsKnown({ grossRevenueCents: 12_900, cogsCents: 5_400 })).toBe(true)
  })

  it('no revenue means nothing was sold, so a zero cost is a fact', () => {
    expect(costIsKnown({ grossRevenueCents: 0, cogsCents: 0 })).toBe(true)
  })

  it('ignores a coverage flag that disagrees with the row — the numbers win', () => {
    // This is the exact prod shape: hasCostPrice true, cogsCents 0, 714 rows.
    expect(
      costIsKnown({ grossRevenueCents: 12_900, cogsCents: 0, coverage: { hasCostPrice: true } }),
    ).toBe(false)
  })
})

describe('profitOrUnknown', () => {
  it('returns null rather than revenue-minus-fees when the cost is missing', () => {
    expect(profitOrUnknown({ grossRevenueCents: 12_900, cogsCents: 0 }, 9_800)).toBeNull()
  })

  it('returns the computed figure when the cost is known', () => {
    expect(profitOrUnknown({ grossRevenueCents: 12_900, cogsCents: 5_400 }, 4_400)).toBe(4_400)
  })

  it('keeps a genuine loss — a negative profit is knowledge, not absence', () => {
    expect(profitOrUnknown({ grossRevenueCents: 12_900, cogsCents: 5_400 }, -2_100)).toBe(-2_100)
  })

  it('keeps the fee-and-ad-spend burn on a day with no sales', () => {
    expect(profitOrUnknown({ grossRevenueCents: 0, cogsCents: 0 }, -1_500)).toBe(-1_500)
  })
})

describe('marginOrUnknown', () => {
  it('is null when profit is unknown, never 0%', () => {
    expect(marginOrUnknown(null, 12_900)).toBeNull()
  })

  it('is null when there is no revenue to divide by', () => {
    expect(marginOrUnknown(4_400, 0)).toBeNull()
  })

  it('is a fraction of revenue when both are known', () => {
    expect(marginOrUnknown(4_400, 12_900)).toBeCloseTo(0.3411, 4)
  })

  it('a true zero profit against real revenue is still 0, not unknown', () => {
    expect(marginOrUnknown(0, 12_900)).toBe(0)
  })
})

describe('the interim cost estimate (ACR.4)', () => {
  it('caps to a share of the selling price, so a cheap SKU is not sold at a loss on paper', () => {
    // A EUR 21.99 knee slider against a flat EUR 50 would read as losing EUR 28 per sale.
    expect(estimateCogsCents(2_199)).toBe(1_539) // 70% of 21.99
    expect(estimateCogsCents(2_596)).toBe(1_817) // the EUR 25.96 XS jacket
  })

  it('uses the flat figure once the price is high enough to carry it', () => {
    expect(estimateCogsCents(10_500)).toBe(5_000) // the EUR 105 median product
    expect(estimateCogsCents(39_995)).toBe(5_000)
  })

  it('refuses to estimate with no price to anchor to — a guess about a guess', () => {
    expect(estimateCogsCents(null)).toBeNull()
    expect(estimateCogsCents(0)).toBeNull()
    expect(estimateCogsCents(undefined)).toBeNull()
  })

  it('an estimated row NEVER claims a real cost price, however often coverage is rebuilt', () => {
    // The estimate is a positive cogsCents, so recomputing from the numbers alone would promote
    // it to "measured" on the next write. It must not.
    let cov: Record<string, boolean> = coverageWithCost(
      null, { grossRevenueCents: 10_500, cogsCents: 5_000 }, { costEstimated: true },
    )
    expect(cov.hasCostPrice).toBe(false)
    expect(cov.costEstimated).toBe(true)

    for (let i = 0; i < 3; i++) {
      cov = coverageWithCost(cov, { grossRevenueCents: 10_500, cogsCents: 5_000 }, { hasAdSpend: true })
      expect(cov.hasCostPrice).toBe(false)
      expect(cov.costEstimated).toBe(true)
    }
  })

  it('a REAL cost still sets hasCostPrice, and is not tainted by the estimate flag', () => {
    const cov = coverageWithCost(null, { grossRevenueCents: 10_500, cogsCents: 4_200 })
    expect(cov.hasCostPrice).toBe(true)
    expect(cov.costEstimated).toBe(false)
  })
})

describe('coverageWithCost', () => {
  it('self-corrects a stale hasCostPrice=true written under the old rule', () => {
    const out = coverageWithCost(
      { hasCostPrice: true, hasReferralFee: true },
      { grossRevenueCents: 12_900, cogsCents: 0 },
    )
    expect(out.hasCostPrice).toBe(false)
    expect(out.hasReferralFee).toBe(true)
  })

  it('sets hasCostPrice true only when a real cost backs it', () => {
    const out = coverageWithCost(null, { grossRevenueCents: 12_900, cogsCents: 5_400 })
    expect(out.hasCostPrice).toBe(true)
  })

  it('does not claim a cost on a no-revenue row just because the row is exempt', () => {
    // costIsKnown is true here (nothing sold), but there is still no cost price on file.
    const out = coverageWithCost(null, { grossRevenueCents: 0, cogsCents: 0 })
    expect(out.hasCostPrice).toBe(false)
  })

  it('carries the caller flags through and coerces junk to booleans', () => {
    const out = coverageWithCost(
      { hasFbaFee: 'yes' },
      { grossRevenueCents: 12_900, cogsCents: 5_400 },
      { hasAdSpend: true },
    )
    expect(out.hasFbaFee).toBe(false)
    expect(out.hasAdSpend).toBe(true)
  })
})
