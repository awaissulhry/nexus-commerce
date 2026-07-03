/** E2 — margin math: the guardrail formulas (pure). */
import { describe, it, expect } from 'vitest'
import { computeEconomics, computeBreakEvenCpcCents, estimateEbayFeesCents } from './ebay-margin.js'

describe('computeEconomics', () => {
  it('computes margin + break-even rate on the ad-fee base', () => {
    // €109.99 price, €45 COGS, €13.00 fees → margin €51.99 → 47.27%
    const e = computeEconomics({ priceCents: 10999, cogsCents: 4500, ebayFeesCents: 1300, shippingCostCents: 0 })
    expect(e.contributionMarginCents).toBe(5199)
    expect(e.contributionMarginPct).toBeCloseTo(47.27, 2)
    expect(e.breakEvenAdRatePct).toBeCloseTo(47.27, 2)
    expect(e.dataStatus).toBe('ESTIMATED')
  })
  it('loss-making listings get a hard 0% break-even, never negative', () => {
    const e = computeEconomics({ priceCents: 2000, cogsCents: 2500, ebayFeesCents: 300, shippingCostCents: 0 })
    expect(e.contributionMarginCents).toBe(-800)
    expect(e.breakEvenAdRatePct).toBe(0)
  })
  it('missing COGS ⇒ MISSING_COGS (manual only), no numbers invented', () => {
    const e = computeEconomics({ priceCents: 10999, cogsCents: null, ebayFeesCents: 1300, shippingCostCents: 0 })
    expect(e.dataStatus).toBe('MISSING_COGS')
    expect(e.breakEvenAdRatePct).toBeNull()
    expect(e.contributionMarginCents).toBeNull()
  })
  it('missing/zero price ⇒ MISSING_PRICE', () => {
    expect(computeEconomics({ priceCents: null, cogsCents: 100, ebayFeesCents: 0, shippingCostCents: 0 }).dataStatus).toBe('MISSING_PRICE')
    expect(computeEconomics({ priceCents: 0, cogsCents: 100, ebayFeesCents: 0, shippingCostCents: 0 }).dataStatus).toBe('MISSING_PRICE')
  })
  it('flags OK when fees are actuals', () => {
    const e = computeEconomics({ priceCents: 10000, cogsCents: 4000, ebayFeesCents: 1200, shippingCostCents: 0 }, false)
    expect(e.dataStatus).toBe('OK')
  })
})

describe('computeBreakEvenCpcCents', () => {
  it('margin × trailing CVR', () => {
    // €50 margin, 100 clicks → 4 sales (4% CVR) → €2.00 break-even CPC
    expect(computeBreakEvenCpcCents(5000, 100, 4)).toBe(200)
  })
  it('null under the minimum-clicks threshold (no statistical basis)', () => {
    expect(computeBreakEvenCpcCents(5000, 49, 4)).toBeNull()
    expect(computeBreakEvenCpcCents(5000, 0, 0)).toBeNull()
  })
  it('zero sales → 0¢ (any click is money lost)', () => {
    expect(computeBreakEvenCpcCents(5000, 200, 0)).toBe(0)
  })
})

describe('estimateEbayFeesCents', () => {
  it('FVF% + fixed, labeled estimate at call sites', () => {
    // defaults: 11.5% + 35c → €109.99 → 1265 + 35 = 1300
    expect(estimateEbayFeesCents(10999)).toBe(1300)
  })
})
