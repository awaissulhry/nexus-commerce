import { describe, expect, it } from 'vitest'
import {
  adjustmentPercentProblem,
  expectedListingPrice,
  followerListingPrice,
  normalisePricingRule,
  pricingRuleLabel,
  roundCents,
} from './listing-price'

describe('roundCents — the one cents rounding', () => {
  it('🔴 a half cent the float hides rounds up: 1.005 → 1.01, 1.015 → 1.02, 2.675 → 2.68', () => {
    // `Math.round(n * 100) / 100` gives 1.00, 1.01 and 2.67 here: `n * 100` lands just below the half.
    expect(roundCents(1.005)).toBe(1.01)
    expect(roundCents(1.015)).toBe(1.02)
    expect(roundCents(2.675)).toBe(2.68)
    expect(roundCents(8.345)).toBe(8.35)
  })

  it('a product of floats lands on the cent it means', () => {
    expect(roundCents(0.1 + 0.2)).toBe(0.3)
    expect(roundCents(10 * 1.1)).toBe(11)
    expect(roundCents(19.99 * 1.075)).toBe(21.49)
    expect(roundCents(123456.785)).toBe(123456.79)
  })

  it('below a half cent stays down; whole numbers and zero are unchanged', () => {
    expect(roundCents(1.0049)).toBe(1)
    expect(roundCents(1.00499999)).toBe(1)
    expect(roundCents(0)).toBe(0)
    expect(roundCents(42)).toBe(42)
  })

  it('🔴 the follower price uses it: master 10 at +0.05% is 10.01, not the float 10.00', () => {
    expect(followerListingPrice(10, 'PERCENT_OF_MASTER', 0.05)).toBe(10.01)
    expect(followerListingPrice(1.005, 'FIXED', null)).toBe(1.01)
  })
})

describe('followerListingPrice — the one rule maths', () => {
  it('FIXED follows the master; PERCENT_OF_MASTER applies the percent; MATCH_AMAZON takes no master price', () => {
    expect(followerListingPrice(10, 'FIXED', 25)).toBe(10)
    expect(followerListingPrice(10, 'PERCENT_OF_MASTER', 10)).toBe(11)
    expect(followerListingPrice(10, 'PERCENT_OF_MASTER', -15)).toBe(8.5)
    expect(followerListingPrice(10, 'MATCH_AMAZON', 10)).toBeNull()
  })

  it('rounds to cents as the column stores it, and reads a Decimal-like or a string', () => {
    expect(followerListingPrice(19.99, 'PERCENT_OF_MASTER', 7.5)).toBe(21.49)
    expect(followerListingPrice('10', 'PERCENT_OF_MASTER', { toString: () => '10' })).toBe(11)
  })

  it('no percent counts as 0, an unknown or missing rule reads as FIXED, and no master price gives null', () => {
    expect(followerListingPrice(10, 'PERCENT_OF_MASTER', null)).toBe(10)
    expect(followerListingPrice(10, null, null)).toBe(10)
    expect(followerListingPrice(10, 'percent_of_master', 20)).toBe(12)
    expect(followerListingPrice(null, 'FIXED', null)).toBeNull()
  })
})

describe('expectedListingPrice', () => {
  it('is the rule price for a following listing and null for a pinned one', () => {
    expect(expectedListingPrice({ followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 }, 10)).toBe(11)
    expect(expectedListingPrice({ followMasterPrice: false, pricingRule: 'FIXED' }, 10)).toBeNull()
    expect(expectedListingPrice({ followMasterPrice: true, pricingRule: 'MATCH_AMAZON' }, 10)).toBeNull()
  })
})

describe('normalisePricingRule and adjustmentPercentProblem', () => {
  it('normalises case and refuses anything else', () => {
    expect(normalisePricingRule(' percent_of_master ')).toBe('PERCENT_OF_MASTER')
    expect(normalisePricingRule('match_amazon')).toBe('MATCH_AMAZON')
    expect(normalisePricingRule('CHEAPEST')).toBeNull()
    expect(normalisePricingRule(3)).toBeNull()
  })

  it('accepts a 2-decimal percent above -100 and within the column', () => {
    for (const ok of [0, 10, -99.99, 999.99, '12.5']) expect(adjustmentPercentProblem(ok)).toBeNull()
  })

  it('refuses a non-number, 3 decimals, -100 or less, and above 999.99', () => {
    expect(adjustmentPercentProblem('ten')).toMatch(/number/)
    expect(adjustmentPercentProblem(Number.NaN)).toMatch(/number/)
    expect(adjustmentPercentProblem(Infinity)).toMatch(/number/)
    expect(adjustmentPercentProblem(10.555)).toMatch(/2 decimals/)
    expect(adjustmentPercentProblem(-100)).toMatch(/above -100%/)
    expect(adjustmentPercentProblem(-150)).toMatch(/above -100%/)
    expect(adjustmentPercentProblem(1000)).toMatch(/999\.99/)
  })

  it('labels a rule for a sentence', () => {
    expect(pricingRuleLabel('PERCENT_OF_MASTER', 10)).toBe('the master price +10%')
    expect(pricingRuleLabel('PERCENT_OF_MASTER', -5)).toBe('the master price -5%')
    expect(pricingRuleLabel('FIXED', null)).toBe('the master price')
    expect(pricingRuleLabel('MATCH_AMAZON', null)).toBe('Amazon’s pricing')
  })
})
