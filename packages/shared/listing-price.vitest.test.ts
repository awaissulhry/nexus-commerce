import { describe, expect, it } from 'vitest'
import {
  adjustmentPercentProblem,
  expectedListingPrice,
  followerListingPrice,
  normalisePricingRule,
  pricingRuleLabel,
} from './listing-price'

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
